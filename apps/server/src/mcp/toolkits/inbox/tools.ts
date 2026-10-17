import {
  InboxCreateInput,
  InboxItem,
  InboxItemId,
  InboxItemState,
  InboxLabel,
  InboxListActivityResult,
  InboxMutationResult,
  InboxPriority,
  IsoDateTime,
  OrchestratorMcpFailure,
  ProjectId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as InboxService from "../../../inbox/InboxService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  InboxService.InboxService,
];

const InboxListTool = Tool.make("t3_inbox_list", {
  description:
    "List the user's work inbox: open items plus items closed in the last two weeks. Each item has a state (open, in_progress, waiting, done, dismissed), a priority from 0 (urgent) to 4 (none), an optional snoozedUntil, and linked thread ids. Use it to see what the user should be working on.",
  parameters: Schema.Struct({
    includeClosed: Schema.optional(Schema.Boolean).annotate({
      description: "Include done and dismissed items. Defaults to false.",
    }),
  }),
  success: Schema.Struct({ items: Schema.Array(InboxItem) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List inbox items")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const InboxAddTool = Tool.make("t3_inbox_add", {
  description:
    "File a work item in the user's inbox, such as a follow-up you could not finish, a decision the user must make, or a bug you noticed outside the task. Called from a thread, the item links back to that thread. Pass origin with a stable externalKey to update the same item on later calls instead of creating duplicates; activity events with the same key are stored once, and new ones mark the item as updated.",
  parameters: Schema.Struct({
    title: InboxCreateInput.fields.title,
    body: Schema.optional(Schema.String).annotate({
      description: "Markdown context. It is sent to the agent when the user starts a thread.",
    }),
    priority: Schema.optional(InboxPriority),
    projectId: Schema.optional(ProjectId),
    url: Schema.optional(TrimmedNonEmptyString),
    origin: InboxCreateInput.fields.origin,
    labels: InboxCreateInput.fields.labels,
    activity: InboxCreateInput.fields.activity,
  }),
  success: InboxMutationResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Add an inbox item")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

const InboxUpdateTool = Tool.make("t3_inbox_update", {
  description:
    "Update an inbox item: change state (mark done, dismiss, reopen), priority, snooze (snoozedUntil, or null to unsnooze), title, body, labels, branch, worktree path, or pull request URLs.",
  parameters: Schema.Struct({
    id: InboxItemId,
    title: Schema.optional(TrimmedNonEmptyString),
    body: Schema.optional(Schema.NullOr(Schema.String)),
    state: Schema.optional(InboxItemState),
    priority: Schema.optional(InboxPriority),
    snoozedUntil: Schema.optional(Schema.NullOr(IsoDateTime)),
    branch: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    worktreePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    pullRequestUrls: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    labels: Schema.optional(Schema.Array(InboxLabel)).annotate({
      description: "Replaces the item's labels.",
    }),
  }),
  success: Schema.Struct({ item: InboxItem }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update an inbox item")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const InboxActivityTool = Tool.make("t3_inbox_activity", {
  description:
    "Read every event grouped under an inbox item, oldest first: the Slack messages, PR comments, or reviews its source reported.",
  parameters: Schema.Struct({ id: InboxItemId }),
  success: InboxListActivityResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read inbox item activity")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const InboxToolkit = Toolkit.make(
  InboxListTool,
  InboxAddTool,
  InboxUpdateTool,
  InboxActivityTool,
);
