#!/usr/bin/env bash
# agda-for-project
#
# File: scripts/agda-for-project/agda-for-project.sh
#
# Changed from upstream: this began as agda-native-air's
# scripts/agda-for-flake.sh at 0359b4be3bddc9df71035a78fe706542fa22a736
# (merged in formalverification/agda-native-air PR 344, 2026-11-07).  The
# key, the build under a lock, the published root, the note beside it, and
# the rules for the streams are that script's, kept as they were.  New here
# (issue 97): the project and the flake found from a file, the discovery of
# the flake's Agda (a remembered choice, the one Agda environment among its
# packages, or its dev shell's agda), the libraries file for a project that
# depends on a sibling library of its checkout, and the answers a host asks
# for without running Agda (--explain, --candidates, --choose, --forget).
#
# Description:
#   Run the Agda that a file's own project pins, for every host that starts
#   Agda: agda2-mode, agda-mode-vscode, this repository's VS Code companion,
#   and agda-native-air's agda-mcp.  A host names this program where it
#   would name `agda`; every argument goes to Agda unchanged.  The program
#   finds the project from its working directory, decides which Agda the
#   project's flake names, builds it once per change of what decides it,
#   and execs it.  So two projects on two Agdas, or two worktrees of one
#   project on two locks, each get their own, with nothing to set by hand.
#
# The project and its flake:
#   The project is the directory of the nearest `.agda-lib` at or above the
#   starting directory (as Agda finds a file's library, past a nested
#   repository's boundary too), or the starting directory itself when there
#   is none.  The flake is the nearest
#   `flake.nix` at or above the project, stopping at a repository's
#   boundary (a directory holding `.git`).  The starting directory is the
#   working directory, or AGDA_FOR_PROJECT_DIR when that is set (for a host
#   that cannot choose the directory it starts Agda in), or, for the
#   options below that take one, the FILE argument (its directory, or the
#   directory itself).
#
# Which Agda (first match wins):
#   1.  An attribute named by the host: AGDA_FLAKE_ATTR, or a leading
#       `--flake-attr NAME` (agda-for-flake.sh's interface, so an agda-mcp
#       registration written for it works here unchanged), which --explain
#       may follow.
#   2.  A choice remembered for this project with --choose: a flake
#       attribute (`package:NAME`), a dev shell (`devshell:NAME`), or an
#       executable (`path:FILE`, kept as an absolute path).  Choices live
#       in the user's state directory, keyed by the repository (its common
#       git directory, which every worktree shares) and the project's
#       directory within it, so one choice serves every worktree; never in
#       the checkout.  Only a working tree git lists for that repository
#       (`git worktree list`) shares them: a `.git` file can name any git
#       directory, so a directory unpacked with one naming a repository of
#       the user's would otherwise inherit that repository's choices, and a
#       choice is consent to run code.  Any other checkout (a submodule's
#       too) is keyed by its own path.
#   3.  The flake's one Agda environment: a package of the system (see
#       Environment) named `default` or with `agda` in its name, that
#       evaluates to a derivation whose pname is `agdaWithPackages` (what
#       nixpkgs' `agda.withPackages` makes).  Names alone would not do:
#       formal-ledger-specifications' packages hold `fls-agda` (an Agda
#       without libraries) and `fls-shake-agdaWithPackages` (a build tool)
#       beside the environment `fls-agdaWithPackages`.  With several
#       environments, `default` wins if it is one; otherwise nothing is
#       decided.
#   4.  The flake's dev shell `default`, when it puts an `agda` on PATH
#       that is its own (in the store, or in the checkout, as the shells of
#       agda-algebras' downstream projects write `.agda/bin/agda`), and not
#       one inherited from the caller's PATH: the shell is entered with a
#       sentinel agda first in the caller's part of PATH, which nix develop
#       puts after the shell's own, and without the caller's AGDA_DIR, so
#       what it gives is its own whoever calls.
#   5.  Otherwise nothing is decided: exit 69 with one line saying so, and
#       --candidates lists what a chooser can offer.
#   What discovery finds (3 or 4) is run only for a trusted flake (below).
#   Why the environment comes before the dev shell (measured 2026-11-07 on
#   formal-ledger-specifications, agda-algebras and agda-lattices): both
#   are cheap once built (discovery 0.35 s and 1.0 s; a dev shell 0.3 s to
#   2.5 s), but evaluating a package runs nothing and builds only Agda and
#   its libraries, while a dev shell runs the project's hook, which writes
#   into the checkout, and builds every tool its developers use.  A project
#   whose dev shell does more (agda-algebras' passes `--library` flags, so a
#   scratch file outside every library still sees them) can be given its
#   dev shell with `--choose devshell:default`.
#
# Trust:
#   Running what a flake provides runs the flake's code as the user,
#   outside any sandbox: a package's bin/agda can be any program, and a dev
#   shell's hook runs on entry.  So opening a file of a repository just
#   cloned must not be enough to run its Agda; direnv asks for `direnv
#   allow` for the same reason.  What discovery finds is therefore run (or
#   entered) only for a trusted flake, by a line of
#   ${XDG_CONFIG_HOME:-$HOME/.config}/agda-for-project/trusted (`~/` for
#   the home directory, `#` for a comment) of one of two kinds: a
#   directory, which trusts every flake at or below it; or `repository
#   GITDIR`, which trusts every working tree git lists for the repository
#   whose common git directory is GITDIR (never a directory whose `.git`
#   file merely names it).  Otherwise the program stops and says how to
#   allow it.  `--choose trust:DIR` and `--choose trust-repository:[GITDIR]`
#   (with none, the project's own) write those lines; an attribute named
#   by the host and a choice are consent for their project.  Evaluating a
#   flake needs no consent (the evaluation is pure), nor does building
#   (builds run as Nix's build users, in its sandbox where the platform has
#   one), so discovery evaluates an untrusted flake to say what trusting it
#   would run.
#
# The project's own libraries:
#   An environment cannot hold the project's own library (Agda would then
#   find it twice), and a project may depend on a sibling library of the
#   same checkout (formal-ledger-test on formal-ledger).  So, for an
#   environment, when the project's `.agda-lib` depends on a library the
#   environment does not register, this program writes a libraries file of
#   the environment's entries and the checkout's tracked `.agda-lib` files
#   that provide the missing names (and what those depend on in turn), and
#   passes it as a `--library-file` after the environment's own, which the
#   later one overrides.  Names are compared without a version suffix, as
#   Agda matches `standard-library` against `standard-library-2.3`.  A dev
#   shell's agda keeps the registry its hook wrote.
#
# Answers without running Agda:
#   --explain [--json] [--no-build] [FILE]
#       The project, its flake, how its Agda was decided, the program with
#       its arguments and environment, its version, and the libraries file;
#       builds first unless --no-build.  With --json, one JSON object on
#       stdout, also when nothing is decided (`"decided": false`, with the
#       line in `error` and its kind in `reason`: `untrusted`, when trust
#       would let discovery's answer, in `method` and `name`, run;
#       `undecided`, when a choice would settle it; `failed` otherwise),
#       and the exit status says which.
#   --candidates [--json] [FILE]
#       What a chooser can offer: trusting the flake, when that would decide
#       (`trust-repository:GITDIR` in a checkout git lists, else
#       `trust:DIR`), each Agda environment of the flake, each dev
#       shell, the Agdas this program has built, and `agda` on PATH, each
#       with an `id` that --choose takes and its version where it is known
#       without building.
#   --choose ID [FILE]
#       Remember ID for the project (see "Which Agda", step 2); or, for
#       `trust:DIR` or `trust-repository:[GITDIR]`, add its line to the
#       trust file and forget the project's choice, so that discovery
#       decides.
#   --forget [FILE]
#       Forget the project's choice.
#
# The key (what decides a build), agda-for-flake.sh's with the system added:
#   For a flake in a git checkout, Nix sees exactly the tracked files, with
#   the working tree's contents.  The key hashes every tracked file except
#   Agda sources (from the index, and for a file the working tree changes,
#   from its type, mode and contents), with the system, the attribute's
#   name and the flake's directory within the repository.
#   (agda-for-flake.sh builds only for Nix's own system, so its key needs
#   none.)  Agda sources are left out because an environment for checking
#   a project cannot depend on them, so the key holds still while a session
#   edits proofs.  An edit to any other tracked file changes the key; the
#   next call then evaluates again, finds the output already in the store,
#   and links a new root to it.  A flake outside any git checkout is keyed
#   by the attribute's output path, from `nix eval` on every call.
#   Discovery is cached under the same key.
#
# The cache, ${XDG_CACHE_HOME:-$HOME/.cache}/agda-for-project/:
#   +  package/<attr>/<key>.out: the gc root (a symlink into the store that
#      keeps the build alive); <key>, a link to it published once the build
#      is checked against the key; <key>.lock; <key>.txt, a note of the
#      checkout and the output that made it; <key>.libraries, the path of
#      the environment's libraries file.
#   +  devshell/<name>/<key>-<checkout>/: `agda` and `agda-dir`, what its
#      hook left on PATH and in AGDA_DIR, as absolute paths; `note.txt`.
#      Beside it, <key>-<checkout>.profile (with its generation,
#      .profile-1-link), the dev environment's gc root, made where it
#      stays, since Nix registers a profile's root by its path.  Per
#      checkout, since the shell's agda may live in the checkout.
#   +  devshell/entered-<checkout>: the shell and key last entered for that
#      checkout, under entered-<checkout>.lock.  A hook writes into the
#      checkout (.agda/bin/agda, its libraries) whatever its key asks, so a
#      record is used only while its key is the one last entered there.
#   +  discover/<key>.json: which Agda the flake names, for that key.
#   +  registries/<hash>.libraries: the libraries files written for
#      sibling libraries, named by their contents.
#   Nothing is ever removed: delete the roots you no longer want (`ls -lt`
#   shows the newest first), then let `nix store gc` reclaim them.
#
# Failure, and what it never does:
#   Nothing decided, an untrusted flake, no network on a miss, a failed
#   build or evaluation, a checkout with no flake.lock or with one git does
#   not track (Nix ignores it, and would resolve every input afresh; both
#   are refused before any evaluation), a flake.lock that does not lock
#   every input flake.nix names (every nix call passes
#   --no-update-lock-file, so Nix refuses it rather than resolve the rest
#   in memory), an attribute with no bin/agda or
#   with no nix to build it: one line on stderr saying which, after any
#   output of nix's own, and exit status 69 (EX_UNAVAILABLE; Agda itself
#   uses 1, 42, 71 and 154).  A malformed
#   command line exits 64 (EX_USAGE).  It never runs another Agda in place
#   of the one decided, and never writes into the checkout itself (a dev
#   shell's hook, run when that shell is the project's Agda, may).
#
# Concurrency:
#   Two first calls at once take an exclusive flock(1) on the build's lock
#   file; the second waits, says so, and then finds what the first built.
#   Without flock both build, which is still correct.
#
# Streams:
#   Hosts read Agda's standard output (JSON, or agda2-mode's s-expressions),
#   so this program writes nothing there except the answers of --explain
#   and --candidates: nix's output goes to stderr, a dev shell's hook writes
#   its banner to /dev/null, and nix reads /dev/null, never the requests
#   waiting on Agda's stdin.  On stderr it writes a line before a first
#   evaluation and before a build (once per key, so that a host which
#   passes over a program silent for a few seconds waits for this one) and
#   before a refusal; a warm start writes nothing.  LD_LIBRARY_PATH and
#   DYLD_LIBRARY_PATH are cleared for nix only; Agda gets the environment
#   it was called with.
#
# Environment:
#   AGDA_FLAKE_ATTR, AGDA_FOR_PROJECT_DIR (above); XDG_CACHE_HOME,
#   XDG_STATE_HOME and XDG_CONFIG_HOME; AGDA_FOR_PROJECT_SYSTEM, the Nix
#   system to evaluate and build for in place of Nix's own (every nix call
#   is passed the one system, as --system, so discovery, the key and the
#   build all name it); NIX_STORE_DIR, as Nix reads it (default
#   /nix/store), for what counts as a dev shell's own agda.
#
# Usage:
#   agda-for-project --version                      # build if needed, then Agda's
#   agda-for-project --explain src/Ledger.lagda.md
#   agda-for-project --candidates --json path/to/File.agda
#   agda-for-project --choose package:fls-agdaWithPackages path/to/File.agda

set -euo pipefail

say() { echo "agda-for-project: $*" >&2; }
usage_error() { say "$*"; say "usage: agda-for-project [AGDA-ARGS...] | --explain [--json] [--no-build] [FILE] | --candidates [--json] [FILE] | --choose ID [FILE] | --forget [FILE]; an ID is package:NAME, devshell:NAME, path:FILE, trust:DIR or trust-repository:[GITDIR]"; exit 64; }

# ---- The command line ------------------------------------------------------
mode=exec json=false build=true choose_id="" target="" attr="${AGDA_FLAKE_ATTR:-}" attr_flag=""
case "${1:-}" in
  --flake-attr)   if [ "$#" -lt 2 ] || [ -z "$2" ]; then usage_error "--flake-attr needs a value"; fi
                  attr="$2" attr_flag="$1"; shift 2 ;;
  --flake-attr=*) attr="${1#--flake-attr=}" attr_flag="$1"; shift
                  [ -n "$attr" ] || usage_error "--flake-attr needs a value" ;;
esac
# A mode may follow --flake-attr, though only --explain uses the attribute.
case "${1:-}" in
  --explain|--candidates|--choose|--forget)
    mode="${1#--}"; shift
    if [ "$mode" = choose ]; then
      if [ "$#" -lt 1 ] || [ -z "$1" ]; then usage_error "--choose needs an ID"; fi
      choose_id="$1"; shift
    fi
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --json)     [ "$mode" = explain ] || [ "$mode" = candidates ] || usage_error "--json goes with --explain or --candidates"
                    json=true ;;
        --no-build) [ "$mode" = explain ] || usage_error "--no-build goes with --explain"
                    build=false ;;
        --)         shift; [ "$#" -le 1 ] || usage_error "one FILE at most"
                    target="${1:-}"; break ;;
        -*)         usage_error "unknown option $1" ;;
        *)          [ -z "$target" ] || usage_error "one FILE at most"
                    target="$1" ;;
      esac
      shift
    done ;;
esac
if [ -n "$attr_flag" ] && [ "$mode" != exec ] && [ "$mode" != explain ]; then
  usage_error "--flake-attr goes with running Agda or with --explain, not --${mode}"
fi

# Exit 69 (EX_UNAVAILABLE): the Agda asked for cannot be run.  Under
# --explain --json the answer is still one JSON object on stdout, whose
# `reason` is this one's kind: `failed`, or, from the two below,
# `undecided` (a choice would settle it) or `untrusted` (trust would).
reason=failed
fail() {
  if [ "$mode" = explain ] && [ "$json" = true ]; then
    explain_json false "$*"
  fi
  say "$*"
  exit 69
}
undecided() { reason=undecided; fail "$@"; }
untrusted() { reason=untrusted; fail "$@"; }

# ---- The starting directory, the project, and the flake --------------------
if [ -n "$target" ]; then
  [ -e "$target" ] || usage_error "no such file: $target"
  if [ -d "$target" ]; then start="$(cd "$target" && pwd -P)"
  else start="$(cd "$(dirname "$target")" && pwd -P)"
  fi
elif [ -n "${AGDA_FOR_PROJECT_DIR:-}" ]; then
  start="$(cd "$AGDA_FOR_PROJECT_DIR" && pwd -P)" ||
    usage_error "AGDA_FOR_PROJECT_DIR names no directory: $AGDA_FOR_PROJECT_DIR"
else
  start="$(pwd -P)"
fi

# The nearest .agda-lib at or above start, as Agda looks for a file's library.
project_root="$start" agda_lib=""
dir="$start"
while :; do
  for f in "$dir"/*.agda-lib; do
    if [ -f "$f" ]; then agda_lib="$f"; project_root="$dir"; break 2; fi
  done
  [ "$dir" != / ] || break
  dir="$(dirname "$dir")"
done

# The nearest flake.nix at or above the project, within its repository.
flake_dir=""
dir="$project_root"
while :; do
  if [ -f "${dir}/flake.nix" ]; then flake_dir="$dir"; break; fi
  if [ -e "${dir}/.git" ] || [ "$dir" = / ]; then break; fi
  dir="$(dirname "$dir")"
done

command -v nix >/dev/null 2>&1 || nix_missing=1
# run_nix SUBCOMMAND ARG...: nix, for the system once it is known.
system=""
run_nix() {
  local sub="$1"; shift
  env -u LD_LIBRARY_PATH -u DYLD_LIBRARY_PATH nix "$sub" ${system:+--system "$system"} "$@"
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi
}
hash32() { local h; h="$(printf '%s' "$1" | sha256)"; printf '%s' "${h:0:32}"; }

# physical FILE DIR: FILE as an absolute path (taken from DIR when it is
# relative) with its directory's links and `..` resolved; the file itself,
# often a link into the store, is kept.  Fails if the directory is gone.
physical() {
  local f="$1" d
  case "$f" in /*) ;; *) f="$2/$f" ;; esac
  d="$(cd "$(dirname "$f")" 2>/dev/null && pwd -P)" || return 1
  printf '%s/%s' "$d" "$(basename "$f")"
}

# The Nix system: AGDA_FOR_PROJECT_SYSTEM, or Nix's own (the one `nix build
# DIR#NAME` resolves NAME for), or, without nix, uname's in Nix's spelling.
# run_nix passes it to every call, so discovery, the key and the build all
# name one system.
if [ -n "${AGDA_FOR_PROJECT_SYSTEM:-}" ]; then
  system="$AGDA_FOR_PROJECT_SYSTEM"
elif [ -z "${nix_missing:-}" ] &&
     system="$(run_nix eval --impure --raw --expr builtins.currentSystem </dev/null 2>/dev/null)" &&
     [ -n "$system" ]; then
  :
else
  machine="$(uname -m)"; kernel="$(uname -s | tr '[:upper:]' '[:lower:]')"
  case "$machine" in arm64) machine=aarch64 ;; esac
  system="${machine}-${kernel}"
fi

# The repository, if any: its top, the flake's directory within it, and the
# common git directory every worktree shares.
top="" sub="" common=""
key_base="${flake_dir:-$project_root}"
if top="$(git -C "$key_base" rev-parse --show-toplevel 2>/dev/null)"; then
  top="$(cd "$top" && pwd -P)"
  common="$(git -C "$top" rev-parse --path-format=absolute --git-common-dir 2>/dev/null ||
            (cd "$top" && cd "$(git rev-parse --git-common-dir)" && pwd -P))"
  [ -z "$flake_dir" ] || sub="${flake_dir#"$top"}"
else
  top=""
fi

cache="${XDG_CACHE_HOME:-$HOME/.cache}/agda-for-project"
state="${XDG_STATE_HOME:-$HOME/.local/state}/agda-for-project"
trust_file="${XDG_CONFIG_HOME:-$HOME/.config}/agda-for-project/trusted"

# The trust file holds two kinds of line: a directory (every flake at or
# below it is trusted), and `repository GITDIR` (every working tree git
# lists for the repository whose common git directory is GITDIR).
# trust_lines: its lines, comments and blanks dropped, `~` expanded.
trust_lines() {
  local line
  [ -f "$trust_file" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    line="${line#"${line%%[![:space:]]*}"}"; line="${line%"${line##*[![:space:]]}"}"
    [ -n "$line" ] || continue
    case "$line" in "repository "*) line="repository $(expand_home "${line#repository }")" ;;
                    *) line="$(expand_home "$line")" ;; esac
    printf '%s\n' "$line"
  done < "$trust_file"
}
expand_home() {
  local d="${1#"${1%%[![:space:]]*}"}"
  # shellcheck disable=SC2088  # a literal ~ in the file, expanded here
  case "$d" in "~") d="$HOME" ;; "~/"*) d="${HOME}/${d#\~/}" ;; esac
  printf '%s' "$d"
}

# trusted DIR: whether DIR is at or below a directory the trust file lists.
trusted() {
  local line want
  while IFS= read -r line; do
    case "$line" in "repository "*) continue ;; esac
    want="$(cd "$line" 2>/dev/null && pwd -P)" || continue
    case "$1/" in "${want%/}/"*) return 0 ;; esac
  done < <(trust_lines)
  return 1
}

# trusts_repository GITDIR: whether the trust file lists the repository
# whose common git directory is GITDIR (both with links resolved).
trusts_repository() {
  local line want
  while IFS= read -r line; do
    case "$line" in "repository "*) ;; *) continue ;; esac
    want="$(cd "${line#repository }" 2>/dev/null && pwd -P)" || continue
    [ "$want" != "$1" ] || return 0
  done < <(trust_lines)
  return 1
}

# flake_trusted: whether the flake is trusted, by a directory at or above
# it, or by its repository when its checkout is one git lists for that
# repository (a `.git` file can name any repository's git directory).
flake_trusted() {
  trusted "$flake_dir" && return 0
  [ -n "$repository" ] && trusts_repository "$repository"
}

# trust_line LINE WHAT: append LINE to the trust file, after a dated
# comment, and say that WHAT is trusted.
trust_line() {
  local sep=""
  mkdir -p "$(dirname "$trust_file")" || fail "cannot create $(dirname "$trust_file")"
  # A newline first if the file's last line has none.
  if [ -s "$trust_file" ] && [ -n "$(tail -c 1 "$trust_file")" ]; then sep=$'\n'; fi
  printf '%s# --choose, %s\n%s\n' "$sep" "$(date -u +%Y-%m-%d)" "$1" >> "$trust_file" ||
    fail "cannot write ${trust_file}"
  say "trusted ${2} (${trust_file})"
}

# ---- The key (agda-for-flake.sh's, unchanged) ------------------------------
NOT_AGDA=(':(exclude)*.agda' ':(exclude)*.lagda' ':(exclude)*.lagda.*')

# git_inputs TOP: one line per tracked file that is not an Agda source,
# "MODE HASH PATH", as Nix will read it: the working tree's for a file it
# changes, the index's otherwise (see agda-for-flake.sh for the cases).
git_inputs() {
  local top="$1" f filemode fmode
  filemode="$(git -C "$top" config --type=bool core.fileMode 2>/dev/null || echo true)"
  {
    git -C "$top" -c core.quotePath=false diff --name-only -- "${NOT_AGDA[@]}" |
      while IFS= read -r f; do
        if [ -L "${top}/${f}" ]; then
          printf 'W\t120000\t%s\t%s\n' \
            "$(readlink -- "${top}/${f}" | tr -d '\n' | git -C "$top" hash-object --stdin)" "$f"
        elif [ -f "${top}/${f}" ]; then
          if [ "$filemode" = false ]; then fmode=index
          elif [ -x "${top}/${f}" ]; then fmode=100755
          else fmode=100644
          fi
          printf 'W\t%s\t%s\t%s\n' "$fmode" "$(git -C "$top" hash-object -- "$f")" "$f"
        else
          printf 'W\tdeleted\tdeleted\t%s\n' "$f"
        fi
      done
    printf 'END\n'
    git -C "$top" -c core.quotePath=false ls-files --stage -- "${NOT_AGDA[@]}"
  } | awk -F '\t' '
    !listed && $0 == "END" { listed = 1; next }
    !listed { wmode[$4] = $2; blob[$4] = $3; next }
    { split($1, f, " "); m = f[1]; h = f[2]
      if ($2 in blob) { h = blob[$2]; if (wmode[$2] != "index") m = wmode[$2] }
      print m, h, $2 }'
}

# key_for KIND NAME: set key and keyed_by for KIND (package, devshell or
# discover) of NAME, for the system, from the checkout as it stands now.  A
# package's key hashes what agda-for-flake.sh's does, and the system.
# Outside a git checkout only a package has a key (its output path, which
# names the system); key is then "" for the others, and they are found
# afresh on every call.
key_for() {
  local kind="$1" name="${2:-}" label out
  case "$kind" in
    package) label="$name" ;;
    *)       label="${kind}:${name}" ;;
  esac
  if [ -n "$top" ]; then
    inputs="$(git_inputs "$top")" || fail "git could not list the files of ${top}"
    key="$(printf 'agda-for-project key 1\nsystem %s\nattr %s\nflake-dir %s\n%s\n' \
             "$system" "$label" "${sub:-/}" "$inputs" | sha256)"
    key="${key:0:32}"
    keyed_by="the tracked files of ${top} other than Agda sources"
  elif [ "$kind" = package ]; then
    out="$(run_nix eval --raw --no-update-lock-file "${flake_dir}#${name}.outPath" </dev/null)" ||
      fail "nix eval of ${flake_dir}#${name}.outPath failed; no Agda was run"
    key="out-$(basename "$out" | cut -c1-32)"
    keyed_by="the output path ${out} (${flake_dir} is not in a git checkout)"
  else
    key="" keyed_by="nothing (${flake_dir} is not in a git checkout)"
  fi
}

# ---- Choices ---------------------------------------------------------------
# listed TOP: whether TOP is a working tree its repository lists (the main
# one or a linked one).  A `.git` file can name any git directory, so a
# directory unpacked with `gitdir: <a repository of the user's>/.git`
# reports that repository as its own; git lists only the trees it made.
listed() {
  local line w
  while IFS= read -r line; do
    case "$line" in "worktree "*) w="${line#worktree }" ;; *) continue ;; esac
    [ "$w" != "$1" ] || return 0
    w="$(cd "$w" 2>/dev/null && pwd -P)" && [ "$w" = "$1" ] && return 0
  done < <(git -C "$1" worktree list --porcelain 2>/dev/null)
  return 1
}

# The repository, for choices and for trust: its common git directory, with
# links resolved, when the checkout is one git lists for it; else "".
repository=""
if [ -n "$common" ] && listed "$top"; then repository="$(cd "$common" && pwd -P)"; fi

# The project's identity: its repository (shared by every worktree git
# lists) and its directory within it; outside a repository, or in a
# checkout its repository does not list, its path.
if [ -n "$repository" ]; then
  rel="${project_root#"$top"}"
  choice_identity="repository ${common} project ${rel:-/}"
else
  choice_identity="directory ${project_root}"
fi
choice_file="${state}/choices/$(hash32 "$choice_identity")"

read_choice() {
  if [ -f "$choice_file" ]; then head -n 1 "$choice_file"; fi
}

# ---- The lock --------------------------------------------------------------
# lock_problem: why the flake is not locked as Nix will read it, or nothing.
# In a git checkout Nix reads only tracked files, so an untracked flake.lock
# is no lock at all: Nix would resolve every input afresh.
lock_problem() {
  if [ ! -f "${flake_dir}/flake.lock" ]; then
    printf "no flake.lock in %s: this program uses only a locked flake; run 'nix flake lock' there" "$flake_dir"
  elif [ -n "$top" ] && ! git -C "$flake_dir" ls-files --error-unmatch -- flake.lock >/dev/null 2>&1; then
    printf "the flake.lock in %s is not tracked by git, so Nix ignores it; run 'git add flake.lock' there" "$flake_dir"
  fi
}
# require_lock: refuse, before any evaluation, a flake that is not locked.
require_lock() {
  local problem
  problem="$(lock_problem)"
  [ -z "$problem" ] || fail "$problem"
}

# ---- Discovery -------------------------------------------------------------
# The expression that finds a flake's Agda environments among its packages.
# shellcheck disable=SC2016  # Nix, not shell
ENVS_EXPR='ps: let
  names = builtins.filter (n: n == "default" || builtins.match ".*[Aa]gda.*" n != null) (builtins.attrNames ps);
  probe = n: let r = builtins.tryEval (let p = ps.${n}; in
      if (p.type or null) == "derivation" && (p.pname or "") == "agdaWithPackages"
      then { name = n; version = p.version or null; } else null);
    in if r.success then r.value else null;
in builtins.filter (x: x != null) (map probe names)'

# nix_eval_json ATTRPATH APPLY: the JSON of the flake's ATTRPATH with APPLY;
# "[]" when the flake does not provide it; fails on any other error.
nix_eval_json() {
  local err out status=0
  err="$(mktemp)"
  out="$(run_nix eval --json --no-update-lock-file "${flake_dir}#$1" --apply "$2" </dev/null 2>"$err")" || status=$?
  if [ "$status" != 0 ]; then
    if grep -q 'does not provide attribute' "$err"; then rm -f "$err"; echo '[]'; return 0; fi
    cat "$err" >&2
    if grep -q 'requires lock file changes' "$err"; then
      say "the flake.lock in ${flake_dir} does not lock every input flake.nix names; run 'nix flake lock' there"
    fi
    rm -f "$err"; return 1
  fi
  rm -f "$err"; printf '%s\n' "$out"
}

# discover: set discovered to a JSON object {envs, devshells} for the flake,
# cached under the key; return 1, having said why, when Nix fails.
discover() {
  local file envs shells
  key_for discover
  file="${cache}/discover/${key}.json"
  if [ -n "$key" ] && [ -f "$file" ]; then discovered="$(cat "$file")"; return 0; fi
  # A first evaluation can take seconds (Nix may fetch the inputs), and
  # agda-mode-vscode passes over a program silent for 3 s; so say so, once
  # per key.  Outside git every call evaluates, and says nothing, since a
  # host may read stderr during a session as an error of Agda's.
  [ -z "$key" ] || say "evaluating ${flake_dir} to find its Agda (key ${key}); once per key"
  envs="$(nix_eval_json "packages.${system}" "$ENVS_EXPR")" ||
    { say "nix eval of ${flake_dir}#packages.${system} failed"; return 1; }
  shells="$(nix_eval_json "devShells.${system}" 'builtins.attrNames')" ||
    { say "nix eval of ${flake_dir}#devShells.${system} failed"; return 1; }
  discovered="$(jq -cn --argjson e "$envs" --argjson d "$shells" '{envs: $e, devshells: $d}')"
  if [ -n "$key" ] && mkdir -p "${cache}/discover" && printf '%s\n' "$discovered" > "${file}.$$"; then
    mv -f "${file}.$$" "$file"
  fi
}

# ---- Deciding --------------------------------------------------------------
# pick: set method and name to what discovery decides from discovered, or
# set pick_problem to why nothing is, and return 1.  Trust is not asked.
pick() {
  local n
  n="$(jq '.envs | length' <<<"$discovered")"
  if [ "$n" = 1 ]; then method=package name="$(jq -r '.envs[0].name' <<<"$discovered")"; return 0; fi
  if [ "$n" -gt 1 ]; then
    if jq -e '.envs | any(.name == "default")' <<<"$discovered" >/dev/null; then
      method=package name=default; return 0
    fi
    pick_problem="${flake_dir} exports ${n} Agda environments ($(jq -r '[.envs[].name] | join(", ")' <<<"$discovered")) and no default among them; choose one with --choose package:NAME"
    return 1
  fi
  if jq -e '.devshells | index("default")' <<<"$discovered" >/dev/null; then
    method=devshell name=default; return 0
  fi
  pick_problem="${flake_dir} exports no Agda environment and no default dev shell; see --candidates, then --choose"
  return 1
}

# decide: set how (attribute, choice, discovered), method (package,
# devshell, path) and name (an attribute, a shell, or an executable), or
# fail with what is missing.  Discovery's answer stands only for a trusted
# flake; for another, method and name say what trusting it would run.
decide() {
  local choice what
  if [ -n "$attr" ]; then how=attribute method=package name="$attr"; return 0; fi
  choice="$(read_choice)"
  if [ -n "$choice" ]; then
    how=choice
    case "$choice" in
      package:?*)  method=package  name="${choice#package:}" ;;
      devshell:?*) method=devshell name="${choice#devshell:}" ;;
      path:/*)     method=path     name="${choice#path:}" ;;
      path:?*) undecided "the Agda chosen for ${project_root}, ${choice#path:}, is not an absolute path; run --forget, then --choose" ;;
      *) undecided "the choice remembered for ${project_root} (${choice_file}) is not an ID; run --forget, then --choose" ;;
    esac
    return 0
  fi
  [ -n "$flake_dir" ] ||
    undecided "no flake.nix at or above ${project_root}, and no Agda chosen for it; see --candidates, then --choose"
  require_lock
  how=discovered
  discover || fail "no Agda was run: Nix could not evaluate ${flake_dir}"
  pick || undecided "$pick_problem"
  flake_trusted && return 0
  case "$method" in
    package) what="running its Agda environment ${name} runs the flake's code as you" ;;
    *)       what="entering its dev shell ${name} runs the project's shell hook as you" ;;
  esac
  untrusted "${flake_dir} is not trusted, and ${what}: allow it with --choose $(trust_grant) ($(trust_scope)), --choose trust:DIR (every flake at or below DIR), or --choose ${method}:${name} (this project); trust is kept in ${trust_file}"
}

# trust_grant, trust_scope: the trust a chooser offers first for this flake,
# and what it covers: its repository, in a checkout git lists for one, so
# that every worktree is covered at once; else the flake's directory.
trust_grant() {
  if [ -n "$repository" ]; then printf 'trust-repository:%s' "$repository"
  else printf 'trust:%s' "$flake_dir"; fi
}
trust_scope() {
  if [ -n "$repository" ]; then printf 'every worktree of its repository, now and later'
  else printf 'every flake at or below it'; fi
}

# ---- Building: an attribute (agda-for-flake.sh's loop) ---------------------
# realize_package: set program to the attribute's bin/agda, building its
# root on a miss, and libraries_of_env to its libraries file (or "").
realize_package() {
  local root dir status built_key attempt=1
  [ -n "$flake_dir" ] || undecided "${name} is a flake attribute, but there is no flake.nix at or above ${project_root}"
  require_lock
  dir="${cache}/package/${name//[^A-Za-z0-9._+-]/_}"
  while :; do
    key_for package "$name"
    root="${dir}/${key}"
    program="${root}/bin/agda"
    [ -x "$program" ] && break
    if [ "$build" = false ]; then program="" built=missing; return 0; fi
    mkdir -p "$dir" || fail "cannot create the cache directory ${dir}"
    exec 9>"${root}.lock" || fail "cannot open the lock file ${root}.lock"
    if command -v flock >/dev/null 2>&1; then
      if ! flock -n 9; then
        say "waiting for another build of ${name} for this key (${root}.lock)"
        flock 9
      fi
    fi
    if [ ! -x "$program" ]; then
      say "building ${name} from ${flake_dir} (key ${key}, from ${keyed_by}); once per key"
      status=0
      run_nix build --no-update-lock-file "${flake_dir}#${name}" -o "${root}.out" </dev/null >&2 || status=$?
      [ "$status" = 0 ] ||
        fail "nix build ${flake_dir}#${name} failed (exit ${status}; offline, or a broken flake?); no Agda was run"
      [ -x "${root}.out/bin/agda" ] ||
        undecided "${name} built to $(readlink "${root}.out" || echo "${root}.out"), which has no executable bin/agda; name an Agda environment"
      built_key="$key"
      key_for package "$name"
      if [ "$key" != "$built_key" ]; then
        rm -f "${root}.out"
        exec 9>&-
        [ "$attempt" -lt 3 ] ||
          fail "the files of ${flake_dir} changed during each of ${attempt} builds; no Agda was run"
        say "the files of ${flake_dir} changed during the build; discarded it, building again"
        attempt=$((attempt + 1))
        continue
      fi
      # The environment's libraries file, for the sibling-library registry;
      # "" when the attribute has none (an older nixpkgs, or not an env).
      run_nix eval --raw --no-update-lock-file "${flake_dir}#${name}.libraryFile" </dev/null \
        > "${root}.libraries.$$" 2>/dev/null || : > "${root}.libraries.$$"
      mv -f "${root}.libraries.$$" "${root}.libraries"
      ln -sfn "${key}.out" "$root" || fail "cannot publish the root ${root}"
      built=yes
      if printf 'checkout %s\nattribute %s\noutput %s\nkeyed by %s\nbuilt %s\n' \
           "$flake_dir" "$name" "$(readlink "${root}.out")" "$keyed_by" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
           > "${root}.txt.$$"; then
        mv -f "${root}.txt.$$" "${root}.txt" || true
      fi
    fi
    exec 9>&-
    break
  done
  libraries_of_env=""
  [ ! -s "${root}.libraries" ] || libraries_of_env="$(cat "${root}.libraries")"
}

# ---- Building: a dev shell -------------------------------------------------
# realize_devshell: enter the dev shell once per key and checkout, keep its
# environment as a gc root, and record the agda its hook left on PATH and
# the AGDA_DIR it set (if it set one), each as an absolute path.  Set
# program and program_env.
realize_devshell() {
  local root dir status outer captured raw shell_pwd agda_dir checkout_tag tmp
  local profile entered want inherits
  [ -n "$flake_dir" ] || undecided "devshell:${name} needs a flake.nix at or above ${project_root}"
  require_lock
  # The caller's agda, for the refusal's line only: the probe below does
  # not see it, and resolved as the shell's is, so that one reached through
  # a profile's links (~/.nix-profile/bin) names its place in the store.
  outer="$(command -v agda 2>/dev/null || true)"
  if [ -n "$outer" ]; then outer="$(physical "$outer" "$PWD")" || outer=""; fi
  key_for devshell "$name"
  checkout_tag="$(hash32 "$flake_dir" | cut -c1-12)"
  dir="${cache}/devshell/${name//[^A-Za-z0-9._+-]/_}"
  root="${dir}/${key:-nogit}-${checkout_tag}"
  # The gc root, made where it stays: Nix registers a profile's root by its
  # path, so a profile made elsewhere and moved here would keep nothing.
  profile="${root}.profile"
  # What the checkout holds is the last entered shell's (a hook writes
  # .agda/bin/agda and its libraries for its own key), so a record is
  # current only while its shell and key are the ones last entered here.
  entered="${cache}/devshell/entered-${checkout_tag}" want="${name} ${key:-nogit}"
  # Outside git there is no key to say the shell is unchanged: enter it again.
  [ -n "$key" ] || [ "$build" = false ] || rm -f "${root}/agda"
  if ! devshell_current; then
    if [ "$build" = false ]; then program="" built=missing; return 0; fi
    mkdir -p "$dir" || fail "cannot create the cache directory ${dir}"
    # One lock per checkout, since every shell entered there writes into it.
    exec 9>"${entered}.lock" || fail "cannot open the lock file ${entered}.lock"
    if command -v flock >/dev/null 2>&1; then
      if ! flock -n 9; then
        say "waiting for another start of a dev shell of ${flake_dir} (${entered}.lock)"
        flock 9
      fi
    fi
    if ! devshell_current; then
      say "entering ${flake_dir}#devShells.${system}.${name} to find its agda (key ${key}); once per key"
      # The hook is about to rewrite the checkout: no record is current
      # until this entry succeeds, even if it fails halfway.
      rm -f "$entered"
      tmp="${root}.tmp.$$"
      rm -rf "$tmp" && mkdir -p "${tmp}/sentinel"
      printf '#!/bin/sh\nexit 127\n' > "${tmp}/sentinel/agda" && chmod +x "${tmp}/sentinel/agda"
      status=0
      # What the probe sees is the shell's own, whoever calls.  nix develop
      # puts the shell's PATH before the caller's, so a sentinel agda first
      # in the caller's part is found only when the shell adds none (and a
      # caller inside the project's own shell, by direnv, already holding
      # its agda, does not make that agda look inherited).  The caller's
      # AGDA_DIR is left out, so the shell's is the one the hook set.  The
      # shell's sh also writes its working directory, against which a
      # relative PATH entry or AGDA_DIR of the hook's is to be read.
      # shellcheck disable=SC2016  # expanded by the dev shell's sh
      ( cd "$flake_dir" && unset AGDA_DIR && PATH="${tmp}/sentinel:${PATH}" &&
        run_nix develop --no-update-lock-file "${flake_dir}#${name}" --profile "$profile" \
          --command sh -c 'command -v agda > "$1" || : > "$1"; printf "%s" "${AGDA_DIR-}" > "$2"; printf "%s" "$PWD" > "$3"' \
          sh "${tmp}/agda" "${tmp}/agda-dir" "${tmp}/pwd" ) </dev/null >/dev/null 2>"${tmp}/stderr" || status=$?
      if [ "$status" != 0 ]; then
        cat "${tmp}/stderr" >&2
        rm -rf "$tmp"
        fail "nix develop ${flake_dir}#${name} failed (exit ${status}); no Agda was run"
      fi
      raw="$(cat "${tmp}/agda")"
      shell_pwd="$(cat "${tmp}/pwd" 2>/dev/null || true)"
      [ -n "$shell_pwd" ] || shell_pwd="$flake_dir"
      if [ -z "$raw" ] || [ "$raw" = "${tmp}/sentinel/agda" ]; then
        rm -rf "$tmp"
        inherits=""
        [ -z "$outer" ] || inherits=" (it would only inherit ${outer}, from the caller's PATH)"
        undecided "the dev shell ${flake_dir}#${name} puts no agda of its own on PATH${inherits}; see --candidates, then --choose"
      fi
      # Where it really is (absolute, its directory's links and `..`
      # resolved, as top is), before asking where it lives; this is the
      # path recorded, so a later call from any directory runs the same one.
      if ! captured="$(physical "$raw" "$shell_pwd")"; then
        rm -rf "$tmp"
        undecided "the dev shell ${flake_dir}#${name} gives ${raw}, whose directory does not exist; see --candidates, then --choose"
      fi
      case "$captured" in
        "${NIX_STORE_DIR:-/nix/store}"/*|"${top:-$flake_dir}"/*) ;;
        *) rm -rf "$tmp"
           undecided "the dev shell ${flake_dir}#${name} gives ${captured}, which is neither in the store nor in the checkout; see --candidates, then --choose" ;;
      esac
      printf '%s' "$captured" > "${tmp}/agda"
      # AGDA_DIR only if the shell sets one, and absolute.
      agda_dir="$(cat "${tmp}/agda-dir")"
      case "$agda_dir" in ""|/*) ;; *) agda_dir="${shell_pwd}/${agda_dir}" ;; esac
      printf '%s' "$agda_dir" > "${tmp}/agda-dir"
      printf 'checkout %s\ndev shell %s\nagda %s\nkeyed by %s\nbuilt %s\n' \
        "$flake_dir" "$name" "$captured" "$keyed_by" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${tmp}/note.txt" || true
      rm -f "${tmp}/stderr" "${tmp}/pwd"
      rm -rf "${tmp}/sentinel" "$root"
      mv "$tmp" "$root" || fail "cannot publish ${root}"
      { printf '%s\n' "$want" > "${entered}.$$" && mv -f "${entered}.$$" "$entered"; } ||
        fail "cannot write ${entered}"
      built=yes
    fi
    exec 9>&-
  fi
  program="$(cat "${root}/agda")"
  agda_dir="$(cat "${root}/agda-dir" 2>/dev/null || true)"
  [ -z "$agda_dir" ] || program_env+=("AGDA_DIR=${agda_dir}")
}
# devshell_current: whether the record at root is usable: its agda is
# there, and its shell and key are the ones last entered in the checkout.
devshell_current() {
  [ -f "${root}/agda" ] && [ -x "$(cat "${root}/agda")" ] &&
    [ "$(cat "$entered" 2>/dev/null)" = "$want" ]
}

# ---- The project's own libraries -------------------------------------------
# lib_field FILE FIELD: the words of an .agda-lib field (on its line and the
# indented lines after it), comments dropped.
lib_field() {
  awk -v field="$2" '
    { sub(/--.*/, "") }
    /^[^ \t]/ { infield = 0 }
    $0 ~ "^" field "[ \t]*:" { infield = 1; sub("^" field "[ \t]*:", "") }
    infield { gsub(/,/, " "); print }' "$1" | tr -s ' \t' '\n' | sed '/^$/d'
}
# base NAME: NAME without a version suffix (standard-library-2.3 to
# standard-library).
base() { sed -E 's/-[0-9][0-9.]*$//' <<<"$1"; }

# registry: when the project depends on a library its environment does not
# register, set registry_file to a libraries file of the environment's
# entries and the checkout's .agda-lib files that provide the missing
# names, transitively; set local_libs and missing_libs for --explain.
registry() {
  local provided="" line name want todo found f text
  registry_file="" local_libs=() missing_libs=()
  [ -n "$agda_lib" ] && [ -n "$libraries_of_env" ] && [ -f "$libraries_of_env" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    if [ -z "$line" ] || [ ! -f "$line" ]; then continue; fi
    for name in $(lib_field "$line" name); do provided+=" $(base "$name") "; done
  done < "$libraries_of_env"
  # The checkout's libraries: "BASE<TAB>PATH" for each tracked .agda-lib.
  local catalog=""
  if [ -n "$top" ]; then
    while IFS= read -r f; do
      [ "${top}/${f}" != "$agda_lib" ] || continue
      for name in $(lib_field "${top}/${f}" name); do
        catalog+="$(base "$name")"$'\t'"${top}/${f}"$'\n'
      done
    done < <(git -C "$top" ls-files -- '*.agda-lib')
  fi
  todo="$(lib_field "$agda_lib" depend)"
  local seen=" "
  while [ -n "$todo" ]; do
    want="$(base "$(head -n 1 <<<"$todo")")"
    todo="$(tail -n +2 <<<"$todo")"
    case "$seen" in *" ${want} "*) continue ;; esac
    seen+="${want} "
    case "$provided" in *" ${want} "*) continue ;; esac
    found="$(awk -F '\t' -v w="$want" '$1 == w { print $2; exit }' <<<"$catalog")"
    if [ -z "$found" ]; then missing_libs+=("$want"); continue; fi
    local_libs+=("$found")
    todo="$(printf '%s\n%s' "$todo" "$(lib_field "$found" depend)" | sed '/^$/d')"
  done
  [ "${#local_libs[@]}" -gt 0 ] || return 0
  # The environment's lines, each ended (its file's last may have no
  # newline), then the checkout's.
  text="$(while IFS= read -r line || [ -n "$line" ]; do printf '%s\n' "$line"; done < "$libraries_of_env"
          printf '%s\n' "${local_libs[@]}")"
  registry_file="${cache}/registries/$(hash32 "$text").libraries"
  if [ ! -f "$registry_file" ]; then
    if ! { mkdir -p "${cache}/registries" && printf '%s\n' "$text" > "${registry_file}.$$" &&
           mv -f "${registry_file}.$$" "$registry_file"; }; then
      fail "cannot write the libraries file ${registry_file}"
    fi
  fi
}

# ---- Resolving -------------------------------------------------------------
# resolve: decide, realize, and set program, program_args, program_env.
resolve() {
  program="" program_args=() program_env=() libraries_of_env="" built=no
  registry_file="" local_libs=() missing_libs=()
  [ -z "${nix_missing:-}" ] || { decide_without_nix; return 0; }
  decide
  case "$method" in
    package)  realize_package
              [ -z "$program" ] || registry
              [ -z "$registry_file" ] || program_args=("--library-file=${registry_file}") ;;
    devshell) realize_devshell ;;
    path)     [ -x "$name" ] || undecided "the chosen Agda ${name} is not an executable; run --forget, then --choose"
              program="$name" ;;
  esac
}

# Without nix, only a chosen executable can run, and not over an attribute
# the host names, which only nix can build.
decide_without_nix() {
  local choice
  [ -z "$attr" ] || fail "the host names the flake attribute ${attr}, and nix is not on PATH; no Agda was run"
  choice="$(read_choice)"
  case "$choice" in
    path:/*) how=choice method=path name="${choice#path:}"
             [ -x "$name" ] || undecided "the chosen Agda ${name} is not an executable; run --forget, then --choose"
             program="$name" ;;
    path:?*) undecided "the Agda chosen for ${project_root}, ${choice#path:}, is not an absolute path; run --forget, then --choose" ;;
    *) fail "nix is not on PATH" ;;
  esac
}

# ---- Answers ---------------------------------------------------------------
version_of() {
  [ -n "$1" ] && [ -x "$1" ] || return 0
  env "${program_env[@]+"${program_env[@]}"}" "$1" "${program_args[@]+"${program_args[@]}"}" --numeric-version 2>/dev/null | head -n 1 || true
}

# json_lines WORD...: a JSON array of the words (none may hold a newline).
json_lines() { { [ "$#" = 0 ] || printf '%s\n' "$@"; } | jq -cRn '[inputs | select(length > 0)]'; }

explain_json() {
  local decided="$1" error="${2:-}" version=""
  [ "$decided" = false ] || version="$(version_of "$program")"
  jq -n \
    --argjson decided "$decided" --arg error "$error" --arg reason "$reason" \
    --arg start "$start" --arg root "$project_root" --arg lib "$agda_lib" \
    --arg flake "$flake_dir" --arg system "$system" \
    --arg how "${how:-}" --arg method "${method:-}" --arg name "${name:-}" \
    --arg program "${program:-}" --arg version "$version" --arg built "${built:-no}" \
    --arg envlib "${libraries_of_env:-}" --arg registry "${registry_file:-}" \
    --arg choice "$(read_choice)" --arg choiceFile "$choice_file" \
    --argjson args "$(json_lines "${program_args[@]+"${program_args[@]}"}")" \
    --argjson env "$(json_lines "${program_env[@]+"${program_env[@]}"}")" \
    --argjson local "$(json_lines "${local_libs[@]+"${local_libs[@]}"}")" \
    --argjson missing "$(json_lines "${missing_libs[@]+"${missing_libs[@]}"}")" '
    def nz: if . == "" then null else . end;
    {
      decided: $decided,
      error: ($error | nz),
      reason: (if $decided then null else $reason end),
      start: $start,
      project: { root: $root, agdaLib: ($lib | nz) },
      flake: ($flake | nz),
      system: $system,
      decidedBy: ($how | nz),
      method: ($method | nz),
      name: ($name | nz),
      program: ($program | nz),
      args: $args,
      env: ($env | map(capture("^(?<k>[^=]+)=(?<v>.*)$") | {(.k): .v}) | add // {}),
      version: ($version | nz),
      built: $built,
      libraries: { environment: ($envlib | nz), file: ($registry | nz),
                   local: $local, missing: $missing },
      choice: ($choice | nz),
      choiceFile: $choiceFile
    }'
}

explain_text() {
  local version
  version="$(version_of "$program")"
  printf 'project    %s%s\n' "$project_root" "${agda_lib:+ ($(basename "$agda_lib"))}"
  printf 'flake      %s\n' "${flake_dir:-none}"
  case "$how" in
    attribute)  printf 'decided by the attribute the host named (AGDA_FLAKE_ATTR or --flake-attr)\n' ;;
    choice)     printf 'decided by the choice remembered in %s\n' "$choice_file" ;;
    discovered) printf 'decided by discovery in the flake, for %s\n' "$system" ;;
  esac
  printf 'agda       %s: %s\n' "${method}" "${name}"
  if [ -n "$program" ]; then
    printf 'program    %s%s\n' "$program" "${program_args[*]:+ ${program_args[*]}}"
  else
    printf 'program    not built yet (--no-build)\n'
  fi
  [ "${#program_env[@]}" = 0 ] || printf 'env        %s\n' "${program_env[*]}"
  printf 'version    %s\n' "${version:-unknown}"
  [ -z "$libraries_of_env" ] || printf 'libraries  %s (the environment'"'"'s)\n' "$libraries_of_env"
  [ -z "$registry_file" ] || printf 'libraries  %s (with %s)\n' "$registry_file" "${local_libs[*]}"
  [ "${#missing_libs[@]}" = 0 ] || printf 'missing    %s (in neither the environment nor the checkout)\n' "${missing_libs[*]}"
  return 0
}

# candidates: one JSON object per line, then an array of them.
candidates() {
  local choice line exe out ver seen=" " d what
  choice="$(read_choice)"
  local problem=""
  [ -z "$flake_dir" ] || problem="$(lock_problem)"
  [ -z "$problem" ] || say "the flake's Agdas are not listed: ${problem}"
  {
    if [ -n "$flake_dir" ] && [ -z "${nix_missing:-}" ] && [ -z "$problem" ]; then
      discover || discovered='{"envs":[],"devshells":[]}'
      # Trusting the flake, offered first when discovery would then decide:
      # its repository's every worktree, or else its directory.
      if ! flake_trusted && pick; then
        if [ -n "$repository" ]; then
          what="the repository of $(git -C "$top" worktree list --porcelain 2>/dev/null | sed -n '1s/^worktree //p') and every worktree git lists for it, now and later"
        else
          what="${flake_dir} and every flake below it"
        fi
        jq -c --arg id "$(trust_grant)" --arg what "$what" --arg would "${method}:${name}" --arg name "$name" '
          {id: $id, kind: "trust",
           version: (if ($would | startswith("package:")) then (.envs[] | select(.name == $name) | .version) else null end),
           label: ("trust " + $what + ", so that discovery runs what it finds there as you (" + $would + " here)")}' <<<"$discovered"
      fi
      jq -c --arg flake "$flake_dir" '.envs[] | {id: ("package:" + .name), kind: "package", version: .version,
        label: (.name + " (Agda " + (.version // "?") + "), an Agda environment of " + $flake)}' <<<"$discovered"
      jq -c --arg flake "$flake_dir" '.devshells[] | {id: ("devshell:" + .), kind: "devshell", version: null,
        label: ("the agda of the dev shell " + . + " of " + $flake + " (entering it runs the project'"'"'s shell hook)")}' <<<"$discovered"
    fi
    for d in "${cache}"/package/*/; do
      [ -d "$d" ] || continue
      for line in "$d"*.txt; do
        [ -f "$line" ] || continue
        out="$(sed -n 's/^output //p' "$line")"
        exe="${out}/bin/agda"
        [ -x "$exe" ] || continue
        case "$seen" in *" ${exe} "*) continue ;; esac
        seen+="${exe} "
        ver="$("$exe" --numeric-version 2>/dev/null | head -n 1 || true)"
        jq -cn --arg exe "$exe" --arg ver "$ver" --arg from "$(sed -n 's/^attribute //p' "$line")" \
          --arg where "$(sed -n 's/^checkout //p' "$line")" \
          '{id: ("path:" + $exe), kind: "built", version: ($ver | if . == "" then null else . end),
            label: ((if $ver == "" then "Agda" else "Agda " + $ver end) + ", built from " + $from + " of " + $where)}'
      done
    done
    exe="$(command -v agda 2>/dev/null || true)"
    if [ -n "$exe" ]; then
      ver="$("$exe" --numeric-version 2>/dev/null | head -n 1 || true)"
      jq -cn --arg exe "$exe" --arg ver "$ver" \
        '{id: ("path:" + $exe), kind: "PATH", version: ($ver | if . == "" then null else . end),
          label: ((if $ver == "" then "Agda" else "Agda " + $ver end) + ", agda on PATH (" + $exe + ")")}'
    fi
  } | jq -s --arg choice "$choice" 'map(. + {chosen: (.id == $choice)})'
}

# ---- The modes -------------------------------------------------------------
case "$mode" in
  explain)
    resolve
    if [ "$json" = true ]; then explain_json true; else explain_text; fi ;;
  candidates)
    if [ "$json" = true ]; then candidates
    else candidates | jq -r '.[] | "\(.id)\t\(.label)\(if .chosen then "  (chosen)" else "" end)"'
    fi ;;
  choose)
    case "$choose_id" in
      trust:?*|trust-repository:*)
        case "$choose_id" in
          trust:*)
            dir="$(cd "${choose_id#trust:}" 2>/dev/null && pwd -P)" || usage_error "${choose_id#trust:} is not a directory"
            if trusted "$dir"; then say "${dir} is already trusted (${trust_file})"
            else trust_line "$dir" "${dir} and every flake below it"; fi ;;
          *)
            # GITDIR, or with none the project's repository.
            gitdir="${choose_id#trust-repository:}"
            if [ -z "$gitdir" ]; then
              gitdir="$repository"
              [ -n "$gitdir" ] || usage_error "${project_root} is not in a checkout git lists for a repository; name its git directory, or trust a directory"
            fi
            if ! gitdir="$(git --git-dir="$gitdir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" ||
               ! gitdir="$(cd "$gitdir" 2>/dev/null && pwd -P)"; then
              usage_error "${choose_id#trust-repository:} is not a git directory"
            fi
            if trusts_repository "$gitdir"; then say "the repository ${gitdir} is already trusted (${trust_file})"
            else trust_line "repository ${gitdir}" "the repository ${gitdir} and every worktree git lists for it"; fi ;;
        esac
        # Discovery decides from now on; a choice would hide what it finds.
        if [ -f "$choice_file" ]; then rm -f "$choice_file"; say "forgot the choice for ${choice_identity}"; fi
        exit 0 ;;
      package:?*|devshell:?*) ;;
      # FILE as given, from the working directory; kept absolute, so the
      # choice means the same executable from wherever a host starts.
      path:?*) exe="${choose_id#path:}"
               if [ ! -f "$exe" ] || [ ! -x "$exe" ]; then usage_error "${exe} is not an executable"; fi
               exe="$(physical "$exe" "$PWD")" || usage_error "${choose_id#path:} is not an executable"
               choose_id="path:${exe}" ;;
      *) usage_error "an ID is package:NAME, devshell:NAME, path:FILE, trust:DIR or trust-repository:[GITDIR] (see --candidates)" ;;
    esac
    mkdir -p "${state}/choices" || fail "cannot create ${state}/choices"
    if ! { printf '%s\n# %s\n' "$choose_id" "$choice_identity" > "${choice_file}.$$" &&
           mv -f "${choice_file}.$$" "$choice_file"; }; then
      fail "cannot write ${choice_file}"
    fi
    say "remembered ${choose_id} for ${choice_identity}" ;;
  forget)
    if [ -f "$choice_file" ]; then rm -f "$choice_file"; say "forgot the choice for ${choice_identity}"
    else say "no choice was remembered for ${choice_identity}"
    fi ;;
  exec)
    resolve
    exec env "${program_env[@]+"${program_env[@]}"}" "$program" "${program_args[@]+"${program_args[@]}"}" "$@" ;;
esac
