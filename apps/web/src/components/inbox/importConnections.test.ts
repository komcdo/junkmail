import type { ConnectionCatalogDocument } from "@t3tools/client-runtime/platform";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { mergeConnectionCatalogs } from "./importConnections";

const env = (id: string) => EnvironmentId.make(id);
const bearer = (id: string, connectionId: string, token: string) => ({
  target: new BearerConnectionTarget({ environmentId: env(id), label: id, connectionId }),
  profile: new BearerConnectionProfile({
    connectionId,
    environmentId: env(id),
    label: id,
    httpBaseUrl: `http://${id}:3773`,
    wsBaseUrl: `ws://${id}:3773`,
  }),
  credential: { connectionId, credential: new BearerConnectionCredential({ token }) },
});
const catalog = (
  entries: ReadonlyArray<ReturnType<typeof bearer>>,
  disabled: ReadonlyArray<string> = [],
): ConnectionCatalogDocument => ({
  schemaVersion: 1,
  targets: entries.map((entry) => entry.target),
  profiles: entries.map((entry) => entry.profile),
  credentials: entries.map((entry) => entry.credential),
  remoteDpopTokens: [],
  disabledEnvironmentIds: disabled.map(env),
});

describe("mergeConnectionCatalogs", () => {
  it("adds imported connections and keeps the browser's own", () => {
    const merged = mergeConnectionCatalogs(
      catalog([bearer("laptop", "c-laptop", "a")]),
      catalog([bearer("studio", "c-studio", "b")], ["studio"]),
      "junkmail",
    );
    expect(merged.targets.map((target) => target.environmentId)).toEqual(["laptop", "studio"]);
    expect(merged.credentials.map((stored) => stored.connectionId)).toEqual([
      "c-laptop",
      "c-studio",
    ]);
    expect(merged.disabledEnvironmentIds).toEqual(["studio"]);
  });

  it("replaces an environment saved under another connection, so importing twice is a no-op", () => {
    const existing = catalog([bearer("studio", "c-old", "stale")]);
    const imported = catalog([bearer("studio", "c-new", "fresh")]);
    const once = mergeConnectionCatalogs(existing, imported, "junkmail");
    expect(once.profiles.map((profile) => profile.connectionId)).toEqual(["c-new"]);
    expect(once.credentials).toEqual(imported.credentials);
    expect(mergeConnectionCatalogs(once, imported, "junkmail")).toEqual(once);
  });

  it("skips this server's own environment", () => {
    const merged = mergeConnectionCatalogs(
      catalog([]),
      catalog([bearer("junkmail", "c-self", "x"), bearer("studio", "c-studio", "y")]),
      "junkmail",
    );
    expect(merged.targets.map((target) => target.environmentId)).toEqual(["studio"]);
    expect(merged.credentials.map((stored) => stored.connectionId)).toEqual(["c-studio"]);
  });
});
