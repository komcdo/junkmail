import {
  CommandId,
  INBOX_CLOSED_STATES,
  InboxError,
  InboxItem,
  InboxItemId,
  ThreadId,
  renderInboxItemPrompt,
  type InboxCreateInput,
  type InboxDeleteInput,
  type InboxDeleteResult,
  type InboxItemState,
  type InboxLinkThreadInput,
  type InboxListResult,
  type InboxMutationResult,
  type InboxReorderInput,
  type InboxReorderResult,
  type InboxStartThreadInput,
  type InboxStartThreadResult,
  type InboxUpdateInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";

/** Closed items older than this drop out of the live list; they stay in the table. */
const CLOSED_ITEM_RETENTION_DAYS = 14;

interface InboxItemRow {
  readonly item_json: string;
}

const decodeItemJson = Schema.decodeUnknownEffect(Schema.fromJsonString(InboxItem));
const encodeItemJson = Schema.encodeEffect(Schema.fromJsonString(InboxItem));

function inboxError(message: string, input?: { itemId?: InboxItemId; cause?: unknown }) {
  return new InboxError({
    message,
    ...(input?.itemId === undefined ? {} : { itemId: input.itemId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}

const nowIso = DateTime.now.pipe(Effect.map((now) => DateTime.formatIso(now)));

function withState(item: InboxItem, state: InboxItemState, now: string): InboxItem {
  if (state === item.state) return item;
  return { ...item, state, closedAt: INBOX_CLOSED_STATES.has(state) ? now : null };
}

export class InboxService extends Context.Service<
  InboxService,
  {
    readonly list: () => Effect.Effect<InboxListResult, InboxError>;
    readonly subscribeList: () => Stream.Stream<InboxListResult, InboxError>;
    readonly get: (id: InboxItemId) => Effect.Effect<InboxItem, InboxError>;
    readonly create: (input: InboxCreateInput) => Effect.Effect<InboxMutationResult, InboxError>;
    readonly update: (input: InboxUpdateInput) => Effect.Effect<InboxMutationResult, InboxError>;
    readonly reorder: (input: InboxReorderInput) => Effect.Effect<InboxReorderResult, InboxError>;
    readonly linkThread: (
      input: InboxLinkThreadInput,
    ) => Effect.Effect<InboxMutationResult, InboxError>;
    readonly delete: (input: InboxDeleteInput) => Effect.Effect<InboxDeleteResult, InboxError>;
    readonly startThread: (
      input: InboxStartThreadInput,
    ) => Effect.Effect<InboxStartThreadResult, InboxError>;
  }
>()("t3/inbox/InboxService") {}

export const layer = Layer.effect(
  InboxService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    // Every change re-emits the whole list, so a slow subscriber only needs the latest signal.
    const changes = yield* PubSub.sliding<void>(1);
    const notifyChanged = PubSub.publish(changes, undefined).pipe(Effect.asVoid);

    const decodeRows = (rows: ReadonlyArray<InboxItemRow>) =>
      Effect.forEach(rows, (row) => decodeItemJson(row.item_json), { concurrency: 1 });

    const findItem = (id: InboxItemId) =>
      sql<InboxItemRow>`SELECT item_json FROM inbox_items WHERE item_id = ${id}`.pipe(
        Effect.flatMap(decodeRows),
        Effect.map((items) => items[0] ?? null),
        Effect.mapError((cause) => inboxError("Could not load inbox item.", { itemId: id, cause })),
      );

    const get: InboxService["Service"]["get"] = (id) =>
      findItem(id).pipe(
        Effect.filterOrFail(
          (item): item is InboxItem => item !== null,
          () => inboxError("Inbox item not found.", { itemId: id }),
        ),
      );

    const writeItem = (item: InboxItem) =>
      encodeItemJson(item).pipe(
        Effect.flatMap(
          (json) => sql`
            INSERT INTO inbox_items (item_id, origin_kind, external_key, state, updated_at, item_json)
            VALUES (
              ${item.id}, ${item.origin.kind}, ${item.origin.externalKey},
              ${item.state}, ${item.updatedAt}, ${json}
            )
            ON CONFLICT (item_id) DO UPDATE SET
              state = excluded.state,
              updated_at = excluded.updated_at,
              item_json = excluded.item_json
          `,
        ),
        Effect.mapError((cause) =>
          inboxError("Could not save inbox item.", { itemId: item.id, cause }),
        ),
      );

    const modify = (id: InboxItemId, change: (item: InboxItem, now: string) => InboxItem) =>
      Effect.gen(function* () {
        const current = yield* get(id);
        const now = yield* nowIso;
        const next = { ...change(current, now), updatedAt: now };
        yield* writeItem(next);
        yield* notifyChanged;
        return { item: next };
      });

    const list: InboxService["Service"]["list"] = () =>
      Effect.gen(function* () {
        const cutoff = DateTime.formatIso(
          DateTime.subtract(yield* DateTime.now, { days: CLOSED_ITEM_RETENTION_DAYS }),
        );
        const rows = yield* sql<InboxItemRow>`
          SELECT item_json FROM inbox_items
          WHERE state NOT IN ('done', 'dismissed') OR updated_at >= ${cutoff}
        `;
        return { items: yield* decodeRows(rows) };
      }).pipe(Effect.mapError((cause) => inboxError("Could not list inbox items.", { cause })));

    const subscribeList: InboxService["Service"]["subscribeList"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before the snapshot so a change between the two is not lost.
          const subscription = yield* PubSub.subscribe(changes);
          return Stream.concat(
            Stream.fromEffect(list()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
          );
        }),
      );

    const findByOrigin = (kind: string, externalKey: string) =>
      sql<InboxItemRow>`
        SELECT item_json FROM inbox_items
        WHERE origin_kind = ${kind} AND external_key = ${externalKey}
      `.pipe(
        Effect.flatMap(decodeRows),
        Effect.map((items) => items[0] ?? null),
        Effect.mapError((cause) => inboxError("Could not load inbox item.", { cause })),
      );

    const create: InboxService["Service"]["create"] = (input) =>
      Effect.gen(function* () {
        const now = yield* nowIso;
        const origin = input.origin ?? { kind: "manual", externalKey: null };
        if (origin.externalKey !== null) {
          const existing = yield* findByOrigin(origin.kind, origin.externalKey);
          if (existing !== null) {
            // Re-delivery from a source refreshes content but never the user's triage.
            const item: InboxItem = {
              ...existing,
              title: input.title,
              ...(input.body === undefined ? {} : { body: input.body }),
              origin: { ...existing.origin, url: input.url ?? existing.origin.url },
              updatedAt: now,
            };
            yield* writeItem(item);
            yield* notifyChanged;
            return { item };
          }
        }
        // A retried command with the same id must not create a second item.
        const id = InboxItemId.make(
          input.commandId === undefined
            ? `inbox-${yield* crypto
                .randomUUIDv4()
                .pipe(
                  Effect.mapError((cause) =>
                    inboxError("Could not generate inbox item id.", { cause }),
                  ),
                )}`
            : `inbox-${input.commandId}`,
        );
        const replay = yield* findItem(id);
        if (replay !== null) return { item: replay };
        const item: InboxItem = {
          id,
          title: input.title,
          body: input.body ?? null,
          state: "open",
          priority: input.priority ?? 4,
          orderKey: null,
          snoozedUntil: null,
          origin: { ...origin, url: input.url ?? null },
          projectId: input.projectId ?? null,
          threadIds: input.threadId === undefined ? [] : [input.threadId],
          worktreePath: null,
          branch: null,
          pullRequestUrls: [],
          createdBy: input.createdBy ?? "user",
          createdAt: now,
          updatedAt: now,
          closedAt: null,
        };
        yield* writeItem(item);
        yield* notifyChanged;
        return { item };
      });

    const update: InboxService["Service"]["update"] = (input) =>
      modify(input.id, (item, now) => {
        const next: InboxItem = {
          ...item,
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.body === undefined ? {} : { body: input.body }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(input.snoozedUntil === undefined ? {} : { snoozedUntil: input.snoozedUntil }),
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          ...(input.worktreePath === undefined ? {} : { worktreePath: input.worktreePath }),
          ...(input.branch === undefined ? {} : { branch: input.branch }),
          ...(input.pullRequestUrls === undefined
            ? {}
            : { pullRequestUrls: input.pullRequestUrls }),
        };
        return input.state === undefined ? next : withState(next, input.state, now);
      });

    const reorder: InboxService["Service"]["reorder"] = (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const now = yield* nowIso;
            const items: InboxItem[] = [];
            for (const { id, orderKey } of input.updates) {
              const item = { ...(yield* get(id)), orderKey, updatedAt: now };
              yield* writeItem(item);
              items.push(item);
            }
            return { items };
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            Schema.is(InboxError)(cause)
              ? cause
              : inboxError("Could not reorder inbox items.", { cause }),
          ),
          Effect.tap(() => notifyChanged),
        );

    const linkThread: InboxService["Service"]["linkThread"] = (input) =>
      modify(input.id, (item) => {
        const others = item.threadIds.filter((threadId) => threadId !== input.threadId);
        return { ...item, threadIds: input.linked ? [...others, input.threadId] : others };
      });

    const deleteItem: InboxService["Service"]["delete"] = (input) =>
      sql`DELETE FROM inbox_items WHERE item_id = ${input.id}`.pipe(
        Effect.mapError((cause) =>
          inboxError("Could not delete inbox item.", { itemId: input.id, cause }),
        ),
        Effect.andThen(notifyChanged),
        Effect.as({ id: input.id }),
      );

    const startThread: InboxService["Service"]["startThread"] = (input) =>
      Effect.gen(function* () {
        const item = yield* get(input.id);
        const key = input.commandId ?? `${item.id}:${item.threadIds.length}`;
        const launched = yield* threadLaunch
          .launch({
            commandId: CommandId.make(`inbox-start:${key}`),
            projectId: input.projectId,
            title: item.title,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            workspaceStrategy: input.workspaceStrategy,
            initialMessage: {
              text: renderInboxItemPrompt(item, input.prompt),
              attachments: [],
            },
            createdBy: "user",
            creationSource: "server",
          })
          .pipe(
            Effect.mapError((cause) =>
              inboxError("Could not start a thread for this inbox item.", {
                itemId: item.id,
                cause,
              }),
            ),
          );
        const threadId = ThreadId.make(launched.threadId);
        const { item: linked } = yield* modify(item.id, (current, now) => {
          const threadIds = current.threadIds.includes(threadId)
            ? current.threadIds
            : [...current.threadIds, threadId];
          const started = { ...current, threadIds, projectId: input.projectId };
          // Starting work on a closed or snoozed item is an explicit reopen.
          return withState({ ...started, snoozedUntil: null }, "in_progress", now);
        });
        return { item: linked, threadId };
      });

    return InboxService.of({
      list,
      subscribeList,
      get,
      create,
      update,
      reorder,
      linkThread,
      delete: deleteItem,
      startThread,
    });
  }),
);
