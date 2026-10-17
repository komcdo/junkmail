import { useAtomValue } from "@effect/atom-react";
import {
  INBOX_PRIORITY_LABELS,
  INBOX_VIEWS,
  inboxEntryKey,
  inboxItemView,
  nextInboxWakeMs,
  selectInboxView,
  type InboxEntry,
  type InboxView,
} from "@t3tools/client-runtime/state/inbox";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { resolveSnoozePresets } from "@t3tools/client-runtime/state/thread-settled";
import type { InboxUpdateInput } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useMemo, useState } from "react";
import { Linking, Pressable, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { Menu } from "../../components/ui/Menu";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsScreen } from "../settings/components/SettingsScreen";

function useMergedInbox(): ReadonlyArray<InboxEntry> {
  const { environments } = useEnvironments();
  return useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          environments.flatMap((environment) => {
            if (environment.connection.phase !== "connected" || environment.serverConfig === null) {
              return [];
            }
            const query = get(
              serverEnvironment.inboxLive({ environmentId: environment.environmentId, input: {} }),
            );
            const data = Option.getOrNull(AsyncResult.value(query));
            return (data?.items ?? []).flatMap((item) =>
              item === undefined ? [] : [{ environmentId: environment.environmentId, item }],
            );
          }),
        ),
      [environments],
    ),
  );
}

function useInboxClock(entries: ReadonlyArray<InboxEntry>): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const wake = nextInboxWakeMs(entries, now);
    const delay = Math.min(60_000, wake === null ? 60_000 : Math.max(250, wake - now + 50));
    const timer = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(timer);
  }, [entries, now]);
  return now;
}

function report(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    Dialog.alert(title, String(squashAtomCommandFailure(result)));
  }
}

export function InboxRouteScreen() {
  const entries = useMergedInbox();
  const now = useInboxClock(entries);
  const insets = useSafeAreaInsets();
  const { environments } = useEnvironments();
  const [view, setView] = useState<InboxView>("inbox");
  const [draft, setDraft] = useState("");
  const createItem = useAtomCommand(serverEnvironment.createInboxItem, {
    label: "inbox create",
    reportFailure: false,
  });
  const updateItem = useAtomCommand(serverEnvironment.updateInboxItem, {
    label: "inbox update",
    reportFailure: false,
  });
  const visible = useMemo(() => selectInboxView(entries, view, now), [entries, view, now]);
  const createEnvironmentId =
    environments.find((env) => env.connection.phase === "connected" && env.serverConfig !== null)
      ?.environmentId ?? null;

  const add = async () => {
    const title = draft.trim();
    if (title.length === 0 || createEnvironmentId === null) return;
    setDraft("");
    report(
      "Could not add inbox item",
      await createItem({ environmentId: createEnvironmentId, input: { title } }),
    );
  };

  const update = async (entry: InboxEntry, input: Omit<InboxUpdateInput, "id">) => {
    report(
      "Could not update inbox item",
      await updateItem({
        environmentId: entry.environmentId,
        input: { id: entry.item.id, ...input },
      }),
    );
  };

  const viewLabel = INBOX_VIEWS.find((option) => option.id === view)?.label ?? "Inbox";

  return (
    <SettingsScreen title="Inbox">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-4 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        keyboardShouldPersistTaps="handled"
      >
        <View className="flex-row items-center gap-3">
          <Menu
            actions={INBOX_VIEWS.map((option) => ({
              id: option.id,
              title: option.label,
              state: option.id === view ? "on" : "off",
            }))}
            onPressAction={({ nativeEvent }) => setView(nativeEvent.event as InboxView)}
          >
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`View: ${viewLabel}`}
              className="flex-row items-center gap-1 active:opacity-70"
            >
              <Text className="font-semibold text-lg text-foreground">{viewLabel}</Text>
              <SymbolView
                name="chevron.down"
                size={12}
                tintColorClassName="accent-foreground-muted"
              />
            </Pressable>
          </Menu>
        </View>
        <View className="rounded-xl bg-grouped-card px-4 py-2">
          <TextInput
            accessibilityLabel="New inbox item"
            value={draft}
            onChangeText={setDraft}
            onSubmitEditing={() => void add()}
            returnKeyType="done"
            readOnly={createEnvironmentId === null}
            placeholder="Add a work item"
            placeholderTextColorClassName="accent-foreground-muted"
            className="min-h-9 font-sans text-base text-foreground"
          />
        </View>
        {visible.length === 0 ? (
          <EmptyState
            variant="plain"
            title={view === "inbox" ? "Inbox zero" : "Nothing here"}
            detail="Add work above, or let agents file it from their threads."
          />
        ) : (
          <View className="overflow-hidden rounded-xl">
            {visible.map((entry, index) => (
              <InboxItemRow
                key={inboxEntryKey(entry)}
                entry={entry}
                now={now}
                borderTop={index > 0}
                onUpdate={(input) => void update(entry, input)}
              />
            ))}
          </View>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

function InboxItemRow(props: {
  readonly entry: InboxEntry;
  readonly now: number;
  readonly borderTop: boolean;
  readonly onUpdate: (input: Omit<InboxUpdateInput, "id">) => void;
}) {
  const { item } = props.entry;
  const closed = item.state === "done" || item.state === "dismissed";
  const snoozed = inboxItemView(item, props.now) === "snoozed";
  const actions = useMemo<MenuAction[]>(
    () => [
      closed
        ? { id: "reopen", title: item.state === "dismissed" ? "Restore" : "Reopen" }
        : { id: "done", title: "Done" },
      {
        id: "snooze",
        title: "Snooze",
        subactions: [
          ...resolveSnoozePresets(new Date(props.now)).map((preset) => ({
            id: `snooze:${preset.snoozedUntil}`,
            title: preset.label,
            subtitle: preset.whenLabel,
          })),
          ...(snoozed ? [{ id: "unsnooze", title: "Unsnooze" }] : []),
        ],
      },
      {
        id: "priority",
        title: "Priority",
        subactions: INBOX_PRIORITY_LABELS.map((label, priority) => ({
          id: `priority:${priority}`,
          title: priority === 4 ? "No priority" : `P${priority} · ${label}`,
          state: priority === item.priority ? ("on" as const) : ("off" as const),
        })),
      },
      ...(["in_progress", "waiting"] as const).map((state) => ({
        id: `state:${state}`,
        title: state === "in_progress" ? "Mark in progress" : "Mark waiting",
        attributes: { disabled: item.state === state },
      })),
      ...(item.origin.url ? [{ id: "open", title: "Open link" }] : []),
      ...(item.state === "dismissed"
        ? []
        : [{ id: "dismiss", title: "Dismiss", attributes: { destructive: true } }]),
    ],
    [closed, item.origin.url, item.priority, item.state, props.now, snoozed],
  );
  const onAction = (id: string) => {
    if (id === "done") props.onUpdate({ state: "done" });
    else if (id === "reopen") props.onUpdate({ state: "open" });
    else if (id === "dismiss") props.onUpdate({ state: "dismissed" });
    else if (id === "unsnooze") props.onUpdate({ snoozedUntil: null });
    else if (id === "open" && item.origin.url) void Linking.openURL(item.origin.url);
    else if (id.startsWith("snooze:")) props.onUpdate({ snoozedUntil: id.slice("snooze:".length) });
    else if (id.startsWith("priority:")) props.onUpdate({ priority: Number(id.slice(9)) });
    else if (id.startsWith("state:")) {
      props.onUpdate({ state: id.slice(6) as "in_progress" | "waiting" });
    }
  };
  return (
    <Menu
      actions={actions}
      shouldOpenOnLongPress={false}
      onPressAction={({ nativeEvent }) => onAction(nativeEvent.event)}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${item.title}, priority ${INBOX_PRIORITY_LABELS[item.priority]}`}
        className={
          props.borderTop
            ? "min-h-14 flex-row items-center gap-3 border-t border-border-subtle bg-grouped-card px-4 py-3 active:opacity-70"
            : "min-h-14 flex-row items-center gap-3 bg-grouped-card px-4 py-3 active:opacity-70"
        }
      >
        <Text className="w-7 font-semibold text-foreground-muted text-xs">
          {item.priority === 4 ? "–" : `P${item.priority}`}
        </Text>
        <View className="min-w-0 flex-1 gap-0.5">
          <Text
            numberOfLines={2}
            className={
              closed ? "text-base text-foreground-muted line-through" : "text-base text-foreground"
            }
          >
            {item.title}
          </Text>
          {item.origin.kind !== "manual" || item.branch || item.pullRequestUrls.length > 0 ? (
            <Text numberOfLines={1} className="text-foreground-muted text-xs">
              {[
                item.origin.kind !== "manual" ? item.origin.kind : null,
                item.branch,
                item.pullRequestUrls.length > 0 ? `${item.pullRequestUrls.length} PR` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </Text>
          ) : null}
        </View>
        <SymbolView name="ellipsis" size={16} tintColorClassName="accent-chevron" />
      </Pressable>
    </Menu>
  );
}
