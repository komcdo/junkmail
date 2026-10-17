import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { inboxEntryKey, inboxItemView, type InboxEntry } from "@t3tools/client-runtime/state/inbox";
import type { InboxUpdateInput } from "@t3tools/contracts";
import {
  AlarmClockIcon,
  CheckIcon,
  ExternalLinkIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GripVerticalIcon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";

import type { useProjects } from "../../state/entities";
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
import { InboxThreadChip, PriorityMenu, SnoozeMenu, StartThreadMenu } from "./InboxItemParts";
import type { InboxProjectRef, InboxThreadRef } from "./useInboxController";

export interface InboxRowProps {
  readonly entry: InboxEntry;
  readonly now: number;
  readonly draggable: boolean;
  readonly selected: boolean;
  readonly environmentLabel: string | null;
  readonly projectTitle: string | null;
  readonly projects: ReturnType<typeof useProjects>;
  readonly onSelect: () => void;
  readonly onOpen: () => void;
  readonly onUpdate: (input: Omit<InboxUpdateInput, "id">) => Promise<void>;
  readonly onStartThread: (projectRef: InboxProjectRef) => void;
  readonly onOpenThread: (threadRef: InboxThreadRef) => void;
  readonly onDelete: () => void;
}

export function InboxRow(props: InboxRowProps) {
  const { entry, now } = props;
  const { item } = entry;
  const key = inboxEntryKey(entry);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: key,
    disabled: !props.draggable,
  });
  const itemView = inboxItemView(item, now);
  const closed = item.state === "done" || item.state === "dismissed";
  const project = props.projects.find((candidate) => candidate.id === item.projectId) ?? null;
  const threadEnvironmentId = project?.environmentId ?? entry.environmentId;

  return (
    <div
      ref={setNodeRef}
      role="listitem"
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-selected={props.selected || undefined}
      data-dragging={isDragging || undefined}
      onClick={props.onSelect}
      className="group relative flex gap-2 rounded-lg border border-transparent px-2 py-2 hover:bg-accent/40 data-[dragging]:z-10 data-[dragging]:bg-background data-[dragging]:shadow-md data-[selected]:border-border data-[selected]:bg-accent/30"
    >
      <button
        type="button"
        aria-label="Drag to reorder"
        disabled={!props.draggable}
        className="mt-0.5 flex h-5 w-4 shrink-0 cursor-grab items-center justify-center text-muted-foreground/60 opacity-0 group-hover:opacity-100 disabled:invisible"
        {...attributes}
        {...listeners}
      >
        <GripVerticalIcon className="size-3.5" />
      </button>

      <PriorityMenu
        priority={item.priority}
        onChange={(priority) => props.onUpdate({ priority })}
      />

      <div className="min-w-0 flex-1">
        <button
          type="button"
          onClick={props.onOpen}
          className="block w-full truncate text-left text-sm data-[closed]:text-muted-foreground data-[closed]:line-through"
          data-closed={closed || undefined}
        >
          {item.title}
        </button>
        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
          {item.origin.kind !== "manual" ? (
            <Badge variant="outline" size="sm">
              {item.origin.kind}
            </Badge>
          ) : null}
          {props.environmentLabel ? (
            <Badge variant="outline" size="sm">
              {props.environmentLabel}
            </Badge>
          ) : null}
          {props.projectTitle ? <span>{props.projectTitle}</span> : null}
          {itemView === "snoozed" && item.snoozedUntil ? (
            <span className="inline-flex items-center gap-1">
              <AlarmClockIcon className="size-3" />
              {new Date(item.snoozedUntil).toLocaleString(undefined, {
                weekday: "short",
                hour: "numeric",
                minute: "2-digit",
              })}
            </span>
          ) : null}
          {item.branch ? (
            <span className="inline-flex items-center gap-1">
              <GitBranchIcon className="size-3" />
              {item.branch}
            </span>
          ) : null}
          {item.worktreePath ? (
            <span className="inline-flex items-center gap-1">
              <FolderGit2Icon className="size-3" />
              {item.worktreePath.split("/").at(-1)}
            </span>
          ) : null}
          {item.pullRequestUrls.map((url) => (
            <a
              key={url}
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="underline-offset-2 hover:underline"
            >
              {url.replace(/^https?:\/\/(www\.)?github\.com\//, "")}
            </a>
          ))}
          {item.threadIds.map((threadId) => (
            <InboxThreadChip
              key={threadId}
              threadRef={scopeThreadRef(threadEnvironmentId, threadId)}
              onOpen={props.onOpenThread}
            />
          ))}
        </div>
      </div>

      <div className="flex shrink-0 items-start gap-0.5 opacity-60 group-hover:opacity-100 group-data-[selected]:opacity-100">
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
          projects={props.projects}
          onStart={props.onStartThread}
        />
        {closed ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Reopen"
            onClick={() => void props.onUpdate({ state: "open" })}
          >
            <RotateCcwIcon />
          </Button>
        ) : (
          <>
            <SnoozeMenu
              snoozed={itemView === "snoozed"}
              onSnooze={(snoozedUntil) => void props.onUpdate({ snoozedUntil })}
            />
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Mark done"
              onClick={() => void props.onUpdate({ state: "done" })}
            >
              <CheckIcon />
            </Button>
          </>
        )}
        <Menu>
          <MenuTrigger
            render={<Button size="icon-xs" variant="ghost-muted" aria-label="More actions" />}
          >
            <MoreHorizontalIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuGroup>
              <MenuGroupLabel>Status</MenuGroupLabel>
              {(["open", "in_progress", "waiting", "done"] as const).map((state) => (
                <MenuItem
                  key={state}
                  disabled={item.state === state}
                  onClick={() => void props.onUpdate({ state })}
                >
                  {state === "open"
                    ? "Inbox"
                    : state === "in_progress"
                      ? "In progress"
                      : state === "waiting"
                        ? "Waiting"
                        : "Done"}
                </MenuItem>
              ))}
            </MenuGroup>
            <MenuSeparator />
            {item.state === "dismissed" ? (
              <MenuItem onClick={() => void props.onUpdate({ state: "open" })}>
                <RotateCcwIcon />
                Restore
              </MenuItem>
            ) : (
              <MenuItem onClick={() => void props.onUpdate({ state: "dismissed" })}>
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
      </div>
    </div>
  );
}
