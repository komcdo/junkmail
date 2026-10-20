import {
  defaultCommandSourceSettings,
  defaultSlackSourceSettings,
  isCommandSourceSettings,
  type CommandSourceSettings,
  type EnvironmentId,
  type InboxSource,
  type InboxSourcePreviewResult,
  type SlackSourceSettings,
  type SlackWatch,
} from "@t3tools/contracts";
import {
  CopyIcon,
  InboxIcon,
  PlayIcon,
  PlusIcon,
  SearchIcon,
  TerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { useState } from "react";

import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../../ui/empty";
import { Input } from "../../ui/input";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { Textarea } from "../../ui/textarea";
import { Switch } from "../../ui/switch";
import { toastManager } from "../../ui/toast";
import { SecretInput } from "../../settings/SecretInput";
import { useSettingsScope } from "../../settings/SettingsScopeContext";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "../../settings/settingsLayout";
import { useInboxSources, type InboxSourceCall } from "./useInboxSources";

/** A Slack app with only `search:read`, which is all the puller needs. */
const SLACK_APP_MANIFEST = `display_information:
  name: junkmail
oauth_config:
  scopes:
    user:
      - search:read
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`;

const STATUS_LABELS: Record<InboxSource["status"], string> = {
  idle: "Healthy",
  running: "Running",
  error: "Retrying",
  auth_required: "Needs a token",
};

function relative(iso: string | null, now: number) {
  if (iso === null) return "never";
  const minutes = Math.round((Date.parse(iso) - now) / 60_000);
  if (minutes === 0) return "now";
  const span =
    Math.abs(minutes) < 60 ? `${Math.abs(minutes)} min` : `${Math.round(Math.abs(minutes) / 60)} h`;
  return minutes < 0 ? `${span} ago` : `in ${span}`;
}

interface Draft {
  readonly name: string;
  readonly enabled: boolean;
  readonly settings: SlackSourceSettings;
  readonly token: string;
}

const draftOf = (source: InboxSource | null): Draft => ({
  name: source?.name ?? "Slack",
  enabled: source?.enabled ?? true,
  settings:
    source === null || isCommandSourceSettings(source.settings)
      ? defaultSlackSourceSettings()
      : source.settings,
  token: "",
});

type SourceBusy = null | "save" | "run" | "preview" | "delete";

const fail = (title: string, message: string) =>
  toastManager.add({ type: "error", title, description: message });

/** Run now, preview and remove, shared by every kind of source. */
function useSourceActions(source: InboxSource | null, call: InboxSourceCall, onSaved: () => void) {
  const [busy, setBusy] = useState<SourceBusy>(null);
  const [preview, setPreview] = useState<InboxSourcePreviewResult | null>(null);

  const runNow = async () => {
    if (source === null) return;
    setBusy("run");
    const result = await call("run", { id: source.id });
    setBusy(null);
    if (!result.ok) return fail("Could not run the source", result.message);
    const { lastRunItemCount, status, lastError } = result.value.source;
    toastManager.add(
      status === "idle"
        ? {
            type: lastError ? "warning" : "success",
            title:
              lastRunItemCount === 0
                ? "Nothing new"
                : `Filed ${lastRunItemCount} item${lastRunItemCount === 1 ? "" : "s"}`,
            ...(lastError ? { description: lastError } : {}),
          }
        : { type: "error", title: `${source.name} failed`, description: lastError ?? undefined },
    );
    onSaved();
  };

  const runPreview = async () => {
    if (source === null) return;
    setBusy("preview");
    const result = await call("preview", { id: source.id });
    setBusy(null);
    if (!result.ok) return fail("Could not preview", result.message);
    setPreview(result.value);
  };

  const remove = async () => {
    if (source === null) return;
    if (!window.confirm(`Remove ${source.name}? Items it filed stay in the inbox.`)) return;
    setBusy("delete");
    const result = await call("delete", { id: source.id });
    setBusy(null);
    if (!result.ok) return fail("Could not remove the source", result.message);
    onSaved();
  };

  return { busy, setBusy, preview, setPreview, runNow, runPreview, remove };
}

function SourceHeaderActions(props: {
  readonly actions: ReturnType<typeof useSourceActions>;
  readonly canRun: boolean;
}) {
  const { busy, runPreview, runNow, remove } = props.actions;
  return (
    <div className="flex items-center gap-1">
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={busy !== null || !props.canRun}
        onClick={() => void runPreview()}
      >
        <SearchIcon className="size-3" />
        {busy === "preview" ? "Checking…" : "Preview"}
      </Button>
      <Button
        size="xs"
        variant="ghost-muted"
        disabled={busy !== null || !props.canRun}
        onClick={() => void runNow()}
      >
        <PlayIcon className="size-3" />
        {busy === "run" ? "Running…" : "Run now"}
      </Button>
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label="Remove source"
        disabled={busy !== null}
        onClick={() => void remove()}
      >
        <Trash2Icon />
      </Button>
    </div>
  );
}

function SourceStatusRow(props: { readonly source: InboxSource; readonly label: string }) {
  const { source } = props;
  const now = useRelativeTimeTick(30_000);
  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          {props.label}
          <Badge
            size="sm"
            variant={
              source.status === "idle"
                ? "success"
                : source.status === "auth_required"
                  ? "error"
                  : "warning"
            }
          >
            {source.enabled ? STATUS_LABELS[source.status] : "Paused"}
          </Badge>
        </span>
      }
      description={
        source.lastError ??
        `Last run ${relative(source.lastRunAt, now)}` +
          (source.lastSuccessAt === null ? "" : ` · ${source.lastRunItemCount} new or updated`) +
          (source.enabled && source.nextRunAt !== null
            ? ` · next ${relative(source.nextRunAt, now)}`
            : "")
      }
    />
  );
}

/** junkmail: Settings → Inbox sources. One section per connected Slack workspace. */
export function InboxSourcesSettings() {
  const { connectedEnvironments, environment } = useSettingsScope();
  const environmentId: EnvironmentId | null =
    (environment ?? connectedEnvironments[0])?.environmentId ?? null;
  const { sources, error, call, refresh } = useInboxSources(environmentId);
  const [adding, setAdding] = useState<null | "slack" | "command">(null);

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Inbox sources"
        variant="plain"
        headerAction={
          <Menu>
            <MenuTrigger
              disabled={environmentId === null || adding !== null}
              render={<Button size="xs" variant="ghost-muted" />}
            >
              <PlusIcon className="size-3" />
              Add source
            </MenuTrigger>
            <MenuPopup align="end">
              <MenuItem onClick={() => setAdding("slack")}>
                <InboxIcon />
                Slack
              </MenuItem>
              <MenuItem onClick={() => setAdding("command")}>
                <TerminalIcon />
                Command
              </MenuItem>
            </MenuPopup>
          </Menu>
        }
      >
        {error ? <p className="px-4 py-2 text-destructive-foreground text-sm">{error}</p> : null}
        {sources !== null && sources.length === 0 && adding === null ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <InboxIcon />
              </EmptyMedia>
              <EmptyTitle>No sources yet</EmptyTitle>
              <EmptyDescription>
                Sources pull work into your inbox on a schedule. Add Slack to file your DMs and
                mentions, or a command to file whatever a script or CLI prints.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : null}
      </SettingsSection>
      {adding === "slack" ? (
        <SlackSourceSection
          source={null}
          call={call}
          onSaved={() => {
            setAdding(null);
            void refresh();
          }}
          onCancel={() => setAdding(null)}
        />
      ) : null}
      {adding === "command" ? (
        <CommandSourceSection
          source={null}
          call={call}
          onSaved={() => {
            setAdding(null);
            void refresh();
          }}
          onCancel={() => setAdding(null)}
        />
      ) : null}
      {(sources ?? []).map((source) =>
        source.kind === "command" ? (
          <CommandSourceSection
            key={source.id}
            source={source}
            call={call}
            onSaved={() => void refresh()}
          />
        ) : (
          <SlackSourceSection
            key={source.id}
            source={source}
            call={call}
            onSaved={() => void refresh()}
          />
        ),
      )}
      {adding === "slack" ||
      (sources ?? []).some((source) => source.kind === "slack" && !source.hasToken) ? (
        <SlackSetupHelp />
      ) : null}
      {adding === "command" || (sources ?? []).some((source) => source.kind === "command") ? (
        <CommandHelp />
      ) : null}
    </SettingsPageContainer>
  );
}

function SlackSourceSection(props: {
  readonly source: InboxSource | null;
  readonly call: InboxSourceCall;
  readonly onSaved: () => void;
  readonly onCancel?: () => void;
}) {
  const { source, call } = props;
  const [draft, setDraft] = useState<Draft>(() => draftOf(source));
  const actions = useSourceActions(source, call, props.onSaved);
  const { busy, setBusy, preview, setPreview } = actions;
  const dirty =
    source === null ||
    draft.token.length > 0 ||
    JSON.stringify(draftOf(source)) !== JSON.stringify({ ...draft, token: "" });
  const setSettings = (patch: Partial<SlackSourceSettings>) =>
    setDraft((current) => ({ ...current, settings: { ...current.settings, ...patch } }));
  const setWatch = (index: number, patch: Partial<SlackWatch>) =>
    setSettings({
      watches: draft.settings.watches.map((watch, i) =>
        i === index ? { ...watch, ...patch } : watch,
      ),
    });

  const save = async () => {
    setBusy("save");
    const result = await call("save", {
      ...(source === null ? {} : { id: source.id }),
      kind: "slack",
      name: draft.name.trim() || "Slack",
      enabled: draft.enabled,
      settings: {
        ...draft.settings,
        watches: draft.settings.watches.filter(
          (watch) => watch.name.trim() !== "" && watch.query.trim() !== "",
        ),
      },
      ...(draft.token.trim() === "" ? {} : { token: draft.token.trim() }),
    });
    setBusy(null);
    if (!result.ok) return fail("Could not save the source", result.message);
    setDraft((current) => ({ ...current, token: "" }));
    props.onSaved();
  };

  return (
    <SettingsSection
      title={source === null ? "New Slack source" : source.name}
      headerAction={
        source === null ? null : <SourceHeaderActions actions={actions} canRun={source.hasToken} />
      }
    >
      {source === null ? null : (
        <SourceStatusRow
          source={source}
          label={source.account ? `${source.account.user} in ${source.account.team}` : "Slack"}
        />
      )}
      <SettingsRow
        title="User token"
        description="A Slack user token (xoxp-…) with the search:read scope. It stays on the server."
        control={
          <SecretInput
            configured={source?.hasToken ?? false}
            value={draft.token}
            placeholder="xoxp-…"
            className="w-full sm:w-64"
            onChange={(event) => setDraft({ ...draft, token: event.currentTarget.value })}
          />
        }
      />
      <SettingsRow
        title="Name"
        control={
          <Input
            value={draft.name}
            className="w-full sm:w-64"
            onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
          />
        }
      />
      <SettingsRow
        title="Pull automatically"
        description={`Every ${draft.settings.intervalMinutes} min while the server runs.`}
        control={
          <Switch
            checked={draft.enabled}
            onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
          />
        }
      />
      <SettingsRow
        title="Interval"
        description="Minutes between pulls. Slack allows about 20 searches a minute per token."
        control={
          <Input
            type="number"
            min={1}
            max={1440}
            value={draft.settings.intervalMinutes}
            className="w-24"
            onChange={(event) =>
              setSettings({
                intervalMinutes: clamp(event.currentTarget.valueAsNumber, 1, 1440, 5),
              })
            }
          />
        }
      />
      <SettingsRow
        title="First pull looks back"
        description="Days of history a new watch pulls in, so connecting a busy workspace is not a flood."
        control={
          <Input
            type="number"
            min={0}
            max={30}
            value={draft.settings.backfillDays}
            className="w-24"
            onChange={(event) =>
              setSettings({ backfillDays: clamp(event.currentTarget.valueAsNumber, 0, 30, 3) })
            }
          />
        }
      />
      <SettingsRow
        title="Ignore bots"
        description="Skip messages from apps and integrations."
        control={
          <Switch
            checked={draft.settings.ignoreBots}
            onCheckedChange={(ignoreBots) => setSettings({ ignoreBots })}
          />
        }
      />
      <SettingsRow
        title="Ignore my own messages"
        description="Your messages still show as context, but never open or bump an item."
        control={
          <Switch
            checked={draft.settings.ignoreOwnMessages}
            onCheckedChange={(ignoreOwnMessages) => setSettings({ ignoreOwnMessages })}
          />
        }
      />
      <SettingsRow
        title="Labels"
        description="Added to every item this source files. Separate with commas."
        control={
          <Input
            value={draft.settings.labels.join(", ")}
            className="w-full sm:w-64"
            onChange={(event) =>
              setSettings({
                labels: event.currentTarget.value
                  .split(",")
                  .map((label) => label.trim())
                  .filter((label) => label.length > 0 && label.length <= 40),
              })
            }
          />
        }
      />
      <SettingsRow
        title="Watches"
        description={
          <>
            Each watch is a Slack search; its matches become items, one per thread or per day of a
            DM. <code>@me</code> means you. Try <code>in:#incidents</code>, <code>from:@boss</code>,
            or <code>"deploy failed" -in:#bots</code>.
          </>
        }
      >
        <div className="flex flex-col gap-1.5 pt-2">
          {draft.settings.watches.map((watch, index) => (
            // oxlint-disable-next-line react/no-array-index-key -- rows have no identity until saved
            <div key={index} className="flex items-center gap-2">
              <Switch
                size="sm"
                checked={watch.enabled}
                aria-label={`Enable ${watch.name}`}
                onCheckedChange={(enabled) => setWatch(index, { enabled })}
              />
              <Input
                value={watch.name}
                placeholder="Name"
                aria-label="Watch name"
                className="w-40"
                onChange={(event) => setWatch(index, { name: event.currentTarget.value })}
              />
              <Input
                value={watch.query}
                placeholder="Slack search, e.g. in:#support @me"
                aria-label="Slack search"
                className="min-w-0 flex-1"
                onChange={(event) => setWatch(index, { query: event.currentTarget.value })}
              />
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`Remove ${watch.name || "watch"}`}
                onClick={() =>
                  setSettings({ watches: draft.settings.watches.filter((_, i) => i !== index) })
                }
              >
                <Trash2Icon />
              </Button>
            </div>
          ))}
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() =>
                setSettings({
                  watches: [...draft.settings.watches, { name: "", query: "", enabled: true }],
                })
              }
            >
              <PlusIcon className="size-3" />
              Add watch
            </Button>
          </div>
        </div>
      </SettingsRow>
      <div className="flex items-center justify-end gap-2 px-4 py-3">
        {props.onCancel ? (
          <Button size="sm" variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button
          size="sm"
          disabled={!dirty || busy !== null || (source === null && draft.token.trim() === "")}
          onClick={() => void save()}
        >
          {busy === "save" ? "Checking token…" : source === null ? "Connect Slack" : "Save"}
        </Button>
      </div>
      {preview === null ? null : <PreviewList preview={preview} onClose={() => setPreview(null)} />}
    </SettingsSection>
  );
}

function PreviewList(props: {
  readonly preview: InboxSourcePreviewResult;
  readonly onClose: () => void;
}) {
  const { items, filteredCount } = props.preview;
  return (
    <div className="border-border/60 border-t px-4 py-3">
      <div className="mb-2 flex items-center justify-between text-muted-foreground text-xs">
        <span>
          Next run would file {items.length} item{items.length === 1 ? "" : "s"}
          {filteredCount > 0 ? ` · ${filteredCount} filtered out` : ""}. Nothing was written.
          {props.preview.warning ? ` ${props.preview.warning}` : ""}
        </span>
        <Button size="xs" variant="ghost-muted" onClick={props.onClose}>
          Close
        </Button>
      </div>
      <ul className="flex flex-col gap-1 text-sm">
        {items.map((item) => (
          <li key={`${item.watch}:${item.title}:${item.latestAt}`} className="flex gap-2">
            <span className="shrink-0 text-muted-foreground text-xs leading-5">{item.watch}</span>
            {item.url ? (
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="truncate hover:underline"
              >
                {item.title}
              </a>
            ) : (
              <span className="truncate">{item.title}</span>
            )}
            {item.messageCount > 1 ? (
              <span className="shrink-0 text-muted-foreground text-xs leading-5">
                {item.messageCount} messages
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SlackSetupHelp() {
  return (
    <SettingsSection title="Getting a Slack token">
      <div className="flex flex-col gap-2 px-4 py-3 text-muted-foreground text-sm">
        <ol className="list-decimal space-y-1 pl-5">
          <li>
            Open{" "}
            <a
              href="https://api.slack.com/apps?new_app=1"
              target="_blank"
              rel="noreferrer"
              className="text-foreground underline"
            >
              api.slack.com/apps
            </a>
            , choose <b>Create New App → From a manifest</b>, and pick your workspace.
          </li>
          <li>Paste the manifest below, then create the app.</li>
          <li>
            Choose <b>Install to Workspace</b>. Some workspaces need an admin to approve it.
          </li>
          <li>
            Under <b>OAuth &amp; Permissions</b>, copy the <b>User OAuth Token</b> (xoxp-…) and
            paste it above.
          </li>
        </ol>
        <div className="relative">
          <pre className="overflow-x-auto rounded-md bg-muted/40 p-3 font-mono text-xs">
            {SLACK_APP_MANIFEST}
          </pre>
          <Button
            size="icon-xs"
            variant="ghost-muted"
            aria-label="Copy manifest"
            className="absolute top-1.5 right-1.5"
            onClick={() =>
              void navigator.clipboard
                .writeText(SLACK_APP_MANIFEST)
                .then(() => toastManager.add({ type: "success", title: "Manifest copied" }))
            }
          >
            <CopyIcon />
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}

interface CommandDraft {
  readonly name: string;
  readonly enabled: boolean;
  readonly settings: CommandSourceSettings;
}

const commandDraftOf = (source: InboxSource | null): CommandDraft => ({
  name: source?.name ?? "Command",
  enabled: source?.enabled ?? true,
  settings:
    source !== null && isCommandSourceSettings(source.settings)
      ? source.settings
      : defaultCommandSourceSettings(),
});

/** A shell command that prints items; runs in the background on the server. */
function CommandSourceSection(props: {
  readonly source: InboxSource | null;
  readonly call: InboxSourceCall;
  readonly onSaved: () => void;
  readonly onCancel?: () => void;
}) {
  const { source, call } = props;
  const [draft, setDraft] = useState<CommandDraft>(() => commandDraftOf(source));
  const actions = useSourceActions(source, call, props.onSaved);
  const { busy, setBusy, preview, setPreview } = actions;
  const dirty = source === null || JSON.stringify(commandDraftOf(source)) !== JSON.stringify(draft);
  const setSettings = (patch: Partial<CommandSourceSettings>) =>
    setDraft((current) => ({ ...current, settings: { ...current.settings, ...patch } }));

  const save = async () => {
    setBusy("save");
    const result = await call("save", {
      ...(source === null ? {} : { id: source.id }),
      kind: "command",
      name: draft.name.trim() || "Command",
      enabled: draft.enabled,
      settings: { ...draft.settings, command: draft.settings.command.trim() },
    });
    setBusy(null);
    if (!result.ok) return fail("Could not save the source", result.message);
    props.onSaved();
  };

  return (
    <SettingsSection
      title={source === null ? "New command source" : source.name}
      headerAction={source === null ? null : <SourceHeaderActions actions={actions} canRun />}
    >
      {source === null ? null : <SourceStatusRow source={source} label="Command" />}
      <SettingsRow
        title="Command"
        description="Runs in your login shell on the machine running junkmail. It prints one JSON item per line, or one JSON array; see the format below."
      >
        <div className="pt-2">
          <Textarea
            value={draft.settings.command}
            rows={4}
            spellCheck={false}
            placeholder='~/bin/my-puller --since "$JUNKMAIL_LAST_SUCCESS_AT"'
            aria-label="Command"
            onChange={(event) => setSettings({ command: event.currentTarget.value })}
          />
        </div>
      </SettingsRow>
      <SettingsRow
        title="Name"
        control={
          <Input
            value={draft.name}
            className="w-full sm:w-64"
            onChange={(event) => setDraft({ ...draft, name: event.currentTarget.value })}
          />
        }
      />
      <SettingsRow
        title="Run automatically"
        description={`Every ${draft.settings.intervalMinutes} min while the server runs.`}
        control={
          <Switch
            checked={draft.enabled}
            onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
          />
        }
      />
      <SettingsRow
        title="Interval"
        description="Minutes between runs."
        control={
          <Input
            type="number"
            min={1}
            max={1440}
            value={draft.settings.intervalMinutes}
            className="w-24"
            onChange={(event) =>
              setSettings({
                intervalMinutes: clamp(event.currentTarget.valueAsNumber, 1, 1440, 10),
              })
            }
          />
        }
      />
      <SettingsRow
        title="Timeout"
        description="Seconds before a run is stopped and counted as failed."
        control={
          <Input
            type="number"
            min={5}
            max={900}
            value={draft.settings.timeoutSeconds}
            className="w-24"
            onChange={(event) =>
              setSettings({
                timeoutSeconds: clamp(event.currentTarget.valueAsNumber, 5, 900, 120),
              })
            }
          />
        }
      />
      <SettingsRow
        title="Labels"
        description="Added to every item this source files. Separate with commas."
        control={
          <Input
            value={draft.settings.labels.join(", ")}
            className="w-full sm:w-64"
            onChange={(event) =>
              setSettings({
                labels: event.currentTarget.value
                  .split(",")
                  .map((label) => label.trim())
                  .filter((label) => label.length > 0 && label.length <= 40),
              })
            }
          />
        }
      />
      <div className="flex items-center justify-end gap-2 px-4 py-3">
        {props.onCancel ? (
          <Button size="sm" variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
        ) : null}
        <Button
          size="sm"
          disabled={!dirty || busy !== null || draft.settings.command.trim() === ""}
          onClick={() => void save()}
        >
          {busy === "save" ? "Saving…" : source === null ? "Add command" : "Save"}
        </Button>
      </div>
      {preview === null ? null : <PreviewList preview={preview} onClose={() => setPreview(null)} />}
    </SettingsSection>
  );
}

const COMMAND_OUTPUT_EXAMPLE = `{"key": "TICKET-7", "title": "Login broken on Safari", "url": "https://tracker/7",
 "priority": 1, "labels": ["bug"],
 "activity": [{"key": "c1", "author": "ann", "body": "Repro attached",
               "occurredAt": "2026-10-20T15:04:05Z"}]}`;

const CLAUDE_SLACK_EXAMPLE = `claude -p --model claude-haiku-4-5 "Use the Slack tools to find DMs to me and messages that mention me in the last day. Print only JSON lines, no prose or code fences, one per thread: {\\"key\\": channel id + thread ts, \\"title\\": who and a short summary, \\"url\\": permalink, \\"activity\\": [{\\"key\\": message ts, \\"author\\": name, \\"body\\": text, \\"occurredAt\\": ISO time}]}"`;

function CopyBlock(props: { readonly text: string; readonly label: string }) {
  return (
    <div className="relative">
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 pr-9 font-mono text-xs">
        {props.text}
      </pre>
      <Button
        size="icon-xs"
        variant="ghost-muted"
        aria-label={`Copy ${props.label}`}
        className="absolute top-1.5 right-1.5"
        onClick={() =>
          void navigator.clipboard
            .writeText(props.text)
            .then(() => toastManager.add({ type: "success", title: "Copied" }))
        }
      >
        <CopyIcon />
      </Button>
    </div>
  );
}

function CommandHelp() {
  return (
    <SettingsSection title="Writing a command source">
      <div className="flex flex-col gap-2 px-4 py-3 text-muted-foreground text-sm">
        <p>
          Print one item per line (or one JSON array). Only <code>key</code> and <code>title</code>{" "}
          are required. The same <code>key</code> on a later run updates that item, and new{" "}
          <code>activity</code> keys show as news on it, so printing everything each run is fine.
        </p>
        <CopyBlock text={COMMAND_OUTPUT_EXAMPLE} label="example item" />
        <p>
          Exit with a non-zero code to report a failure; stderr becomes the error shown here. The
          command gets <code>$JUNKMAIL_LAST_SUCCESS_AT</code> (ISO time of the last good run, empty
          the first time) to fetch only what is new.
        </p>
        <p>
          No Slack app? If Claude is connected to your Slack, this asks it for your DMs and mentions
          with Haiku, using your Claude plan:
        </p>
        <CopyBlock text={CLAUDE_SLACK_EXAMPLE} label="Claude Slack command" />
      </div>
    </SettingsSection>
  );
}

function clamp(value: number, min: number, max: number, fallback: number) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}
