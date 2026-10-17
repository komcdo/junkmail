#!/usr/bin/env bash
# junkmail: merge upstream T3 Code into the current branch, then verify the fork still fits.
#
#   scripts/junkmail/sync-upstream.sh            fetch, merge upstream/main, verify
#   scripts/junkmail/sync-upstream.sh --verify   verify only (after resolving conflicts by hand)
#
# Undo a merge that went badly with: git merge --abort   (mid-merge)
#                                    git reset --hard ORIG_HEAD   (after it committed)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

UPSTREAM_REF="${UPSTREAM_REF:-upstream/main}"
GENERATED_ROUTES="apps/web/src/routeTree.gen.ts"

if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh" >/dev/null
  nvm use 24 >/dev/null
fi
export PATH="$HOME/.local/share/vite-plus/bin:$PATH"

verify() {
  echo "==> Installing dependencies"
  vp i
  echo "==> Regenerating the route tree"
  node scripts/junkmail/generate-routes.mjs
  if ! git diff --quiet -- "$GENERATED_ROUTES"; then
    echo "    $GENERATED_ROUTES changed; commit it with the merge."
  fi
  for pkg in packages/contracts packages/client-runtime apps/server apps/web apps/mobile; do
    echo "==> Typecheck $pkg"
    (cd "$pkg" && vp run typecheck)
  done
  echo "==> Inbox tests"
  (cd packages/client-runtime && vp test run src/state/inbox.test.ts)
  (cd apps/server && vp test run src/inbox)
  echo "==> Fork seams"
  node scripts/junkmail/seams.mjs "$UPSTREAM_REF"
  echo "Upstream sync verified."
}

if [ "${1:-}" = "--verify" ]; then
  verify
  exit 0
fi

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Commit or stash your changes before syncing." >&2
  exit 1
fi

# Remember conflict resolutions so the same hunk never needs resolving twice.
git config rerere.enabled true
git config rerere.autoupdate true

git fetch upstream
behind=$(git rev-list --count "HEAD..$UPSTREAM_REF")
if [ "$behind" = "0" ]; then
  echo "Already up to date with $UPSTREAM_REF."
  exit 0
fi
echo "==> Merging $behind commits from $UPSTREAM_REF into $(git branch --show-current)"

if ! git merge --no-edit "$UPSTREAM_REF"; then
  if git diff --name-only --diff-filter=U | grep -qx "$GENERATED_ROUTES"; then
    git checkout --theirs -- "$GENERATED_ROUTES"
    node scripts/junkmail/generate-routes.mjs
    git add "$GENERATED_ROUTES"
  fi
  remaining=$(git diff --name-only --diff-filter=U)
  if [ -n "$remaining" ]; then
    echo
    echo "Conflicts to resolve (see docs/junkmail/UPSTREAM.md):"
    echo "$remaining" | sed 's/^/  /'
    echo
    echo "Resolve them, 'git add' each file, 'git commit --no-edit', then run:"
    echo "  scripts/junkmail/sync-upstream.sh --verify"
    exit 1
  fi
  git commit --no-edit
fi

verify
