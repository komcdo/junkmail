import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Inbox tables are a fork addition. They use their own migrations ledger because the
 * upstream migrator skips every id below the highest one recorded: sharing upstream's
 * ledger would make a later upstream migration (or ours) silently never run.
 */
const INBOX_MIGRATIONS_TABLE = "junkmail_migrations";

const Migration0001 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS inbox_items (
      item_id TEXT PRIMARY KEY,
      origin_kind TEXT NOT NULL,
      external_key TEXT,
      state TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      item_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inbox_items_origin
    ON inbox_items (origin_kind, external_key)
    WHERE external_key IS NOT NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_inbox_items_state_updated
    ON inbox_items (state, updated_at)
  `;
});

// Activity is its own table: a busy PR can carry hundreds of events, and the live list only
// needs the count and the latest one, which the item keeps.
const Migration0002 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS inbox_activity (
      item_id TEXT NOT NULL,
      activity_key TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      activity_json TEXT NOT NULL,
      PRIMARY KEY (item_id, activity_key)
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_inbox_activity_item_time
    ON inbox_activity (item_id, occurred_at)
  `;
});

// Configured pullers. Tokens live in the secret store, keyed by source id, never in this table.
const Migration0003 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS inbox_sources (
      source_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      settings_json TEXT NOT NULL,
      cursor_json TEXT,
      account_json TEXT,
      status TEXT NOT NULL,
      last_error TEXT,
      last_run_at TEXT,
      last_success_at TEXT,
      next_run_at TEXT,
      last_run_item_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `;
});

// `junkmail import-t3` also creates this when it stages settings into a copied database.
const Migration0004 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS junkmail_client_import (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL
    )
  `;
});

const run = Migrator.make({});

export const runInboxMigrations = Effect.fn("runInboxMigrations")(function* () {
  const executed = yield* run({
    table: INBOX_MIGRATIONS_TABLE,
    loader: Migrator.fromRecord({
      "1_InboxItems": Migration0001,
      "2_InboxActivity": Migration0002,
      "3_InboxSources": Migration0003,
      "4_ClientImport": Migration0004,
    }),
  });
  if (executed.length > 0) {
    yield* Effect.log("Inbox migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
});
