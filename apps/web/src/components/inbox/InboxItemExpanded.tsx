import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { InboxEntry } from "@t3tools/client-runtime/state/inbox";
import type { InboxActivity, InboxUpdateInput } from "@t3tools/contracts";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import type { useProjects } from "../../state/entities";
import { InboxItemDetails, InboxThreadChip, StartThreadMenu } from "./InboxItemParts";
import { InboxLabelEditor } from "./InboxLabels";
import type { InboxProjectRef, InboxThreadRef } from "./useInboxController";

const ACTIVITY_COLLAPSED_COUNT = 8;

function pluralKind(kind: string, count: number) {
  if (count === 1) return `1 ${kind}`;
  return `${count} ${kind.endsWith("s") ? kind : `${kind}s`}`;
}

export function summarizeActivity(activity: ReadonlyArray<Pick<InboxActivity, "kind">>) {
  const counts = new Map<string, number>();
  for (const event of activity) counts.set(event.kind, (counts.get(event.kind) ?? 0) + 1);
  return [...counts].map(([kind, count]) => pluralKind(kind, count)).join(" · ");
}

function formatWhen(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The item's details, opened in place under its row. */
export function InboxItemExpanded(props: {
  readonly entry: InboxEntry;
  /** Events that were unseen when the item opened; marked New until it closes. */
  readonly newActivityCount: number;
  readonly labelSuggestions: ReadonlyArray<string>;
  readonly projects: ReturnType<typeof useProjects>;
  readonly threadEnvironmentId: InboxEntry["environmentId"];
  readonly onUpdate: (input: Omit<InboxUpdateInput, "id">) => Promise<void>;
  readonly onStartThread: (projectRef: InboxProjectRef) => void;
  readonly onOpenThread: (threadRef: InboxThreadRef) => void;
}) {
  const { item } = props.entry;
  const project = props.projects.find((candidate) => candidate.id === item.projectId) ?? null;
  return (
    <div
      className="grid gap-3 pt-2 pb-1"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {item.activityCount > 0 ? (
        <InboxActivityTimeline entry={props.entry} newActivityCount={props.newActivityCount} />
      ) : null}
      <section className="grid gap-1">
        <h3 className="font-medium text-muted-foreground text-xs">Labels</h3>
        <InboxLabelEditor
          labels={item.labels}
          suggestions={props.labelSuggestions}
          onChange={(labels) => void props.onUpdate({ labels })}
        />
      </section>
      <section className="grid gap-1">
        <h3 className="flex items-center gap-2 font-medium text-muted-foreground text-xs">
          Threads
          <StartThreadMenu
            project={project}
            projects={props.projects}
            onStart={props.onStartThread}
          />
        </h3>
        {item.threadIds.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            No thread yet. Start one to hand this to an agent with its context and activity.
          </p>
        ) : (
          <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
            {item.threadIds.map((threadId) => (
              <InboxThreadChip
                key={threadId}
                threadRef={scopeThreadRef(props.threadEnvironmentId, threadId)}
                onOpen={props.onOpenThread}
              />
            ))}
          </div>
        )}
      </section>
      <details className="group/edit">
        <summary className="cursor-pointer select-none font-medium text-muted-foreground text-xs hover:text-foreground">
          Edit title, notes, branch, worktree, pull requests
        </summary>
        <InboxItemDetails key={item.id} entry={props.entry} onUpdate={props.onUpdate} />
      </details>
      <p className="text-muted-foreground text-xs">
        {[
          item.origin.kind === "manual"
            ? "Added by you"
            : item.createdBy === "agent"
              ? "Filed by an agent"
              : `From ${item.origin.kind}`,
          `created ${formatWhen(item.createdAt)}`,
          `updated ${formatWhen(item.updatedAt)}`,
        ].join(" · ")}
      </p>
    </div>
  );
}

function InboxActivityTimeline(props: {
  readonly entry: InboxEntry;
  readonly newActivityCount: number;
}) {
  const { item } = props.entry;
  const [showAll, setShowAll] = useState(false);
  const { data, error, isPending } = useEnvironmentQuery(
    serverEnvironment.inboxActivity({
      environmentId: props.entry.environmentId,
      input: { id: item.id, revision: item.activityCount },
    }),
  );
  const activity = data?.activity ?? [];
  const firstNew = activity.length - props.newActivityCount;
  const hidden = showAll ? 0 : Math.max(0, activity.length - ACTIVITY_COLLAPSED_COUNT);
  return (
    <section className="grid gap-1.5">
      <h3 className="flex items-center gap-2 font-medium text-muted-foreground text-xs">
        Activity
        <span className="font-normal">
          {activity.length > 0
            ? summarizeActivity(activity)
            : pluralKind("event", item.activityCount)}
        </span>
      </h3>
      {error ? <p className="text-destructive-foreground text-xs">{String(error)}</p> : null}
      {isPending && activity.length === 0 ? (
        <p className="text-muted-foreground text-xs">Loading…</p>
      ) : null}
      {hidden > 0 ? (
        <button
          type="button"
          className="w-fit text-muted-foreground text-xs hover:text-foreground"
          onClick={() => setShowAll(true)}
        >
          Show {hidden} earlier
        </button>
      ) : null}
      <ol className="grid gap-1.5">
        {activity.slice(hidden).map((event, offset) => {
          const isNew = hidden + offset >= firstNew;
          return (
            <li
              key={event.key}
              data-new={isNew || undefined}
              className="grid gap-0.5 rounded-md border border-transparent bg-muted/40 px-2.5 py-1.5 text-xs data-[new]:border-info/40"
            >
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <span className="font-medium text-foreground">{event.author ?? "Unknown"}</span>
                <span>{event.kind}</span>
                <span>· {formatWhen(event.occurredAt)}</span>
                {isNew ? (
                  <Badge size="sm" variant="info">
                    New
                  </Badge>
                ) : null}
                {event.url ? (
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    className="ml-auto"
                    aria-label="Open in source"
                    render={<a href={event.url} target="_blank" rel="noopener noreferrer" />}
                  >
                    <ExternalLinkIcon />
                  </Button>
                ) : null}
              </div>
              <p className="whitespace-pre-wrap break-words text-foreground">{event.body}</p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
