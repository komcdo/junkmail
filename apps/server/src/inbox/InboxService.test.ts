import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId, ThreadId, type InboxItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as InboxService from "./InboxService.ts";

const makeLayer = (launched: Ref.Ref<ReadonlyArray<string>>) =>
  InboxService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (input) =>
            Ref.update(launched, (texts) => [...texts, input.initialMessage?.text ?? ""]).pipe(
              Effect.as({
                threadId: ThreadId.make("thread-1"),
              } as ThreadLaunchService.ThreadLaunchResult),
            ),
        }),
        NodeCrypto.layer,
        SqlitePersistence.layerMemory,
      ),
    ),
  );

const withInbox = <A, E>(
  body: (
    inbox: InboxService.InboxService["Service"],
    launched: Ref.Ref<ReadonlyArray<string>>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const launched = yield* Ref.make<ReadonlyArray<string>>([]);
    return yield* Effect.gen(function* () {
      const inbox = yield* InboxService.InboxService;
      return yield* body(inbox, launched);
    }).pipe(Effect.provide(makeLayer(launched)));
  });

it.effect("re-delivering a source item refreshes content but keeps the user's triage", () =>
  withInbox((inbox) =>
    Effect.gen(function* () {
      const origin = { kind: "github", externalKey: "acme/api#12" };
      const { item } = yield* inbox.create({ title: "Review comment", origin });
      yield* inbox.update({ id: item.id, priority: 0, state: "waiting" });

      const { item: again } = yield* inbox.create({ title: "Review comment (edited)", origin });

      assert.strictEqual(again.id, item.id);
      assert.strictEqual(again.title, "Review comment (edited)");
      assert.strictEqual(again.priority, 0);
      assert.strictEqual(again.state, "waiting");
      assert.strictEqual((yield* inbox.list()).items.length, 1);
    }),
  ),
);

it.effect("a retried create with the same command id does not duplicate the item", () =>
  withInbox((inbox) =>
    Effect.gen(function* () {
      const commandId = CommandId.make("create-1");
      const first = yield* inbox.create({ commandId, title: "Write release notes" });
      const second = yield* inbox.create({ commandId, title: "Write release notes" });
      assert.strictEqual(second.item.id, first.item.id);
      assert.strictEqual((yield* inbox.list()).items.length, 1);
    }),
  ),
);

it.effect("closing records closedAt and reopening clears it", () =>
  withInbox((inbox) =>
    Effect.gen(function* () {
      const { item } = yield* inbox.create({ title: "Answer Slack thread" });
      const done = yield* inbox.update({ id: item.id, state: "done" });
      assert.isNotNull(done.item.closedAt);
      const reopened = yield* inbox.update({ id: item.id, state: "open" });
      assert.isNull(reopened.item.closedAt);
    }),
  ),
);

it.effect("reorder persists order keys", () =>
  withInbox((inbox) =>
    Effect.gen(function* () {
      const a = (yield* inbox.create({ title: "A" })).item;
      const b = (yield* inbox.create({ title: "B" })).item;
      yield* inbox.reorder({
        updates: [
          { id: b.id, orderKey: "g" },
          { id: a.id, orderKey: "n" },
        ],
      });
      const keys = new Map<InboxItemId, string | null>(
        (yield* inbox.list()).items.flatMap((item) =>
          item === undefined ? [] : [[item.id, item.orderKey] as const],
        ),
      );
      assert.strictEqual(keys.get(b.id), "g");
      assert.strictEqual(keys.get(a.id), "n");
    }),
  ),
);

it.effect("starting a thread sends the item as context, links it, and unsnoozes", () =>
  withInbox((inbox, launched) =>
    Effect.gen(function* () {
      const { item } = yield* inbox.create({
        title: "Fix flaky test",
        body: "CI failed twice on main.",
        url: "https://example.com/ci/1",
      });
      yield* inbox.update({ id: item.id, snoozedUntil: "2999-01-01T00:00:00.000Z" });

      const result = yield* inbox.startThread({
        id: item.id,
        projectId: ProjectId.make("project-1"),
        modelSelection: { instanceId: "claude", model: "claude-sonnet-5-5" } as never,
        runtimeMode: "full-access" as never,
        interactionMode: "default" as never,
        workspaceStrategy: { type: "root" },
        prompt: "Fix this.",
      });

      const [text] = yield* Ref.get(launched);
      assert.include(text, "Fix this.");
      assert.include(text, "CI failed twice on main.");
      assert.include(text, "https://example.com/ci/1");
      assert.deepStrictEqual(result.item.threadIds, [ThreadId.make("thread-1")]);
      assert.strictEqual(result.item.state, "in_progress");
      assert.isNull(result.item.snoozedUntil);
    }),
  ),
);

const comment = (n: number) => ({
  key: `comment-${n}`,
  kind: "comment",
  author: `reviewer-${n}`,
  body: `Comment ${n}`,
  occurredAt: `2026-10-17T10:0${n}:00.000Z`,
});

it.effect("groups every event from one source item and ignores re-delivered ones", () =>
  withInbox((inbox) =>
    Effect.gen(function* () {
      const origin = { kind: "github", externalKey: "acme/api#7" };
      const first = yield* inbox.create({
        title: "PR #7",
        origin,
        activity: [1, 2, 3].map(comment),
      });
      // A poll re-sends the whole history plus three new comments, one of them twice.
      const again = yield* inbox.create({
        title: "PR #7",
        origin,
        activity: [1, 2, 3, 4, 5, 6, 6].map(comment),
      });

      assert.strictEqual(first.created, true);
      assert.strictEqual(again.created, false);
      assert.strictEqual(again.addedActivity, 3);
      assert.strictEqual(again.item.activityCount, 6);
      assert.strictEqual(again.item.unseenActivityCount, 3);
      assert.strictEqual(again.item.lastActivity?.key, "comment-6");
      const { activity } = yield* inbox.listActivity({ id: first.item.id });
      assert.deepStrictEqual(
        activity.map((event) => event.key),
        [1, 2, 3, 4, 5, 6].map((n) => `comment-${n}`),
      );
      assert.strictEqual((yield* inbox.list()).items.length, 1);

      const seen = yield* inbox.update({ id: first.item.id, markSeen: true });
      assert.strictEqual(seen.item.unseenActivityCount, 0);
    }),
  ),
);

it.effect("news on a done or snoozed item brings it back; a dismissed one stays dismissed", () =>
  withInbox((inbox) =>
    Effect.gen(function* () {
      const done = { kind: "slack", externalKey: "C1/1" };
      const snoozed = { kind: "slack", externalKey: "C1/2" };
      const dismissed = { kind: "slack", externalKey: "C1/3" };
      const a = yield* inbox.create({ title: "a", origin: done });
      const b = yield* inbox.create({ title: "b", origin: snoozed });
      const c = yield* inbox.create({ title: "c", origin: dismissed });
      yield* inbox.update({ id: a.item.id, state: "done" });
      yield* inbox.update({ id: b.item.id, snoozedUntil: "2099-01-01T00:00:00.000Z" });
      yield* inbox.update({ id: c.item.id, state: "dismissed" });

      const reply = [
        { key: "m1", kind: "message", body: "any update?", occurredAt: "2026-10-17T12:00:00.000Z" },
      ];
      const woke = yield* inbox.create({ title: "a", origin: done, activity: reply });
      const unsnoozed = yield* inbox.create({ title: "b", origin: snoozed, activity: reply });
      const ignored = yield* inbox.create({ title: "c", origin: dismissed, activity: reply });
      // Re-delivery with nothing new changes no triage.
      yield* inbox.update({ id: a.item.id, state: "done" });
      const quiet = yield* inbox.create({ title: "a", origin: done, activity: reply });

      assert.strictEqual(woke.item.state, "open");
      assert.strictEqual(woke.item.closedAt, null);
      assert.strictEqual(unsnoozed.item.snoozedUntil, null);
      assert.strictEqual(ignored.item.state, "dismissed");
      assert.strictEqual(ignored.item.unseenActivityCount, 1);
      assert.strictEqual(quiet.item.state, "done");
    }),
  ),
);

it.effect("labels merge case-insensitively and a source never removes the user's labels", () =>
  withInbox((inbox) =>
    Effect.gen(function* () {
      const origin = { kind: "jira", externalKey: "ENG-1" };
      const { item } = yield* inbox.create({ title: "t", origin, labels: ["backend", "Backend"] });
      yield* inbox.update({ id: item.id, labels: ["backend", "urgent-fix"] });
      const again = yield* inbox.create({ title: "t", origin, labels: ["BACKEND", "q4"] });
      assert.deepStrictEqual(again.item.labels, ["backend", "urgent-fix", "q4"]);
    }),
  ),
);

it.effect("search finds items by any event's text, not just the latest", () =>
  withInbox((inbox) =>
    Effect.gen(function* () {
      const { item } = yield* inbox.create({
        title: "PR #9",
        origin: { kind: "github", externalKey: "acme/api#9" },
        activity: [1, 2, 3].map(comment),
      });
      yield* inbox.create({ title: "unrelated", activity: [{ ...comment(1), body: "100%_off" }] });
      assert.deepStrictEqual((yield* inbox.search({ query: "comment 1" })).ids, [item.id]);
      assert.strictEqual((yield* inbox.search({ query: "100%_" })).ids.length, 1);
      assert.strictEqual((yield* inbox.search({ query: "0%x" })).ids.length, 0);
    }),
  ),
);
