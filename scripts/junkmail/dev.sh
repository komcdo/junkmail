#!/usr/bin/env bash
# junkmail: one command to run the fork on its own dev data and open it.
#
#   scripts/junkmail/dev.sh             server + web, opens the browser when ready
#   scripts/junkmail/dev.sh --seed      also files the realistic filler items first
#   scripts/junkmail/dev.sh --desktop   the Electron app instead of a browser tab
#   scripts/junkmail/dev.sh --no-open   print the pairing URL without opening it
#
# State lives in this checkout's gitignored .t3, never in ~/.t3/userdata. Ctrl+C stops it.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null
  nvm use 24 >/dev/null
fi
export PATH="$HOME/.local/share/vite-plus/bin:$PATH"
# Dev mode otherwise turns this checkout into a project and opens a thread with the default
# provider, which aborts startup when imported settings disable that provider.
export T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD="${T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD:-false}"

HOME_DIR="$PWD/.t3"
LOG="$HOME_DIR/junkmail-dev.log"
TASK="dev"
SEED=0
OPEN=1
for arg in "$@"; do
  case "$arg" in
    --seed) SEED=1 ;;
    --desktop) TASK="dev:desktop" ;;
    --no-open) OPEN=0 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done
mkdir -p "$HOME_DIR"

if [ "$SEED" = "1" ]; then
  scripts/junkmail/seed.sh
fi

vp run "$TASK" --home-dir "$HOME_DIR" >"$LOG" 2>&1 &
DEV_PID=$!
trap 'kill "$DEV_PID" 2>/dev/null || true' INT TERM EXIT

echo "Starting junkmail ($TASK)... log: $LOG"
until grep -q "pairingUrl:" "$LOG" 2>/dev/null; do
  if ! kill -0 "$DEV_PID" 2>/dev/null; then
    echo "Dev server exited. Last lines of the log:" >&2
    tail -20 "$LOG" >&2
    exit 1
  fi
  sleep 1
done
URL=$(grep -oE "pairingUrl: [^ ]+" "$LOG" | head -1 | cut -d' ' -f2)
echo "Ready: $URL"
echo "The first load compiles the app and can take ~30s. Ctrl+C to stop."
if [ "$OPEN" = "1" ] && [ "$TASK" = "dev" ] && command -v open >/dev/null; then open "$URL"; fi
wait "$DEV_PID"
