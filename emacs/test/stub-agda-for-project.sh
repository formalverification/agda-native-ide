#!/usr/bin/env bash
# File: emacs/test/stub-agda-for-project.sh
#
# A stand-in for agda-for-project in the package's unit tests
# (agda-for-project-test.el).  It answers from files in $STUB_DIR, which
# each test writes, and appends each command line to $STUB_DIR/calls:
#
#   --explain --json --no-build FILE   explain-nobuild.json, exit explain-nobuild.status (default 0)
#   --explain --json FILE              explain-build.json,   exit explain-build.status (default 0)
#   --explain [--no-build] FILE        explain.txt on stdout, explain.err on stderr
#   --candidates --json FILE           candidates.json
#   --choose ID FILE                   writes ID to chosen; then explain-chosen.json, if present,
#                                      becomes explain-nobuild.json
#   --forget FILE                      "forgot" on stderr
#
# A file NAME.err, if present, is written to stderr beside NAME's answer.

set -euo pipefail
dir="${STUB_DIR:?STUB_DIR is unset}"
printf '%s\n' "$*" >> "${dir}/calls"

answer() {
  [ ! -f "${dir}/$1.err" ] || cat "${dir}/$1.err" >&2
  cat "${dir}/$1.json"
  exit "$(cat "${dir}/$1.status" 2>/dev/null || echo 0)"
}

case "$1" in
  --explain)
    if [ "${2:-}" = --json ]; then
      if [ "${3:-}" = --no-build ]; then answer explain-nobuild; else answer explain-build; fi
    fi
    [ ! -f "${dir}/explain.err" ] || cat "${dir}/explain.err" >&2
    [ ! -f "${dir}/explain.txt" ] || cat "${dir}/explain.txt"
    exit "$(cat "${dir}/explain.status" 2>/dev/null || echo 0)" ;;
  --candidates)
    cat "${dir}/candidates.json" ;;
  --choose)
    printf '%s\n' "$2" > "${dir}/chosen"
    echo "agda-for-project: remembered $2" >&2
    if [ -f "${dir}/explain-chosen.json" ]; then
      cp "${dir}/explain-chosen.json" "${dir}/explain-nobuild.json"
      echo 0 > "${dir}/explain-nobuild.status"
    fi ;;
  --forget)
    echo "agda-for-project: forgot the choice" >&2 ;;
  *)
    echo "stub-agda-for-project: unexpected $*" >&2; exit 64 ;;
esac
