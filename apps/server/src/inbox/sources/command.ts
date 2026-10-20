/**
 * junkmail: the command puller. Runs a shell command in the background and files each JSON item
 * it prints. Any system with a CLI, script, or agent that can print JSON becomes a source.
 */
import {
  InboxLabel,
  IsoDateTime,
  TrimmedNonEmptyString,
  type CommandSourceSettings,
  type InboxCreateInput,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type * as ProcessRunner from "../../processRunner.ts";

/** Larger output fails the run, so a runaway command cannot exhaust memory. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const STDERR_TAIL = 2000;

export class CommandSourceError extends Schema.TaggedError<CommandSourceError>()(
  "CommandSourceError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/**
 * Runs in the user's login shell, so the command sees the same PATH and tools as their
 * terminal; a background service otherwise starts with a bare PATH.
 */
export const runSourceCommand = (
  runner: ProcessRunner.ProcessRunner["Service"],
  input: {
    readonly command: string;
    readonly timeoutSeconds: number;
    readonly env: Readonly<Record<string, string>>;
  },
) =>
  Effect.gen(function* () {
    const shell = yield* Effect.gen(function* () {
      return yield* Config.String("SHELL");
    }).pipe(Effect.orElseSucceed(() => "/bin/sh"));
    const output = yield* runner
      .run({
        command: shell,
        args: ["-lc", input.command],
        env: { ...input.env },
        timeout: Duration.seconds(input.timeoutSeconds),
        maxOutputBytes: MAX_OUTPUT_BYTES,
      })
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "ProcessTimeoutError"
            ? new CommandSourceError({ message: `Timed out after ${input.timeoutSeconds} s.` })
            : cause._tag === "ProcessOutputLimitError"
              ? new CommandSourceError({ message: "Printed more than 16 MB." })
              : new CommandSourceError({ message: "Could not run the command.", cause }),
        ),
      );
    if (output.code !== 0) {
      const detail = output.stderr.trim().slice(-STDERR_TAIL);
      return yield* new CommandSourceError({
        message: `Exited with code ${String(output.code)}${detail ? `: ${detail}` : "."}`,
      });
    }
    return output.stdout;
  });

// Server-side only: exporting it from contracts pushes the CLI's types past the compiler's
// instantiation limit, and clients never decode it.
/** One line of a command source's output. `key` must stay the same across runs. */
export const CommandSourceItem = Schema.Struct({
  key: TrimmedNonEmptyString.check(Schema.isMaxLength(500)),
  title: TrimmedNonEmptyString,
  body: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  /** 0 (urgent) to 4 (none); only applies when the item is first filed. */
  priority: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 }))),
  labels: Schema.optional(Schema.Array(InboxLabel)),
  /** Keep the title the item already has, for output that only sees the newest event. */
  keepTitle: Schema.optional(Schema.Boolean),
  activity: Schema.optional(
    Schema.Array(
      Schema.Struct({
        key: TrimmedNonEmptyString,
        body: Schema.String,
        author: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
        url: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
        occurredAt: IsoDateTime,
        kind: Schema.optional(TrimmedNonEmptyString),
      }),
    ),
  ),
});
export type CommandSourceItem = typeof CommandSourceItem.Type;

const decodeItemJson = Schema.decodeUnknownResult(Schema.fromJsonString(CommandSourceItem));
const decodeItem = Schema.decodeUnknownResult(CommandSourceItem);
const decodeArrayJson = Schema.decodeUnknownResult(
  Schema.fromJsonString(Schema.Array(Schema.Unknown)),
);

export type CommandItem = InboxCreateInput & { readonly watch: string };

/** Valid items, plus the reason the first invalid one was dropped. */
export function parseCommandOutput(input: {
  readonly stdout: string;
  readonly sourceId: string;
  readonly settings: CommandSourceSettings;
}): {
  readonly items: ReadonlyArray<CommandItem>;
  readonly invalidCount: number;
  readonly warning: string | null;
} {
  const text = input.stdout.trim();
  const results: Array<Result.Result<CommandSourceItem, unknown>> = [];
  if (text.startsWith("[")) {
    const array = decodeArrayJson(text);
    if (Result.isFailure(array)) {
      return { items: [], invalidCount: 1, warning: "The output is not a valid JSON array." };
    }
    for (const value of array.success) results.push(decodeItem(value));
  } else {
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      // Tolerates a model wrapping its output in a Markdown code fence.
      if (trimmed.length > 0 && !trimmed.startsWith("```")) results.push(decodeItemJson(trimmed));
    }
  }
  const items: CommandItem[] = [];
  let invalidCount = 0;
  let warning: string | null = null;
  results.forEach((result, index) => {
    if (Result.isFailure(result)) {
      invalidCount++;
      warning ??= `Item ${index + 1} is not valid: ${String(result.failure).slice(0, 300)}`;
      return;
    }
    const item = result.success;
    items.push({
      watch: "Command",
      title: item.title,
      ...(item.body === undefined ? {} : { body: item.body }),
      url: item.url ?? null,
      ...(item.priority === undefined ? {} : { priority: item.priority }),
      // Scoped to the source, so two commands can use the same keys.
      origin: { kind: "command", externalKey: `${input.sourceId}:${item.key}` },
      createdBy: "source",
      labels: [...input.settings.labels, ...(item.labels ?? [])],
      ...(item.keepTitle === undefined ? {} : { keepTitle: item.keepTitle }),
      activity: (item.activity ?? []).map((event) => ({
        key: event.key,
        kind: event.kind ?? "message",
        author: event.author ?? null,
        body: event.body,
        url: event.url ?? null,
        occurredAt: event.occurredAt,
      })),
    });
  });
  return { items, invalidCount, warning };
}
