import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  applyInboxOrderUpdates,
  planInboxReorder,
  type InboxEntry,
  type InboxOrderUpdate,
} from "@t3tools/client-runtime/state/inbox";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  renderInboxItemPrompt,
  type EnvironmentId,
  type InboxItem,
  type InboxUpdateInput,
  type ThreadId,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { requestConfirmDialog } from "../../confirmDialog";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { useProjects } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { useInboxClock, useMergedInbox } from "./useMergedInbox";

export type InboxProjectRef = ReturnType<typeof scopeProjectRef>;
export type InboxThreadRef = ReturnType<typeof scopeThreadRef>;

export function reportInboxFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: String(squashAtomCommandFailure(result)),
    }),
  );
}

/** Inbox state and actions shared by the inbox page and the inbox sidebar. */
export function useInboxController() {
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
  const loadActivity = useAtomCommand(serverEnvironment.loadInboxActivity, {
    label: "inbox load activity",
    reportFailure: false,
  });

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
    async (entry: InboxEntry, input: Omit<InboxUpdateInput, "id">, failure?: string) => {
      const result = await updateItem({
        environmentId: entry.environmentId,
        input: { id: entry.item.id, ...input },
      });
      reportInboxFailure(failure ?? "Could not update inbox item", result);
    },
    [updateItem],
  );

  const addItem = useCallback(
    async (input: { readonly title: string; readonly threadId?: ThreadId }) => {
      const title = input.title.trim();
      if (title.length === 0 || createEnvironmentId === null) return;
      const result = await createItem({
        environmentId: createEnvironmentId,
        input: {
          title,
          ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        },
      });
      reportInboxFailure("Could not add inbox item", result);
    },
    [createEnvironmentId, createItem],
  );

  // A thread origin keyed by thread id makes filing idempotent: a second click updates the item.
  const fileThread = useCallback(
    async (thread: {
      readonly environmentId: EnvironmentId;
      readonly id: ThreadId;
      readonly projectId: InboxItem["projectId"];
      readonly title: string;
    }) => {
      const created = await createItem({
        environmentId: thread.environmentId,
        input: {
          title: thread.title.trim() || "Untitled thread",
          projectId: thread.projectId,
          origin: { kind: "thread", externalKey: thread.id },
          threadId: thread.id,
        },
      });
      reportInboxFailure("Could not file the thread", created);
      if (created._tag !== "Success") return;
      const result = await updateItem({
        environmentId: thread.environmentId,
        input: { id: created.value.item.id, state: "in_progress" },
      });
      reportInboxFailure("Could not update inbox item", result);
    },
    [createItem, updateItem],
  );

  const projectFor = useCallback(
    (item: InboxItem) => projects.find((project) => project.id === item.projectId) ?? null,
    [projects],
  );

  const openThread = useCallback(
    (threadRef: InboxThreadRef) =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: threadRef.environmentId, threadId: threadRef.threadId },
      }),
    [navigate],
  );

  // Threads and the clipboard get the whole conversation, not just the preview the list carries.
  const renderContext = useCallback(
    async (entry: InboxEntry, prompt?: string) => {
      const { item } = entry;
      const loaded =
        item.activityCount === 0
          ? null
          : await loadActivity({ environmentId: entry.environmentId, input: { id: item.id } });
      const activity = loaded?._tag === "Success" ? loaded.value.activity : [];
      return renderInboxItemPrompt(item, prompt, activity);
    },
    [loadActivity],
  );

  const copyContext = useCallback(
    async (entry: InboxEntry) => {
      try {
        await navigator.clipboard.writeText(await renderContext(entry));
        toastManager.add({ type: "success", title: "Context copied" });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not copy context",
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [renderContext],
  );

  const startThread = useCallback(
    async (entry: InboxEntry, projectRef: InboxProjectRef) => {
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
        .setPrompt(session.draftId, await renderContext(entry, "Work on this inbox item."));
      const linked = await linkThread({
        environmentId: entry.environmentId,
        input: { id: item.id, threadId: session.threadId, linked: true },
      });
      reportInboxFailure("Could not link the thread to the inbox item", linked);
      await update(entry, {
        state: "in_progress",
        snoozedUntil: null,
        ...(projectRef.environmentId === entry.environmentId
          ? { projectId: projectRef.projectId }
          : {}),
      });
    },
    [linkThread, newThread, renderContext, update],
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
      reportInboxFailure("Could not delete inbox item", result);
    },
    [deleteItem],
  );

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
        reportInboxFailure("Could not save the new order", result);
      }
    },
    [entries, reorderItems, snapshot.entries],
  );

  return {
    snapshot,
    entries,
    now,
    projects,
    createEnvironmentId,
    multiEnvironment,
    environmentLabel,
    projectFor,
    update,
    addItem,
    fileThread,
    startThread,
    copyContext,
    openThread,
    removeItem,
    move,
  };
}
