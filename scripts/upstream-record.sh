#!/usr/bin/env bash
# File: scripts/upstream-record.sh
#
# Print the provenance record of one commit of upstream (plfa-playground):
# every file in its tree, as sha256sum prints it (the SHA-256, two
# spaces, the path in upstream's tree), in git's tree order.  It reads the
# commit from this repository's object store, so fetch the `upstream`
# remote first (README, "Syncing with upstream").
#
#   scripts/upstream-record.sh <commit> > upstream/plfa-playground.sha256
#
# The committed record is this script's output for the imported commit,
# so `diff` against it lists every file a later commit adds, removes or
# changes.

set -euo pipefail

commit=${1:?usage: scripts/upstream-record.sh <commit>}

git ls-tree -r -z "$commit" |
  while IFS= read -r -d '' entry; do
    meta=${entry%%$'\t'*}
    file=${entry#*$'\t'}
    read -r _mode type object <<<"$meta"
    [ "$type" = blob ] || continue
    digest=$(git cat-file blob "$object" | sha256sum)
    printf '%s  %s\n' "${digest%% *}" "$file"
  done
