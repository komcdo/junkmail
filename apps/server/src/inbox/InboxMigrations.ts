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

const run = Migrator.make({});

export const runInboxMigrations = Effect.fn("runInboxMigrations")(function* () {
  const executed = yield* run({
    table: INBOX_MIGRATIONS_TABLE,
    loader: Migrator.fromRecord({ "1_InboxItems": Migration0001 }),
  });
  if (executed.length > 0) {
    yield* Effect.log("Inbox migrations ran successfully").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
});
