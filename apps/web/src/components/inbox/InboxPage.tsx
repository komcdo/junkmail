import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  INBOX_PRIORITY_LABELS,
  INBOX_VIEWS,
  applyInboxOrderUpdates,
  countInboxView,
  inboxEntryKey,
  inboxItemView,
  planInboxReorder,
  selectInboxView,
  sortInboxEntriesByPriority,
  type InboxEntry,
  type InboxOrderUpdate,
  type InboxView,
} from "@t3tools/client-runtime/state/inbox";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";
import {
  renderInboxItemPrompt,
  type EnvironmentId,
  type InboxItem,
  type InboxUpdateInput,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  AlarmClockIcon,
  ArrowDownWideNarrowIcon,
  CheckIcon,
  ExternalLinkIcon,
  FolderGit2Icon,
  GitBranchIcon,
  GripVerticalIcon,
  InboxIcon,
  MessageSquarePlusIcon,
  MoreHorizontalIcon,
  RotateCcwIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { useAtomCommand } from "../../state/use-atom-command";
import { useInboxClock, useMergedInbox } from "./useMergedInbox";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useComposerDraftStore } from "../../composerDraftStore";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects, useThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { requestConfirmDialog } from "../../confirmDialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Kbd } from "../ui/kbd";
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
import { SidebarInset } from "../ui/sidebar";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";

const MANUAL_ORDER_VIEWS: ReadonlySet<InboxView> = new Set(["inbox", "in_progress", "waiting"]);
const PRIORITY_BADGE = ["error", "warning", "info", "outline", "outline"] as const;

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: String(squashAtomCommandFailure(result)),
    }),
  );
}

export function InboxPage() {
  const snapshot = useMergedInbox();
  const now = useInboxClock(snapshot.entries);
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const projects = useProjects();
  const newThread = useNewThreadHandler();

  const createItem = useAtomCommand(serverEnvironment.createInboxItem, { label: "inbox create" });
  const updateItem = useAtomCommand(serverEnvironment.updateInboxItem, { label: "inbox update" });
  const reorderItems = useAtomCommand(serverEnvironment.reorderInboxItems, {
    label: "inbox reorder",
  });
  const linkThread = useAtomCommand(serverEnvironment.linkInboxThread, {
    label: "inbox link thread",
  });
  const deleteItem = useAtomCommand(serverEnvironment.deleteInboxItem, { label: "inbox delete" });

  const [view, setView] = useState<InboxView>("inbox");
  const [sortByPriority, setSortByPriority] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  // Planned keys show immediately; the next server snapshot supersedes them.
  const [pendingOrder, setPendingOrder] = useState<{
    readonly base: ReadonlyArray<InboxEntry>;
    readonly plan: ReadonlyArray<InboxOrderUpdate>;
  } | null>(null);

  const entries = useMemo(
    () =>
      pendingOrder !== null && pendingOrder.base === snapshot.entries
        ? applyInboxOrderUpdates(snapshot.entries, pendingOrder.plan)
        : snapshot.entries,
    [snapshot.entries, pendingOrder],
  );
  const visible = useMemo(() => {
    const selected = selectInboxView(entries, view, now);
    return sortByPriority && MANUAL_ORDER_VIEWS.has(view)
      ? sortInboxEntriesByPriority(selected)
      : selected;
  }, [entries, view, now, sortByPriority]);
  const draggable = MANUAL_ORDER_VIEWS.has(view) && !sortByPriority;

  const connectedEnvironmentIds = useMemo(
    () =>
      environments
        .filter((env) => env.connection.phase === "connected" && env.serverConfig !== null)
        .map((env) => env.environmentId),
    [environments],
  );
  const createEnvironmentId =
    primaryEnvironmentId !== null && connectedEnvironmentIds.includes(primaryEnvironmentId)
      ? primaryEnvironmentId
      : (connectedEnvironmentIds[0] ?? null);
  const multiEnvironment = connectedEnvironmentIds.length > 1;
  const environmentLabel = useCallback(
    (environmentId: EnvironmentId) =>
      environments.find((env) => env.environmentId === environmentId)?.label ?? environmentId,
    [environments],
  );

  const update = useCallback(
    async (entry: InboxEntry, input: Omit<InboxUpdateInput, "id">, failure: string) => {
      const result = await updateItem({
        environmentId: entry.environmentId,
        input: { id: entry.item.id, ...input },
      });
      reportFailure(failure, result);
    },
    [updateItem],
  );

  const setState = useCallback(
    (entry: InboxEntry, state: InboxItem["state"]) =>
      update(entry, { state }, "Could not update inbox item"),
    [update],
  );

  const addItem = async () => {
    const title = draftTitle.trim();
    if (title.length === 0 || createEnvironmentId === null) return;
    setDraftTitle("");
    const result = await createItem({ environmentId: createEnvironmentId, input: { title } });
    reportFailure("Could not add inbox item", result);
  };

  const projectFor = useCallback(
    (item: InboxItem) => projects.find((project) => project.id === item.projectId) ?? null,
    [projects],
  );

  const startThread = useCallback(
    async (entry: InboxEntry, projectRef: ReturnType<typeof scopeProjectRef>) => {
      const { item } = entry;
      const session = await newThread(projectRef, {
        ...(item.worktreePath === null ? {} : { worktreePath: item.worktreePath }),
        ...(item.branch === null ? {} : { branch: item.branch }),
      }).catch(() => null);
      if (session === null) {
        toastManager.add({ type: "error", title: "Could not open a thread" });
        return;
      }
      useComposerDraftStore
        .getState()
        .setPrompt(session.draftId, renderInboxItemPrompt(item, "Work on this inbox item."));
      const linked = await linkThread({
        environmentId: entry.environmentId,
        input: { id: item.id, threadId: session.threadId, linked: true },
      });
      reportFailure("Could not link the thread to the inbox item", linked);
      await update(
        entry,
        {
          state: "in_progress",
          snoozedUntil: null,
          ...(projectRef.environmentId === entry.environmentId
            ? { projectId: projectRef.projectId }
            : {}),
        },
        "Could not update inbox item",
      );
    },
    [linkThread, newThread, update],
  );

  const removeItem = useCallback(
    async (entry: InboxEntry) => {
      const message =
        "Delete this inbox item?\nDismiss keeps it under Dismissed; delete removes it.";
      const confirmed =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      if (!confirmed) return;
      const result = await deleteItem({
        environmentId: entry.environmentId,
        input: { id: entry.item.id },
      });
      reportFailure("Could not delete inbox item", result);
    },
    [deleteItem],
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const visibleKeys = useMemo(() => visible.map(inboxEntryKey), [visible]);

  const move = useCallback(
    async (movedKey: string, orderedKeys: ReadonlyArray<string>) => {
      const plan = planInboxReorder({ entries, orderedKeys, movedKey });
      if (plan.length === 0) return;
      setPendingOrder({ base: snapshot.entries, plan });
      for (const group of plan) {
        const result = await reorderItems({
          environmentId: group.environmentId,
          input: { updates: group.updates },
        });
        if (result._tag === "Failure") setPendingOrder(null);
        reportFailure("Could not save the new order", result);
      }
    },
    [entries, reorderItems, snapshot.entries],
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    const from = visibleKeys.indexOf(String(active.id));
    const to = visibleKeys.indexOf(String(over.id));
    if (from === -1 || to === -1) return;
    void move(String(active.id), arrayMove(visibleKeys, from, to));
  };

  const selected = visible.find((entry) => inboxEntryKey(entry) === selectedKey) ?? null;
  const listRef = useRef<HTMLDivElement | null>(null);
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey) return;
    const index = selected === null ? -1 : visible.indexOf(selected);
    const select = (next: number) => {
      const entry = visible[Math.max(0, Math.min(visible.length - 1, next))];
      if (entry) setSelectedKey(inboxEntryKey(entry));
    };
    const key = event.key;
    if (key === "j" || key === "ArrowDown") select(index + 1);
    else if (key === "k" || key === "ArrowUp") {
      if (event.altKey && selected !== null && draggable && index > 0) {
        void move(inboxEntryKey(selected), arrayMove(visibleKeys, index, index - 1));
      } else select(index - 1);
    } else if (selected === null) return;
    else if (key === "e") void setState(selected, "done");
    else if (key === "d") void setState(selected, "dismissed");
    else if (key === "u") void update(selected, { snoozedUntil: null }, "Could not unsnooze");
    else if (/^[0-4]$/.test(key)) {
      void update(selected, { priority: Number(key) }, "Could not set priority");
    } else if (key === "Enter") setExpandedKey(inboxEntryKey(selected));
    else if (key === "o" && selected.item.origin.url) {
      window.open(selected.item.origin.url, "_blank", "noopener");
    } else return;
    event.preventDefault();
  };

  const counts = useMemo(
    () => new Map(INBOX_VIEWS.map(({ id }) => [id, countInboxView(entries, id, now)])),
    [entries, now],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 flex-1 flex-col">
        <header className="flex flex-col gap-3 border-b px-4 pt-4 pb-3 sm:px-6">
          <div className="flex items-center gap-2">
            <InboxIcon className="size-4 text-muted-foreground" />
            <h1 className="font-semibold text-base">Inbox</h1>
            <div className="ml-auto flex items-center gap-1">
              {MANUAL_ORDER_VIEWS.has(view) ? (
                <Button
                  size="xs"
                  variant={sortByPriority ? "outline" : "ghost-muted"}
                  onClick={() => setSortByPriority((value) => !value)}
                >
                  <ArrowDownWideNarrowIcon />
                  {sortByPriority ? "By priority" : "My order"}
                </Button>
              ) : null}
            </div>
          </div>
          <nav className="flex flex-wrap gap-1" aria-label="Inbox views">
            {INBOX_VIEWS.map(({ id, label }) => (
              <Button
                key={id}
                size="xs"
                variant={view === id ? "outline" : "ghost-muted"}
                aria-pressed={view === id}
                onClick={() => setView(id)}
              >
                {label}
                {counts.get(id) ? (
                  <span className="text-muted-foreground tabular-nums">{counts.get(id)}</span>
                ) : null}
              </Button>
            ))}
          </nav>
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void addItem();
            }}
          >
            <Input
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              placeholder={
                createEnvironmentId === null
                  ? "Connect an environment to add items"
                  : "Add a work item and press Enter"
              }
              disabled={createEnvironmentId === null}
              aria-label="New inbox item"
            />
          </form>
          {snapshot.errors.map((error) => (
            <p key={error} className="text-destructive-foreground text-xs">
              {error}
            </p>
          ))}
        </header>

        <div
          ref={listRef}
          tabIndex={0}
          onKeyDown={onListKeyDown}
          className="min-h-0 flex-1 overflow-y-auto px-2 py-2 outline-none sm:px-4"
          aria-label="Inbox items"
          role="list"
        >
          {visible.length === 0 ? (
            snapshot.loading ? null : (
              <Empty>
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <InboxIcon />
                  </EmptyMedia>
                  <EmptyTitle>{view === "inbox" ? "Inbox zero" : "Nothing here"}</EmptyTitle>
                  <EmptyDescription>
                    {view === "inbox"
                      ? "Add work above, or let agents and pullers file it here."
                      : "Items you move here will show up in this view."}
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis]}
              onDragEnd={handleDragEnd}
            >
              <SortableContext items={visibleKeys} strategy={verticalListSortingStrategy}>
                {visible.map((entry) => {
                  const key = inboxEntryKey(entry);
                  return (
                    <InboxRow
                      key={key}
                      entry={entry}
                      now={now}
                      draggable={draggable}
                      selected={key === selectedKey}
                      expanded={key === expandedKey}
                      environmentLabel={
                        multiEnvironment ? environmentLabel(entry.environmentId) : null
                      }
                      projectTitle={projectFor(entry.item)?.title ?? null}
                      projects={projects}
                      onSelect={() => setSelectedKey(key)}
                      onToggleExpanded={() =>
                        setExpandedKey((current) => (current === key ? null : key))
                      }
                      onUpdate={(input) => update(entry, input, "Could not update inbox item")}
                      onStartThread={(projectRef) => void startThread(entry, projectRef)}
                      onOpenThread={(threadRef) =>
                        void navigate({
                          to: "/$environmentId/$threadId",
                          params: {
                            environmentId: threadRef.environmentId,
                            threadId: threadRef.threadId,
                          },
                        })
                      }
                      onDelete={() => void removeItem(entry)}
                    />
                  );
                })}
              </SortableContext>
            </DndContext>
          )}
        </div>
        <footer className="hidden gap-3 border-t px-6 py-2 text-muted-foreground text-xs sm:flex">
          <span>
            <Kbd>j</Kbd>/<Kbd>k</Kbd> move
          </span>
          <span>
            <Kbd>e</Kbd> done
          </span>
          <span>
            <Kbd>d</Kbd> dismiss
          </span>
          <span>
            <Kbd>0</Kbd>–<Kbd>4</Kbd> priority
          </span>
          <span>
            <Kbd>⌥↑</Kbd> reorder
          </span>
          <span>
            <Kbd>Enter</Kbd> details
          </span>
          <span>
            <Kbd>o</Kbd> open link
          </span>
        </footer>
      </div>
    </SidebarInset>
  );
}

interface InboxRowProps {
  readonly entry: InboxEntry;
  readonly now: number;
  readonly draggable: boolean;
  readonly selected: boolean;
  readonly expanded: boolean;
  readonly environmentLabel: string | null;
  readonly projectTitle: string | null;
  readonly projects: ReturnType<typeof useProjects>;
  readonly onSelect: () => void;
  readonly onToggleExpanded: () => void;
  readonly onUpdate: (input: Omit<InboxUpdateInput, "id">) => Promise<void>;
  readonly onStartThread: (projectRef: ReturnType<typeof scopeProjectRef>) => void;
  readonly onOpenThread: (threadRef: ReturnType<typeof scopeThreadRef>) => void;
  readonly onDelete: () => void;
}

function InboxRow(props: InboxRowProps) {
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
          onClick={props.onToggleExpanded}
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
        {props.expanded ? <InboxItemDetails entry={entry} onUpdate={props.onUpdate} /> : null}
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

function PriorityMenu(props: {
  readonly priority: number;
  readonly onChange: (priority: number) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={`Priority: ${INBOX_PRIORITY_LABELS[props.priority]}`}
            className="mt-0.5 shrink-0"
          />
        }
      >
        <Badge variant={PRIORITY_BADGE[props.priority] ?? "outline"} size="sm">
          {props.priority === 4 ? "–" : `P${props.priority}`}
        </Badge>
      </MenuTrigger>
      <MenuPopup align="start">
        {INBOX_PRIORITY_LABELS.map((label, priority) => (
          <MenuItem
            key={label}
            disabled={priority === props.priority}
            onClick={() => props.onChange(priority)}
          >
            {priority === 4 ? "No priority" : `P${priority} · ${label}`}
            <MenuShortcut>{priority}</MenuShortcut>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function SnoozeMenu(props: {
  readonly snoozed: boolean;
  readonly onSnooze: (snoozedUntil: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  // Presets are relative to when the menu opens, not when the row rendered.
  const presets = useMemo(() => (open ? resolveSnoozePresets(new Date()) : []), [open]);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger render={<Button size="icon-xs" variant="ghost-muted" aria-label="Snooze" />}>
        <AlarmClockIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        {presets.map((preset) => (
          <MenuItem key={preset.id} onClick={() => props.onSnooze(preset.snoozedUntil)}>
            {preset.label}
            <MenuShortcut>{preset.whenLabel}</MenuShortcut>
          </MenuItem>
        ))}
        {props.snoozed ? (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => props.onSnooze(null)}>Unsnooze</MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

function StartThreadMenu(props: {
  readonly project: ReturnType<typeof useProjects>[number] | null;
  readonly projects: ReturnType<typeof useProjects>;
  readonly onStart: (projectRef: ReturnType<typeof scopeProjectRef>) => void;
}) {
  if (props.project !== null) {
    const project = props.project;
    return (
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label={`Start a thread in ${project.title}`}
        onClick={() => props.onStart(scopeProjectRef(project.environmentId, project.id))}
      >
        <MessageSquarePlusIcon />
      </Button>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        render={<Button size="icon-xs" variant="ghost-muted" aria-label="Start a thread" />}
      >
        <MessageSquarePlusIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>Start a thread in</MenuGroupLabel>
          {props.projects.length === 0 ? <MenuItem disabled>No projects yet</MenuItem> : null}
          {props.projects.map((project) => (
            <MenuItem
              key={`${project.environmentId}:${project.id}`}
              onClick={() => props.onStart(scopeProjectRef(project.environmentId, project.id))}
            >
              {project.title}
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

function InboxThreadChip(props: {
  readonly threadRef: ReturnType<typeof scopeThreadRef>;
  readonly onOpen: (threadRef: ReturnType<typeof scopeThreadRef>) => void;
}) {
  const thread = useThreadShell(props.threadRef);
  // A linked draft that was never sent, or a deleted thread, has no shell to show.
  if (thread === null) return null;
  const pullRequest = thread.pullRequests[0] ?? null;
  return (
    <>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          props.onOpen(props.threadRef);
        }}
        className="inline-flex max-w-56 items-center gap-1 truncate underline-offset-2 hover:underline"
      >
        <MessageSquarePlusIcon className="size-3 shrink-0" />
        <span className="truncate">{thread.title}</span>
      </button>
      {thread.branch ? (
        <span className="inline-flex items-center gap-1">
          <GitBranchIcon className="size-3" />
          {thread.branch}
        </span>
      ) : null}
      {thread.worktreePath ? (
        <span className="inline-flex items-center gap-1">
          <FolderGit2Icon className="size-3" />
          {thread.worktreePath.split("/").at(-1)}
        </span>
      ) : null}
      {pullRequest ? (
        <a
          href={pullRequest.url}
          target="_blank"
          rel="noopener noreferrer"
          className="underline-offset-2 hover:underline"
          onClick={(event) => event.stopPropagation()}
        >
          #{pullRequest.number}
        </a>
      ) : null}
    </>
  );
}

function InboxItemDetails(props: {
  readonly entry: InboxEntry;
  readonly onUpdate: (input: Omit<InboxUpdateInput, "id">) => Promise<void>;
}) {
  const { item } = props.entry;
  const [title, setTitle] = useState(item.title);
  const [body, setBody] = useState(item.body ?? "");
  const [branch, setBranch] = useState(item.branch ?? "");
  const [worktreePath, setWorktreePath] = useState(item.worktreePath ?? "");
  const [pullRequests, setPullRequests] = useState(item.pullRequestUrls.join("\n"));
  const save = () => {
    const nextTitle = title.trim();
    const nextPullRequests = pullRequests
      .split(/\s+/)
      .map((url) => url.trim())
      .filter((url) => url.length > 0);
    void props.onUpdate({
      ...(nextTitle.length > 0 && nextTitle !== item.title ? { title: nextTitle } : {}),
      ...(body !== (item.body ?? "") ? { body: body.length > 0 ? body : null } : {}),
      ...(branch.trim() !== (item.branch ?? "") ? { branch: branch.trim() || null } : {}),
      ...(worktreePath.trim() !== (item.worktreePath ?? "")
        ? { worktreePath: worktreePath.trim() || null }
        : {}),
      ...(nextPullRequests.join("\n") !== item.pullRequestUrls.join("\n")
        ? { pullRequestUrls: nextPullRequests }
        : {}),
    });
  };
  return (
    <div
      className="mt-2 grid gap-2"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <Input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={save}
        aria-label="Title"
      />
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onBlur={save}
        placeholder="Notes and context. This is sent to the agent when you start a thread."
        aria-label="Notes"
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <Input
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          onBlur={save}
          placeholder="Branch"
          aria-label="Branch"
        />
        <Input
          value={worktreePath}
          onChange={(e) => setWorktreePath(e.target.value)}
          onBlur={save}
          placeholder="Worktree path"
          aria-label="Worktree path"
        />
      </div>
      <Textarea
        value={pullRequests}
        onChange={(e) => setPullRequests(e.target.value)}
        onBlur={save}
        placeholder="Pull request URLs, one per line"
        aria-label="Pull request URLs"
      />
    </div>
  );
}
