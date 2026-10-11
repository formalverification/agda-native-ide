#!/usr/bin/env bash
# File: scripts/library-archives/build.sh
#
# Build agda-algebras' interfaces, and those of the standard-library modules
# they import, with the compiler's plain agda under wasmtime, over a stage
# laid out as the page's drive (stage.sh), and write the dependency graph
# Agda itself computes (issue 12).  `nix build .#agda-algebras-interfaces`
# runs it in the Nix sandbox; it runs as well outside it.
#
# usage: build.sh OUT
#   env: WASMTIME, AGDA_WASM (stage.sh); AGDA_DATA_ZIP, STDLIB_ZIP and
#        SOURCES_ZIP, the three archives the stage is laid out from; WORK, a
#        directory to build in (default: a new temporary one)
#
# What OUT holds, all of it determined by the inputs:
#   stage/agda-algebras/_build/<version>/agda/src/**.agdai
#   stage/stdlib/_build/<version>/agda/src/**.agdai
#   graph.dot     `agda --dependency-graph` of a module importing every
#                 module of agda-algebras: transitively reduced, so its
#                 reachability, not its edges, is each module's closure
#   modules.txt   agda-algebras' modules, one per line, sorted
#   checked.txt   the build's Checking lines, in the order Agda printed them
#
# Every module of agda-algebras' include path is built, Legacy/ included,
# since a reader may import any of them; `agda --build-library` finds them
# (sorted, so the order does not depend on the filesystem) and checks them
# one at a time, so no generated Everything.agda is needed.  The build log,
# with GNU time's and GHC's statistics for each run, goes to standard error.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=scripts/library-archives/stage.sh
. "$here/stage.sh"
: "${WASMTIME:?}" "${AGDA_WASM:?}" "${AGDA_DATA_ZIP:?}" "${STDLIB_ZIP:?}" "${SOURCES_ZIP:?}"
out=${1:?usage: build.sh OUT}
work=${WORK:-$(mktemp -d)}
stage=$work/stage
logs=$work/logs
mkdir -p "$out" "$logs"

lay_out_stage "$stage" "$AGDA_DATA_ZIP" "$STDLIB_ZIP" "$SOURCES_ZIP"
# The first run compiles the module, unless wasmtime's cache has it.
version=$(agda_guest_timed "$logs/version.time" "$stage" / --numeric-version)
echo "build: Agda $version; wasmtime's first run:" \
  "$(grep -E 'Elapsed|Maximum resident' "$logs/version.time" | sed 's/^\t//' | paste -sd ';')" >&2

# run NAME GUEST_PWD ARG...: agda over the stage, logged, with GNU time's
# statistics and GHC's (+RTS -s); fails unless agda exits 0.
run() {
  local name=$1 pwd=$2 status=0
  shift 2
  echo "build: $name: agda $*; load $(load_average)" >&2
  agda_guest_timed "$logs/$name.time" "$stage" "$pwd" +RTS -s -RTS "$@" \
    > "$logs/$name.log" 2>&1 || status=$?
  cat "$logs/$name.log" >&2
  grep -E 'Elapsed|Maximum resident' "$logs/$name.time" >&2
  if [ "$status" -ne 0 ]; then
    echo "build: $name: agda exited $status" >&2
    return 1
  fi
}

# 1.  Every module of agda-algebras, and what it imports.
run build-library /agda-algebras --build-library
grep 'Checking ' "$logs/build-library.log" | sed 's/^ *//' > "$out/checked.txt"
(cd "$stage/agda-algebras/src" && find . -type f \
    \( -name '*.agda' -o -name '*.lagda' -o -name '*.lagda.*' \) \
  | sed -e 's|^\./||' -e 's|\.lagda\.[a-z]*$||' -e 's|\.l\{0,1\}agda$||' -e 's|/|.|g' \
  | LC_ALL=C sort) > "$out/modules.txt"
modules=$(wc -l < "$out/modules.txt")
checked_aa=$(grep -c '(/agda-algebras/' "$out/checked.txt" || true)
checked_stdlib=$(grep -c '(/stdlib/' "$out/checked.txt" || true)
checked_prim=$(grep -c '(/lib/prim/' "$out/checked.txt" || true)
echo "build: checked $checked_aa of agda-algebras' $modules modules," \
  "$checked_stdlib of the standard library's, $checked_prim builtins" >&2
if [ "$checked_aa" -ne "$modules" ] || [ "$checked_prim" -ne 0 ]; then
  echo "build: expected all $modules of agda-algebras' modules and no builtin" >&2
  exit 1
fi

# 2.  The graph: Agda's own, of a module that imports every module, over
# the built stage, so that only that module is checked.
write_play_library "$stage"
{
  printf '{-# OPTIONS --without-K --safe #-}\n\nmodule All where\n\n'
  sed 's/^/import /' "$out/modules.txt"
} > "$stage/play/All.agda"
run dependency-graph /play --dependency-graph=/play/graph.dot /play/All.agda
graph_checked=$(checking_lines "$logs/dependency-graph.log")
if [ "$graph_checked" -ne 1 ]; then
  echo "build: the graph's run checked $graph_checked modules, not 1 (All)" >&2
  exit 1
fi
cp "$stage/play/graph.dot" "$out/graph.dot"

# 3.  The interfaces, at their paths in the stage.
for lib in agda-algebras stdlib; do
  mkdir -p "$out/stage/$lib"
  cp -R "$stage/$lib/_build" "$out/stage/$lib/_build"
done
echo "build: $(find "$out/stage" -name '*.agdai' | wc -l) interfaces," \
  "$(grep -c -- '->' "$out/graph.dot") edges in the graph" >&2
