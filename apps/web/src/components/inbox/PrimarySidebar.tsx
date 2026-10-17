import { Navigate, useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useEnvironments } from "../../state/environments";
import { useSidebar } from "../ui/sidebar";
import { InboxSidebar } from "./InboxSidebar";
import { usePrimarySidebarMode } from "./sidebarMode";

// Overrides the width variable below the provider's inline value, so upstream's persisted
// sidebar width is untouched and returns the moment an item opens. Mounted only while full.
const FULL_WIDTH_CSS = `
[data-slot="sidebar"]:has([data-app-sidebar]) { --sidebar-width: 100vw; }
[data-slot="sidebar-wrapper"]:has([data-app-sidebar]) [data-slot="sidebar-inset"],
[data-slot="sidebar"]:has([data-app-sidebar]) [data-slot="sidebar-rail"] { display: none; }
`;

/** junkmail: the inbox replaces upstream's thread list unless the user switches back. */
export function PrimarySidebar(props: { readonly threads: ReactNode }) {
  const [mode] = usePrimarySidebarMode();
  const { isMobile, open } = useSidebar();
  const nothingSelected = useLocation({
    select: (location) =>
      location.pathname === "/inbox" &&
      !(typeof location.search.item === "string" && location.search.item.length > 0),
  });
  if (mode === "threads") return props.threads;
  const full = nothingSelected && open && !isMobile;
  return (
    <>
      {full ? <style>{FULL_WIDTH_CSS}</style> : null}
      <InboxSidebar full={full} />
    </>
  );
}

/**
 * junkmail: with the inbox as the sidebar, `/` lands on the inbox instead of auto-starting a
 * draft. Without environments upstream's onboarding still shows.
 */
export function withInboxLanding<P extends object>(Component: (props: P) => ReactNode) {
  return function InboxLanding(props: P) {
    const [mode] = usePrimarySidebarMode();
    const { environments, isReady } = useEnvironments();
    if (mode === "threads") return <Component {...props} />;
    if (!isReady) return null;
    if (environments.length === 0) return <Component {...props} />;
    return <Navigate to="/inbox" replace />;
  };
}
