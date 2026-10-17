import { scopeProjectRef, type scopeThreadRef } from "@t3tools/client-runtime/environment";
import { INBOX_PRIORITY_LABELS, type InboxEntry } from "@t3tools/client-runtime/state/inbox";
import { resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";
import type { InboxUpdateInput } from "@t3tools/contracts";
import { AlarmClockIcon, FolderGit2Icon, GitBranchIcon, MessageSquarePlusIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useProjects, useThreadShell } from "../../state/entities";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
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
import { Textarea } from "../ui/textarea";

export const PRIORITY_BADGE = ["error", "warning", "info", "outline", "outline"] as const;

export function PriorityMenu(props: {
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

export function SnoozeMenu(props: {
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

export function StartThreadMenu(props: {
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

export function InboxThreadChip(props: {
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

export function InboxItemDetails(props: {
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
