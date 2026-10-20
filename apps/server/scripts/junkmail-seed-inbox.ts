// @effect-diagnostics nodeBuiltinImport:off globalConsole:off globalDate:off - A dev seeding script that runs outside the server and stamps fixture times.
// junkmail: fills a dev database with realistic inbox items, as pullers would deliver them.
//
//   node apps/server/scripts/junkmail-seed-inbox.ts [--db <statev2.sqlite>] [--phase initial|updates]
//
// `initial` files a spread of GitHub, Slack, Jira, Gmail, Reddit, Twitter, and manual items.
// `updates` re-delivers some of them with their old events plus new ones, the way a poller
// does, to exercise grouping, de-duplication, and the "new activity" marker.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type { InboxActivityInput, InboxCreateInput, InboxItemState } from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";

import * as ServerSecretStore from "../src/auth/ServerSecretStore.ts";
import * as InboxService from "../src/inbox/InboxService.ts";
import * as ThreadLaunchService from "../src/orchestration-v2/ThreadLaunchService.ts";
import * as SqlitePersistence from "../src/persistence/Sqlite.ts";
import * as Scheduler from "../src/scheduling/Scheduler.ts";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../..",
);
const args = process.argv.slice(2);
const flag = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};
const dbPath = NodePath.resolve(
  flag("db") ?? NodePath.join(repoRoot, ".t3/userdata/statev2.sqlite"),
);
const phase = flag("phase") ?? "initial";

// Never write to the live install; this script is for isolated dev state only.
const liveUserdata = NodePath.join(NodeOS.homedir(), ".t3/userdata");
if (dbPath.startsWith(liveUserdata + NodePath.sep)) {
  console.error(`Refusing to seed the live database at ${dbPath}.`);
  process.exit(1);
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

const PR_ORIGIN = { kind: "github", externalKey: "acme/api#482" };
const PR_URL = "https://github.com/acme/api/pull/482";
const prComments: InboxActivityInput[] = [
  ["maya", "Can we make the limit configurable per API key? Enterprise keys need more headroom."],
  [
    "devon",
    "The Redis call happens before auth. An unauthenticated client can still burn a lookup.",
  ],
  ["maya", "Nit: `RATE_WINDOW_MS` reads better than `WINDOW`."],
  ["sam", "Do we have a test for the 429 response body? Clients parse `retryAfter`."],
  [
    "devon",
    "Suggest a sliding window instead of fixed buckets; fixed buckets let 2x through at the boundary.",
  ],
  [
    "priya",
    "Looks good otherwise. Please add a CHANGELOG entry since this changes public behaviour.",
  ],
].map(([author, body], index) => ({
  key: `review-comment-${9001 + index}`,
  kind: "comment",
  author,
  body: body!,
  url: `${PR_URL}#discussion_r${9001 + index}`,
  occurredAt: minutesAgo(300 - index * 35),
}));

const SLACK_ORIGIN = { kind: "slack", externalKey: "C042DEPLOYS/1729170000.000100" };
const slackMessages: InboxActivityInput[] = [
  {
    key: "1729170000.000100",
    kind: "message",
    author: "jordan",
    body: "Are we freezing deploys Friday for the launch? Need a yes/no from eng by EOD.",
    occurredAt: minutesAgo(95),
  },
  {
    key: "1729170420.000200",
    kind: "message",
    author: "alex",
    body: "+1, marketing wants the site stable from Thursday night.",
    occurredAt: minutesAgo(88),
  },
];

const DONE_ORIGIN = { kind: "slack", externalKey: "C01SECURITY/1729000000.000300" };
const SNOOZED_ORIGIN = { kind: "gmail", externalKey: "thread-18f2c9a" };
const DISMISSED_ORIGIN = { kind: "gmail", externalKey: "thread-newsletter-42" };
const JIRA_ORIGIN = { kind: "jira", externalKey: "ENG-1312" };

interface Seed {
  readonly input: InboxCreateInput;
  readonly state?: InboxItemState;
  readonly snoozedUntil?: string;
  readonly branch?: string;
  readonly pullRequestUrls?: ReadonlyArray<string>;
}

const initial: ReadonlyArray<Seed> = [
  {
    input: {
      title: "Review: Add rate limiting to /v2/search (#482)",
      body: "Devon and Maya asked for changes. Needs a decision on sliding vs fixed windows.",
      origin: PR_ORIGIN,
      url: PR_URL,
      priority: 1,
      labels: ["backend", "needs-review"],
      activity: prComments,
      createdBy: "source",
    },
    branch: "feat/search-rate-limit",
    pullRequestUrls: [PR_URL],
  },
  {
    input: {
      title: "#deploys: Deploy freeze for Friday's launch?",
      origin: SLACK_ORIGIN,
      url: "https://acme.slack.com/archives/C042DEPLOYS/p1729170000000100",
      priority: 1,
      labels: ["ops"],
      activity: slackMessages,
      createdBy: "source",
    },
  },
  {
    input: {
      title: "ENG-1312 Checkout page times out on Safari 17",
      body: "Repro: add 3+ items, apply a coupon, click Pay. Spinner never resolves on Safari 17.4.",
      origin: JIRA_ORIGIN,
      url: "https://acme.atlassian.net/browse/ENG-1312",
      priority: 0,
      labels: ["bug", "frontend"],
      activity: [
        {
          key: "ENG-1312-created",
          kind: "created",
          author: "support-bot",
          body: "Reported by 14 customers in the last 24h.",
          occurredAt: minutesAgo(600),
        },
      ],
      createdBy: "source",
    },
  },
  {
    input: {
      title: "Invoice from Vercel: October usage ($412.80)",
      origin: { kind: "gmail", externalKey: "thread-18f2b11" },
      priority: 3,
      labels: ["billing"],
      createdBy: "source",
    },
  },
  {
    input: {
      title: "acme/web#77 Dark mode toggle flickers on first load",
      origin: { kind: "github", externalKey: "acme/web#77" },
      url: "https://github.com/acme/web/issues/77",
      priority: 2,
      labels: ["frontend", "good-first-issue"],
      activity: [
        {
          key: "issue-77-comment-1",
          kind: "comment",
          author: "lee",
          body: "Happens because the theme class is applied after hydration. Needs an inline script in <head>.",
          occurredAt: minutesAgo(1440),
        },
      ],
      createdBy: "source",
    },
  },
  {
    input: {
      title: "r/typescript: someone asked how junkmail pullers work",
      origin: { kind: "reddit", externalKey: "t3_1g5x9qz" },
      url: "https://reddit.com/r/typescript/comments/1g5x9qz",
      labels: ["community"],
      createdBy: "source",
    },
  },
  {
    input: {
      title: '@vercel replied: "Edge config limits are per project"',
      origin: { kind: "twitter", externalKey: "1846912345678901234" },
      priority: 3,
      labels: ["community"],
      createdBy: "source",
    },
  },
  {
    input: { title: "Write the Q4 planning doc", priority: 2, labels: ["planning"] },
    state: "in_progress",
  },
  {
    input: {
      title: "Priya: can you look at the flaky checkout e2e test?",
      origin: { kind: "slack", externalKey: "D07PRIYA/1729160000.000500" },
      priority: 1,
      labels: ["testing"],
      activity: [
        {
          key: "1729160000.000500",
          kind: "message",
          author: "priya",
          body: "checkout.spec.ts fails ~1 in 5 on CI. Waiting on your call before I quarantine it.",
          occurredAt: minutesAgo(240),
        },
      ],
      createdBy: "source",
    },
    state: "waiting",
  },
  {
    input: {
      title: "Rotate staging database credentials",
      origin: DONE_ORIGIN,
      labels: ["ops", "security"],
      activity: [
        {
          key: "1729000000.000300",
          kind: "message",
          author: "sec-bot",
          body: "Quarterly rotation due for staging-db.",
          occurredAt: minutesAgo(3000),
        },
      ],
      createdBy: "source",
    },
    state: "done",
  },
  {
    input: {
      title: "Design: onboarding checklist feedback",
      origin: SNOOZED_ORIGIN,
      labels: ["design"],
      createdBy: "source",
    },
    snoozedUntil: hoursFromNow(20),
  },
  {
    input: {
      title: "Newsletter: This week in React #208",
      origin: DISMISSED_ORIGIN,
      priority: 4,
      createdBy: "source",
    },
    state: "dismissed",
  },
];

const updates: ReadonlyArray<InboxCreateInput> = [
  // The poller re-sends both old messages (duplicates) and two new replies.
  {
    title: "#deploys: Deploy freeze for Friday's launch?",
    origin: SLACK_ORIGIN,
    activity: [
      ...slackMessages,
      {
        key: "1729171800.000300",
        kind: "message",
        author: "jordan",
        body: "Bumping this, need an answer in the next hour.",
        occurredAt: minutesAgo(10),
      },
      {
        key: "1729171900.000400",
        kind: "message",
        author: "riley",
        body: "If we freeze, the search rate limiting PR has to land Thursday.",
        occurredAt: minutesAgo(8),
      },
    ],
  },
  // All six old comments again, plus an approval.
  {
    title: "Review: Add rate limiting to /v2/search (#482)",
    origin: PR_ORIGIN,
    url: PR_URL,
    activity: [
      ...prComments,
      {
        key: "review-approved-1",
        kind: "review",
        author: "priya",
        body: "Approved with the CHANGELOG nit.",
        url: `${PR_URL}#pullrequestreview-1`,
        occurredAt: minutesAgo(3),
      },
    ],
  },
  // News on a done item reopens it; on a snoozed one, wakes it; a dismissed one stays put.
  {
    title: "Rotate staging database credentials",
    origin: DONE_ORIGIN,
    activity: [
      {
        key: "1729172000.000900",
        kind: "message",
        author: "sec-bot",
        body: "The new staging credentials failed the health check. Rollback needed.",
        occurredAt: minutesAgo(5),
      },
    ],
  },
  {
    title: "Design: onboarding checklist feedback",
    origin: SNOOZED_ORIGIN,
    activity: [
      {
        key: "msg-18f2c9a-2",
        kind: "email",
        author: "noor@acme.design",
        body: "Updated mocks attached. We need your sign-off before Monday's sprint planning.",
        occurredAt: minutesAgo(6),
      },
    ],
  },
  {
    title: "Newsletter: This week in React #208",
    origin: DISMISSED_ORIGIN,
    activity: [
      {
        key: "newsletter-208-reminder",
        kind: "email",
        author: "newsletter",
        body: "You haven't opened this week's issue.",
        occurredAt: minutesAgo(7),
      },
    ],
  },
  // The same Jira ticket delivered twice, once with a new label: still one item.
  {
    title: "ENG-1312 Checkout page times out on Safari 17",
    origin: JIRA_ORIGIN,
    labels: ["regression"],
  },
  {
    title: "ENG-1312 Checkout page times out on Safari 17",
    origin: JIRA_ORIGIN,
    labels: ["regression"],
  },
];

const program = Effect.gen(function* () {
  const inbox = yield* InboxService.InboxService;
  if (phase === "initial") {
    for (const seed of initial) {
      const { item } = yield* inbox.create(seed.input);
      if (seed.state || seed.snoozedUntil || seed.branch || seed.pullRequestUrls) {
        yield* inbox.update({
          id: item.id,
          ...(seed.state ? { state: seed.state } : {}),
          ...(seed.snoozedUntil ? { snoozedUntil: seed.snoozedUntil } : {}),
          ...(seed.branch ? { branch: seed.branch } : {}),
          ...(seed.pullRequestUrls ? { pullRequestUrls: seed.pullRequestUrls } : {}),
        });
      }
      yield* Console.log(`filed   ${item.title}`);
    }
  } else if (phase === "updates") {
    for (const input of updates) {
      const result = yield* inbox.create(input);
      yield* Console.log(
        `${result.created ? "created" : "updated"} ${result.item.title}  +${result.addedActivity ?? 0} new, ${result.item.state}`,
      );
    }
  } else {
    return yield* Effect.die(`Unknown phase ${phase}; use initial or updates.`);
  }
  const { items } = yield* inbox.list();
  yield* Console.log(`\n${items.length} items in ${dbPath}`);
});

// Seeding never starts threads, so the launcher is a stub.
const layer = InboxService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
      // Seeding writes items directly; no puller runs.
      Layer.mock(Scheduler.Scheduler)({ register: () => Effect.void }),
      Layer.mock(ServerSecretStore.ServerSecretStore)({}),
      FetchHttpClient.layer,
      NodeCrypto.layer,
      SqlitePersistence.layerFromPath(dbPath),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

await Effect.runPromise(program.pipe(Effect.provide(layer)));
