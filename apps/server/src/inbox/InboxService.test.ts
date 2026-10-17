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
