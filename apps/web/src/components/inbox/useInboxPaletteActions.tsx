import { useNavigate } from "@tanstack/react-router";
import { InboxIcon, ListIcon } from "lucide-react";

import type { CommandPaletteActionItem } from "../CommandPalette.logic";
import { usePrimarySidebarMode } from "./sidebarMode";

/** junkmail: inbox entries for the command palette, spread into its action list. */
export function useInboxPaletteActions(iconClassName: string): CommandPaletteActionItem[] {
  const navigate = useNavigate();
  const [mode, setMode] = usePrimarySidebarMode();
  return [
    {
      kind: "action",
      value: "action:inbox",
      searchTerms: ["inbox", "todo", "tasks", "work items", "triage", "snoozed"],
      title: "Open inbox",
      icon: <InboxIcon className={iconClassName} />,
      run: async () => {
        await navigate({ to: "/inbox" });
      },
    },
    {
      kind: "action",
      value: "action:primary-sidebar",
      searchTerms: ["sidebar", "inbox", "threads", "thread list", "switch", "classic"],
      title: mode === "inbox" ? "Show thread list in sidebar" : "Show inbox in sidebar",
      icon:
        mode === "inbox" ? (
          <ListIcon className={iconClassName} />
        ) : (
          <InboxIcon className={iconClassName} />
        ),
      run: async () => {
        setMode(mode === "inbox" ? "threads" : "inbox");
      },
    },
  ];
}
