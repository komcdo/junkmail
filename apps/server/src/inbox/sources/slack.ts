/**
 * junkmail: the stock Slack puller. Every watch is a Slack search, so one user token with
 * `search:read` covers DMs, mentions, channels, and anything else the search box can express.
 */
import type { InboxCreateInput, SlackSourceSettings } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

export const SLACK_API = "https://slack.com/api";
/** Pages of 100 per watch per run; a busier watch catches up over the next runs. */
const MAX_PAGES_PER_WATCH = 5;
const TITLE_LENGTH = 90;

export interface SlackAccount {
  readonly teamId: string;
  readonly team: string;
  readonly userId: string;
  readonly user: string;
}

const SlackMatch = Schema.Struct({
  ts: Schema.String,
  text: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String),
  bot_id: Schema.optional(Schema.String),
  subtype: Schema.optional(Schema.String),
  permalink: Schema.optional(Schema.String),
  channel: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
      is_im: Schema.optional(Schema.Boolean),
      is_mpim: Schema.optional(Schema.Boolean),
    }),
  ),
});
export type SlackMatch = typeof SlackMatch.Type;

const SlackEnvelope = Schema.Struct({ ok: Schema.Boolean, error: Schema.optional(Schema.String) });
const AuthTestResponse = Schema.Struct({
  team_id: Schema.String,
  team: Schema.String,
  user_id: Schema.String,
  user: Schema.String,
});
const SearchResponse = Schema.Struct({
  messages: Schema.optional(
    Schema.Struct({
      matches: Schema.optional(Schema.Array(SlackMatch)),
      paging: Schema.optional(Schema.Struct({ pages: Schema.optional(Schema.Number) })),
    }),
  ),
});
const decodeEnvelope = Schema.decodeUnknownEffect(SlackEnvelope);
const decodeAuthTest = Schema.decodeUnknownEffect(AuthTestResponse);
const decodeSearch = Schema.decodeUnknownEffect(SearchResponse);

/** Per-watch high-water marks, as Slack message timestamps. */
export const SlackCursor = Schema.Struct({ watches: Schema.Record(Schema.String, Schema.String) });
export type SlackCursor = typeof SlackCursor.Type;

const AUTH_ERRORS = new Set([
  "not_authed",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "missing_scope",
  "not_allowed_token_type",
]);

const SLACK_ERROR_MESSAGES: Record<string, string> = {
  not_authed: "No Slack token is saved.",
  invalid_auth: "Slack rejected the token. Paste a fresh one.",
  token_revoked: "The Slack token was revoked. Paste a fresh one.",
  token_expired: "The Slack token expired. Paste a fresh one.",
  account_inactive: "The Slack account for this token is deactivated.",
  missing_scope: "The token lacks the search:read scope. Add it to the Slack app and reinstall.",
  not_allowed_token_type:
    "Search needs a user token (xoxp-…), not a bot token. Copy the User OAuth Token.",
  ratelimited: "Slack rate-limited the request; it retries automatically.",
  unreachable: "Could not reach Slack.",
};

export class SlackApiError extends Schema.TaggedError<SlackApiError>()("SlackApiError", {
  code: Schema.String,
  /** Seconds Slack asked us to wait, on a rate limit. */
  retryAfterSec: Schema.NullOr(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return SLACK_ERROR_MESSAGES[this.code] ?? `Slack returned "${this.code}".`;
  }

  get isAuthFailure() {
    return AUTH_ERRORS.has(this.code);
  }
}

const slackError = (code: string, cause?: unknown) =>
  new SlackApiError({ code, retryAfterSec: null, ...(cause === undefined ? {} : { cause }) });

const callSlack = (token: string, method: string, params: Record<string, string>) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.get(`${SLACK_API}/${method}`).pipe(
          HttpClientRequest.setUrlParams(params),
          HttpClientRequest.setHeaders({ Authorization: `Bearer ${token}` }),
        ),
      )
      .pipe(
        Effect.timeout("20 seconds"),
        Effect.mapError((cause) => slackError("unreachable", cause)),
      );
    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers["retry-after"] ?? "", 10);
      return yield* new SlackApiError({
        code: "ratelimited",
        retryAfterSec: Number.isFinite(retryAfter) ? retryAfter : 60,
      });
    }
    if (response.status >= 400) return yield* slackError(`http_${response.status}`);
    const body = yield* response.json.pipe(
      Effect.mapError((cause) => slackError("invalid_response", cause)),
    );
    const envelope = yield* decodeEnvelope(body).pipe(
      Effect.mapError((cause) => slackError("invalid_response", cause)),
    );
    if (!envelope.ok) return yield* slackError(envelope.error ?? "unknown_error");
    return body;
  });

export const slackAuthTest = (token: string) =>
  callSlack(token, "auth.test", {}).pipe(
    Effect.flatMap((body) =>
      decodeAuthTest(body).pipe(Effect.mapError((cause) => slackError("invalid_response", cause))),
    ),
    Effect.map((body): SlackAccount => ({
      teamId: body.team_id,
      team: body.team,
      userId: body.user_id,
      user: body.user,
    })),
  );

/** `@me` is the signed-in user; Slack search matches mentions written as `<@U…>`. */
export function expandSlackQuery(query: string, account: SlackAccount): string {
  return query.replace(/(^|\s)@me(?=\s|$)/g, `$1<@${account.userId}>`);
}

const isoOfMillis = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const isoOfTs = (ts: string) => isoOfMillis(Number.parseFloat(ts) * 1000);

/** Slack's `after:` is a whole day, exclusive, so ask for the day before and filter by ts. */
const afterDay = (sinceSec: number) => isoOfMillis((sinceSec - 86_400) * 1000).slice(0, 10);

const searchSince = (token: string, query: string, sinceTs: string) =>
  Effect.gen(function* () {
    const since = Number.parseFloat(sinceTs);
    const matches: SlackMatch[] = [];
    let latestTs = sinceTs;
    for (let page = 1; page <= MAX_PAGES_PER_WATCH; page++) {
      const body = yield* callSlack(token, "search.messages", {
        query: `${query} after:${afterDay(since)}`,
        sort: "timestamp",
        sort_dir: "desc",
        count: "100",
        page: String(page),
      }).pipe(
        Effect.flatMap((raw) =>
          decodeSearch(raw).pipe(Effect.mapError((cause) => slackError("invalid_response", cause))),
        ),
      );
      let reachedCursor = false;
      for (const match of body.messages?.matches ?? []) {
        if (Number.parseFloat(match.ts) <= since) {
          reachedCursor = true;
          continue;
        }
        matches.push(match);
        if (Number.parseFloat(match.ts) > Number.parseFloat(latestTs)) latestTs = match.ts;
      }
      if (reachedCursor || page >= (body.messages?.paging?.pages ?? 1)) break;
    }
    return { matches, latestTs };
  });

const decodeEntities = (text: string) =>
  text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

/** Slack mrkdwn to plain text: `<@U1|ann>` → @ann, `<#C1|eng>` → #eng, `<url|label>` → label (url). */
export function slackText(text: string): string {
  return decodeEntities(
    text.replace(/<([^<>]+)>/g, (_whole, inner: string) => {
      const [target = "", label] = inner.split("|");
      if (target.startsWith("@")) return `@${label ?? target.slice(1)}`;
      if (target.startsWith("#")) return `#${label ?? target.slice(1)}`;
      if (target.startsWith("!")) return `@${label ?? target.slice(1).split("^")[0]}`;
      return label === undefined || label === target ? target : `${label} (${target})`;
    }),
  ).trim();
}

function threadTsOf(match: SlackMatch): string | null {
  if (match.permalink === undefined || !URL.canParse(match.permalink)) return null;
  return new URL(match.permalink).searchParams.get("thread_ts");
}

function truncate(text: string, length: number) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= length ? line : `${line.slice(0, length - 1)}…`;
}

export type SlackItem = InboxCreateInput & { readonly watch: string };

/**
 * One item per conversation: a thread (root and replies share the root's ts), or a day of a
 * direct message, so a DM you dismissed does not swallow that person's messages forever.
 */
export function groupSlackMatches(input: {
  readonly account: SlackAccount;
  readonly settings: SlackSourceSettings;
  readonly matches: ReadonlyArray<{ readonly watch: string; readonly match: SlackMatch }>;
}): { readonly items: ReadonlyArray<SlackItem>; readonly filteredCount: number } {
  const { account, settings } = input;
  const groups = new Map<string, { watch: string; messages: SlackMatch[]; news: number }>();
  const seen = new Set<string>();
  let filteredCount = 0;
  for (const { watch, match } of input.matches) {
    const channelId = match.channel?.id;
    if (channelId === undefined) continue;
    // Two watches can match the same message.
    const messageKey = `${channelId}:${match.ts}`;
    if (seen.has(messageKey)) continue;
    seen.add(messageKey);
    if (settings.ignoreBots && (match.bot_id !== undefined || match.subtype === "bot_message")) {
      filteredCount++;
      continue;
    }
    const threadTs = threadTsOf(match);
    const direct = match.channel?.is_im === true || match.channel?.is_mpim === true;
    const key =
      threadTs !== null
        ? `${channelId}:${threadTs}`
        : direct
          ? `${channelId}:day:${isoOfTs(match.ts).slice(0, 10)}`
          : `${channelId}:${match.ts}`;
    const group = groups.get(key) ?? { watch, messages: [], news: 0 };
    group.messages.push(match);
    if (!(settings.ignoreOwnMessages && match.user === account.userId)) group.news++;
    groups.set(key, group);
  }

  const items: SlackItem[] = [];
  for (const [key, group] of groups) {
    // Your own messages ride along as context but never open an item on their own.
    if (group.news === 0) {
      filteredCount += group.messages.length;
      continue;
    }
    const ordered = group.messages.toSorted(
      (a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts),
    );
    const first = ordered[0]!;
    const where = first.channel?.is_im
      ? `DM from ${first.username ?? "someone"}`
      : first.channel?.is_mpim
        ? "Group DM"
        : `#${first.channel?.name ?? "channel"}`;
    items.push({
      watch: group.watch,
      title: truncate(`${where}: ${slackText(first.text ?? "") || "(no text)"}`, TITLE_LENGTH),
      url: first.permalink ?? null,
      origin: { kind: "slack", externalKey: `${account.teamId}:${key}` },
      createdBy: "source",
      labels: settings.labels,
      // A reply arriving alone must not rename the thread after itself.
      keepTitle: true,
      activity: ordered.map((match) => ({
        key: match.ts,
        kind: "message",
        author: match.username ?? match.user ?? null,
        body: slackText(match.text ?? ""),
        url: match.permalink ?? null,
        occurredAt: isoOfTs(match.ts),
      })),
    });
  }
  return { items, filteredCount };
}

export const pullSlack = (input: {
  readonly token: string;
  readonly settings: SlackSourceSettings;
  readonly cursor: SlackCursor | null;
}) =>
  Effect.gen(function* () {
    const account = yield* slackAuthTest(input.token);
    const nowSec = Math.floor((yield* Clock.currentTimeMillis) / 1000);
    const backfillTs = String(nowSec - input.settings.backfillDays * 86_400);
    const watches: Record<string, string> = {};
    const matches: Array<{ watch: string; match: SlackMatch }> = [];
    for (const watch of input.settings.watches) {
      if (!watch.enabled) continue;
      const query = expandSlackQuery(watch.query, account);
      // Keyed by the query, so editing a watch starts it fresh from the backfill window.
      const since = input.cursor?.watches[query] ?? backfillTs;
      const result = yield* searchSince(input.token, query, since);
      watches[query] = result.latestTs;
      for (const match of result.matches) matches.push({ watch: watch.name, match });
    }
    const cursor: SlackCursor = { watches };
    return {
      account,
      cursor,
      ...groupSlackMatches({ account, settings: input.settings, matches }),
    };
  });
