#!/usr/bin/env bash
# DCO check (M0-05, CONTRIBUTING.md#sign-off-dco): every non-merge commit in BASE..HEAD needs a
# "Signed-off-by: Name <email>" trailer. Commits by GitHub bot accounts (release-please,
# Renovate's app) are exempt; Renovate also adds the trailer itself (renovate.json commitBody).
#   .github/scripts/dco-check.sh <base-sha> <head-sha>
# A missing or unknown base (new branch, force push) checks only the head commit.
set -euo pipefail

base="${1:?usage: dco-check.sh <base-sha> <head-sha>}"
head="${2:?usage: dco-check.sh <base-sha> <head-sha>}"
zero="0000000000000000000000000000000000000000"

if [ "$base" = "$zero" ] || ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  range="${head}^!"
else
  range="${base}..${head}"
fi

checked=0
failed=0
while read -r sha; do
  [ -n "$sha" ] || continue
  checked=$((checked + 1))
  author="$(git log -1 --format='%an <%ae>' "$sha")"
  case "$author" in
    *'[bot] <'*) continue ;;
  esac
  if ! git log -1 --format='%B' "$sha" | grep -Eq '^Signed-off-by: .+ <[^<>@ ]+@[^<>@ ]+>[[:space:]]*$'; then
    echo "::error::Commit $(git rev-parse --short "$sha") has no Signed-off-by trailer: $(git log -1 --format='%s' "$sha")"
    failed=$((failed + 1))
  fi
done < <(git rev-list --no-merges "$range")

if [ "$failed" -gt 0 ]; then
  echo "dco FAILED: $failed of $checked commit(s) lack a Signed-off-by trailer. Fix with: git commit -s --amend (or git rebase --signoff <base>)." >&2
  exit 1
fi
echo "dco passed: $checked commit(s) checked."
