import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";

/**
 * junkmail: which list fills the primary sidebar. Client-local on purpose, so the fork adds
 * no field to upstream's settings contract.
 */
export type PrimarySidebarMode = "inbox" | "threads";

const PRIMARY_SIDEBAR_MODE_KEY = "junkmail:primary-sidebar";
const PrimarySidebarModeSchema = Schema.Literals(["inbox", "threads"]);

export function usePrimarySidebarMode() {
  return useLocalStorage<PrimarySidebarMode, PrimarySidebarMode>(
    PRIMARY_SIDEBAR_MODE_KEY,
    "inbox",
    PrimarySidebarModeSchema,
  );
}
