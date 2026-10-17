import { useAtomValue } from "@effect/atom-react";
import {
  countInboxView,
  nextInboxWakeMs,
  type InboxEntry,
} from "@t3tools/client-runtime/state/inbox";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useMemo, useState } from "react";

import { useEnvironments } from "../../state/environments";
import { formatEnvironmentQueryError } from "../../state/query";
import { serverEnvironment } from "../../state/server";

export interface InboxSnapshot {
  readonly entries: ReadonlyArray<InboxEntry>;
  readonly errors: ReadonlyArray<string>;
  readonly loading: boolean;
}

/** Every connected environment's inbox, merged; each item stays owned by its environment. */
export function useMergedInbox(): InboxSnapshot {
  const { environments } = useEnvironments();
  return useAtomValue(
    useMemo(
      () =>
        Atom.make((get): InboxSnapshot => {
          const entries: InboxEntry[] = [];
          const errors: string[] = [];
          let loading = false;
          for (const environment of environments) {
            if (environment.connection.phase !== "connected" || environment.serverConfig === null) {
              continue;
            }
            const query = get(
              serverEnvironment.inboxLive({
                environmentId: environment.environmentId,
                input: {},
              }),
            );
            if (query._tag === "Failure") {
              errors.push(`${environment.label}: ${formatEnvironmentQueryError(query.cause)}`);
              continue;
            }
            const data = Option.getOrNull(AsyncResult.value(query));
            if (data === null) {
              loading = true;
              continue;
            }
            for (const item of data.items) {
              if (item !== undefined)
                entries.push({ environmentId: environment.environmentId, item });
            }
          }
          return { entries, errors, loading };
        }),
      [environments],
    ),
  );
}

/** Re-renders when the next snooze wakes, and every minute for relative labels. */
export function useInboxClock(entries: ReadonlyArray<InboxEntry>): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const wake = nextInboxWakeMs(entries, now);
    const delay = Math.min(60_000, wake === null ? 60_000 : Math.max(250, wake - now + 50));
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [entries, now]);
  return now;
}

/** Open, unsnoozed items across every connected environment: the sidebar badge. */
export function useInboxActionableCount(): number {
  const { entries } = useMergedInbox();
  const now = useInboxClock(entries);
  return countInboxView(entries, "inbox", now);
}
