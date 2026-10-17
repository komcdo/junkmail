import { createFileRoute } from "@tanstack/react-router";

import { InboxPage } from "../components/inbox/InboxPage";

export interface InboxSearch {
  readonly view?: string;
  readonly item?: string;
}

export const Route = createFileRoute("/_chat/inbox")({
  validateSearch: (raw: Record<string, unknown>): InboxSearch => ({
    ...(typeof raw.view === "string" ? { view: raw.view } : {}),
    ...(typeof raw.item === "string" ? { item: raw.item } : {}),
  }),
  component: InboxPage,
});
