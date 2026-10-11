#!/usr/bin/env bash
# File: scripts/library-archives/check.sh
#
# Check that agda-algebras' archives serve a cold check of each root (issue
# 12's second criterion): for each root, a fresh stage laid out as the
# page's drive (stage.sh) with the builtins, both libraries' sources, and
# only the archives the index names for that root (index.mjs); a Main that
# imports the root under agda-algebras' options line; and the compiler's
# agda, which must exit 0 having type-checked one module, Main.  Anything
# else fails.  `nix build .#agda-algebras-check` runs it on every root.
#
# usage: check.sh [--controls] ARCHIVES REPORT [ROOT...]
#   ARCHIVES  what `nix build .#agda-algebras-archives` wrote
#   REPORT    the file to write: per root, its exit status, its Checking
#             lines, its closure's modules, its archives and their bytes
#   ROOT...   the roots to check (default: every root of the index)
#   --controls  then run two controls on CONTROL_ROOT, each of which must
#             type-check more than one module, or the check could not fail:
#             the root's own archive left out, and one byte of its source
#             changed under its interface
#   env: WASMTIME, AGDA_WASM (stage.sh); AGDA_DATA_ZIP and STDLIB_ZIP, the
#        builtins and the standard library the page ships; JOBS, the checks
#        run at once (default 4); WORK, a directory to stage in (default: a
#        new temporary one); MAIN_OPTIONS, Main's options line (default
#        agda-algebras'); CONTROL_ROOT (default Overture.Basic)
#
# A root's stage links its files to one copy of each archive, made read-only,
# so that staging costs little and no check can change what another reads.
# Each check's time and peak memory go to standard error.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=scripts/library-archives/stage.sh
. "$here/stage.sh"
controls=
if [ "${1:-}" = --controls ]; then controls=1; shift; fi
: "${WASMTIME:?}" "${AGDA_WASM:?}" "${AGDA_DATA_ZIP:?}" "${STDLIB_ZIP:?}"
archives=${1:?usage: check.sh [--controls] ARCHIVES REPORT [ROOT...]}
report=${2:?usage: check.sh [--controls] ARCHIVES REPORT [ROOT...]}
shift 2
work=${WORK:-$(mktemp -d)}
export MAIN_OPTIONS=${MAIN_OPTIONS:-'{-# OPTIONS --without-K --exact-split --safe #-}'}
control_root=${CONTROL_ROOT:-Overture.Basic}
# xargs -P 0 runs every check at once, at up to 1 GiB each.
jobs=${JOBS:-4}
if ! [ "$jobs" -ge 1 ] 2> /dev/null; then
  echo "check: JOBS must be a count of at least 1, not '$jobs'" >&2
  exit 2
fi
index=$archives/index.json
mkdir -p "$work/archives" "$work/roots" "$work/results"

# The drive before any interface archive, and a play library for Main.
lay_out_stage "$work/base" "$AGDA_DATA_ZIP" "$STDLIB_ZIP" \
  "$archives/$(cd "$archives" && ls -- *-sources.zip)"
write_play_library "$work/base"
find "$work/base" -type f -exec chmod a-w {} +
for zip in "$archives"/interfaces/*.zip; do
  name=$(basename "$zip" .zip)
  unzip -q "$zip" -d "$work/archives/$name"
  find "$work/archives/$name" -type f -exec chmod a-w {} +
done
# One run first, so that wasmtime compiles the module once, not once a job.
agda_guest "$work/base" / --version >&2

# check_root "ROOT MODULES BYTES ARCHIVE...": stage the root, check it, and
# write its line to $work/results/ROOT.
check_root() {
  local root modules bytes needed stage status=0 count line
  read -r root modules bytes needed <<< "$1"
  stage=$work/roots/$root
  mkdir -p "$stage"
  cp -al "$work/base/." "$stage/"
  for archive in $needed; do
    cp -al "$work/archives/$(basename "$archive" .zip)/." "$stage/"
  done
  "${STAGE_HOOK:-true}" "$stage" "$root"
  printf '%s\nmodule Main where\nimport %s\n' "$MAIN_OPTIONS" "$root" \
    > "$stage/play/Main.agda"
  agda_guest_timed "$stage.time" "$stage" /play /play/Main.agda \
    > "$stage.log" 2>&1 || status=$?
  count=$(checking_lines "$stage.log")
  line="$root $status $count $modules $(wc -w <<< "$needed") $bytes"
  echo "$line" > "$work/results/$root"
  echo "check: $line $(sed -n 's/.*Elapsed (wall clock) time (h:mm:ss or m:ss): //p' "$stage.time") $(sed -n 's/.*Maximum resident set size (kbytes): //p' "$stage.time") KiB" >&2
  if [ "$status" -ne 0 ] || [ "$count" -ne 1 ]; then
    sed 's/^/  | /' "$stage.log" | head -40 >&2
  fi
  rm -rf "$stage"
}
export -f check_root agda_guest agda_guest_timed checking_lines
export work WASMTIME AGDA_WASM

node "$here/index.mjs" each "$index" "$@" > "$work/plan"
echo "check: $(date -u +%FT%TZ), load $(load_average), $jobs at once" >&2
xargs -d '\n' -P "$jobs" -n 1 bash -c 'check_root "$1"' _ < "$work/plan"
echo "check: done $(date -u +%FT%TZ), load $(load_average)" >&2

{
  echo "root exit checking modules archives bytes"
  LC_ALL=C sort "$work"/results/*
} > "$report"
# A root with no line failed too: its check did not finish.
total=$(wc -l < "$work/plan")
passed=$(awk 'NR > 1 && $2 == 0 && $3 == 1' "$report" | wc -l)
failed=$((total - passed))
echo "check: $passed of $total roots checked Main alone" >&2

if [ -n "$controls" ]; then
  # Each control stages the root as above, then breaks it: a check that
  # still type-checks Main alone would pass anything.
  drop_own_archive() { rm -f "$1/agda-algebras/_build/"*/agda/src/"${2//.//}.agdai"; }
  change_a_source_byte() {
    local file first new=x
    file=$(find "$1/agda-algebras/src" -path "*/${2//.//}.*" -type f | head -1)
    cp "$file" "$file.copy" && mv "$file.copy" "$file" && chmod u+w "$file"
    first=$(head -c 1 "$file")
    [ "$first" = x ] && new=y
    printf '%s' "$new" | dd of="$file" bs=1 count=1 conv=notrunc status=none
  }
  export -f drop_own_archive change_a_source_byte
  rm -rf "$work/results"; mkdir -p "$work/results"
  for control in drop_own_archive change_a_source_byte; do
    STAGE_HOOK=$control check_root "$(node "$here/index.mjs" each "$index" "$control_root")"
    read -r _ status count rest < "$work/results/$control_root"
    echo "control:$control $status $count $rest" >> "$report"
    if [ "$count" -le 1 ]; then
      echo "check: control $control type-checked $count module: it cannot fail" >&2
      failed=$((failed + 1))
    fi
  done
fi

[ "$failed" -eq 0 ]
