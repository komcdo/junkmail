import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  decodeInboxSourcesResponse,
  encodeInboxSourcesRequest,
  type EnvironmentId,
  type InboxSource,
  type InboxSourceOperation,
  type InboxSourceOperationInput,
  type InboxSourceOperationOutput,
} from "@t3tools/contracts";
import { useCallback, useEffect, useState } from "react";

import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";

/** Run status changes in the background; the page refreshes this often while it is open. */
const REFRESH_MS = 15_000;

export type InboxSourceCall = <Op extends InboxSourceOperation>(
  operation: Op,
  input: InboxSourceOperationInput<Op>,
) => Promise<
  | { readonly ok: true; readonly value: InboxSourceOperationOutput<Op> }
  | { readonly ok: false; readonly message: string }
>;

/** junkmail: the configured sources of one environment, and the operations on them. */
export function useInboxSources(environmentId: EnvironmentId | null) {
  const command = useAtomCommand(serverEnvironment.inboxSources, {
    label: "inbox sources",
    reportFailure: false,
  });
  const [sources, setSources] = useState<ReadonlyArray<InboxSource> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const call: InboxSourceCall = useCallback(
    async (operation, input) => {
      if (environmentId === null) return { ok: false, message: "No environment is connected." };
      const result = await command({
        environmentId,
        input: encodeInboxSourcesRequest(operation, input),
      });
      if (result._tag !== "Success") {
        return { ok: false, message: String(squashAtomCommandFailure(result)) };
      }
      return { ok: true, value: decodeInboxSourcesResponse(operation, result.value) };
    },
    [command, environmentId],
  );

  const refresh = useCallback(async () => {
    const result = await call("list", {});
    if (result.ok) {
      setSources(result.value.sources);
      setError(null);
    } else {
      setError(result.message);
    }
  }, [call]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return { sources, error, call, refresh };
}
