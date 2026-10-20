import {
  CommandId,
  INBOX_ACTIVITY_PREVIEW_LENGTH,
  INBOX_CLOSED_STATES,
  InboxActivity,
  InboxError,
  InboxItem,
  InboxItemId,
  ThreadId,
  normalizeInboxLabels,
  renderInboxItemPrompt,
  type InboxActivityInput,
  type InboxCreateInput,
  type InboxDeleteInput,
  type InboxDeleteResult,
  type InboxItemState,
  type InboxLinkThreadInput,
  type InboxListActivityInput,
  type InboxListActivityResult,
  type InboxListResult,
  type InboxMutationResult,
  type InboxReorderInput,
  type InboxSearchInput,
  type InboxSearchResult,
  type InboxReorderResult,
  type InboxStartThreadInput,
  type InboxStartThreadResult,
  type InboxClientImportResult,
  type InboxSourcesRequest,
  type InboxSourcesResponse,
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
import * as InboxSources from "./InboxSourceService.ts";

/** Closed items older than this drop out of the live list; they stay in the table. */
const CLOSED_ITEM_RETENTION_DAYS = 14;

interface InboxItemRow {
  readonly item_json: string;
}

interface InboxActivityRow {
  readonly activity_key: string;
  readonly activity_json: string;
}

const decodeItemJson = Schema.decodeUnknownEffect(Schema.fromJsonString(InboxItem));
const decodeActivityJson = Schema.decodeUnknownEffect(Schema.fromJsonString(InboxActivity));
const encodeActivityJson = Schema.encodeEffect(Schema.fromJsonString(InboxActivity));
const encodeItemJson = Schema.encodeEffect(Schema.fromJsonString(InboxItem));
const isInboxError = Schema.is(InboxError);

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

function toActivity(input: InboxActivityInput): InboxActivity {
  return {
    key: input.key,
    kind: input.kind,
    author: input.author ?? null,
    body: input.body,
    url: input.url ?? null,
    occurredAt: input.occurredAt,
  };
}

function previewOf(activity: InboxActivity): InboxActivity {
  return activity.body.length <= INBOX_ACTIVITY_PREVIEW_LENGTH
    ? activity
    : { ...activity, body: `${activity.body.slice(0, INBOX_ACTIVITY_PREVIEW_LENGTH - 1)}…` };
}

function latestOf(current: InboxActivity | null, added: ReadonlyArray<InboxActivity>) {
  let latest = current;
  for (const activity of added) {
    if (latest === null || activity.occurredAt >= latest.occurredAt) latest = activity;
  }
  return latest === null ? null : previewOf(latest);
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
    readonly listActivity: (
      input: InboxListActivityInput,
    ) => Effect.Effect<InboxListActivityResult, InboxError>;
    readonly search: (input: InboxSearchInput) => Effect.Effect<InboxSearchResult, InboxError>;
    /**
     * Configured pullers, behind the one `inbox.sources` RPC. Typed by its flat request and
     * response rather than the operations: the richer types push the server's merged layer
     * types past the compiler's instantiation limit.
     */
    readonly sources: (
      request: InboxSourcesRequest,
    ) => Effect.Effect<InboxSourcesResponse, InboxError>;
    /** The browser-side settings `junkmail import-t3` staged, if any. */
    readonly clientImport: () => Effect.Effect<InboxClientImportResult, InboxError>;
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

    /** Stores events not already stored for the item and returns the new ones. */
    const appendActivity = (itemId: InboxItemId, inputs: ReadonlyArray<InboxActivityInput>) =>
      Effect.gen(function* () {
        if (inputs.length === 0) return [];
        const rows = yield* sql<Pick<InboxActivityRow, "activity_key">>`
          SELECT activity_key FROM inbox_activity WHERE item_id = ${itemId}
        `;
        const known = new Set(rows.map((row) => row.activity_key));
        const added: InboxActivity[] = [];
        for (const input of inputs) {
          if (known.has(input.key)) continue;
          known.add(input.key);
          const activity = toActivity(input);
          const json = yield* encodeActivityJson(activity);
          yield* sql`
            INSERT INTO inbox_activity (item_id, activity_key, occurred_at, activity_json)
            VALUES (${itemId}, ${activity.key}, ${activity.occurredAt}, ${json})
          `;
          added.push(activity);
        }
        return added;
      }).pipe(
        Effect.mapError((cause) => inboxError("Could not save inbox activity.", { itemId, cause })),
      );

    const create: InboxService["Service"]["create"] = (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const now = yield* nowIso;
            const origin = input.origin ?? { kind: "manual", externalKey: null };
            const inputLabels = input.labels ?? [];
            if (origin.externalKey !== null) {
              const existing = yield* findByOrigin(origin.kind, origin.externalKey);
              if (existing !== null) {
                // Re-delivery refreshes content and adds new events, never the user's triage,
                // except that news on a finished or snoozed item brings it back.
                const added = yield* appendActivity(existing.id, input.activity ?? []);
                const woken = added.length > 0;
                const refreshed: InboxItem = {
                  ...existing,
                  title: input.keepTitle === true ? existing.title : input.title,
                  ...(input.body === undefined ? {} : { body: input.body }),
                  origin: { ...existing.origin, url: input.url ?? existing.origin.url },
                  labels: normalizeInboxLabels([...existing.labels, ...inputLabels]),
                  activityCount: existing.activityCount + added.length,
                  unseenActivityCount: existing.unseenActivityCount + added.length,
                  lastActivity: latestOf(existing.lastActivity, added),
                  snoozedUntil: woken ? null : existing.snoozedUntil,
                  updatedAt: now,
                };
                const item =
                  woken && existing.state === "done"
                    ? withState(refreshed, "open", now)
                    : refreshed;
                yield* writeItem(item);
                return { item, created: false, addedActivity: added.length };
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
            if (replay !== null) return { item: replay, created: false, addedActivity: 0 };
            const added = yield* appendActivity(id, input.activity ?? []);
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
              labels: normalizeInboxLabels(inputLabels),
              activityCount: added.length,
              // A new item is unseen as a whole; the count tracks news on items already seen.
              unseenActivityCount: 0,
              lastActivity: latestOf(null, added),
            };
            yield* writeItem(item);
            return { item, created: true, addedActivity: added.length };
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isInboxError(cause) ? cause : inboxError("Could not save inbox item.", { cause }),
          ),
          Effect.tap(() => notifyChanged),
        );

    const listActivity: InboxService["Service"]["listActivity"] = (input) =>
      sql<InboxActivityRow>`
        SELECT activity_key, activity_json FROM inbox_activity
        WHERE item_id = ${input.id}
        ORDER BY occurred_at ASC, activity_key ASC
      `.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) => decodeActivityJson(row.activity_json), { concurrency: 1 }),
        ),
        Effect.map((activity) => ({ activity })),
        Effect.mapError((cause) =>
          inboxError("Could not load inbox activity.", { itemId: input.id, cause }),
        ),
      );

    // SQLite LIKE is case-insensitive for ASCII; escape the wildcards a query may contain.
    const search: InboxService["Service"]["search"] = (input) => {
      const pattern = `%${input.query.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
      return sql<{ readonly item_id: string }>`
        SELECT DISTINCT item_id FROM inbox_activity
        WHERE activity_json LIKE ${pattern} ESCAPE '\\'
        LIMIT 500
      `.pipe(
        Effect.map((rows) => ({ ids: rows.map((row) => InboxItemId.make(row.item_id)) })),
        Effect.mapError((cause) => inboxError("Could not search inbox activity.", { cause })),
      );
    };

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
          ...(input.labels === undefined ? {} : { labels: normalizeInboxLabels(input.labels) }),
          ...(input.markSeen === true ? { unseenActivityCount: 0 } : {}),
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
            isInboxError(cause) ? cause : inboxError("Could not reorder inbox items.", { cause }),
          ),
          Effect.tap(() => notifyChanged),
        );

    const linkThread: InboxService["Service"]["linkThread"] = (input) =>
      modify(input.id, (item) => {
        const others = item.threadIds.filter((threadId) => threadId !== input.threadId);
        return { ...item, threadIds: input.linked ? [...others, input.threadId] : others };
      });

    const deleteItem: InboxService["Service"]["delete"] = (input) =>
      sql
        .withTransaction(
          sql`DELETE FROM inbox_activity WHERE item_id = ${input.id}`.pipe(
            Effect.andThen(sql`DELETE FROM inbox_items WHERE item_id = ${input.id}`),
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            inboxError("Could not delete inbox item.", { itemId: input.id, cause }),
          ),
          Effect.andThen(notifyChanged),
          Effect.as({ id: input.id }),
        );

    const startThread: InboxService["Service"]["startThread"] = (input) =>
      Effect.gen(function* () {
        const item = yield* get(input.id);
        const { activity } = yield* listActivity({ id: item.id });
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
              text: renderInboxItemPrompt(item, input.prompt, activity),
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

    const sources = InboxSources.dispatch(yield* InboxSources.make({ create }));

    // `junkmail import-t3` writes this row into the database it copies.
    const clientImport = () =>
      sql<{ readonly json: string }>`SELECT json FROM junkmail_client_import WHERE id = 1`.pipe(
        Effect.map((rows) => ({ json: rows[0]?.json ?? null })),
        Effect.mapError((cause) => inboxError("Could not read the imported settings.", { cause })),
      );

    return InboxService.of({
      sources,
      clientImport,
      list,
      subscribeList,
      get,
      create,
      update,
      reorder,
      linkThread,
      delete: deleteItem,
      startThread,
      listActivity,
      search,
    });
  }),
);
