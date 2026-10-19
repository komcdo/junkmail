#!/usr/bin/env bash
# junkmail: cut a Homebrew release.
#
#   scripts/junkmail/release.sh 0.1.0
#
# Tags the current commit as junkmail-v<version> and pushes the tag. GitHub Actions
# (.github/workflows/junkmail-release.yml) builds the Apple Silicon CLI archive and publishes
# the release; this script then copies the generated formula into komcdo/homebrew-junkmail,
# creating that tap repo on first use. Needs `gh` signed in to the account that owns the fork.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

VERSION="${1:-}"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.]+)?$ ]]; then
  echo "usage: scripts/junkmail/release.sh <version>   (for example 0.1.0)" >&2
  exit 1
fi
REPO="komcdo/junkmail"
TAP="komcdo/homebrew-junkmail"
TAG="junkmail-v$VERSION"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Commit your changes first; the release builds the pushed commit." >&2
  exit 1
fi
BRANCH="$(git branch --show-current)"
git push origin "$BRANCH"
if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  git tag "$TAG"
fi
git push origin "$TAG"

echo "==> Waiting for the release build (about 15 minutes)"
RUN_ID=""
for _ in $(seq 1 30); do
  # Filter by name rather than --workflow, which only sees workflows on the default branch.
  RUN_ID="$(gh run list -R "$REPO" --event push -L 20 --json databaseId,headBranch,workflowName \
    -q ".[] | select(.headBranch == \"$TAG\" and .workflowName == \"junkmail release\") | .databaseId" |
    head -1)"
  [ -n "$RUN_ID" ] && break
  sleep 5
done
if [ -z "$RUN_ID" ]; then
  echo "No release run started. Enable workflows on the fork: https://github.com/$REPO/actions" >&2
  exit 1
fi
gh run watch "$RUN_ID" -R "$REPO" --exit-status

echo "==> Updating the Homebrew tap"
if ! gh repo view "$TAP" >/dev/null 2>&1; then
  gh repo create "$TAP" --public --description "Homebrew tap for junkmail"
fi
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
gh repo clone "$TAP" "$WORK/tap" -- --quiet 2>/dev/null || git init -q "$WORK/tap"
gh release download "$TAG" -R "$REPO" --pattern junkmail.rb --dir "$WORK"
mkdir -p "$WORK/tap/Formula"
cp "$WORK/junkmail.rb" "$WORK/tap/Formula/junkmail.rb"
cd "$WORK/tap"
git add Formula/junkmail.rb
if git diff --cached --quiet; then
  echo "Tap already has $VERSION."
else
  git commit -qm "junkmail $VERSION"
  git branch -M main
  git remote get-url origin >/dev/null 2>&1 || git remote add origin "https://github.com/$TAP.git"
  git push -q -u origin main
fi

cat <<EOF

Released junkmail $VERSION.
Install:  brew install komcdo/junkmail/junkmail
Upgrade:  brew upgrade junkmail
EOF
