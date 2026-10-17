import { OrchestratorMcpFailure, type InboxError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as InboxService from "../../../inbox/InboxService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { InboxToolkit } from "./tools.ts";

const toFailure = (error: InboxError) =>
  new OrchestratorMcpFailure({
    code: error.message === "Inbox item not found." ? "invalid_request" : "orchestration_error",
    message: error.message,
  });

const handlers = {
  t3_inbox_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const inbox = yield* InboxService.InboxService;
      const { items } = yield* inbox.list().pipe(Effect.mapError(toFailure));
      return {
        items: items.flatMap((item) =>
          item === undefined ||
          (input.includeClosed !== true && (item.state === "done" || item.state === "dismissed"))
            ? []
            : [item],
        ),
      };
    }),
  ),
  t3_inbox_add: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const context = yield* McpInvocationContext.McpInvocationContext;
      const inbox = yield* InboxService.InboxService;
      return yield* inbox
        .create({
          ...input,
          createdBy: "agent",
          origin: input.origin ?? { kind: "agent", externalKey: null },
          ...(context.thread === undefined ? {} : { threadId: context.thread.threadId }),
        })
        .pipe(Effect.mapError(toFailure));
    }),
  ),
  t3_inbox_update: McpToolAccess.writesWithCapability((input) =>
    Effect.gen(function* () {
      const inbox = yield* InboxService.InboxService;
      return yield* inbox.update(input).pipe(Effect.mapError(toFailure));
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof InboxToolkit.tools>;

export const layer = McpToolAccess.toLayer(InboxToolkit, handlers);
