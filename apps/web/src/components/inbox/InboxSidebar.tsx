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
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  INBOX_VIEWS,
  countInboxView,
  inboxEntryKey,
  selectInboxView,
  type InboxEntry,
  type InboxView,
} from "@t3tools/client-runtime/state/inbox";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { useNavigate, useParams } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  ChevronRightIcon,
  InboxIcon,
  ListIcon,
  Maximize2Icon,
  MoreHorizontalIcon,
  PlusIcon,
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
import { filterSidebarV2VisibleThreads } from "../Sidebar.logic";
import { SidebarChromeFooter, SidebarChromeHeader } from "../sidebar/SidebarChrome";
import { SidebarHeaderIconButton } from "../sidebar/SidebarThreadHeader";
import { Button } from "../ui/button";
import { Kbd } from "../ui/kbd";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { SidebarContent, SidebarGroup, SidebarInput, useSidebar } from "../ui/sidebar";
import { InboxItemExpanded } from "./InboxItemExpanded";
import { InboxLabelChip } from "./InboxLabels";
import { InboxRow, ThreadStatusDot } from "./InboxRow";
import { usePrimarySidebarMode } from "./sidebarMode";
import { useInboxController } from "./useInboxController";
import { useInboxActivityMatches } from "./useMergedInbox";

const MANUAL_ORDER_VIEWS: ReadonlySet<InboxView> = new Set(["inbox", "in_progress", "waiting"]);
const InboxViewSchema = Schema.Literals(INBOX_VIEWS.map((view) => view.id));
const VIEW_KEY = "junkmail:inbox-sidebar:view";
const UNFILED_KEY = "junkmail:inbox-sidebar:unfiled-collapsed";
const UNFILED_INITIAL_COUNT = 8;

function matchesQuery(entry: InboxEntry, query: string) {
  if (query.length === 0) return true;
  const { item } = entry;
  return [item.title, item.body, item.lastActivity?.body, item.lastActivity?.author, ...item.labels]
    .filter((text): text is string => typeof text === "string")
    .some((text) => text.toLowerCase().includes(query));
}

function hasLabel(entry: InboxEntry, label: string | null) {
  if (label === null) return true;
  const wanted = label.toLowerCase();
  return entry.item.labels.some((candidate) => candidate.toLowerCase() === wanted);
}

/**
 * junkmail: the inbox as the app's primary surface. `full` fills the window; otherwise it sits
 * beside an open thread. Items expand in place. Threads no item claims stay under "Unfiled".
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
  const [view, setView] = useLocalStorage<InboxView, InboxView>(VIEW_KEY, "inbox", InboxViewSchema);
  const [unfiledCollapsed, setUnfiledCollapsed] = useLocalStorage(
    UNFILED_KEY,
    false,
    Schema.Boolean,
  );
  const [query, setQuery] = useState("");
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<{ key: string; newCount: number } | null>(null);
  const [unfiledCount, setUnfiledCount] = useState(UNFILED_INITIAL_COUNT);
  const addInputRef = useRef<HTMLInputElement | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const activityMatches = useInboxActivityMatches(normalizedQuery);
  const showAddInput = full || adding;

  const shellsByKey = useMemo(
    () => new Map(shells.map((shell) => [`${shell.environmentId}:${shell.id}`, shell])),
    [shells],
  );
  const threadEnvironmentOf = (entry: InboxEntry) =>
    controller.projectFor(entry.item)?.environmentId ?? entry.environmentId;
  // Linked threads live in the item's project environment, which may differ from the item's.
  const linkedShells = (entry: InboxEntry): EnvironmentThreadShell[] => {
    const environmentId = threadEnvironmentOf(entry);
    return entry.item.threadIds
      .flatMap((threadId) => shellsByKey.get(`${environmentId}:${threadId}`) ?? [])
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };

  const labelSuggestions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const { item } of entries) {
      for (const label of item.labels) {
        if (!seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label);
      }
    }
    return [...seen.values()].sort((a, b) => a.localeCompare(b));
  }, [entries]);
  const labelled = useMemo(
    () => entries.filter((entry) => hasLabel(entry, labelFilter)),
    [entries, labelFilter],
  );
  const counts = useMemo(
    () => new Map(INBOX_VIEWS.map(({ id }) => [id, countInboxView(labelled, id, now)])),
    [labelled, now],
  );
  const visible = useMemo(
    () =>
      selectInboxView(labelled, view, now).filter(
        (entry) =>
          matchesQuery(entry, normalizedQuery) || activityMatches.has(inboxEntryKey(entry)),
      ),
    [labelled, view, now, normalizedQuery, activityMatches],
  );
  const visibleKeys = useMemo(() => visible.map(inboxEntryKey), [visible]);
  const sortable = MANUAL_ORDER_VIEWS.has(view) && normalizedQuery.length === 0;

  // Threads of open items are filed; threads of closed items reappear as unfiled once active.
  const { openLinkedIds, allLinkedIds } = useMemo(() => {
    const open = new Set<string>();
    const all = new Set<string>();
    for (const { item } of entries) {
      const closed = item.state === "done" || item.state === "dismissed";
      for (const threadId of item.threadIds) {
        all.add(threadId);
        if (!closed) open.add(threadId);
      }
    }
    return { openLinkedIds: open, allLinkedIds: all };
  }, [entries]);
  // Threads no item claims, shelved like the upstream sidebar: snoozed under Snoozed, settled under Done.
  const unfiledByView = useMemo(() => {
    const nowIso = new Date(now).toISOString();
    const byView = { inbox: [], snoozed: [], done: [] } as Record<
      "inbox" | "snoozed" | "done",
      EnvironmentThreadShell[]
    >;
    for (const shell of filterSidebarV2VisibleThreads(shells, null)) {
      if (shell.deletedAt !== null) continue;
      if (normalizedQuery.length > 0 && !shell.title.toLowerCase().includes(normalizedQuery)) {
        continue;
      }
      if (shell.settledOverride === "settled") {
        if (!allLinkedIds.has(shell.id)) byView.done.push(shell);
      } else if (effectiveSnoozed(shell, { now: nowIso })) {
        if (!allLinkedIds.has(shell.id)) byView.snoozed.push(shell);
      } else if (!openLinkedIds.has(shell.id)) {
        byView.inbox.push(shell);
      }
    }
    for (const list of Object.values(byView))
      list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return byView;
  }, [allLinkedIds, normalizedQuery, now, openLinkedIds, shells]);
  const unfiledView = view === "inbox" || view === "snoozed" || view === "done" ? view : null;
  const unfiled = unfiledView === null ? [] : unfiledByView[unfiledView];
  const unfiledLabel =
    unfiledView === "done"
      ? "Settled threads"
      : unfiledView === "snoozed"
        ? "Snoozed threads"
        : "Unfiled threads";
  const showUnfiled = labelFilter === null && unfiled.length > 0;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const reorder = (movedKey: string, targetKey: string) => {
    if (!sortable) return;
    const from = visibleKeys.indexOf(movedKey);
    const to = visibleKeys.indexOf(targetKey);
    if (from === -1 || to === -1 || from === to) return;
    void move(movedKey, arrayMove(visibleKeys, from, to));
  };
  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over !== null) reorder(String(event.active.id), String(event.over.id));
  };

  const closeMobile = () => {
    if (isMobile) setOpenMobile(false);
  };
  const toggleExpanded = (entry: InboxEntry) => {
    const key = inboxEntryKey(entry);
    if (expanded?.key === key) {
      setExpanded(null);
      return;
    }
    // Opening an item is reading it: the "new" marker clears, but stays visible until it closes.
    setExpanded({ key, newCount: entry.item.unseenActivityCount });
    if (entry.item.unseenActivityCount > 0) void update(entry, { markSeen: true });
  };
  const openLinkedThread = (entry: InboxEntry) => {
    const latest = linkedShells(entry)[0];
    if (latest === undefined) return null;
    return () => {
      closeMobile();
      openThread(scopeThreadRef(latest.environmentId, latest.id));
    };
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
  const selectView = (next: InboxView) => {
    setView(next);
    setSelectedKey(null);
  };

  const selected = visible.find((entry) => inboxEntryKey(entry) === selectedKey) ?? null;
  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey) return;
    const index = selected === null ? -1 : visible.indexOf(selected);
    const select = (next: number) => {
      const entry = visible[Math.max(0, Math.min(visible.length - 1, next))];
      if (entry) setSelectedKey(inboxEntryKey(entry));
    };
    const key = event.key;
    if (key === "j" || key === "ArrowDown") {
      const next = visible[index + 1];
      if (event.altKey && selected !== null) {
        if (next) reorder(inboxEntryKey(selected), inboxEntryKey(next));
      } else select(index + 1);
    } else if (key === "k" || key === "ArrowUp") {
      const previous = visible[index - 1];
      if (event.altKey && selected !== null) {
        if (previous) reorder(inboxEntryKey(selected), inboxEntryKey(previous));
      } else select(index - 1);
    } else if (event.altKey && /^Digit[1-6]$/.test(event.code)) {
      const target = INBOX_VIEWS[Number(event.code.slice(5)) - 1];
      if (target) selectView(target.id);
    } else if (selected === null) return;
    else if (key === "Enter") toggleExpanded(selected);
    else if (key === "Escape") setExpanded(null);
    else if (key === "t") openLinkedThread(selected)?.();
    else if (key === "e") void update(selected, { state: "done" });
    else if (key === "d") void update(selected, { state: "dismissed" });
    else if (key === "u") void update(selected, { snoozedUntil: null });
    else if (/^[0-4]$/.test(key)) void update(selected, { priority: Number(key) });
    else if (key === "o" && selected.item.origin.url) {
      window.open(selected.item.origin.url, "_blank", "noopener");
    } else return;
    event.preventDefault();
  };

  const header = (
    <SidebarGroup className="z-[1]">
      <div className={cn("flex flex-col gap-1.5", full && "mx-auto w-full max-w-4xl")}>
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
            <SidebarHeaderIconButton label="Expand inbox" onClick={expandInbox}>
              <Maximize2Icon />
            </SidebarHeaderIconButton>
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
              {full ? null : (
                <MenuItem
                  disabled={controller.createEnvironmentId === null}
                  onClick={() => {
                    setAdding(true);
                    queueMicrotask(() => addInputRef.current?.focus());
                  }}
                >
                  <PlusIcon />
                  Add to inbox
                </MenuItem>
              )}
              <MenuItem onClick={() => setUnfiledCollapsed(!unfiledCollapsed)}>
                {unfiledCollapsed ? "Show" : "Hide"} unfiled threads
              </MenuItem>
              <MenuSeparator />
              <MenuItem onClick={() => setSidebarMode("threads")}>
                <ListIcon />
                Show thread list instead
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
        <nav
          className={cn(
            "flex gap-1 px-1",
            full ? "flex-wrap" : "-mx-1 overflow-x-auto px-2 [scrollbar-width:none]",
          )}
          aria-label="Inbox views"
        >
          {INBOX_VIEWS.map(({ id, label }) => {
            const count = counts.get(id) ?? 0;
            return (
              <Button
                key={id}
                size="xs"
                variant={view === id ? "outline" : "ghost-muted"}
                aria-pressed={view === id}
                onClick={() => selectView(id)}
              >
                {label}
                {count > 0 ? (
                  <span className="text-muted-foreground tabular-nums">{count}</span>
                ) : null}
              </Button>
            );
          })}
        </nav>
        {labelFilter !== null ? (
          <div className="flex items-center gap-1.5 px-2 text-muted-foreground text-xs">
            Label
            <InboxLabelChip label={labelFilter} onRemove={() => setLabelFilter(null)} />
          </div>
        ) : null}
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
          role="list"
          className={cn("flex flex-col outline-none", full && "mx-auto w-full max-w-4xl")}
        >
          <SidebarGroup>
            <div className="flex flex-col gap-0.5">
              {visible.length === 0 && showUnfiled ? null : visible.length === 0 ? (
                <p className="px-2 py-6 text-center text-muted-foreground text-sm">
                  {controller.snapshot.loading
                    ? "Loading…"
                    : normalizedQuery.length > 0 || labelFilter !== null
                      ? "No matching items."
                      : view === "inbox"
                        ? "Inbox zero. Add work above, or let agents and pullers file it."
                        : "Nothing here."}
                </p>
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
                      const linked = linkedShells(entry);
                      const isExpanded = expanded?.key === key;
                      return (
                        <InboxRow
                          key={key}
                          rowKey={key}
                          entry={entry}
                          now={now}
                          density={full ? "full" : "compact"}
                          thread={linked[0] ?? null}
                          projectTitle={controller.projectFor(entry.item)?.title ?? null}
                          environmentLabel={
                            controller.multiEnvironment
                              ? controller.environmentLabel(entry.environmentId)
                              : null
                          }
                          active={
                            routeThreadRef !== null &&
                            linked.some(
                              (shell) =>
                                shell.id === routeThreadRef.threadId &&
                                shell.environmentId === routeThreadRef.environmentId,
                            )
                          }
                          selected={full && key === selectedKey}
                          expanded={isExpanded}
                          draggable={sortable && !isExpanded}
                          labelFilter={labelFilter}
                          onToggle={() => toggleExpanded(entry)}
                          onSelect={() => setSelectedKey(key)}
                          onUpdate={(input) => update(entry, input)}
                          onOpenThread={openLinkedThread(entry)}
                          onLabelClick={(label) =>
                            setLabelFilter((current) =>
                              current?.toLowerCase() === label.toLowerCase() ? null : label,
                            )
                          }
                          onDelete={() => void controller.removeItem(entry)}
                          onCopyContext={() => void controller.copyContext(entry)}
                        >
                          {isExpanded ? (
                            <InboxItemExpanded
                              entry={entry}
                              newActivityCount={expanded.newCount}
                              labelSuggestions={labelSuggestions}
                              projects={controller.projects}
                              threadEnvironmentId={threadEnvironmentOf(entry)}
                              onUpdate={(input) => update(entry, input)}
                              onStartThread={(projectRef) =>
                                void controller.startThread(entry, projectRef)
                              }
                              onOpenThread={(threadRef) => {
                                closeMobile();
                                openThread(threadRef);
                              }}
                              onCopyContext={() => void controller.copyContext(entry)}
                            />
                          ) : null}
                        </InboxRow>
                      );
                    })}
                  </SortableContext>
                </DndContext>
              )}
            </div>
          </SidebarGroup>

          {showUnfiled ? (
            <SidebarGroup>
              <div className="flex flex-col gap-0.5">
                <button
                  type="button"
                  aria-expanded={!unfiledCollapsed}
                  onClick={() => setUnfiledCollapsed(!unfiledCollapsed)}
                  className="flex h-6 items-center gap-1 rounded-md px-2 text-left font-medium text-sidebar-muted-foreground text-xs hover:text-sidebar-foreground"
                >
                  <ChevronRightIcon
                    className={cn(
                      "size-3 shrink-0 transition-transform",
                      !unfiledCollapsed && "rotate-90",
                    )}
                  />
                  {unfiledLabel}
                  <span className="tabular-nums opacity-70">{unfiled.length}</span>
                </button>
                {unfiledCollapsed ? null : (
                  <>
                    {unfiled.slice(0, unfiledCount).map((shell) => (
                      <UnfiledThreadRow
                        key={`${shell.environmentId}:${shell.id}`}
                        thread={shell}
                        projectTitle={
                          controller.projects.find(
                            (project) =>
                              project.id === shell.projectId &&
                              project.environmentId === shell.environmentId,
                          )?.title ?? null
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
                    {unfiled.length > unfiledCount ? (
                      <button
                        type="button"
                        className="px-2 py-1 text-left text-muted-foreground text-xs hover:text-foreground"
                        onClick={() => setUnfiledCount((count) => count + 25)}
                      >
                        Show {Math.min(25, unfiled.length - unfiledCount)} more
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
                  <Kbd>Enter</Kbd> details
                </span>
                <span>
                  <Kbd>t</Kbd> open thread
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
                  <Kbd>⌥1</Kbd>–<Kbd>⌥6</Kbd> tabs
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

function UnfiledThreadRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly projectTitle: string | null;
  readonly active: boolean;
  readonly onOpen: () => void;
  readonly onFile: () => void;
}) {
  const meta = [props.projectTitle, props.thread.branch].filter(Boolean).join(" · ");
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
        {meta ? <span className="truncate text-muted-foreground text-xs">{meta}</span> : null}
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
