#!/usr/bin/env bash
# File: compiler/build-agda-2.9.0.sh
#
# Builds the compiler of issue 58 from pinned sources: Agda 2.9.0 for
# wasm32-wasi, and the Agda Language Server against it in two variants,
# the command module the page runs today and the reactor module issue 59
# needs.  No agda-web patch is involved: Agda builds for WASI as it is
# since agda/agda PR 8205, and the server's own patches for 2.9.0 are the
# two files in compiler/patches/ named below.
#
# Run it in the dev shell that pins its toolchain (flake.nix, `compiler`):
#
#   nix develop .#compiler --command compiler/build-agda-2.9.0.sh [OUT]
#
# OUT (default: compiler-out/ beside this repository's root, outside it)
# receives agda.wasm, als.wasm, als-reactor.wasm, als-reactor.js and
# SHA256SUMS, with each build plan.  The work tree (clones, the cabal
# store, dist-newstyle) goes to $WORK, by default one fixed path,
# /tmp/agda-native-ide-compiler, because the binaries record the paths
# they were built at (a package's data directory, for one), so two builds
# give the same bytes only from the same path.  What is pinned, and where:
#
#   +  Agda: agda/agda at AGDA_COMMIT, built with Agda's default flags
#      (optimise-heavily on, use-xdg-data-home off, so that the data
#      directory is $Agda_datadir itself, where the page puts it).
#   +  The server: agda/agda-language-server at ALS_COMMIT (tag v8), its
#      submodules network and lsp at the commits that tag records, its
#      Agda submodule replaced by AGDA_COMMIT, and the two patches.
#   +  Hackage: INDEX_STATE, the Agda commit's time, for every build.
#   +  The source-repository-packages: by commit, in the project files.
#   +  The toolchain: ghc-wasm-meta at flake.lock's `ghc-wasm-meta` input
#      (wasm32-wasi-ghc 9.10, wasm32-wasi-cabal, binaryen's wasm-opt),
#      and the native alex, happy, hpack, autoconf and node of the
#      flake's nixpkgs.  cabal builds its own alex and happy for wasm (the
#      build-tool-depends), which cannot run; the native ones on PATH
#      generate Agda's lexer and parser, so they are part of the pin.
#
# Network access: git clones and Hackage downloads, both pinned.  From
# an empty work directory, a run took 27 minutes on a 20-core
# workstation (2026-10-07).

set -euo pipefail

AGDA_COMMIT=da66a8c75f11d10699a6b38b261efdf244b66f2a
ALS_COMMIT=0f77a209243185cb8e36a11bfc7b6ab47f5125b4
INDEX_STATE=2026-10-05T16:41:29Z

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
out=$(realpath -m "${1:-$repo/../compiler-out}")
work=$(realpath -m "${WORK:-/tmp/agda-native-ide-compiler}")
patches=$repo/compiler/patches
export CABAL_DIR=$work/cabal

for tool in git wasm32-wasi-ghc wasm32-wasi-cabal wasm-opt alex happy hpack autoreconf node sha256sum; do
  command -v "$tool" > /dev/null || { echo "$tool is not on PATH: run in nix develop .#compiler" >&2; exit 1; }
done
mkdir -p "$out" "$work"
echo "== $(date -u +%FT%TZ) $(uptime)"
echo "== wasm32-wasi-ghc $(wasm32-wasi-ghc --numeric-version), wasm32-wasi-cabal $(wasm32-wasi-cabal --numeric-version)," \
  "$(wasm-opt --version), alex $(alex --numeric-version), happy $(happy --version | head -1)"

# A clone at one commit, fetched by its hash.
checkout () {  # checkout <url> <commit> <dir>
  [ -d "$3/.git" ] || git init -q "$3"
  git -C "$3" fetch -q --depth 1 "$1" "$2"
  git -C "$3" checkout -q --detach FETCH_HEAD
  [ "$(git -C "$3" rev-parse HEAD)" = "$2" ]
}

echo "== sources"
checkout https://github.com/agda/agda.git "$AGDA_COMMIT" "$work/agda"
checkout https://github.com/agda/agda-language-server.git "$ALS_COMMIT" "$work/als"
(
  cd "$work/als"
  # A rerun keeps dist-newstyle, so that it rebuilds only what changed.
  git reset -q --hard && git clean -qfdx -e wasm-submodules -e dist-newstyle
  for sub in network lsp; do
    url=$(git config -f .gitmodules "submodule.wasm-submodules/$sub.url")
    commit=$(git rev-parse "HEAD:wasm-submodules/$sub")
    checkout "$url" "$commit" "wasm-submodules/$sub"
    git -C "wasm-submodules/$sub" clean -qfdx
  done
  checkout https://github.com/agda/agda.git "$AGDA_COMMIT" wasm-submodules/agda
  git -C wasm-submodules/agda clean -qfdx
  # --whitespace=nowarn: a configured apply.whitespace=fix would rewrite
  # the patched lines (Haskell indents with spaces), and change the build.
  git apply --whitespace=nowarn "$patches/agda-language-server-agda-2.9.0.patch" \
    "$patches/agda-language-server-wasm-project.patch"
  hpack -f > /dev/null
  (cd wasm-submodules/network && autoreconf -i 2> /dev/null)
  cp cabal.project.wasm32 cabal.project
)

echo "== the Hackage index at $INDEX_STATE"
wasm32-wasi-cabal update "hackage.haskell.org,$INDEX_STATE"

flags=(-O2 --enable-split-sections)

echo "== agda"
(
  cd "$work/agda"
  time wasm32-wasi-cabal build --index-state="$INDEX_STATE" "${flags[@]}" exe:agda
  cp dist-newstyle/cache/plan.json "$out/plan-agda.json"
  # list-bin can print git's checkout messages first; the path is last.
  linked=$(wasm32-wasi-cabal list-bin --index-state="$INDEX_STATE" "${flags[@]}" exe:agda | tail -n 1)
  wasm-opt "$linked" -Oz -o "$out/agda.wasm"
)

for variant in command reactor; do
  echo "== the language server, $variant"
  (
    cd "$work/als"
    vflags=("${flags[@]}" --flag=Agda-2-9-0)
    [ "$variant" = reactor ] && vflags+=(--flag=reactor)
    time wasm32-wasi-cabal build "${vflags[@]}" exe:als
    cp dist-newstyle/cache/plan.json "$out/plan-als-$variant.json"
    linked=$(wasm32-wasi-cabal list-bin "${vflags[@]}" exe:als | tail -n 1)
    if [ "$variant" = command ]; then
      wasm-opt "$linked" -Oz -o "$out/als.wasm"
    else
      # The reactor's JavaScript glue, written by GHC's post-linker from
      # the linked module, with the toolchain that linked it.
      node "$(wasm32-wasi-ghc --print-libdir)/post-link.mjs" -i "$linked" -o "$out/als-reactor.js"
      wasm-opt "$linked" -Oz -o "$out/als-reactor.wasm"
    fi
  )
done

(cd "$out" && sha256sum agda.wasm als.wasm als-reactor.wasm als-reactor.js > SHA256SUMS && cat SHA256SUMS)
echo "== $(date -u +%FT%TZ) $(uptime)"
