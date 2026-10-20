/**
 * junkmail: the inbox RPC surface, kept out of `rpc.ts` so upstream merges touch only the
 * one-line hooks that spread these into `WS_METHODS`, `WsRpcGroup`, and the scope tables.
 */
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  InboxCreateInput,
  InboxDeleteInput,
  InboxDeleteResult,
  InboxError,
  InboxLinkThreadInput,
  InboxListActivityInput,
  InboxListActivityResult,
  InboxListInput,
  InboxListResult,
  InboxMutationResult,
  InboxReorderInput,
  InboxSearchInput,
  InboxSearchResult,
  InboxReorderResult,
  InboxStartThreadInput,
  InboxStartThreadResult,
  InboxUpdateInput,
} from "./inbox.ts";
import {
  InboxClientImportResult,
  InboxSourcesRequest,
  InboxSourcesResponse,
} from "./inboxSources.ts";

export const INBOX_WS_METHODS = {
  inboxList: "inbox.list",
  inboxSubscribe: "inbox.subscribe",
  inboxCreate: "inbox.create",
  inboxUpdate: "inbox.update",
  inboxReorder: "inbox.reorder",
  inboxLinkThread: "inbox.linkThread",
  inboxDelete: "inbox.delete",
  inboxStartThread: "inbox.startThread",
  inboxListActivity: "inbox.listActivity",
  inboxSearch: "inbox.search",
  inboxSources: "inbox.sources",
  inboxClientImport: "inbox.clientImport",
} as const;

const InboxRpcError = Schema.Union([InboxError, EnvironmentAuthorizationError]);

export const InboxRpcGroup = RpcGroup.make(
  Rpc.make(INBOX_WS_METHODS.inboxList, {
    payload: InboxListInput,
    success: InboxListResult,
    error: InboxRpcError,
  }),
  Rpc.make(INBOX_WS_METHODS.inboxSubscribe, {
    payload: InboxListInput,
    success: InboxListResult,
    error: InboxRpcError,
    stream: true,
  }),
  Rpc.make(INBOX_WS_METHODS.inboxCreate, {
    payload: InboxCreateInput,
    success: InboxMutationResult,
    error: InboxRpcError,
  }),
  Rpc.make(INBOX_WS_METHODS.inboxUpdate, {
    payload: InboxUpdateInput,
    success: InboxMutationResult,
    error: InboxRpcError,
  }),
  Rpc.make(INBOX_WS_METHODS.inboxReorder, {
    payload: InboxReorderInput,
    success: InboxReorderResult,
    error: InboxRpcError,
  }),
  Rpc.make(INBOX_WS_METHODS.inboxLinkThread, {
    payload: InboxLinkThreadInput,
    success: InboxMutationResult,
    error: InboxRpcError,
  }),
  Rpc.make(INBOX_WS_METHODS.inboxDelete, {
    payload: InboxDeleteInput,
    success: InboxDeleteResult,
    error: InboxRpcError,
  }),
  Rpc.make(INBOX_WS_METHODS.inboxStartThread, {
    payload: InboxStartThreadInput,
    success: InboxStartThreadResult,
    error: InboxRpcError,
  }),
  Rpc.make(INBOX_WS_METHODS.inboxListActivity, {
    payload: InboxListActivityInput,
    success: InboxListActivityResult,
    error: InboxRpcError,
  }),
  Rpc.make(INBOX_WS_METHODS.inboxSearch, {
    payload: InboxSearchInput,
    success: InboxSearchResult,
    error: InboxRpcError,
  }),
  Rpc.make(INBOX_WS_METHODS.inboxSources, {
    payload: InboxSourcesRequest,
    success: InboxSourcesResponse,
    error: InboxRpcError,
  }),
  Rpc.make(INBOX_WS_METHODS.inboxClientImport, {
    payload: Schema.Struct({}),
    success: InboxClientImportResult,
    error: InboxRpcError,
  }),
);

/** Mutations the client checks before sending; spread into `CLIENT_GUARDED_RPC_SCOPES`. */
export const INBOX_CLIENT_GUARDED_RPC_SCOPES = {
  [INBOX_WS_METHODS.inboxCreate]: AuthOrchestrationOperateScope,
  [INBOX_WS_METHODS.inboxUpdate]: AuthOrchestrationOperateScope,
  [INBOX_WS_METHODS.inboxReorder]: AuthOrchestrationOperateScope,
  [INBOX_WS_METHODS.inboxLinkThread]: AuthOrchestrationOperateScope,
  [INBOX_WS_METHODS.inboxDelete]: AuthOrchestrationOperateScope,
  [INBOX_WS_METHODS.inboxStartThread]: AuthOrchestrationOperateScope,
  // Sources hold tokens, so even listing them is a settings operation.
  [INBOX_WS_METHODS.inboxSources]: AuthSettingsWriteScope,
} as const;

/** Reads the server authorizes; spread into `RPC_REQUIRED_SCOPES` with the guarded scopes. */
export const INBOX_READ_RPC_SCOPES = {
  [INBOX_WS_METHODS.inboxList]: AuthOrchestrationReadScope,
  [INBOX_WS_METHODS.inboxSubscribe]: AuthOrchestrationReadScope,
  [INBOX_WS_METHODS.inboxListActivity]: AuthOrchestrationReadScope,
  [INBOX_WS_METHODS.inboxSearch]: AuthOrchestrationReadScope,
  [INBOX_WS_METHODS.inboxClientImport]: AuthOrchestrationReadScope,
} as const;

/** Span aggregate for every inbox method; spread into the server's `RPC_AGGREGATES`. */
export const INBOX_RPC_AGGREGATES = Object.fromEntries(
  Object.values(INBOX_WS_METHODS).map((method) => [method, "inbox"]),
) as { readonly [K in (typeof INBOX_WS_METHODS)[keyof typeof INBOX_WS_METHODS]]: "inbox" };
