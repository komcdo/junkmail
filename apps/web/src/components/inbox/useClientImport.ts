import { InboxClientImport } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useEffect } from "react";

import { usePrimaryEnvironment } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

/** Which staged import this browser already applied. */
const APPLIED_KEY = "junkmail:client-import-applied";
const decodeImport = Schema.decodeUnknownOption(Schema.fromJsonString(InboxClientImport));

/**
 * junkmail: applies the theme, custom themes and layout `junkmail import-t3` staged from the
 * official desktop app. They live in localStorage, which no server can write, so each browser
 * copies them in once per import and reloads to pick them up.
 */
export function useClientImport() {
  const primary = usePrimaryEnvironment();
  const environmentId =
    primary?.connection.phase === "connected" && primary.serverConfig !== null
      ? primary.environmentId
      : null;
  const load = useAtomCommand(serverEnvironment.loadInboxClientImport, {
    label: "inbox client import",
    reportFailure: false,
  });

  useEffect(() => {
    if (environmentId === null) return;
    let cancelled = false;
    void load({ environmentId, input: {} }).then((result) => {
      if (cancelled || result._tag !== "Success" || result.value.json === null) return;
      const staged = decodeImport(result.value.json);
      if (staged._tag === "None") return;
      const { importedAt, entries } = staged.value;
      if (window.localStorage.getItem(APPLIED_KEY) === importedAt) return;
      for (const [key, value] of Object.entries(entries)) window.localStorage.setItem(key, value);
      window.localStorage.setItem(APPLIED_KEY, importedAt);
      window.location.reload();
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, load]);
}
