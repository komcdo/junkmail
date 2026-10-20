import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  decodeInboxSourcesResponse,
  defaultSlackSourceSettings,
  encodeInboxSourcesRequest,
  type InboxSourceId,
  type InboxSourceOperation,
  type InboxSourceOperationInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as InboxService from "./InboxService.ts";
import { expandSlackQuery, slackText } from "./sources/slack.ts";

const ME = "U_ME";
// it.effect runs on a test clock; every test pins it here.
const NOW_MS = 1_792_000_000_000;
const nowSec = NOW_MS / 1000;
const ts = (secondsAgo: number, fraction = "000100") => `${nowSec - secondsAgo}.${fraction}`;

interface FakeSlack {
  auth: "ok" | "invalid_auth";
  rateLimited: boolean;
  /** Matches returned for a query containing the key. */
  search: Record<string, ReadonlyArray<Record<string, unknown>>>;
  queries: string[];
}

const fakeSlackClient = (slack: FakeSlack) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), {
            status,
            headers: { "content-type": "application/json", ...headers },
          }),
        );
      if (slack.rateLimited) return json({ ok: false }, 429, { "retry-after": "120" });
      if (slack.auth !== "ok") return json({ ok: false, error: slack.auth });
      if (request.url.endsWith("/auth.test")) {
        return json({ ok: true, team_id: "T1", team: "Acme", user_id: ME, user: "me" });
      }
      const query = Option.getOrElse(UrlParams.getFirst(request.urlParams, "query"), () => "");
      slack.queries.push(query);
      const key = Object.keys(slack.search).find((candidate) => query.includes(candidate));
      const matches = key === undefined ? [] : slack.search[key];
      return json({ ok: true, messages: { matches, paging: { pages: 1 } } });
    }),
  );

const makeLayer = (slack: FakeSlack) => {
  const secrets = new Map<string, Uint8Array>();
  return InboxService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        // Runs are driven by hand here; the scheduler only needs to accept the registration.
        Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: (name) => Effect.succeed(Option.fromNullishOr(secrets.get(name))),
          set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
          remove: (name) => Effect.sync(() => void secrets.delete(name)),
        }),
        Layer.succeed(HttpClient.HttpClient, fakeSlackClient(slack)),
        NodeCrypto.layer,
        SqlitePersistence.layerMemory,
      ),
    ),
  );
};

const call = <Op extends InboxSourceOperation>(
  inbox: InboxService.InboxService["Service"],
  operation: Op,
  input: InboxSourceOperationInput<Op>,
) =>
  inbox
    .sources(encodeInboxSourcesRequest(operation, input))
    .pipe(Effect.map((response) => decodeInboxSourcesResponse(operation, response)));

const withSlack = <A, E>(
  slack: FakeSlack,
  body: (inbox: InboxService.InboxService["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW_MS);
    return yield* body(yield* InboxService.InboxService);
  }).pipe(Effect.provide(makeLayer(slack)));

const newSlack = (search: FakeSlack["search"] = {}): FakeSlack => ({
  auth: "ok",
  rateLimited: false,
  search,
  queries: [],
});

const addSource = (inbox: InboxService.InboxService["Service"]) =>
  call(inbox, "save", {
    kind: "slack",
    name: "Acme Slack",
    enabled: true,
    settings: defaultSlackSourceSettings(),
    token: "xoxp-test",
  }).pipe(Effect.map(({ source }) => source.id as InboxSourceId));

const dm = (secondsAgo: number, text: string, user = "U_ANN") => ({
  ts: ts(secondsAgo),
  text,
  user,
  username: user === ME ? "me" : "ann",
  permalink: `https://acme.slack.com/archives/D1/p${secondsAgo}`,
  channel: { id: "D1", name: "U_ANN", is_im: true },
});

const threadReply = (secondsAgo: number, rootSecondsAgo: number, text: string) => ({
  ts: ts(secondsAgo),
  text,
  user: "U_BOB",
  username: "bob",
  permalink: `https://acme.slack.com/archives/C1/p${secondsAgo}?thread_ts=${ts(rootSecondsAgo)}`,
  channel: { id: "C1", name: "eng" },
});

it.effect("saving checks the token, which never comes back over the wire", () =>
  withSlack(newSlack(), (inbox) =>
    Effect.gen(function* () {
      yield* addSource(inbox);
      const { sources } = yield* call(inbox, "list", {});
      assert.strictEqual(sources.length, 1);
      assert.strictEqual(sources[0]?.hasToken, true);
      assert.deepStrictEqual(sources[0]?.account, { team: "Acme", user: "me" });
      assert.notInclude(JSON.stringify(sources), "xoxp-test");
    }),
  ),
);

it.effect("a rejected token is reported and not saved", () =>
  withSlack({ ...newSlack(), auth: "invalid_auth" }, (inbox) =>
    Effect.gen(function* () {
      const failure = yield* addSource(inbox).pipe(Effect.flip);
      assert.include(failure.message, "rejected the token");
      const { sources } = yield* call(inbox, "list", {});
      assert.strictEqual(sources.length, 0);
    }),
  ),
);

it.effect(
  "groups DMs by day and thread replies by thread, skipping bots and lone own messages",
  () => {
    const slack = newSlack({
      "to:me": [
        dm(300, "Can you look at <https://x.dev/pr/1|the PR>?"),
        dm(200, "Also &lt;urgent&gt;"),
        dm(100, "ok on it", ME),
      ],
      [`<@${ME}>`]: [
        threadReply(250, 400, `<@${ME}|me> thoughts on the migration?`),
        { ...threadReply(240, 400, "deploy finished"), bot_id: "B1", user: undefined },
        // A reply you wrote in a thread nobody else touched opens nothing.
        { ...threadReply(230, 900, "note to self"), user: ME, username: "me" },
      ],
    });
    return withSlack(slack, (inbox) =>
      Effect.gen(function* () {
        const id = yield* addSource(inbox);
        const { source } = yield* call(inbox, "run", { id });
        assert.strictEqual(source.status, "idle");
        assert.strictEqual(source.lastRunItemCount, 2);
        assert.isTrue(slack.queries.some((query) => query.startsWith(`<@${ME}> after:`)));

        const { items } = yield* inbox.list();
        const direct = items.find((item) => item.title.startsWith("DM from ann"));
        assert.strictEqual(
          direct?.title,
          "DM from ann: Can you look at the PR (https://x.dev/pr/1)?",
        );
        assert.strictEqual(direct?.activityCount, 3);
        assert.deepStrictEqual(direct?.labels, ["slack"]);
        assert.strictEqual(direct?.createdBy, "source");
        const thread = items.find((item) => item.title.startsWith("#eng"));
        assert.strictEqual(thread?.title, "#eng: @me thoughts on the migration?");
        assert.strictEqual(thread?.activityCount, 1);
        assert.strictEqual(thread?.origin.externalKey, `T1:C1:${ts(400)}`);
        assert.strictEqual(items.length, 2);
      }),
    );
  },
);

it.effect("a later reply joins the thread's item as news and keeps its title", () => {
  const slack = newSlack({ [`<@${ME}>`]: [threadReply(250, 400, "first question")] });
  return withSlack(slack, (inbox) =>
    Effect.gen(function* () {
      const id = yield* addSource(inbox);
      yield* call(inbox, "run", { id });
      slack.search[`<@${ME}>`] = [
        threadReply(50, 400, "following up"),
        threadReply(250, 400, "first question"),
      ];
      yield* call(inbox, "run", { id });
      const [item] = (yield* inbox.list()).items;
      assert.strictEqual(item?.title, "#eng: first question");
      assert.strictEqual(item?.activityCount, 2);
      assert.strictEqual(item?.unseenActivityCount, 1);
      assert.strictEqual(item?.lastActivity?.body, "following up");
    }),
  );
});

it.effect("a revoked token stops the source until a new one is saved", () => {
  const slack = newSlack();
  return withSlack(slack, (inbox) =>
    Effect.gen(function* () {
      const id = yield* addSource(inbox);
      slack.auth = "invalid_auth";
      const { source } = yield* call(inbox, "run", { id });
      assert.strictEqual(source.status, "auth_required");
      assert.isNull(source.nextRunAt);
      assert.include(source.lastError ?? "", "rejected the token");
    }),
  );
});

it.effect("a rate limit waits at least as long as Slack asks", () => {
  const slack = newSlack();
  return withSlack(slack, (inbox) =>
    Effect.gen(function* () {
      const id = yield* addSource(inbox);
      slack.rateLimited = true;
      const { source } = yield* call(inbox, "run", { id });
      assert.strictEqual(source.status, "error");
      const waitMs = Date.parse(source.nextRunAt ?? "") - NOW_MS;
      assert.isAbove(waitMs, 4 * 60_000);
    }),
  );
});

it.effect("preview shows what would be filed without filing it", () => {
  const slack = newSlack({ "to:me": [dm(100, "lunch?")] });
  return withSlack(slack, (inbox) =>
    Effect.gen(function* () {
      const id = yield* addSource(inbox);
      const preview = yield* call(inbox, "preview", { id });
      assert.deepStrictEqual(
        preview.items.map((item) => [item.title, item.watch, item.messageCount]),
        [["DM from ann: lunch?", "Direct messages", 1]],
      );
      assert.strictEqual((yield* inbox.list()).items.length, 0);
    }),
  );
});

it("turns Slack markup into plain text and @me into a mention", () => {
  assert.strictEqual(
    slackText("<@U1|ann> see <#C2|eng> and <https://a.dev> &amp; <!here>"),
    "@ann see #eng and https://a.dev & @here",
  );
  const account = { teamId: "T", team: "t", userId: "U9", user: "me" };
  assert.strictEqual(expandSlackQuery("@me in:#eng", account), "<@U9> in:#eng");
  assert.strictEqual(expandSlackQuery("to:me", account), "to:me");
});
