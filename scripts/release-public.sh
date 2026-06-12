#!/bin/sh
# Release the current tree to the public repo as ONE curated commit.
# Dev happens in the private repo (full history); the public repo receives
# tree snapshots only — no private history ever crosses. The attest bot
# commits to public main between releases; we parent on its tip so those
# re-issued attestations are never clobbered (pull public first if the local
# registry/ should incorporate them).
set -eu
MSG="${1:?usage: scripts/release-public.sh \"release: <summary>\"}"
PUBLIC_REMOTE="${PUBLIC_REMOTE:-public}"
git fetch "$PUBLIC_REMOTE" main 2>/dev/null || true
TREE=$(git rev-parse 'HEAD^{tree}')
if PARENT=$(git rev-parse --verify -q "$PUBLIC_REMOTE/main"); then
  COMMIT=$(git commit-tree "$TREE" -p "$PARENT" -m "$MSG")
else
  COMMIT=$(git commit-tree "$TREE" -m "$MSG")
fi
git push "$PUBLIC_REMOTE" "$COMMIT:refs/heads/main"
echo "released $COMMIT to $PUBLIC_REMOTE/main"
