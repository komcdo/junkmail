import * as Effect from "effect/Effect";
import { INBOX_WS_METHODS } from "@t3tools/contracts";

import type * as Inbox from "./InboxService.ts";

/** junkmail: the inbox handlers `ws.ts` spreads into its handler table. */
export const makeInboxRpcHandlers = (inbox: Inbox.InboxService["Service"]) => ({
  [INBOX_WS_METHODS.inboxList]: (_input: unknown) => inbox.list(),
  [INBOX_WS_METHODS.inboxSubscribe]: (_input: unknown) => inbox.subscribeList(),
  [INBOX_WS_METHODS.inboxCreate]: inbox.create,
  [INBOX_WS_METHODS.inboxUpdate]: (input: Parameters<typeof inbox.update>[0]) =>
    Effect.annotateCurrentSpan({ "inbox.item_id": input.id }).pipe(
      Effect.andThen(inbox.update(input)),
    ),
  [INBOX_WS_METHODS.inboxReorder]: inbox.reorder,
  [INBOX_WS_METHODS.inboxLinkThread]: (input: Parameters<typeof inbox.linkThread>[0]) =>
    Effect.annotateCurrentSpan({ "inbox.item_id": input.id }).pipe(
      Effect.andThen(inbox.linkThread(input)),
    ),
  [INBOX_WS_METHODS.inboxDelete]: (input: Parameters<typeof inbox.delete>[0]) =>
    Effect.annotateCurrentSpan({ "inbox.item_id": input.id }).pipe(
      Effect.andThen(inbox.delete(input)),
    ),
  [INBOX_WS_METHODS.inboxStartThread]: (input: Parameters<typeof inbox.startThread>[0]) =>
    Effect.annotateCurrentSpan({ "inbox.item_id": input.id }).pipe(
      Effect.andThen(inbox.startThread(input)),
    ),
  [INBOX_WS_METHODS.inboxListActivity]: (input: Parameters<typeof inbox.listActivity>[0]) =>
    Effect.annotateCurrentSpan({ "inbox.item_id": input.id }).pipe(
      Effect.andThen(inbox.listActivity(input)),
    ),
  [INBOX_WS_METHODS.inboxSearch]: inbox.search,
  [INBOX_WS_METHODS.inboxSources]: inbox.sources,
  [INBOX_WS_METHODS.inboxClientImport]: (_input: unknown) => inbox.clientImport(),
});
