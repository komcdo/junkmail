/** junkmail: the inbox layer `runtimeLayer.ts` provides. */
import type * as Crypto from "effect/Crypto";
import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import type * as SqlClient from "effect/sql/SqlClient";
import { FetchHttpClient } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import type * as ServerConfig from "../config.ts";
import type * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import type * as ProcessRunner from "../processRunner.ts";
import type * as Scheduler from "../scheduling/Scheduler.ts";
import * as InboxService from "./InboxService.ts";

/**
 * Spelled out rather than inferred: upstream's server layer types sit at the compiler's
 * instantiation limit, and a flat named type here costs far less than the inferred expression.
 */
export const layer: Layer.Layer<
  InboxService.InboxService,
  never,
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProcessRunner.ProcessRunner
  | Scheduler.Scheduler
  | ServerConfig.ServerConfig
  | SqlClient.SqlClient
  | ThreadLaunchService.ThreadLaunchService
> = InboxService.layer.pipe(
  // Provided here so the pullers' needs do not widen every layer type above the inbox.
  Layer.provide(Layer.mergeAll(ServerSecretStore.layer, FetchHttpClient.layer)),
  Layer.orDie,
);
