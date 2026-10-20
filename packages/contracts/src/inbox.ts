import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CommandId,
  ForwardCompatibleArray,
  IsoDateTime,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { OrchestrationV2ThreadLaunchWorkspaceStrategy } from "./orchestrationV2.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const InboxItemId = TrimmedNonEmptyString.pipe(Schema.brand("InboxItemId"));
export type InboxItemId = typeof InboxItemId.Type;

/** Snooze is orthogonal to state: a snoozed item keeps its state and hides until `snoozedUntil`. */
export const InboxItemState = Schema.Literals([
  "open",
  "in_progress",
  "waiting",
  "done",
  "dismissed",
]);
export type InboxItemState = typeof InboxItemState.Type;

export const INBOX_CLOSED_STATES: ReadonlySet<InboxItemState> = new Set(["done", "dismissed"]);

/** 0 is urgent, 4 is no priority. */
export const InboxPriority = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 4 }),
).annotate({ description: "Priority from 0 (urgent) to 4 (none)." });
export type InboxPriority = typeof InboxPriority.Type;

export const InboxCreatedBy = Schema.Literals(["user", "agent", "source"]);
export type InboxCreatedBy = typeof InboxCreatedBy.Type;

export const InboxItemOrigin = Schema.Struct({
  kind: TrimmedNonEmptyString.annotate({
    description: "Where the item came from: 'manual', 'agent', or a puller id such as 'github'.",
  }),
  externalKey: Schema.NullOr(TrimmedNonEmptyString).annotate({
    description: "Stable id in the origin system. Items with the same kind and key are one item.",
  }),
  url: Schema.NullOr(TrimmedNonEmptyString),
});
export type InboxItemOrigin = typeof InboxItemOrigin.Type;

export const InboxLabel = TrimmedNonEmptyString.check(Schema.isMaxLength(40)).annotate({
  description: "A free-form tag, such as 'backend' or 'needs-review'. Compared case-insensitively.",
});
export type InboxLabel = typeof InboxLabel.Type;

/**
 * One event a source reports about an item: a Slack message, a PR comment, a review. The
 * key is the event's id in the source, so a re-delivered event is never stored twice.
 */
export const InboxActivity = Schema.Struct({
  key: TrimmedNonEmptyString,
  kind: TrimmedNonEmptyString.annotate({
    description: "What happened: 'message', 'comment', 'review', 'commit', 'status', ...",
  }),
  author: Schema.NullOr(TrimmedNonEmptyString),
  body: Schema.String,
  url: Schema.NullOr(TrimmedNonEmptyString),
  occurredAt: IsoDateTime,
});
export type InboxActivity = typeof InboxActivity.Type;

export const InboxActivityInput = Schema.Struct({
  key: InboxActivity.fields.key,
  kind: InboxActivity.fields.kind,
  author: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  body: Schema.String,
  url: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  occurredAt: IsoDateTime,
});
export type InboxActivityInput = typeof InboxActivityInput.Type;

/** Previews keep the live list small; the full bodies load per item with `inbox.listActivity`. */
export const INBOX_ACTIVITY_PREVIEW_LENGTH = 280;

export const InboxItem = Schema.Struct({
  id: InboxItemId,
  title: TrimmedNonEmptyString,
  body: Schema.NullOr(Schema.String),
  state: InboxItemState,
  priority: InboxPriority,
  /** Manual order; null until the user first drags, and keyless items sort first. */
  orderKey: Schema.NullOr(TrimmedNonEmptyString),
  snoozedUntil: Schema.NullOr(IsoDateTime),
  origin: InboxItemOrigin,
  projectId: Schema.NullOr(ProjectId),
  threadIds: Schema.Array(ThreadId),
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  branch: Schema.NullOr(TrimmedNonEmptyString),
  pullRequestUrls: Schema.Array(TrimmedNonEmptyString),
  createdBy: InboxCreatedBy,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: Schema.NullOr(IsoDateTime),
  labels: Schema.Array(InboxLabel).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  activityCount: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /** Activity that arrived after the item was created and the user has not looked at yet. */
  unseenActivityCount: Schema.Int.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  lastActivity: Schema.NullOr(InboxActivity).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type InboxItem = typeof InboxItem.Type;

export const InboxListInput = Schema.Struct({});
export type InboxListInput = typeof InboxListInput.Type;

export const InboxListResult = Schema.Struct({
  // Pullers add origin kinds over time; one undecodable item must not hide the inbox.
  items: ForwardCompatibleArray(InboxItem),
});
export type InboxListResult = typeof InboxListResult.Type;

export const InboxCreateInput = Schema.Struct({
  commandId: Schema.optional(CommandId),
  title: TrimmedNonEmptyString,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  priority: Schema.optional(InboxPriority),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  url: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  origin: Schema.optional(
    Schema.Struct({
      kind: TrimmedNonEmptyString,
      externalKey: Schema.NullOr(TrimmedNonEmptyString),
    }),
  ).annotate({
    description: "Omit for a manual item. An existing item with the same kind and key is updated.",
  }),
  threadId: Schema.optional(ThreadId).annotate({
    description: "Link the new item to this thread, such as a follow-up an agent filed.",
  }),
  createdBy: Schema.optional(InboxCreatedBy),
  labels: Schema.optional(Schema.Array(InboxLabel)).annotate({
    description: "Added to the item's labels; an update never removes labels the user set.",
  }),
  activity: Schema.optional(Schema.Array(InboxActivityInput)).annotate({
    description:
      "Events to group under the item. Re-sending one with the same key is a no-op, so a source can deliver its whole history every poll.",
  }),
  keepTitle: Schema.optional(Schema.Boolean).annotate({
    description:
      "When the origin matches an existing item, keep its title; for sources that only see the newest event, such as a Slack reply.",
  }),
});
export type InboxCreateInput = typeof InboxCreateInput.Type;

export const InboxUpdateInput = Schema.Struct({
  id: InboxItemId,
  title: Schema.optional(TrimmedNonEmptyString),
  body: Schema.optional(Schema.NullOr(Schema.String)),
  state: Schema.optional(InboxItemState),
  priority: Schema.optional(InboxPriority),
  snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
  projectId: Schema.optional(Schema.NullOr(ProjectId)),
  worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  pullRequestUrls: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  labels: Schema.optional(Schema.Array(InboxLabel)),
  markSeen: Schema.optional(Schema.Boolean).annotate({
    description: "Clear the unseen-activity count, as when the user opens the item.",
  }),
});
export type InboxUpdateInput = typeof InboxUpdateInput.Type;

export const InboxReorderInput = Schema.Struct({
  updates: Schema.Array(Schema.Struct({ id: InboxItemId, orderKey: TrimmedNonEmptyString })),
});
export type InboxReorderInput = typeof InboxReorderInput.Type;

export const InboxLinkThreadInput = Schema.Struct({
  id: InboxItemId,
  threadId: ThreadId,
  linked: Schema.Boolean,
});
export type InboxLinkThreadInput = typeof InboxLinkThreadInput.Type;

export const InboxDeleteInput = Schema.Struct({ id: InboxItemId });
export type InboxDeleteInput = typeof InboxDeleteInput.Type;

export const InboxStartThreadInput = Schema.Struct({
  id: InboxItemId,
  commandId: Schema.optional(CommandId),
  projectId: ProjectId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy,
  prompt: Schema.optional(Schema.String).annotate({
    description: "Instructions placed above the item's context in the first message.",
  }),
});
export type InboxStartThreadInput = typeof InboxStartThreadInput.Type;

export const InboxListActivityInput = Schema.Struct({
  id: InboxItemId,
  /** Ignored by the server; clients pass the activity count so a new event refetches. */
  revision: Schema.optional(Schema.Int),
});
export type InboxListActivityInput = typeof InboxListActivityInput.Type;

export const InboxListActivityResult = Schema.Struct({ activity: Schema.Array(InboxActivity) });
export type InboxListActivityResult = typeof InboxListActivityResult.Type;

export const InboxSearchInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type InboxSearchInput = typeof InboxSearchInput.Type;

/** Items whose stored activity matches; the client already matches titles and labels. */
export const InboxSearchResult = Schema.Struct({ ids: Schema.Array(InboxItemId) });
export type InboxSearchResult = typeof InboxSearchResult.Type;

export const InboxMutationResult = Schema.Struct({
  item: InboxItem,
  /** Set by create: false when the origin matched an existing item that was updated instead. */
  created: Schema.optional(Schema.Boolean),
  addedActivity: Schema.optional(Schema.Int),
});
export type InboxMutationResult = typeof InboxMutationResult.Type;

export const InboxReorderResult = Schema.Struct({ items: Schema.Array(InboxItem) });
export type InboxReorderResult = typeof InboxReorderResult.Type;

export const InboxDeleteResult = Schema.Struct({ id: InboxItemId });
export type InboxDeleteResult = typeof InboxDeleteResult.Type;

export const InboxStartThreadResult = Schema.Struct({ item: InboxItem, threadId: ThreadId });
export type InboxStartThreadResult = typeof InboxStartThreadResult.Type;

export class InboxError extends Schema.TaggedError<InboxError>()("InboxError", {
  message: Schema.String,
  itemId: Schema.optional(InboxItemId),
  cause: Schema.optional(Schema.Defect()),
}) {}

/** Labels compare case-insensitively; the first spelling seen wins. */
export function normalizeInboxLabels(labels: ReadonlyArray<string>): string[] {
  const seen = new Map<string, string>();
  for (const raw of labels) {
    const label = raw.trim();
    if (label.length > 0 && !seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label);
  }
  return [...seen.values()];
}

/** First message of a thread started from an item: instructions, then the item as quoted context. */
export function renderInboxItemPrompt(
  item: InboxItem,
  prompt?: string,
  activity: ReadonlyArray<InboxActivity> = [],
): string {
  const lines: string[] = [];
  const instructions = prompt?.trim();
  if (instructions) lines.push(instructions, "");
  lines.push(`Inbox item: ${item.title}`);
  if (item.origin.url) lines.push(`Link: ${item.origin.url}`);
  for (const url of item.pullRequestUrls) lines.push(`Pull request: ${url}`);
  if (item.labels.length > 0) lines.push(`Labels: ${item.labels.join(", ")}`);
  if (item.body?.trim()) lines.push("", item.body.trim());
  if (activity.length > 0) {
    lines.push("", `Activity (${activity.length}):`);
    for (const event of activity) {
      const who = event.author ?? "unknown";
      lines.push(`- ${event.occurredAt} ${event.kind} by ${who}: ${event.body.trim()}`);
    }
  }
  return lines.join("\n");
}
