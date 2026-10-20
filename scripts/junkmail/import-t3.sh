#!/usr/bin/env bash
# junkmail: bring threads, attachments and settings over from an official T3 Code install.
#
#   junkmail import-t3                     (Homebrew install; imports into ~/.junkmail)
#   T3CODE_HOME=<dir> scripts/junkmail/import-t3.sh [--from <t3 home>] [--app-data <dir>]
#
# Brings over threads, attachments, server settings (providers, models, environment theme),
# keybindings and custom themes from the official install (default ~/.t3), plus the desktop
# app's browser-side state: selected theme, custom themes, appearance, UI layout and drafts.
# That state lives in the app's localStorage, which a browser on junkmail's own address cannot
# see, so it is staged in junkmail-client-import.json and each browser applies it once.
#
# Nothing in the official install is modified: the database is copied with SQLite's online
# backup in read-only mode, so T3 Code can stay open. junkmail must be stopped. Whatever
# junkmail already had is moved to userdata/before-import-<time>/, not deleted.
set -euo pipefail

FROM="$HOME/.t3"
# The desktop app's Electron profile, where its localStorage lives.
if [ "$(uname)" = "Darwin" ]; then
  APP_DATA="$HOME/Library/Application Support/t3code"
else
  APP_DATA="${XDG_CONFIG_HOME:-$HOME/.config}/t3code"
fi
HERE="$(cd "$(dirname "$0")" && pwd)"
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="${2:?--from needs a folder}"; shift 2 ;;
    --app-data) APP_DATA="${2:?--app-data needs a folder}"; shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done
SRC="$FROM/userdata"
DEST="${T3CODE_HOME:?Set T3CODE_HOME to the junkmail data folder}/userdata"

if [ "$(cd "$SRC" 2>/dev/null && pwd -P)" = "$(mkdir -p "$DEST" && cd "$DEST" && pwd -P)" ]; then
  echo "The source and junkmail data folders are the same: $DEST" >&2
  exit 1
fi
# A V2 install already has statev2.sqlite; older ones have state.sqlite, which junkmail
# upgrades itself on first start.
if [ -f "$SRC/statev2.sqlite" ]; then
  DB="statev2.sqlite"
elif [ -f "$SRC/state.sqlite" ]; then
  DB="state.sqlite"
else
  echo "No T3 Code database in $SRC. Pass --from <folder> if it lives elsewhere." >&2
  exit 1
fi
if lsof -t "$DEST/statev2.sqlite" >/dev/null 2>&1; then
  echo "junkmail is running. Stop it first: brew services stop junkmail" >&2
  exit 1
fi

BACKUP="$DEST/before-import-$(date +%Y%m%d-%H%M%S)"
moved=0
for name in statev2.sqlite statev2.sqlite-wal statev2.sqlite-shm state.sqlite state.sqlite-wal \
  state.sqlite-shm attachments settings.json keybindings.json client-settings.json themes \
  junkmail-client-import.json; do
  if [ -e "$DEST/$name" ]; then
    mkdir -p "$BACKUP"
    mv "$DEST/$name" "$BACKUP/"
    moved=1
  fi
done

echo "==> Copying threads from $SRC/$DB"
sqlite3 "file:$SRC/$DB?mode=ro" ".backup '$DEST/$DB'"
for name in attachments settings.json keybindings.json client-settings.json themes; do
  if [ -e "$SRC/$name" ]; then
    echo "==> Copying $name"
    cp -R "$SRC/$name" "$DEST/$name"
  fi
done

# Browser-side state. Keys that name threads carry the environment id, so they are rewritten
# to junkmail's own id, created here if junkmail has never started.
if [ ! -s "$DEST/environment-id" ]; then
  uuidgen | tr '[:upper:]' '[:lower:]' > "$DEST/environment-id"
fi
LEVELDB="$APP_DATA/Local Storage/leveldb"
if ! command -v python3 >/dev/null 2>&1; then
  echo "==> Skipping theme and layout: python3 is not installed"
elif [ ! -d "$LEVELDB" ] && [ ! -f "$SRC/client-settings.json" ]; then
  echo "==> No desktop app state found at $APP_DATA; theme and layout stay default"
else
  echo "==> Staging theme, appearance and layout for the browser"
  python3 "$HERE/read-localstorage.py" --stage "$LEVELDB" "$SRC" "$DEST"
  # The server reads it from the database, which it carries into statev2.sqlite on first start.
  sqlite3 "$DEST/$DB" "
    CREATE TABLE IF NOT EXISTS junkmail_client_import (
      id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
    INSERT OR REPLACE INTO junkmail_client_import (id, json)
      VALUES (1, CAST(readfile('$DEST/junkmail-client-import.json') AS TEXT));"
fi

echo
echo "Imported into $DEST. Start junkmail and your threads appear under Unfiled."
echo "Each browser you open junkmail in applies the theme and layout once, then reloads."
if [ "$moved" = "1" ]; then
  echo "junkmail's previous data, inbox included, is in $BACKUP"
fi
