# File: scripts/library-archives/stage.sh
#
# A stage: a directory laid out as the page's drive (layOutDrive, in the
# engine's packages/engine/src/browser/worker/drive.ts), which the
# compiler's plain agda runs over as the guest's root, with HOME and
# Agda_datadir as the page's server has them
# (packages/engine/src/browser/worker/als.ts).  Sourced by build.sh and
# check.sh (issue 12).
#
#   /lib/prim                  agda-data.zip: the builtins, with their
#                              interfaces under _build/<version>/agda/
#   /stdlib                    the standard library's src/ and its
#                              .agda-lib, from the archive the page ships
#   /agda-algebras             its .agda-lib and src/, from its sources
#                              archive
#   /home/root/.config/agda/libraries
#                              naming the two .agda-lib files
#
# Everything a stage holds comes from the archives the page mounts, so that
# what is built and checked here is what the page reads.  Mounted as the
# guest's root, Agda's walk for a project root ends at /, so interfaces land
# under each library's _build/<version>/agda/src/, where the server looks,
# and the paths Agda stores in an interface are the page's, not the host's.
#
# The caller sets WASMTIME (the wasmtime binary) and AGDA_WASM (the
# compiler's agda.wasm), and a writable HOME: wasmtime compiles the module
# on its first run and caches the result under $HOME/.cache (or
# $XDG_CACHE_HOME), where every later run finds it; without the cache,
# every run compiles it again (about 20 s and 4.3 GiB here).

# lay_out_stage STAGE AGDA_DATA_ZIP STDLIB_ZIP SOURCES_ZIP
lay_out_stage() {
  local stage=$1 data=$2 stdlib=$3 sources=$4 unpacked
  mkdir -p "$stage/stdlib" "$stage/home/root/.config/agda"
  unzip -q "$data" -d "$stage"
  # As layOutDrive takes the standard library: its src/ and its .agda-lib,
  # under agda-stdlib-<version>/ in the archive, at /stdlib.
  unpacked=$(mktemp -d)
  unzip -q "$stdlib" 'agda-stdlib-*/src/*' 'agda-stdlib-*/standard-library.agda-lib' \
    -d "$unpacked"
  mv "$unpacked"/agda-stdlib-*/src "$unpacked"/agda-stdlib-*/standard-library.agda-lib \
    "$stage/stdlib/"
  rm -rf "$unpacked"
  unzip -q "$sources" -d "$stage"
  printf '%s\n' /stdlib/standard-library.agda-lib \
    /agda-algebras/agda-algebras.agda-lib > "$stage/home/root/.config/agda/libraries"
}

# agda_guest STAGE GUEST_PWD ARG...: the compiler's agda over STAGE, with
# GUEST_PWD as its working directory.
agda_guest() {
  agda_guest_timed "" "$@"
}

# agda_guest_timed TIME_FILE STAGE GUEST_PWD ARG...: the same, with GNU
# time's statistics (wall clock, peak resident set in KiB) in TIME_FILE.
agda_guest_timed() {
  local time_file=$1 stage=$2 pwd=$3
  shift 3
  local command=("$WASMTIME" run --dir "$stage"::/
    --env HOME=/home/root --env Agda_datadir=/ --env PWD="$pwd"
    "$AGDA_WASM" "$@")
  if [ -n "$time_file" ]; then
    command time -v -o "$time_file" "${command[@]}"
  else
    "${command[@]}"
  fi
}

# library_name AGDA_LIB: the library's name, as a depend: line names it.
library_name() {
  sed -n 's/^name: *//p' "$1"
}

# write_play_library STAGE: /play/play.agda-lib, a library that depends on
# the stage's two libraries, by the names their .agda-lib files give.
write_play_library() {
  mkdir -p "$1/play"
  printf 'name: play\ndepend: %s %s\ninclude: .\n' \
    "$(library_name "$1/stdlib/standard-library.agda-lib")" \
    "$(library_name "$1/agda-algebras/agda-algebras.agda-lib")" \
    > "$1/play/play.agda-lib"
}

# load_average: the 1-, 5- and 15-minute load, where the system says.
load_average() {
  cut -d' ' -f1-3 /proc/loadavg 2> /dev/null || echo unknown
}

# checking_lines LOG: how many modules Agda type-checked.  Unanchored, since
# Agda indents the Checking lines of nested modules.
checking_lines() {
  grep -c 'Checking ' "$1" || true
}
