#!/usr/bin/env bash
# stub-nix.sh
#
# File: scripts/agda-for-project/stub-nix.sh
#
# Description:
#   A stand-in for nix in the launcher's tests (test.mjs), linked into a
#   test's PATH as `nix`, so the tests need no network and no Nix store.
#   It answers the calls the launcher makes, in their exact shapes:
#     eval --json ... FLAKE#packages.SYSTEM --apply EXPR
#     eval --json ... FLAKE#devShells.SYSTEM --apply builtins.attrNames
#     eval --raw  ... FLAKE#ATTR.libraryFile
#     eval --raw  ... FLAKE#ATTR.outPath          (a flake outside git)
#     build ... FLAKE#ATTR -o ROOT
#     develop ... FLAKE#NAME --profile PROFILE --command CMD...
#   Each test steers it with control files in FLAKE/.stub/, which git does
#   not track, so they never change the launcher's key: packages.json and
#   devshells.json (what the flake provides; absent means "does not provide
#   attribute"), libraries (the environment's libraries file), version (what
#   the stub Agda answers to --numeric-version), build-sleep, build-fails,
#   no-agda, eval-fails, develop-fails, devshell-agda (`checkout`, the
#   default, writes FLAKE/.agda/bin/agda as agda-algebras' downstream shells
#   do; `none` adds no agda; `elsewhere` adds one outside both the store
#   and the checkout), and keep-agda-dir (the shell leaves AGDA_DIR
#   as it found it).
#
#   Every call is logged to STUB_NIX_LOG.  A build makes a directory in
#   STUB_STORE whose bin/agda prints which build it came from, its
#   arguments, its AGDA_DIR, and then its stdin; build and develop also print
#   a line on stdout, which must never reach the launcher's stdout.

set -eu
echo "nix $*" >> "$STUB_NIX_LOG"
sub="$1"; shift

ref=""
for a in "$@"; do case "$a" in *'#'*) ref="$a"; break ;; esac; done
flake="${ref%%#*}" attrpath="${ref#*#}"
ctl="${flake}/.stub"
version="$(cat "${ctl}/version" 2>/dev/null || echo 2.9.0)"

# make_agda FILE TAG: a stub Agda.
make_agda() {
  cat > "$1" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = --numeric-version ]; then echo "${version}"; exit 0; fi
echo "agda $2"
for a in "\$@"; do echo "arg \$a"; done
echo "AGDA_DIR=\${AGDA_DIR-unset}"
cat
exit "\${STUB_AGDA_EXIT:-0}"
EOF
  chmod +x "$1"
}

case "$sub" in
  eval)
    if [ -f "${ctl}/eval-fails" ]; then echo "error: stub nix cannot evaluate ${ref}" >&2; exit 1; fi
    case "$attrpath" in
      *.libraryFile)
        if [ -f "${ctl}/libraries" ]; then printf '%s' "${ctl}/libraries"
        else echo "error: attribute 'libraryFile' missing" >&2; exit 1
        fi ;;
      *.outPath)
        printf '/nix/store/%s-%s' \
          "$(cat "${flake}/flake.nix" "${flake}/flake.lock" 2>/dev/null | sha256sum | cut -c1-32)" \
          "${attrpath%.outPath}" ;;
      packages.*)
        if [ -f "${ctl}/packages.json" ]; then cat "${ctl}/packages.json"
        else echo "error: flake 'path:${flake}' does not provide attribute '${attrpath}'" >&2; exit 1
        fi ;;
      devShells.*)
        if [ -f "${ctl}/devshells.json" ]; then cat "${ctl}/devshells.json"
        else echo "error: flake 'path:${flake}' does not provide attribute '${attrpath}'" >&2; exit 1
        fi ;;
      *) echo "stub nix: unexpected eval of ${attrpath}" >&2; exit 2 ;;
    esac ;;
  build)
    root="" prev=""
    for a in "$@"; do [ "$prev" != -o ] || root="$a"; prev="$a"; done
    sleep "$(cat "${ctl}/build-sleep" 2>/dev/null || echo 0)"
    echo "stub nix: stdout noise"
    if [ -f "${ctl}/build-fails" ]; then echo "error: stub nix cannot fetch" >&2; exit 1; fi
    n="$(grep -c '^nix build' "$STUB_NIX_LOG")"
    out="${STUB_STORE}/build-${n}-${attrpath}"
    mkdir -p "${out}/bin"
    [ -f "${ctl}/no-agda" ] || make_agda "${out}/bin/agda" "build-${n} of ${attrpath}"
    ln -sfn "$out" "$root" ;;
  develop)
    profile="" prev=""
    for a in "$@"; do [ "$prev" != --profile ] || profile="$a"; prev="$a"; done
    while [ "$#" -gt 0 ] && [ "$1" != --command ]; do shift; done
    shift
    echo "stub nix: dev shell banner"
    if [ -f "${ctl}/develop-fails" ]; then echo "error: stub nix cannot build the dev shell" >&2; exit 1; fi
    mkdir -p "${STUB_STORE}/dev-env"
    ln -sfn "${STUB_STORE}/dev-env" "$profile"
    case "$(cat "${ctl}/devshell-agda" 2>/dev/null || echo checkout)" in
      checkout)
        mkdir -p "${flake}/.agda/bin"
        make_agda "${flake}/.agda/bin/agda" "devshell of ${flake}"
        export PATH="${flake}/.agda/bin:${PATH}"
        [ -f "${ctl}/keep-agda-dir" ] || export AGDA_DIR="${flake}/.agda" ;;
      elsewhere)
        mkdir -p "${STUB_STORE}/../elsewhere-bin"
        make_agda "${STUB_STORE}/../elsewhere-bin/agda" "elsewhere"
        export PATH="${STUB_STORE}/../elsewhere-bin:${PATH}" ;;
    esac
    exec "$@" ;;
  *) echo "stub nix: unexpected ${sub} $*" >&2; exit 2 ;;
esac
