import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** junkmail: inbox atoms, spread into `createServerEnvironmentAtoms` so `server.ts` stays upstream. */
export function createInboxEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
) {
  return {
    inboxLive: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:inbox:live",
      tag: WS_METHODS.inboxSubscribe,
    }),
    createInboxItem: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:inbox:create",
      tag: WS_METHODS.inboxCreate,
    }),
    updateInboxItem: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:inbox:update",
      tag: WS_METHODS.inboxUpdate,
    }),
    reorderInboxItems: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:inbox:reorder",
      tag: WS_METHODS.inboxReorder,
    }),
    linkInboxThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:inbox:link-thread",
      tag: WS_METHODS.inboxLinkThread,
    }),
    deleteInboxItem: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:inbox:delete",
      tag: WS_METHODS.inboxDelete,
    }),
    startInboxThread: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:inbox:start-thread",
      tag: WS_METHODS.inboxStartThread,
    }),
  };
}
