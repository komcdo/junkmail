import {
  ConnectionCatalogDocument,
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
} from "@t3tools/client-runtime/platform";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Where upstream's browser connection storage keeps its catalog (`connection/storage.ts`). */
const DATABASE_NAME = "t3code:connection-runtime";
const CATALOG_STORE_NAME = "catalog";
const CATALOG_KEY = "document";

const CatalogJson = Schema.fromJsonString(ConnectionCatalogDocument);
const decodeCatalog = Schema.decodeUnknownOption(CatalogJson);
const encodeCatalog = Schema.encodeSync(CatalogJson);

/**
 * junkmail: `existing` with the imported connections added. An imported environment replaces
 * the saved one, so importing twice changes nothing; this server's own environment is skipped.
 */
export function mergeConnectionCatalogs(
  existing: ConnectionCatalogDocument,
  imported: ConnectionCatalogDocument,
  primaryEnvironmentId: string,
): ConnectionCatalogDocument {
  const targets = imported.targets.filter(
    (target) => target.environmentId !== primaryEnvironmentId,
  );
  const environments = new Set<string>(targets.map((target) => target.environmentId));
  const profiles = imported.profiles.filter((profile) => environments.has(profile.environmentId));
  const connections = new Set(profiles.map((profile) => profile.connectionId));
  // The replaced environments' old connections, whose tokens would otherwise linger.
  const replaced = new Set(
    existing.profiles
      .filter((profile) => environments.has(profile.environmentId))
      .map((profile) => profile.connectionId),
  );
  return {
    ...existing,
    targets: [
      ...existing.targets.filter((target) => !environments.has(target.environmentId)),
      ...targets,
    ],
    profiles: [
      ...existing.profiles.filter((profile) => !environments.has(profile.environmentId)),
      ...profiles,
    ],
    credentials: [
      ...existing.credentials.filter(
        (stored) => !connections.has(stored.connectionId) && !replaced.has(stored.connectionId),
      ),
      ...imported.credentials.filter((stored) => connections.has(stored.connectionId)),
    ],
    disabledEnvironmentIds: [
      ...existing.disabledEnvironmentIds.filter((id) => !environments.has(id)),
      ...imported.disabledEnvironmentIds.filter((id) => environments.has(id)),
    ],
  };
}

function request<A>(req: IDBRequest<A>): Promise<A> {
  return new Promise((resolve, reject) => {
    req.addEventListener("success", () => resolve(req.result));
    req.addEventListener("error", () => reject(req.error));
  });
}

/**
 * Adds the staged connections to this browser's saved connections. The page reloads right
 * after, so the connection runtime's in-memory copy of the catalog never sees a stale one.
 * Returns how many connections were added.
 */
export async function importConnections(raw: string, primaryEnvironmentId: string) {
  const imported = decodeCatalog(raw);
  if (Option.isNone(imported) || imported.value.targets.length === 0) return 0;
  // The connection runtime opened (and created) the database before any environment connected.
  const database = await request(indexedDB.open(DATABASE_NAME));
  try {
    if (!database.objectStoreNames.contains(CATALOG_STORE_NAME)) return 0;
    const store = database
      .transaction(CATALOG_STORE_NAME, "readwrite")
      .objectStore(CATALOG_STORE_NAME);
    const current = await request(store.get(CATALOG_KEY));
    const existing = Option.getOrElse(
      typeof current === "string" ? decodeCatalog(current) : Option.none(),
      () => EMPTY_CONNECTION_CATALOG_DOCUMENT,
    );
    const merged = mergeConnectionCatalogs(existing, imported.value, primaryEnvironmentId);
    await request(store.put(encodeCatalog(merged), CATALOG_KEY));
    return merged.targets.length - existing.targets.length;
  } finally {
    database.close();
  }
}
