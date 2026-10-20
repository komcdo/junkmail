/**
 * junkmail: configured pullers. Runs each enabled source on its interval through the shared
 * scheduler and files what it finds with `InboxService.create`, the same path the UI and MCP use.
 */
import {
  INBOX_SOURCE_OPERATIONS,
  InboxSource,
  InboxError,
  InboxSourceId,
  StoredSlackSourceSettings,
  type InboxSourceIdInput,
  type InboxSourceListResult,
  type InboxSourcePreviewResult,
  type InboxSourceResult,
  type InboxSourceSaveInput,
  type InboxSourceStatus,
  type InboxSourcesRequest,
  type InboxSourcesResponse,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpClient } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import type * as InboxService from "./InboxService.ts";
import { SlackApiError, SlackCursor, pullSlack, slackAuthTest } from "./sources/slack.ts";

interface SourceRow {
  readonly source_id: string;
  readonly kind: string;
  readonly name: string;
  readonly enabled: number;
  readonly settings_json: string;
  readonly cursor_json: string | null;
  readonly account_json: string | null;
  readonly status: string;
  readonly last_error: string | null;
  readonly last_run_at: string | null;
  readonly last_success_at: string | null;
  readonly next_run_at: string | null;
  readonly last_run_item_count: number;
}

const decodeSettings = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredSlackSourceSettings));
const encodeSettings = Schema.encodeEffect(Schema.fromJsonString(StoredSlackSourceSettings));
const decodeSource = Schema.decodeUnknownEffect(InboxSource);
const SourceAccount = Schema.Struct({ team: Schema.String, user: Schema.String });
type SourceAccount = typeof SourceAccount.Type;
const encodeCursor = Schema.encodeSync(Schema.fromJsonString(SlackCursor));
const encodeAccount = Schema.encodeSync(Schema.fromJsonString(SourceAccount));
const decodeCursorOption = Schema.decodeUnknownOption(Schema.fromJsonString(SlackCursor));
const decodeAccountOption = Schema.decodeUnknownOption(Schema.fromJsonString(SourceAccount));
const isSlackApiError = Schema.is(SlackApiError);

/** Retry a failing source no sooner than this, whatever its interval. */
const ERROR_RETRY_MS = 5 * 60_000;

const secretName = (id: string) => `inbox-source-${id}`;
const nowIso = DateTime.now.pipe(Effect.map((now) => DateTime.formatIso(now)));
const isoAfter = (ms: number) =>
  Clock.currentTimeMillis.pipe(
    Effect.map((now) => DateTime.formatIso(DateTime.makeUnsafe(now + ms))),
  );

// Source failures share InboxError: each new error class widens the type of every RPC handler
// in ws.ts, and that table is already at the compiler's instantiation limit.
function sourceError(message: string, input?: { sourceId?: InboxSourceId; cause?: unknown }) {
  return new InboxError({
    message: input?.sourceId === undefined ? message : `${input.sourceId}: ${message}`,
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}
const isSourceError = Schema.is(InboxError);

// A cursor or account that no longer decodes is dropped: the next run re-pulls the backfill.
const readCursor = (text: string | null) =>
  text === null ? null : Option.getOrNull(decodeCursorOption(text));
const readAccount = (text: string | null) =>
  text === null ? null : Option.getOrNull(decodeAccountOption(text));

export interface InboxSources {
  readonly list: () => Effect.Effect<InboxSourceListResult, InboxError>;
  readonly save: (input: InboxSourceSaveInput) => Effect.Effect<InboxSourceResult, InboxError>;
  readonly delete: (input: InboxSourceIdInput) => Effect.Effect<InboxSourceIdInput, InboxError>;
  /** Pull now, whatever the schedule says. */
  readonly run: (input: InboxSourceIdInput) => Effect.Effect<InboxSourceResult, InboxError>;
  /** What the next run would file, without writing anything. */
  readonly preview: (
    input: InboxSourceIdInput,
  ) => Effect.Effect<InboxSourcePreviewResult, InboxError>;
}

export const make = (inbox: Pick<InboxService.InboxService["Service"], "create">) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const httpClient = yield* HttpClient.HttpClient;
    // One pull at a time: runs are short, and it keeps the scheduler and "Run now" from racing
    // on the same cursor.
    const runLock = yield* Semaphore.make(1);

    const readToken = (id: InboxSourceId) =>
      secrets.get(secretName(id)).pipe(
        Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
        Effect.mapError((cause) =>
          sourceError("Could not read the source token.", { sourceId: id, cause }),
        ),
      );

    const toSource = (row: SourceRow) =>
      Effect.gen(function* () {
        const settings = yield* decodeSettings(row.settings_json);
        const id = InboxSourceId.make(row.source_id);
        const token = yield* readToken(id);
        return yield* decodeSource({
          id,
          kind: row.kind,
          name: row.name,
          enabled: row.enabled === 1,
          settings,
          hasToken: Option.isSome(token),
          account: readAccount(row.account_json),
          status: row.status,
          lastError: row.last_error,
          lastRunAt: row.last_run_at,
          lastSuccessAt: row.last_success_at,
          nextRunAt: row.next_run_at,
          lastRunItemCount: row.last_run_item_count,
        });
      }).pipe(
        Effect.mapError((cause) =>
          isSourceError(cause) ? cause : sourceError("Could not read a saved source.", { cause }),
        ),
      );

    const findRow = (id: InboxSourceId) =>
      sql<SourceRow>`SELECT * FROM inbox_sources WHERE source_id = ${id}`.pipe(
        Effect.map((rows) => rows[0] ?? null),
        Effect.mapError((cause) =>
          sourceError("Could not load the source.", { sourceId: id, cause }),
        ),
        Effect.flatMap((row) =>
          row === null
            ? Effect.fail(sourceError("That source no longer exists.", { sourceId: id }))
            : Effect.succeed(row),
        ),
      );

    const recordRun = (
      id: InboxSourceId,
      outcome: {
        readonly status: InboxSourceStatus;
        readonly error: string | null;
        readonly nextRunAt: string | null;
        readonly cursor?: SlackCursor;
        readonly account?: SourceAccount;
        readonly itemCount?: number;
      },
    ) =>
      Effect.gen(function* () {
        const now = yield* nowIso;
        const succeeded = outcome.status === "idle";
        yield* sql`
          UPDATE inbox_sources SET
            status = ${outcome.status},
            last_error = ${outcome.error},
            last_run_at = ${now},
            last_success_at = COALESCE(${succeeded ? now : null}, last_success_at),
            next_run_at = ${outcome.nextRunAt},
            cursor_json = COALESCE(${outcome.cursor === undefined ? null : encodeCursor(outcome.cursor)}, cursor_json),
            account_json = COALESCE(${outcome.account === undefined ? null : encodeAccount(outcome.account)}, account_json),
            last_run_item_count = COALESCE(${outcome.itemCount ?? null}, last_run_item_count)
          WHERE source_id = ${id}
        `;
      }).pipe(
        Effect.mapError((cause) =>
          sourceError("Could not record the run.", { sourceId: id, cause }),
        ),
      );

    const pull = (row: SourceRow, token: string) =>
      decodeSettings(row.settings_json).pipe(
        Effect.mapError((cause) => sourceError("The source settings are invalid.", { cause })),
        Effect.flatMap((settings) =>
          pullSlack({ token, settings, cursor: readCursor(row.cursor_json) }),
        ),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );

    const runSource = (id: InboxSourceId) =>
      runLock.withPermits(1)(
        Effect.gen(function* () {
          const row = yield* findRow(id);
          const token = yield* readToken(id);
          if (Option.isNone(token)) {
            yield* recordRun(id, {
              status: "auth_required",
              error: "Paste a Slack token to start pulling.",
              nextRunAt: null,
            });
            return;
          }
          const settings = yield* decodeSettings(row.settings_json).pipe(
            Effect.mapError((cause) => sourceError("The source settings are invalid.", { cause })),
          );
          const intervalMs = settings.intervalMinutes * 60_000;
          const result = yield* pull(row, token.value).pipe(
            Effect.map((value) => ({ ok: true as const, value })),
            Effect.catch((cause) => Effect.succeed({ ok: false as const, cause })),
          );
          if (!result.ok) {
            const { cause } = result;
            const slack = isSlackApiError(cause) ? cause : null;
            const message = cause.message;
            yield* Effect.logWarning("inbox source run failed", { sourceId: id, error: message });
            yield* recordRun(
              id,
              slack?.isAuthFailure
                ? // Stays stopped until a new token is saved; retrying a dead token only spams.
                  { status: "auth_required", error: message, nextRunAt: null }
                : {
                    status: "error",
                    error: message,
                    nextRunAt: yield* isoAfter(
                      Math.max(intervalMs, ERROR_RETRY_MS, (slack?.retryAfterSec ?? 0) * 1000),
                    ),
                  },
            );
            return;
          }
          let itemCount = 0;
          for (const { watch: _watch, ...item } of result.value.items) {
            const filed = yield* inbox
              .create(item)
              .pipe(
                Effect.mapError((cause) =>
                  sourceError("Could not file a Slack item.", { sourceId: id, cause }),
                ),
              );
            if (filed.created === true || (filed.addedActivity ?? 0) > 0) itemCount++;
          }
          // The cursor moves only after every item is filed, so a failure re-pulls, and
          // re-filing is a no-op because activity keys dedupe.
          yield* recordRun(id, {
            status: "idle",
            error: null,
            nextRunAt: yield* isoAfter(intervalMs),
            cursor: result.value.cursor,
            account: { team: result.value.account.team, user: result.value.account.user },
            itemCount,
          });
        }),
      );

    const list: InboxSources["list"] = () =>
      sql<SourceRow>`SELECT * FROM inbox_sources ORDER BY created_at ASC`.pipe(
        Effect.mapError((cause) => sourceError("Could not load sources.", { cause })),
        Effect.flatMap((rows) => Effect.forEach(rows, toSource)),
        Effect.map((sources) => ({ sources })),
      );

    const getSource = (id: InboxSourceId) => findRow(id).pipe(Effect.flatMap(toSource));

    const save: InboxSources["save"] = (input) =>
      Effect.gen(function* () {
        const id =
          input.id ??
          InboxSourceId.make(`${input.kind}-${(yield* crypto.randomUUIDv4()).slice(0, 8)}`);
        let account: SourceAccount | null = null;
        if (input.token !== undefined) {
          // Check the token before saving it, so a typo fails here rather than on the next run.
          const checked = yield* slackAuthTest(input.token).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.mapError((cause) => sourceError(cause.message, { sourceId: id, cause })),
          );
          account = { team: checked.team, user: checked.user };
          yield* secrets.set(secretName(id), new TextEncoder().encode(input.token));
        }
        const settingsJson = yield* encodeSettings(input.settings);
        const now = yield* nowIso;
        const enabled = input.enabled ? 1 : 0;
        // Saving reschedules: an enabled source runs on the next scheduler tick.
        const nextRunAt = input.enabled ? now : null;
        yield* sql`
          INSERT INTO inbox_sources (
            source_id, kind, name, enabled, settings_json, account_json, status, next_run_at, created_at
          ) VALUES (
            ${id}, ${input.kind}, ${input.name}, ${enabled}, ${settingsJson},
            ${account === null ? null : encodeAccount(account)}, 'idle', ${nextRunAt}, ${now}
          )
          ON CONFLICT (source_id) DO UPDATE SET
            name = excluded.name,
            enabled = excluded.enabled,
            settings_json = excluded.settings_json,
            account_json = COALESCE(excluded.account_json, inbox_sources.account_json),
            status = CASE WHEN excluded.account_json IS NOT NULL THEN 'idle' ELSE inbox_sources.status END,
            last_error = CASE WHEN excluded.account_json IS NOT NULL THEN NULL ELSE inbox_sources.last_error END,
            next_run_at = excluded.next_run_at
        `;
        return { source: yield* getSource(id) };
      }).pipe(
        Effect.mapError((cause) =>
          isSourceError(cause) ? cause : sourceError("Could not save the source.", { cause }),
        ),
      );

    const remove: InboxSources["delete"] = (input) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM inbox_sources WHERE source_id = ${input.id}`;
        yield* secrets.remove(secretName(input.id));
        return input;
      }).pipe(
        Effect.mapError((cause) =>
          sourceError("Could not delete the source.", { sourceId: input.id, cause }),
        ),
      );

    const run: InboxSources["run"] = (input) =>
      runSource(input.id).pipe(
        Effect.andThen(getSource(input.id)),
        Effect.map((source) => ({ source })),
      );

    const preview: InboxSources["preview"] = (input) =>
      Effect.gen(function* () {
        const row = yield* findRow(input.id);
        const token = yield* readToken(input.id);
        if (Option.isNone(token)) {
          return yield* sourceError("Paste a Slack token first.", { sourceId: input.id });
        }
        const result = yield* pull(row, token.value).pipe(
          Effect.mapError((cause) =>
            isSourceError(cause)
              ? cause
              : sourceError(cause.message, { sourceId: input.id, cause }),
          ),
        );
        const now = yield* nowIso;
        return {
          filteredCount: result.filteredCount,
          items: result.items.map((item) => ({
            title: item.title,
            watch: item.watch,
            url: item.url ?? null,
            messageCount: item.activity?.length ?? 0,
            latestAt: item.activity?.at(-1)?.occurredAt ?? now,
          })),
        };
      });

    const runDue = Effect.gen(function* () {
      const now = yield* nowIso;
      const due = yield* sql<{ source_id: string }>`
        SELECT source_id FROM inbox_sources
        WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ${now}
        ORDER BY next_run_at ASC
      `;
      for (const { source_id } of due) {
        yield* runSource(InboxSourceId.make(source_id)).pipe(
          Effect.catch((error) =>
            Effect.logWarning("inbox source run failed", { sourceId: source_id, error }),
          ),
        );
      }
    });
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("inbox-sources", runDue);

    const sources: InboxSources = { list, save, delete: remove, run, preview };
    return sources;
  });

/** Serves the single `inbox.sources` RPC: decode the operation's input, run it, encode. */
export const dispatch =
  (sources: InboxSources) =>
  (request: InboxSourcesRequest): Effect.Effect<InboxSourcesResponse, InboxError> => {
    const codecs = INBOX_SOURCE_OPERATIONS[request.operation];
    const input = codecs.input as unknown as Schema.Codec<unknown>;
    const output = codecs.output as unknown as Schema.Codec<unknown>;
    return Schema.decodeEffect(Schema.fromJsonString(input))(request.input).pipe(
      Effect.mapError((cause) => sourceError("The request did not match its schema.", { cause })),
      Effect.flatMap((decoded) =>
        (sources[request.operation] as (value: unknown) => Effect.Effect<unknown, InboxError>)(
          decoded,
        ),
      ),
      Effect.flatMap((result) =>
        Schema.encodeEffect(Schema.fromJsonString(output))(result).pipe(
          Effect.mapError((cause) => sourceError("Could not encode the response.", { cause })),
        ),
      ),
      Effect.map((encoded) => ({ output: encoded })),
    );
  };
