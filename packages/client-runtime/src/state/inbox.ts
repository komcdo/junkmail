import type { EnvironmentId, InboxItem, InboxItemId } from "@t3tools/contracts";

import { planPinnedReorder } from "./threadSort.ts";

/** An inbox item and the environment that owns it; the client merges every connected inbox. */
export interface InboxEntry {
  readonly environmentId: EnvironmentId;
  readonly item: InboxItem;
}

export type InboxView = "inbox" | "in_progress" | "waiting" | "snoozed" | "done" | "dismissed";

export const INBOX_VIEWS: ReadonlyArray<{ readonly id: InboxView; readonly label: string }> = [
  { id: "inbox", label: "Inbox" },
  { id: "in_progress", label: "In progress" },
  { id: "waiting", label: "Waiting" },
  { id: "snoozed", label: "Snoozed" },
  { id: "done", label: "Done" },
  { id: "dismissed", label: "Dismissed" },
];

export const INBOX_PRIORITY_LABELS = ["Urgent", "High", "Medium", "Low", "None"] as const;

export function inboxEntryKey(entry: InboxEntry): string {
  return `${entry.environmentId}:${entry.item.id}`;
}

export function isInboxItemSnoozed(item: InboxItem, nowMs: number): boolean {
  if (item.snoozedUntil === null) return false;
  const wake = Date.parse(item.snoozedUntil);
  return Number.isFinite(wake) && wake > nowMs;
}

/** Snoozed open work shows only under Snoozed; closed items ignore a leftover snooze. */
export function inboxItemView(item: InboxItem, nowMs: number): InboxView {
  if (item.state === "done" || item.state === "dismissed") return item.state;
  if (isInboxItemSnoozed(item, nowMs)) return "snoozed";
  if (item.state === "open") return "inbox";
  return item.state;
}

/**
 * Manual order first: keyless items (new, never dragged) on top, newest first; then keyed
 * items by key. Keys are plain strings, so items from different environments interleave.
 */
export function sortInboxEntries(entries: ReadonlyArray<InboxEntry>): InboxEntry[] {
  return [...entries].sort((left, right) => {
    const a = left.item;
    const b = right.item;
    if (a.orderKey === null || b.orderKey === null) {
      if (a.orderKey !== b.orderKey) return a.orderKey === null ? -1 : 1;
      return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
    }
    if (a.orderKey !== b.orderKey) return a.orderKey < b.orderKey ? -1 : 1;
    return inboxEntryKey(left).localeCompare(inboxEntryKey(right));
  });
}

export function sortInboxEntriesByPriority(entries: ReadonlyArray<InboxEntry>): InboxEntry[] {
  return sortInboxEntries(entries).sort((a, b) => a.item.priority - b.item.priority);
}

export function selectInboxView(
  entries: ReadonlyArray<InboxEntry>,
  view: InboxView,
  nowMs: number,
): InboxEntry[] {
  const visible = entries.filter((entry) => inboxItemView(entry.item, nowMs) === view);
  if (view === "done" || view === "dismissed") {
    return visible.sort((a, b) => (b.item.closedAt ?? "").localeCompare(a.item.closedAt ?? ""));
  }
  if (view === "snoozed") {
    return visible.sort((a, b) =>
      (a.item.snoozedUntil ?? "").localeCompare(b.item.snoozedUntil ?? ""),
    );
  }
  return sortInboxEntries(visible);
}

export function countInboxView(
  entries: ReadonlyArray<InboxEntry>,
  view: InboxView,
  nowMs: number,
): number {
  return entries.reduce(
    (count, entry) => count + (inboxItemView(entry.item, nowMs) === view ? 1 : 0),
    0,
  );
}

/** Earliest future snooze wake, so a view can re-render exactly when an item returns. */
export function nextInboxWakeMs(entries: ReadonlyArray<InboxEntry>, nowMs: number): number | null {
  let next: number | null = null;
  for (const { item } of entries) {
    if (item.state === "done" || item.state === "dismissed" || item.snoozedUntil === null) continue;
    const wake = Date.parse(item.snoozedUntil);
    if (Number.isFinite(wake) && wake > nowMs && (next === null || wake < next)) next = wake;
  }
  return next;
}

export interface InboxOrderUpdate {
  readonly environmentId: EnvironmentId;
  readonly updates: ReadonlyArray<{ readonly id: InboxItemId; readonly orderKey: string }>;
}

/**
 * Order keys after moving one entry, grouped by owning environment. `orderedKeys` is the
 * visible order with the move applied; hidden items keep their keys and are never rewritten.
 */
export function planInboxReorder(input: {
  readonly entries: ReadonlyArray<InboxEntry>;
  readonly orderedKeys: ReadonlyArray<string>;
  readonly movedKey: string;
}): InboxOrderUpdate[] {
  const byKey = new Map(input.entries.map((entry) => [inboxEntryKey(entry), entry]));
  const keysById = new Map(
    input.entries.map((entry) => [inboxEntryKey(entry), entry.item.orderKey]),
  );
  const writes = planPinnedReorder({
    orderedIds: input.orderedKeys,
    keysById,
    movedId: input.movedKey,
  });
  const grouped = new Map<EnvironmentId, { id: InboxItemId; orderKey: string }[]>();
  for (const write of writes) {
    const entry = byKey.get(write.id);
    if (entry === undefined) continue;
    const updates = grouped.get(entry.environmentId) ?? [];
    updates.push({ id: entry.item.id, orderKey: write.orderKey });
    grouped.set(entry.environmentId, updates);
  }
  return [...grouped].map(([environmentId, updates]) => ({ environmentId, updates }));
}

/** Applies planned keys locally so a drag does not snap back while the RPC is in flight. */
export function applyInboxOrderUpdates(
  entries: ReadonlyArray<InboxEntry>,
  plan: ReadonlyArray<InboxOrderUpdate>,
): InboxEntry[] {
  const keys = new Map<string, string>();
  for (const { environmentId, updates } of plan) {
    for (const { id, orderKey } of updates) keys.set(`${environmentId}:${id}`, orderKey);
  }
  return entries.map((entry) => {
    const orderKey = keys.get(inboxEntryKey(entry));
    return orderKey === undefined ? entry : { ...entry, item: { ...entry.item, orderKey } };
  });
}
