#!/usr/bin/env bash
# junkmail: set up the fork on a new Mac or Linux machine, or update an existing checkout.
#
#   curl -fsSL https://raw.githubusercontent.com/komcdo/junkmail/inbox-phase1/scripts/junkmail/install.sh | bash
#
# Installs nvm + Node 24 and Vite+ if missing, clones (or pulls) the fork into
# JUNKMAIL_DIR (default ~/Dev/junkmail), and installs dependencies. Safe to re-run.
set -euo pipefail

REPO="${JUNKMAIL_REPO:-https://github.com/komcdo/junkmail.git}"
BRANCH="${JUNKMAIL_BRANCH:-inbox-phase1}"
DIR="${JUNKMAIL_DIR:-$HOME/Dev/junkmail}"

command -v git >/dev/null || { echo "Install git first (xcode-select --install on macOS)." >&2; exit 1; }

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [ ! -s "$NVM_DIR/nvm.sh" ]; then
  echo "==> Installing nvm"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
fi
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh"
echo "==> Installing Node 24"
nvm install 24 >/dev/null
nvm use 24 >/dev/null

if ! command -v vp >/dev/null && [ ! -x "$HOME/.local/share/vite-plus/bin/vp" ]; then
  echo "==> Installing Vite+ (vp)"
  curl -fsSL https://vite.plus | bash
fi
export PATH="$HOME/.local/share/vite-plus/bin:$PATH"

if [ -d "$DIR/.git" ]; then
  echo "==> Updating $DIR"
  git -C "$DIR" fetch origin "$BRANCH"
  git -C "$DIR" checkout "$BRANCH"
  git -C "$DIR" pull --ff-only origin "$BRANCH"
else
  echo "==> Cloning into $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --branch "$BRANCH" "$REPO" "$DIR"
fi

echo "==> Installing dependencies"
(cd "$DIR" && vp i)

cat <<EOF

junkmail is installed in $DIR

  cd $DIR
  scripts/junkmail/dev.sh            # start it; opens your browser when ready
  scripts/junkmail/dev.sh --seed     # same, with test data

Sign in to the agent CLIs you use (Claude Code, Codex) on this machine so threads can run.
Re-run this installer any time to update.
EOF
