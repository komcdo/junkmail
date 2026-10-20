import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { defaultCommandSourceSettings, type EnvironmentId } from "@t3tools/contracts";
import { useCallback, useState } from "react";

import { useComposerDraftStore } from "../../../composerDraftStore";
import { useNewThreadHandler } from "../../../hooks/useHandleNewThread";
import { useScratchProject } from "../../../hooks/useScratchProject";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
} from "../../../providerInstances";
import { useEnvironments } from "../../../state/environments";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { toastManager } from "../../ui/toast";
import { SettingsRow, SettingsSection } from "../../settings/settingsLayout";
import { renderBuildSourcePrompt, shellQuote, sourceFolderName } from "./buildSourcePrompt";
import type { InboxSourceCall } from "./useInboxSources";

const randomSuffix = () => Math.random().toString(36).slice(2, 8);

/**
 * junkmail: whether an agent can build a source in `environmentId`, and how. The script lives in
 * the scratch workspace, where the agent's thread runs, so sandboxed agents can write it too.
 */
export function useBuildSource(environmentId: EnvironmentId | null, call: InboxSourceCall) {
  const { environments } = useEnvironments();
  const { scratchWorkspaceRootFor, openScratchProject } = useScratchProject();
  const newThread = useNewThreadHandler();
  const environment = environments.find((entry) => entry.environmentId === environmentId);
  const scratchRoot = scratchWorkspaceRootFor(environmentId);
  const serverConfig = environment?.serverConfig ?? null;
  const providerReady =
    serverConfig !== null &&
    applyProviderInstanceSettings(
      deriveProviderInstanceEntries(serverConfig.providers),
      serverConfig.settings,
      null,
    ).some(isProviderInstancePickerReady);
  const unavailableReason = !providerReady
    ? "Needs a provider that is signed in and ready."
    : scratchRoot === null
      ? "Needs a server that offers a scratch workspace."
      : null;

  const build = useCallback(
    async (name: string, description: string): Promise<boolean> => {
      if (environmentId === null || scratchRoot === null) return false;
      const folder = `${scratchRoot}/inbox-sources/${sourceFolderName(name, randomSuffix())}`;
      const script = `${folder}/pull`;
      const settings = { ...defaultCommandSourceSettings(), command: shellQuote(script) };
      // Off until the script works; the agent's last step points the user at Preview.
      const saved = await call("save", { kind: "command", name, enabled: false, settings });
      if (!saved.ok) {
        toastManager.add({
          type: "error",
          title: "Could not add the source",
          description: saved.message,
        });
        return false;
      }
      const project = await openScratchProject(environmentId, "Could not open a scratch thread");
      if (project === null) return false;
      const session = await newThread(scopeProjectRef(project.environmentId, project.id)).catch(
        () => null,
      );
      if (session === null) {
        toastManager.add({ type: "error", title: "Could not open a thread" });
        return false;
      }
      useComposerDraftStore.getState().setPrompt(
        session.draftId,
        renderBuildSourcePrompt({
          description,
          sourceName: name,
          folder,
          script,
          intervalMinutes: settings.intervalMinutes,
          timeoutSeconds: settings.timeoutSeconds,
        }),
      );
      return true;
    },
    [call, environmentId, newThread, openScratchProject, scratchRoot],
  );

  return { unavailableReason, build };
}

export function BuildSourceSection(props: {
  readonly unavailableReason: string | null;
  readonly build: (name: string, description: string) => Promise<boolean>;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = props.unavailableReason === null && name.trim() !== "" && description.trim() !== "";

  const submit = async () => {
    setBusy(true);
    const built = await props.build(name.trim(), description.trim());
    setBusy(false);
    if (built) props.onDone();
  };

  return (
    <SettingsSection title="Build a source with AI">
      <SettingsRow
        title="What should it pull?"
        description="An agent writes a script that fetches this, tests it, and hands it to junkmail. Say what counts as needing you."
      >
        <div className="pt-2">
          <Textarea
            value={description}
            rows={4}
            placeholder="Jira tickets assigned to me or where I'm mentioned, with their latest comments."
            aria-label="What should it pull?"
            onChange={(event) => setDescription(event.currentTarget.value)}
          />
        </div>
      </SettingsRow>
      <SettingsRow
        title="Name"
        control={
          <Input
            value={name}
            placeholder="Jira"
            className="w-full sm:w-64"
            onChange={(event) => setName(event.currentTarget.value)}
          />
        }
      />
      <div className="flex items-center justify-end gap-2 px-4 py-3">
        {props.unavailableReason ? (
          <p className="mr-auto text-muted-foreground text-xs">{props.unavailableReason}</p>
        ) : (
          <p className="mr-auto text-muted-foreground text-xs">
            Opens a thread with the brief drafted. Pick the model, then send it.
          </p>
        )}
        <Button size="sm" variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={!ready || busy} onClick={() => void submit()}>
          Build
        </Button>
      </div>
    </SettingsSection>
  );
}
