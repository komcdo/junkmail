import { EnvironmentId, InboxItemId, type InboxItem } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyInboxOrderUpdates,
  inboxEntryKey,
  inboxItemView,
  nextInboxWakeMs,
  planInboxReorder,
  selectInboxView,
  type InboxEntry,
} from "./inbox.ts";

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");

function entry(
  id: string,
  overrides: Partial<InboxItem> = {},
  environmentId: EnvironmentId = local,
): InboxEntry {
  return {
    environmentId,
    item: {
      id: InboxItemId.make(id),
      title: id,
      body: null,
      state: "open",
      priority: 4,
      orderKey: null,
      snoozedUntil: null,
      origin: { kind: "manual", externalKey: null, url: null },
      projectId: null,
      threadIds: [],
      worktreePath: null,
      branch: null,
      pullRequestUrls: [],
      createdBy: "user",
      createdAt: "2026-10-16T10:00:00.000Z",
      updatedAt: "2026-10-16T10:00:00.000Z",
      closedAt: null,
      ...overrides,
    },
  };
}

describe("inboxItemView", () => {
  it("hides snoozed open work until it wakes", () => {
    const item = entry("a", { snoozedUntil: "2026-10-16T13:00:00.000Z" }).item;
    expect(inboxItemView(item, NOW)).toBe("snoozed");
    expect(inboxItemView(item, Date.parse("2026-10-16T13:00:01.000Z"))).toBe("inbox");
  });

  it("ignores a snooze left on a closed item", () => {
    const item = entry("a", { state: "done", snoozedUntil: "2026-10-17T00:00:00.000Z" }).item;
    expect(inboxItemView(item, NOW)).toBe("done");
  });
});

describe("selectInboxView", () => {
  it("puts never-dragged items first, newest first, then the manual order", () => {
    const entries = [
      entry("keyed-late", { orderKey: "t" }),
      entry("keyed-early", { orderKey: "c" }, remote),
      entry("new-old", { createdAt: "2026-10-16T09:00:00.000Z" }),
      entry("new-recent", { createdAt: "2026-10-16T11:00:00.000Z" }),
    ];
    expect(selectInboxView(entries, "inbox", NOW).map((e) => e.item.id)).toEqual([
      "new-recent",
      "new-old",
      "keyed-early",
      "keyed-late",
    ]);
  });
});

describe("planInboxReorder", () => {
  it("writes one key when the neighbors already have keys", () => {
    const entries = [entry("a", { orderKey: "g" }), entry("b", { orderKey: "n" }, remote)];
    const moved = entry("c", { orderKey: "t" });
    const all = [...entries, moved];
    const plan = planInboxReorder({
      entries: all,
      orderedKeys: [inboxEntryKey(entries[0]!), inboxEntryKey(moved), inboxEntryKey(entries[1]!)],
      movedKey: inboxEntryKey(moved),
    });
    expect(plan).toHaveLength(1);
    expect(plan[0]!.environmentId).toBe(local);
    const key = plan[0]!.updates[0]!.orderKey;
    expect(key > "g" && key < "n").toBe(true);
  });

  it("spreads keys over the visible items, grouped by environment, when items have none", () => {
    const entries = [entry("a"), entry("b", {}, remote), entry("c")];
    const ordered = [entries[2]!, entries[0]!, entries[1]!].map(inboxEntryKey);
    const plan = planInboxReorder({ entries, orderedKeys: ordered, movedKey: ordered[0]! });
    const applied = applyInboxOrderUpdates(entries, plan);
    expect(selectInboxView(applied, "inbox", NOW).map(inboxEntryKey)).toEqual(ordered);
    expect(plan.map((group) => group.environmentId).sort()).toEqual([local, remote]);
  });

  it("never reuses a key held by an item hidden from the current view", () => {
    const hidden = entry("hidden", { state: "waiting", orderKey: "n" });
    const a = entry("a", { orderKey: "g" });
    const b = entry("b", { orderKey: "t" });
    const plan = planInboxReorder({
      entries: [a, b, hidden],
      orderedKeys: [inboxEntryKey(a), inboxEntryKey(b)].reverse(),
      movedKey: inboxEntryKey(b),
    });
    const keys = plan.flatMap((group) => group.updates.map((update) => update.orderKey));
    expect(keys).not.toContain("n");
  });
});

describe("nextInboxWakeMs", () => {
  it("returns the earliest future wake of open items", () => {
    const entries = [
      entry("a", { snoozedUntil: "2026-10-16T15:00:00.000Z" }),
      entry("b", { snoozedUntil: "2026-10-16T13:00:00.000Z" }),
      entry("c", { state: "done", snoozedUntil: "2026-10-16T12:30:00.000Z" }),
    ];
    expect(nextInboxWakeMs(entries, NOW)).toBe(Date.parse("2026-10-16T13:00:00.000Z"));
  });
});
