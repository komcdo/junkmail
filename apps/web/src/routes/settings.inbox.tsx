import { createFileRoute } from "@tanstack/react-router";

import { InboxSourcesSettings } from "../components/inbox/sources/InboxSourcesSettings";

/** junkmail: Settings → Inbox sources. */
export const Route = createFileRoute("/settings/inbox")({
  component: InboxSourcesSettings,
});
