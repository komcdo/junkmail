#!/usr/bin/env bash
# junkmail: fill the dev inbox with realistic test items, then deliver follow-ups to them
# (new Slack replies, a PR approval, duplicates) so "new" tags and grouping show up.
#
#   scripts/junkmail/seed.sh           add test data (safe while the dev server runs; reload)
#   scripts/junkmail/seed.sh --fresh   wipe this checkout's dev database first
#
# Only ever touches this checkout's gitignored .t3, never ~/.t3/userdata.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null
  nvm use 24 >/dev/null
fi

DB="$PWD/.t3/userdata/statev2.sqlite"
if [ "${1:-}" = "--fresh" ]; then
  rm -f "$DB" "$DB-wal" "$DB-shm"
  echo "Wiped $DB (restart the dev server if it is running)."
fi

seed() {
  node apps/server/scripts/junkmail-seed-inbox.ts --db "$DB" --phase "$1" | grep -v '^\[' || true
}
seed initial
seed updates
echo "Done. Reload the inbox to see it."
