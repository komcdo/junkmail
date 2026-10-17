import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { inboxItemView, type InboxEntry } from "@t3tools/client-runtime/state/inbox";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { InboxUpdateInput } from "@t3tools/contracts";
import {
  CheckIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  GripVerticalIcon,
  MessageSquareTextIcon,
  MessagesSquareIcon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuShortcut,
  MenuTrigger,
} from "../ui/menu";
import { PRIORITY_BADGE, PriorityMenu, SnoozeMenu } from "./InboxItemParts";
import { InboxLabelChip } from "./InboxLabels";

const STATUS_DOT: Partial<Record<SidebarThreadStatus, { label: string; className: string }>> = {
  working: { label: "Agent working", className: "bg-info" },
  approval: { label: "Needs approval", className: "bg-warning" },
  input: { label: "Needs input", className: "bg-indigo-500" },
  failed: { label: "Failed", className: "bg-destructive" },
  limited: { label: "Usage limited", className: "bg-warning" },
};
const STATE_MENU = [
  { state: "open", label: "Inbox" },
  { state: "in_progress", label: "In progress" },
  { state: "waiting", label: "Waiting" },
  { state: "done", label: "Done" },
] as const;
const COMPACT_LABEL_LIMIT = 2;

function formatWake(snoozedUntil: string) {
  return new Date(snoozedUntil).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function ThreadStatusDot(props: { readonly thread: EnvironmentThreadShell | null }) {
  if (props.thread === null) return null;
  const status = STATUS_DOT[resolveSidebarThreadStatus(props.thread)];
  if (status === undefined) return null;
  return (
    <span className="flex size-4 shrink-0 items-center justify-center">
      <span className={cn("size-1.5 rounded-full", status.className)} />
      <span className="sr-only">{status.label}</span>
    </span>
  );
}

export interface InboxRowProps {
  readonly entry: InboxEntry;
  readonly rowKey: string;
  readonly now: number;
  readonly density: "full" | "compact";
  readonly thread: EnvironmentThreadShell | null;
  readonly projectTitle: string | null;
  readonly environmentLabel: string | null;
  readonly active: boolean;
  readonly selected: boolean;
  readonly expanded: boolean;
  readonly draggable: boolean;
  readonly labelFilter: string | null;
  readonly children?: ReactNode;
  readonly onToggle: () => void;
  readonly onSelect: () => void;
  readonly onUpdate: (input: Omit<InboxUpdateInput, "id">) => Promise<void>;
  readonly onOpenThread: (() => void) | null;
  readonly onLabelClick: (label: string) => void;
  readonly onDelete: () => void;
}

export function InboxRow(props: InboxRowProps) {
  const { item } = props.entry;
  const full = props.density === "full";
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.rowKey,
    disabled: !props.draggable,
  });
  const view = inboxItemView(item, props.now);
  const closed = view === "done" || view === "dismissed";
  const pullRequest = props.thread?.pullRequests[0] ?? null;
  const branch = item.branch ?? props.thread?.branch ?? null;
  const labels = full ? item.labels : item.labels.slice(0, COMPACT_LABEL_LIMIT);
  const meta = [
    view === "snoozed" && item.snoozedUntil ? `Wakes ${formatWake(item.snoozedUntil)}` : null,
    item.origin.kind !== "manual" && item.origin.kind !== "thread" ? item.origin.kind : null,
    props.environmentLabel,
    props.projectTitle,
    branch,
    pullRequest ? `#${pullRequest.number}` : null,
  ].filter((part): part is string => !!part);
  const update = (input: Omit<InboxUpdateInput, "id">) => void props.onUpdate(input);

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-active={props.active || undefined}
      data-selected={props.selected || undefined}
      data-expanded={props.expanded || undefined}
      data-dragging={isDragging || undefined}
      onClick={props.onSelect}
      className={cn(
        "group/row relative rounded-lg border border-transparent hover:bg-sidebar-row-hover data-[active]:bg-sidebar-row-hover data-[dragging]:z-10 data-[dragging]:bg-sidebar data-[dragging]:shadow-md data-[expanded]:border-border data-[expanded]:bg-sidebar-row-hover/60 data-[selected]:border-border",
        full ? "px-2 py-2" : "px-2 py-1.5",
      )}
      {...(full ? {} : { ...attributes, ...listeners })}
      // The drag attributes carry role="button"; the row stays a list item.
      role="listitem"
    >
      <div className="flex items-start gap-1.5">
        {full ? (
          <button
            type="button"
            aria-label="Drag to reorder"
            disabled={!props.draggable}
            className="mt-0.5 flex h-5 w-4 shrink-0 cursor-grab items-center justify-center text-muted-foreground/60 opacity-0 group-hover/row:opacity-100 disabled:invisible"
            {...attributes}
            {...listeners}
          >
            <GripVerticalIcon className="size-3.5" />
          </button>
        ) : null}
        {full && !closed ? (
          <PriorityMenu priority={item.priority} onChange={(priority) => update({ priority })} />
        ) : null}
        <div
          className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1"
          onClick={(event) => {
            event.stopPropagation();
            props.onSelect();
            props.onToggle();
          }}
        >
          <button
            type="button"
            aria-expanded={props.expanded}
            className="flex min-w-0 items-center gap-1.5 text-left outline-hidden"
          >
            <ChevronRightIcon
              className={cn(
                "size-3 shrink-0 text-muted-foreground transition-transform",
                props.expanded && "rotate-90",
              )}
            />
            {!full && item.priority < 4 && !closed ? (
              <Badge variant={PRIORITY_BADGE[item.priority] ?? "outline"} size="sm">
                P{item.priority}
              </Badge>
            ) : null}
            <span
              className={cn(
                "truncate text-sm",
                closed ? "text-muted-foreground line-through" : "text-sidebar-foreground",
                item.unseenActivityCount > 0 && "font-semibold",
              )}
            >
              {item.title}
            </span>
            {item.unseenActivityCount > 0 ? (
              <Badge size="sm" variant="info" className="shrink-0">
                {item.unseenActivityCount} new
              </Badge>
            ) : null}
          </button>
          {meta.length > 0 || item.activityCount > 0 || labels.length > 0 ? (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5 pl-4.5 text-muted-foreground text-xs">
              {labels.map((label) => (
                <InboxLabelChip
                  key={label}
                  label={label}
                  active={props.labelFilter?.toLowerCase() === label.toLowerCase()}
                  onClick={() => props.onLabelClick(label)}
                />
              ))}
              {!full && item.labels.length > labels.length ? (
                <span>+{item.labels.length - labels.length}</span>
              ) : null}
              {item.activityCount > 0 ? (
                <span className="inline-flex items-center gap-0.5">
                  <MessagesSquareIcon className="size-3" />
                  {item.activityCount}
                </span>
              ) : null}
              {meta.length > 0 ? <span className="truncate">{meta.join(" · ")}</span> : null}
            </div>
          ) : null}
          {full && !props.expanded && item.lastActivity ? (
            <span className="line-clamp-1 pl-4.5 text-muted-foreground text-xs">
              <span className="font-medium">{item.lastActivity.author ?? "Someone"}:</span>{" "}
              {item.lastActivity.body}
            </span>
          ) : null}
        </div>
        <ThreadStatusDot thread={props.thread} />
        <div
          className={cn(
            "flex shrink-0 items-center gap-0.5",
            full
              ? "opacity-60 group-hover/row:opacity-100 group-data-[selected]/row:opacity-100"
              : "absolute top-1 right-1 hidden rounded-md bg-sidebar-row-hover group-hover/row:flex",
          )}
          onClick={(event) => event.stopPropagation()}
        >
          {props.onOpenThread ? (
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Open thread"
              onClick={props.onOpenThread}
            >
              <MessageSquareTextIcon />
            </Button>
          ) : null}
          {full && item.origin.url ? (
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Open source"
              render={<a href={item.origin.url} target="_blank" rel="noopener noreferrer" />}
            >
              <ExternalLinkIcon />
            </Button>
          ) : null}
          {closed ? (
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label={view === "dismissed" ? "Restore" : "Reopen"}
              onClick={() => update({ state: "open" })}
            >
              <RotateCcwIcon />
            </Button>
          ) : (
            <>
              <SnoozeMenu
                snoozed={view === "snoozed"}
                onSnooze={(snoozedUntil) => update({ snoozedUntil })}
              />
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Mark done"
                onClick={() => update({ state: "done" })}
              >
                <CheckIcon />
              </Button>
            </>
          )}
          {full ? (
            <Menu>
              <MenuTrigger
                render={<Button size="icon-xs" variant="ghost-muted" aria-label="More actions" />}
              >
                <MoreHorizontalIcon />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuGroup>
                  <MenuGroupLabel>Status</MenuGroupLabel>
                  {STATE_MENU.map(({ state, label }) => (
                    <MenuItem
                      key={state}
                      disabled={item.state === state}
                      onClick={() => update({ state })}
                    >
                      {label}
                    </MenuItem>
                  ))}
                </MenuGroup>
                {item.unseenActivityCount > 0 ? (
                  <MenuItem onClick={() => update({ markSeen: true })}>Mark as seen</MenuItem>
                ) : null}
                <MenuSeparator />
                {item.state === "dismissed" ? (
                  <MenuItem onClick={() => update({ state: "open" })}>
                    <RotateCcwIcon />
                    Restore
                  </MenuItem>
                ) : (
                  <MenuItem onClick={() => update({ state: "dismissed" })}>
                    <XIcon />
                    Dismiss
                    <MenuShortcut>D</MenuShortcut>
                  </MenuItem>
                )}
                <MenuItem variant="destructive" onClick={props.onDelete}>
                  <Trash2Icon />
                  Delete
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      </div>
      {props.expanded ? <div className="pl-5">{props.children}</div> : null}
    </div>
  );
}
