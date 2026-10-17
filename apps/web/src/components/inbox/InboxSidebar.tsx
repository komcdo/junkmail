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
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  inboxEntryKey,
  inboxItemView,
  selectInboxView,
  type InboxEntry,
  type InboxView,
} from "@t3tools/client-runtime/state/inbox";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { useNavigate, useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  CheckIcon,
  ChevronRightIcon,
  InboxIcon,
  ListIcon,
  Maximize2Icon,
  MoreHorizontalIcon,
  PlusIcon,
  RotateCcwIcon,
  SearchIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import { isElectron } from "../../env";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { startNewThreadFromContext } from "../../lib/chatThreadActions";
import { cn } from "../../lib/utils";
import { useThreadShells } from "../../state/entities";
import { resolveThreadRouteRef } from "../../threadRoutes";
import {
  filterSidebarV2VisibleThreads,
  resolveSidebarThreadStatus,
  type SidebarThreadStatus,
} from "../Sidebar.logic";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SidebarContent, SidebarGroup, SidebarInput, useSidebar } from "../ui/sidebar";
import { PRIORITY_BADGE, SnoozeMenu } from "./InboxItemParts";
import { InboxRow } from "./InboxRow";
import { usePrimarySidebarMode } from "./sidebarMode";
import { useInboxController } from "./useInboxController";

interface InboxSection {
  readonly view: InboxView;
  readonly label: string;
  /** Manual order applies; other views sort by wake or close time. */
  readonly sortable: boolean;
}

const SECTIONS: ReadonlyArray<InboxSection> = [
  { view: "inbox", label: "Inbox", sortable: true },
  { view: "in_progress", label: "In progress", sortable: true },
  { view: "waiting", label: "Waiting", sortable: true },
  { view: "snoozed", label: "Snoozed", sortable: false },
  { view: "done", label: "Done", sortable: false },
  { view: "dismissed", label: "Dismissed", sortable: false },
];
const UNFILED_INITIAL_COUNT = 8;
const COLLAPSED_SECTIONS_KEY = "junkmail:inbox-sidebar:collapsed";
const CollapsedSectionsSchema = Schema.Array(Schema.String);
const DEFAULT_COLLAPSED: ReadonlyArray<string> = ["done", "dismissed"];

const STATUS_DOT: Partial<Record<SidebarThreadStatus, { label: string; className: string }>> = {
  working: { label: "Working", className: "bg-info" },
  approval: { label: "Needs approval", className: "bg-warning" },
  input: { label: "Needs input", className: "bg-indigo-500" },
  failed: { label: "Failed", className: "bg-destructive" },
  limited: { label: "Usage limited", className: "bg-warning" },
};

function matchesQuery(text: string, query: string) {
  return query.length === 0 || text.toLowerCase().includes(query);
}

function formatWake(snoozedUntil: string) {
  return new Date(snoozedUntil).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * junkmail: the inbox as the primary sidebar. `full` fills the window when nothing is open;
 * otherwise it sits beside the selected thread or item. Items with a thread open the thread;
 * items without one open their detail pane. Threads no item claims stay under "Unfiled".
 */
export function InboxSidebar(props: { readonly full: boolean }) {
  const { full } = props;
  const controller = useInboxController();
  const { entries, now, update, move, openThread, fileThread } = controller;
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const [, setSidebarMode] = usePrimarySidebarMode();
  const { activeDraftThread, activeThread, defaultProjectRef, handleNewThread } =
    useHandleNewThread();
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const shells = useThreadShells();
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [unfiledCount, setUnfiledCount] = useState(UNFILED_INITIAL_COUNT);
  const [collapsed, setCollapsed] = useLocalStorage(
    COLLAPSED_SECTIONS_KEY,
    DEFAULT_COLLAPSED,
    CollapsedSectionsSchema,
  );
  const addInputRef = useRef<HTMLInputElement | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const showAddInput = full || adding;

  const shellsByKey = useMemo(
    () => new Map(shells.map((shell) => [`${shell.environmentId}:${shell.id}`, shell])),
    [shells],
  );
  const projectsByKey = useMemo(
    () =>
      new Map(
        controller.projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
      ),
    [controller.projects],
  );
  // Linked threads live in the item's project environment, which may differ from the item's.
  const linkedShells = (entry: InboxEntry): EnvironmentThreadShell[] => {
    const environmentId = controller.projectFor(entry.item)?.environmentId ?? entry.environmentId;
    return entry.item.threadIds
      .flatMap((threadId) => shellsByKey.get(`${environmentId}:${threadId}`) ?? [])
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };

  const sections = SECTIONS.map((section) => ({
    ...section,
    collapsed: collapsed.includes(section.view),
    entries: selectInboxView(entries, section.view, now).filter((entry) =>
      matchesQuery(entry.item.title, normalizedQuery),
    ),
  }));
  const navigable = sections.flatMap((section) => (section.collapsed ? [] : section.entries));

  const linkedThreadIds = useMemo(() => {
    const ids = new Set<string>();
    for (const { item } of entries) {
      if (item.state === "done" || item.state === "dismissed") continue;
      for (const threadId of item.threadIds) ids.add(threadId);
    }
    return ids;
  }, [entries]);
  const unfiled = useMemo(() => {
    const nowIso = new Date(now).toISOString();
    return filterSidebarV2VisibleThreads(shells, null)
      .filter(
        (shell) =>
          shell.deletedAt === null &&
          shell.settledOverride !== "settled" &&
          !effectiveSnoozed(shell, { now: nowIso }) &&
          !linkedThreadIds.has(shell.id),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [linkedThreadIds, now, shells]);
  const visibleUnfiled = unfiled.filter((shell) => matchesQuery(shell.title, normalizedQuery));

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const sectionOf = (key: string) =>
    sections.find((section) => section.entries.some((entry) => inboxEntryKey(entry) === key));
  // Reorders stay within a section; moving between sections is a state change.
  const reorderWithin = (movedKey: string, targetKey: string) => {
    const section = sectionOf(movedKey);
    if (section === undefined || !section.sortable) return;
    const keys = section.entries.map(inboxEntryKey);
    const from = keys.indexOf(movedKey);
    const to = keys.indexOf(targetKey);
    if (from === -1 || to === -1 || from === to) return;
    void move(movedKey, arrayMove(keys, from, to));
  };
  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over === null) return;
    reorderWithin(String(event.active.id), String(event.over.id));
  };

  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const openEntry = (entry: InboxEntry) => {
    closeMobile();
    setSelectedKey(inboxEntryKey(entry));
    const latest = linkedShells(entry)[0];
    if (latest !== undefined) {
      openThread(scopeThreadRef(latest.environmentId, latest.id));
      return;
    }
    void navigate({ to: "/inbox", search: { item: inboxEntryKey(entry) } });
  };
  const expandInbox = () => {
    closeMobile();
    void navigate({ to: "/inbox" });
  };
  const submitDraft = async () => {
    const title = draftTitle.trim();
    if (title.length === 0) return;
    setDraftTitle("");
    await controller.addItem({ title });
  };
  const toggleSection = (view: string) =>
    setCollapsed((current) =>
      current.includes(view) ? current.filter((key) => key !== view) : [...current, view],
    );

  const selected = navigable.find((entry) => inboxEntryKey(entry) === selectedKey) ?? null;
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey) return;
    const index = selected === null ? -1 : navigable.indexOf(selected);
    const select = (next: number) => {
      const entry = navigable[Math.max(0, Math.min(navigable.length - 1, next))];
      if (entry) setSelectedKey(inboxEntryKey(entry));
    };
    const key = event.key;
    if (key === "j" || key === "ArrowDown") {
      if (event.altKey && selected !== null) {
        const next = navigable[index + 1];
        if (next) reorderWithin(inboxEntryKey(selected), inboxEntryKey(next));
      } else select(index + 1);
    } else if (key === "k" || key === "ArrowUp") {
      if (event.altKey && selected !== null) {
        const previous = navigable[index - 1];
        if (previous) reorderWithin(inboxEntryKey(selected), inboxEntryKey(previous));
      } else select(index - 1);
    } else if (selected === null) return;
    else if (key === "Enter") openEntry(selected);
    else if (key === "e") void update(selected, { state: "done" });
    else if (key === "d") void update(selected, { state: "dismissed" });
    else if (key === "u") void update(selected, { snoozedUntil: null });
    else if (/^[0-4]$/.test(key)) void update(selected, { priority: Number(key) });
    else if (key === "o" && selected.item.origin.url) {
      window.open(selected.item.origin.url, "_blank", "noopener");
    } else return;
    event.preventDefault();
  };

  const renderEntry = (section: (typeof sections)[number], entry: InboxEntry) => {
    const key = inboxEntryKey(entry);
    const linked = linkedShells(entry);
    const draggable = section.sortable && normalizedQuery.length === 0;
    if (full) {
      return (
        <InboxRow
          key={key}
          entry={entry}
          now={now}
          draggable={draggable}
          selected={key === selectedKey}
          environmentLabel={
            controller.multiEnvironment ? controller.environmentLabel(entry.environmentId) : null
          }
          projectTitle={controller.projectFor(entry.item)?.title ?? null}
          projects={controller.projects}
          onSelect={() => setSelectedKey(key)}
          onOpen={() => openEntry(entry)}
          onUpdate={(input) => update(entry, input)}
          onStartThread={(projectRef) => void controller.startThread(entry, projectRef)}
          onOpenThread={openThread}
          onDelete={() => void controller.removeItem(entry)}
        />
      );
    }
    const project = entry.item.projectId
      ? projectsByKey.get(
          `${linked[0]?.environmentId ?? entry.environmentId}:${entry.item.projectId}`,
        )
      : undefined;
    return (
      <InboxSidebarRow
        key={key}
        entry={entry}
        now={now}
        thread={linked[0] ?? null}
        projectTitle={project?.title ?? null}
        environmentLabel={
          controller.multiEnvironment ? controller.environmentLabel(entry.environmentId) : null
        }
        active={
          routeThreadRef !== null &&
          linked.some(
            (shell) =>
              shell.id === routeThreadRef.threadId &&
              shell.environmentId === routeThreadRef.environmentId,
          )
        }
        draggable={draggable}
        onOpen={() => openEntry(entry)}
        onUpdate={(input) => void update(entry, input)}
      />
    );
  };

  const header = (
    <SidebarGroup className="z-[1]">
      <div className={cn("flex flex-col gap-1", full && "mx-auto w-full max-w-4xl")}>
        <div className="flex items-center gap-1">
          <div className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground">
            <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
            <SidebarInput
              nativeInput
              type="search"
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setQuery("");
              }}
              placeholder="Search"
              aria-label="Search inbox"
              className="min-w-0 flex-1"
            />
          </div>
          {full ? null : (
            <>
              <SidebarHeaderIconButton
                label="Add to inbox"
                disabled={controller.createEnvironmentId === null}
                onClick={() => {
                  setAdding(true);
                  queueMicrotask(() => addInputRef.current?.focus());
                }}
              >
                <PlusIcon />
              </SidebarHeaderIconButton>
              <SidebarHeaderIconButton label="Expand inbox" onClick={expandInbox}>
                <Maximize2Icon />
              </SidebarHeaderIconButton>
            </>
          )}
          <SidebarHeaderIconButton
            label="New thread"
            onClick={() =>
              void startNewThreadFromContext({
                activeDraftThread,
                activeThread: activeThread ?? undefined,
                defaultProjectRef,
                handleNewThread,
              })
            }
          >
            <SquarePenIcon />
          </SidebarHeaderIconButton>
          <Menu>
            <MenuTrigger render={<SidebarHeaderIconButton label="Inbox options" />}>
              <MoreHorizontalIcon />
            </MenuTrigger>
            <MenuPopup align="end">
              {SECTIONS.map((section) => (
                <MenuItem key={section.view} onClick={() => toggleSection(section.view)}>
                  {collapsed.includes(section.view) ? "Show" : "Hide"} {section.label}
                </MenuItem>
              ))}
              <MenuSeparator />
              <MenuItem onClick={() => setSidebarMode("threads")}>
                <ListIcon />
                Show thread list instead
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
        {showAddInput ? (
          <form
            className="flex items-center gap-1 px-1"
            onSubmit={(event) => {
              event.preventDefault();
              void submitDraft();
            }}
          >
            <SidebarInput
              ref={addInputRef}
              value={draftTitle}
              disabled={controller.createEnvironmentId === null}
              onChange={(event) => setDraftTitle(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setDraftTitle("");
                  setAdding(false);
                }
              }}
              placeholder={
                controller.createEnvironmentId === null
                  ? "Connect an environment to add items"
                  : "Add a work item, then Enter"
              }
              aria-label="New inbox item"
              className="min-w-0 flex-1"
            />
            {full ? null : (
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Cancel"
                onClick={() => {
                  setDraftTitle("");
                  setAdding(false);
                }}
              >
                <XIcon />
              </Button>
            )}
          </form>
        ) : null}
        {controller.snapshot.errors.map((error) => (
          <p key={error} className="px-2 text-destructive-foreground text-xs">
            {error}
          </p>
        ))}
      </div>
    </SidebarGroup>
  );

  return (
    <>
      <SidebarChromeHeader isElectron={isElectron} />
      <SidebarContent className="min-h-full" fixedHeader={header}>
        <div
          tabIndex={full ? 0 : -1}
          onKeyDown={full ? onListKeyDown : undefined}
          aria-label="Inbox items"
          className={cn("flex flex-col outline-none", full && "mx-auto w-full max-w-4xl")}
        >
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={handleDragEnd}
          >
            {sections.map((section) =>
              section.entries.length === 0 && section.view !== "inbox" ? null : (
                <SidebarGroup key={section.view}>
                  <div className="flex flex-col gap-0.5">
                    <SectionHeader
                      label={section.label}
                      count={section.entries.length}
                      collapsed={section.collapsed}
                      onToggle={() => toggleSection(section.view)}
                    />
                    {section.collapsed ? null : section.entries.length === 0 ? (
                      <p className="px-2 py-1 text-muted-foreground text-xs">
                        {normalizedQuery.length > 0
                          ? "No matches"
                          : "Inbox zero. Add work above, or let agents file it."}
                      </p>
                    ) : (
                      <SortableContext
                        items={section.entries.map(inboxEntryKey)}
                        strategy={verticalListSortingStrategy}
                      >
                        {section.entries.map((entry) => renderEntry(section, entry))}
                      </SortableContext>
                    )}
                  </div>
                </SidebarGroup>
              ),
            )}
          </DndContext>

          {visibleUnfiled.length > 0 ? (
            <SidebarGroup>
              <div className="flex flex-col gap-0.5">
                <SectionHeader
                  label="Unfiled threads"
                  count={visibleUnfiled.length}
                  collapsed={collapsed.includes("unfiled")}
                  onToggle={() => toggleSection("unfiled")}
                />
                {collapsed.includes("unfiled") ? null : (
                  <>
                    {visibleUnfiled.slice(0, unfiledCount).map((shell) => (
                      <UnfiledThreadRow
                        key={`${shell.environmentId}:${shell.id}`}
                        thread={shell}
                        projectTitle={
                          projectsByKey.get(`${shell.environmentId}:${shell.projectId}`)?.title ??
                          null
                        }
                        active={
                          routeThreadRef !== null &&
                          routeThreadRef.threadId === shell.id &&
                          routeThreadRef.environmentId === shell.environmentId
                        }
                        onOpen={() => {
                          closeMobile();
                          openThread(scopeThreadRef(shell.environmentId, shell.id));
                        }}
                        onFile={() => void fileThread(shell)}
                      />
                    ))}
                    {visibleUnfiled.length > unfiledCount ? (
                      <button
                        type="button"
                        className="px-2 py-1 text-left text-muted-foreground text-xs hover:text-foreground"
                        onClick={() => setUnfiledCount((count) => count + 25)}
                      >
                        Show {Math.min(25, visibleUnfiled.length - unfiledCount)} more
                      </button>
                    ) : null}
                  </>
                )}
              </div>
            </SidebarGroup>
          ) : null}

          {full ? (
            <SidebarGroup>
              <div className="flex flex-wrap gap-3 px-2 pb-2 text-muted-foreground text-xs">
                <span>
                  <Kbd>j</Kbd>/<Kbd>k</Kbd> move
                </span>
                <span>
                  <Kbd>Enter</Kbd> open
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
                  <Kbd>⌥↑</Kbd>/<Kbd>⌥↓</Kbd> reorder
                </span>
                <span>
                  <Kbd>o</Kbd> open link
                </span>
              </div>
            </SidebarGroup>
          ) : null}
        </div>
      </SidebarContent>
      <SidebarChromeFooter />
    </>
  );
}

function SectionHeader(props: {
  readonly label: string;
  readonly count: number;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={!props.collapsed}
      onClick={props.onToggle}
      className="flex h-6 items-center gap-1 rounded-md px-2 text-left font-medium text-sidebar-muted-foreground text-xs hover:text-sidebar-foreground"
    >
      <ChevronRightIcon
        className={cn("size-3 shrink-0 transition-transform", !props.collapsed && "rotate-90")}
      />
      <span>{props.label}</span>
      {props.count > 0 ? <span className="tabular-nums opacity-70">{props.count}</span> : null}
    </button>
  );
}

function ThreadStatusDot(props: { readonly thread: EnvironmentThreadShell | null }) {
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

function RowMeta(props: { readonly parts: ReadonlyArray<string | null> }) {
  const parts = [...new Set(props.parts.filter((part): part is string => !!part))];
  if (parts.length === 0) return null;
  return (
    <span className="truncate text-sidebar-muted-foreground text-xs">{parts.join(" · ")}</span>
  );
}

function InboxSidebarRow(props: {
  readonly entry: InboxEntry;
  readonly now: number;
  readonly thread: EnvironmentThreadShell | null;
  readonly projectTitle: string | null;
  readonly environmentLabel: string | null;
  readonly active: boolean;
  readonly draggable: boolean;
  readonly onOpen: () => void;
  readonly onUpdate: (input: {
    readonly state?: InboxEntry["item"]["state"];
    readonly snoozedUntil?: string | null;
  }) => void;
}) {
  const { item } = props.entry;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: inboxEntryKey(props.entry),
    disabled: !props.draggable,
  });
  const view = inboxItemView(item, props.now);
  const closed = view === "done" || view === "dismissed";
  const pullRequest = props.thread?.pullRequests[0] ?? null;
  const branch = item.branch ?? props.thread?.branch ?? null;
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      data-active={props.active || undefined}
      data-dragging={isDragging || undefined}
      className="group/row relative flex items-start gap-1.5 rounded-md px-2 py-1.5 hover:bg-sidebar-row-hover data-[active]:bg-sidebar-row-hover data-[dragging]:z-10 data-[dragging]:bg-sidebar data-[dragging]:shadow-md"
      {...attributes}
      {...listeners}
    >
      <button
        type="button"
        onClick={props.onOpen}
        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left outline-hidden"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {item.priority < 4 && !closed ? (
            <Badge variant={PRIORITY_BADGE[item.priority] ?? "outline"} size="sm">
              P{item.priority}
            </Badge>
          ) : null}
          <span
            className={cn(
              "truncate text-sm",
              closed ? "text-sidebar-muted-foreground line-through" : "text-sidebar-foreground",
            )}
          >
            {item.title}
          </span>
        </span>
        <RowMeta
          parts={[
            view === "snoozed" && item.snoozedUntil
              ? `Wakes ${formatWake(item.snoozedUntil)}`
              : null,
            item.origin.kind !== "manual" && item.origin.kind !== "thread"
              ? item.origin.kind
              : null,
            props.environmentLabel,
            props.projectTitle,
            branch,
            pullRequest ? `#${pullRequest.number}` : null,
          ]}
        />
      </button>
      <ThreadStatusDot thread={props.thread} />
      <div className="absolute top-1 right-1 hidden items-center gap-0.5 rounded-md bg-sidebar-row-hover group-hover/row:flex">
        {closed ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label={view === "dismissed" ? "Restore" : "Reopen"}
            onClick={() => props.onUpdate({ state: "open" })}
          >
            <RotateCcwIcon />
          </Button>
        ) : (
          <>
            <SnoozeMenu
              snoozed={view === "snoozed"}
              onSnooze={(snoozedUntil) => props.onUpdate({ snoozedUntil })}
            />
            <Button
              size="icon-xs"
              variant="ghost-muted"
              aria-label="Mark done"
              onClick={() => props.onUpdate({ state: "done" })}
            >
              <CheckIcon />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function UnfiledThreadRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly projectTitle: string | null;
  readonly active: boolean;
  readonly onOpen: () => void;
  readonly onFile: () => void;
}) {
  return (
    <div
      data-active={props.active || undefined}
      className="group/row relative flex items-start gap-1.5 rounded-md px-2 py-1.5 hover:bg-sidebar-row-hover data-[active]:bg-sidebar-row-hover"
    >
      <button
        type="button"
        onClick={props.onOpen}
        className="flex min-w-0 flex-1 flex-col gap-0.5 text-left outline-hidden"
      >
        <span className="truncate text-sidebar-muted-foreground text-sm group-hover/row:text-sidebar-foreground">
          {props.thread.title}
        </span>
        <RowMeta parts={[props.projectTitle, props.thread.branch]} />
      </button>
      <ThreadStatusDot thread={props.thread} />
      <div className="absolute top-1 right-1 hidden items-center rounded-md bg-sidebar-row-hover group-hover/row:flex">
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="File in inbox"
          onClick={props.onFile}
        >
          <InboxIcon />
        </Button>
      </div>
    </div>
  );
}
