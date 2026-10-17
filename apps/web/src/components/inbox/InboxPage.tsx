import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { inboxEntryKey, inboxItemView, type InboxEntry } from "@t3tools/client-runtime/state/inbox";
import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  CheckIcon,
  ExternalLinkIcon,
  InboxIcon,
  RotateCcwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";

import { isElectron } from "../../env";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { SidebarInset, useSidebar } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  InboxItemDetails,
  InboxThreadChip,
  PriorityMenu,
  SnoozeMenu,
  StartThreadMenu,
} from "./InboxItemParts";
import { useInboxController } from "./useInboxController";

const STATE_LABELS: Record<InboxEntry["item"]["state"], string> = {
  open: "Inbox",
  in_progress: "In progress",
  waiting: "Waiting",
  done: "Done",
  dismissed: "Dismissed",
};

/**
 * The detail pane for one inbox item (`/inbox?item=`). With no item selected the inbox
 * sidebar fills the window, so this pane only shows when the sidebar is collapsed.
 */
export function InboxPage() {
  const search: Record<string, unknown> = useSearch({ strict: false });
  const itemKey = typeof search.item === "string" && search.item.length > 0 ? search.item : null;
  const controller = useInboxController();
  const navigate = useNavigate();
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  const entry =
    itemKey === null
      ? null
      : (controller.entries.find((candidate) => inboxEntryKey(candidate) === itemKey) ?? null);
  const close = () => void navigate({ to: "/inbox" });

  if (entry === null) {
    const showInbox = () => {
      if (isMobile) setOpenMobile(true);
      else {
        setOpen(true);
        close();
      }
    };
    return (
      <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
        {isElectron ? <WorkspacePageHeader electron /> : null}
        {itemKey !== null && controller.snapshot.loading ? null : (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <InboxIcon />
              </EmptyMedia>
              <EmptyTitle>{itemKey === null ? "Nothing selected" : "Item not found"}</EmptyTitle>
              <EmptyDescription>
                {itemKey === null
                  ? "Pick an item from the inbox."
                  : "It was deleted, or its environment is disconnected."}
              </EmptyDescription>
            </EmptyHeader>
            <Button variant="outline" onClick={showInbox}>
              Show inbox
            </Button>
          </Empty>
        )}
      </SidebarInset>
    );
  }

  const { item } = entry;
  const closed = item.state === "done" || item.state === "dismissed";
  const project = controller.projectFor(item);
  const threadEnvironmentId = project?.environmentId ?? entry.environmentId;
  const update = (input: Parameters<typeof controller.update>[1]) =>
    controller.update(entry, input);
  const snoozed = inboxItemView(item, controller.now) === "snoozed";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron} className="border-b">
        <PriorityMenu priority={item.priority} onChange={(priority) => void update({ priority })} />
        <Badge variant="outline" size="sm">
          {snoozed ? "Snoozed" : STATE_LABELS[item.state]}
        </Badge>
        {controller.multiEnvironment ? (
          <Badge variant="outline" size="sm">
            {controller.environmentLabel(entry.environmentId)}
          </Badge>
        ) : null}
        <div className="ml-auto flex items-center gap-0.5">
          {item.origin.url ? (
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Open source"
              render={<a href={item.origin.url} target="_blank" rel="noopener noreferrer" />}
            >
              <ExternalLinkIcon />
            </Button>
          ) : null}
          <StartThreadMenu
            project={project}
            projects={controller.projects}
            onStart={(projectRef) => void controller.startThread(entry, projectRef)}
          />
          {closed ? (
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={item.state === "dismissed" ? "Restore" : "Reopen"}
              onClick={() => void update({ state: "open" })}
            >
              <RotateCcwIcon />
            </Button>
          ) : (
            <>
              <SnoozeMenu
                snoozed={snoozed}
                onSnooze={(snoozedUntil) => void update({ snoozedUntil })}
              />
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Mark done"
                onClick={() => void update({ state: "done" })}
              >
                <CheckIcon />
              </Button>
            </>
          )}
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Delete"
            onClick={() => void controller.removeItem(entry)}
          >
            <Trash2Icon />
          </Button>
          <Button size="icon-xs" variant="ghost-muted" aria-label="Close" onClick={close}>
            <XIcon />
          </Button>
        </div>
      </WorkspacePageHeader>
      <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        <div className="mx-auto grid max-w-3xl gap-4">
          <InboxItemDetails key={itemKey} entry={entry} onUpdate={update} />
          {item.threadIds.length > 0 ? (
            <section className="grid gap-1">
              <h2 className="font-medium text-muted-foreground text-xs">Threads</h2>
              <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
                {item.threadIds.map((threadId) => (
                  <InboxThreadChip
                    key={threadId}
                    threadRef={scopeThreadRef(threadEnvironmentId, threadId)}
                    onOpen={controller.openThread}
                  />
                ))}
              </div>
            </section>
          ) : null}
          <p className="text-muted-foreground text-xs">
            {[
              item.origin.kind === "manual" ? "Added by you" : `From ${item.origin.kind}`,
              project ? `Project ${project.title}` : null,
              `Created ${new Date(item.createdAt).toLocaleString()}`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
      </div>
    </SidebarInset>
  );
}
