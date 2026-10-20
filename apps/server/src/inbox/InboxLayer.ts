/** junkmail: the inbox layer `runtimeLayer.ts` provides. */
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as InboxService from "./InboxService.ts";

// Provided here so the pullers' needs do not widen every layer type above the inbox.
export const layer = InboxService.layer.pipe(
  Layer.provide(Layer.mergeAll(ServerSecretStore.layer, FetchHttpClient.layer)),
);
