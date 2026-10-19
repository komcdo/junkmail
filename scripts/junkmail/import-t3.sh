#!/usr/bin/env bash
# junkmail: bring threads, attachments and settings over from an official T3 Code install.
#
#   junkmail import-t3                     (Homebrew install; imports into ~/.junkmail)
#   T3CODE_HOME=<dir> scripts/junkmail/import-t3.sh [--from <t3 home>]
#
# Reads the official install (default ~/.t3) without modifying it: the database is copied with
# SQLite's online backup in read-only mode, so T3 Code can stay open. junkmail must be stopped.
# Whatever junkmail already had is moved to userdata/before-import-<time>/, not deleted.
set -euo pipefail

FROM="$HOME/.t3"
while [ $# -gt 0 ]; do
  case "$1" in
    --from) FROM="${2:?--from needs a folder}"; shift 2 ;;
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
  state.sqlite-shm attachments settings.json keybindings.json; do
  if [ -e "$DEST/$name" ]; then
    mkdir -p "$BACKUP"
    mv "$DEST/$name" "$BACKUP/"
    moved=1
  fi
done

echo "==> Copying threads from $SRC/$DB"
sqlite3 "file:$SRC/$DB?mode=ro" ".backup '$DEST/$DB'"
for name in attachments settings.json keybindings.json; do
  if [ -e "$SRC/$name" ]; then
    echo "==> Copying $name"
    cp -R "$SRC/$name" "$DEST/$name"
  fi
done

echo
echo "Imported into $DEST. Start junkmail and your threads appear under Unfiled."
if [ "$moved" = "1" ]; then
  echo "junkmail's previous data, inbox included, is in $BACKUP"
fi
