/**
 * junkmail: inbox sources, the configured pullers that file work into the inbox.
 *
 * A source is one connected account of one puller kind. Its token lives in the server's secret
 * store and never crosses the wire; clients only learn whether one is saved.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { InboxLabel } from "./inbox.ts";

export const InboxSourceId = TrimmedNonEmptyString.check(Schema.isMaxLength(64)).pipe(
  Schema.brand("InboxSourceId"),
);
export type InboxSourceId = typeof InboxSourceId.Type;

/** One Slack search whose matches become inbox items. `@me` expands to the signed-in user. */
export const SlackWatch = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(300)),
  enabled: Schema.Boolean,
});
export type SlackWatch = typeof SlackWatch.Type;

export const DEFAULT_SLACK_WATCHES: ReadonlyArray<SlackWatch> = [
  { name: "Direct messages", query: "to:me", enabled: true },
  { name: "Mentions", query: "@me", enabled: true },
];

export const SlackSourceSettings = Schema.Struct({
  watches: Schema.Array(SlackWatch),
  ignoreBots: Schema.Boolean,
  /** Your own messages still join threads as context, but never count as news. */
  ignoreOwnMessages: Schema.Boolean,
  intervalMinutes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1440 })),
  /** How far back the first run looks, so connecting a busy workspace is not a flood. */
  backfillDays: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30 })),
  labels: Schema.Array(InboxLabel),
});
export type SlackSourceSettings = typeof SlackSourceSettings.Type;

/**
 * What the server stores: missing fields take their defaults, so settings saved by an older
 * build still load. Kept off the wire types, where nesting decoding defaults inside
 * `InboxSource` pushes the server's types past the compiler's instantiation limit.
 */
export const StoredSlackSourceSettings = Schema.Struct({
  watches: SlackSourceSettings.fields.watches.pipe(
    Schema.withDecodingDefault(Effect.succeed([...DEFAULT_SLACK_WATCHES])),
  ),
  ignoreBots: SlackSourceSettings.fields.ignoreBots.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  ignoreOwnMessages: SlackSourceSettings.fields.ignoreOwnMessages.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
  ),
  intervalMinutes: SlackSourceSettings.fields.intervalMinutes.pipe(
    Schema.withDecodingDefault(Effect.succeed(5)),
  ),
  backfillDays: SlackSourceSettings.fields.backfillDays.pipe(
    Schema.withDecodingDefault(Effect.succeed(3)),
  ),
  labels: SlackSourceSettings.fields.labels.pipe(
    Schema.withDecodingDefault(Effect.succeed(["slack"])),
  ),
});

const decodeStoredSlackSettings = Schema.decodeUnknownSync(StoredSlackSourceSettings);
export const defaultSlackSourceSettings = (): SlackSourceSettings => decodeStoredSlackSettings({});

export const InboxSourceKind = Schema.Literals(["slack"]);
export type InboxSourceKind = typeof InboxSourceKind.Type;

export const InboxSourceStatus = Schema.Literals(["idle", "running", "error", "auth_required"]);
export type InboxSourceStatus = typeof InboxSourceStatus.Type;

export const InboxSource = Schema.Struct({
  id: InboxSourceId,
  kind: InboxSourceKind,
  name: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  settings: SlackSourceSettings,
  hasToken: Schema.Boolean,
  /** Who the token belongs to, from the last successful check. */
  account: Schema.NullOr(Schema.Struct({ team: Schema.String, user: Schema.String })),
  status: InboxSourceStatus,
  lastError: Schema.NullOr(Schema.String),
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastSuccessAt: Schema.NullOr(IsoDateTime),
  nextRunAt: Schema.NullOr(IsoDateTime),
  /** Items created or updated by the last successful run. */
  lastRunItemCount: Schema.Int,
});
export type InboxSource = typeof InboxSource.Type;

export const InboxSourceListResult = Schema.Struct({ sources: Schema.Array(InboxSource) });
export type InboxSourceListResult = typeof InboxSourceListResult.Type;

export const InboxSourceSaveInput = Schema.Struct({
  id: Schema.optional(InboxSourceId).annotate({ description: "Omit to add a new source." }),
  kind: InboxSourceKind,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(60)),
  enabled: Schema.Boolean,
  settings: SlackSourceSettings,
  token: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "Replaces the saved token. Omit to keep the current one.",
  }),
});
export type InboxSourceSaveInput = typeof InboxSourceSaveInput.Type;

export const InboxSourceIdInput = Schema.Struct({ id: InboxSourceId });
export type InboxSourceIdInput = typeof InboxSourceIdInput.Type;

export const InboxSourceResult = Schema.Struct({ source: InboxSource });
export type InboxSourceResult = typeof InboxSourceResult.Type;

/** What a dry run would file, without touching the inbox or the source's cursor. */
export const InboxSourcePreviewResult = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      title: Schema.String,
      watch: Schema.String,
      url: Schema.NullOr(Schema.String),
      messageCount: Schema.Int,
      latestAt: IsoDateTime,
    }),
  ),
  /** Matches dropped by the bot and own-message filters. */
  filteredCount: Schema.Int,
});
export type InboxSourcePreviewResult = typeof InboxSourcePreviewResult.Type;

/**
 * Every source operation travels through one RPC whose payload is JSON validated by the
 * per-operation schemas below. Five typed RPCs pushed the server's merged RPC and layer types
 * past the TypeScript instantiation limit; a string payload keeps those types flat.
 */
export const INBOX_SOURCE_OPERATIONS = {
  list: { input: Schema.Struct({}), output: InboxSourceListResult },
  save: { input: InboxSourceSaveInput, output: InboxSourceResult },
  delete: { input: InboxSourceIdInput, output: InboxSourceIdInput },
  /** Pull now, whatever the schedule says. */
  run: { input: InboxSourceIdInput, output: InboxSourceResult },
  /** What the next run would file, without writing anything. */
  preview: { input: InboxSourceIdInput, output: InboxSourcePreviewResult },
} as const;
export type InboxSourceOperation = keyof typeof INBOX_SOURCE_OPERATIONS;
export type InboxSourceOperationInput<Op extends InboxSourceOperation> =
  (typeof INBOX_SOURCE_OPERATIONS)[Op]["input"]["Type"];
export type InboxSourceOperationOutput<Op extends InboxSourceOperation> =
  (typeof INBOX_SOURCE_OPERATIONS)[Op]["output"]["Type"];

export const InboxSourcesRequest = Schema.Struct({
  operation: Schema.Literals(["list", "save", "delete", "run", "preview"]),
  input: Schema.String,
});
export type InboxSourcesRequest = typeof InboxSourcesRequest.Type;

export const InboxSourcesResponse = Schema.Struct({ output: Schema.String });
export type InboxSourcesResponse = typeof InboxSourcesResponse.Type;

export function encodeInboxSourcesRequest<Op extends InboxSourceOperation>(
  operation: Op,
  input: InboxSourceOperationInput<Op>,
): InboxSourcesRequest {
  const schema = INBOX_SOURCE_OPERATIONS[operation].input as unknown as Schema.Codec<unknown>;
  return { operation, input: Schema.encodeSync(Schema.fromJsonString(schema))(input) };
}

export function decodeInboxSourcesResponse<Op extends InboxSourceOperation>(
  operation: Op,
  response: InboxSourcesResponse,
): InboxSourceOperationOutput<Op> {
  const schema = INBOX_SOURCE_OPERATIONS[operation].output as unknown as Schema.Codec<unknown>;
  return Schema.decodeUnknownSync(Schema.fromJsonString(schema))(
    response.output,
  ) as InboxSourceOperationOutput<Op>;
}

/**
 * Browser-side settings `junkmail import-t3` staged from the official desktop app: localStorage
 * entries (theme, custom themes, layout), applied once per browser. Null when nothing is staged.
 */
export const InboxClientImportResult = Schema.Struct({ json: Schema.NullOr(Schema.String) });
export type InboxClientImportResult = typeof InboxClientImportResult.Type;

export const InboxClientImport = Schema.Struct({
  importedAt: Schema.String,
  entries: Schema.Record(Schema.String, Schema.String),
});
export type InboxClientImport = typeof InboxClientImport.Type;
