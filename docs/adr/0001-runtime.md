<!-- File: docs/adr/0001-runtime.md -->

# ADR 0001: the runtime

File: `agda-native-ide/docs/adr/0001-runtime.md`

+  **Status**: Accepted when the pull request that adds it merges.  The
   fork, its import, its pins and its notice land with this record; the
   second lane is recorded and not adopted ([#30]).
+  **Date**: 2026-10-04.
+  **Tracking**: [#7] (this record); [#2] (the fork), [#48] (the notice),
   [#4] (the pins; its mirror and rebuild stay open), [#3] (its dev-shell
   clause); [#30] (the second lane).
+  **Ancestry**: agda-native-air's [browser IDE proposal][proposal], § 1
   "Fork the runtime"; agda-algebras PR [585][pr-585] and its
   [ADR-011][adr-011], which built and measured the second lane; the
   2026-10-04 investigation of the fork, whose findings are recorded on
   [#2] to [#6], [#13], [#48], [#49] and [#50].

## Executive summary

The IDE's runtime is [plfa-playground][upstream], forked whole.  It runs the
Agda Language Server (Agda 2.8.0 with a language-server front end), compiled
to WASI (the WebAssembly System Interface, the POSIX-like imports through
which a WebAssembly program reaches files and streams), in a browser
worker; a second worker owns the in-memory filesystem Agda reads; the two
share memory, which is why the page must be served cross-origin isolated
(with the two response headers, `Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy`, without which a browser withholds shared
memory).  The page drives Agda through its interaction protocol, and an
edit that stays inside one goal is checked with a give (Agda's command
that checks one expression against one goal) rather than a full reload.
[`docs/notes/runtime.md`][note] explains the architecture.

It comes in as a snapshot, not a history merge: 89 of upstream's 128 files,
byte for byte, at commit `ae0aa84c`, with a provenance record of every file's
SHA-256; and the 36 binaries the app needs (the compiler, the archives, the
fonts and an icon) are pinned by SHA-256 in the flake and fetched, never
committed.  The build refuses a file that differs from its pin, and `NOTICE`
names everything the built site ships, with the license texts beside it.

Why this shape: the fork already does what every later milestone builds
on, under the MIT license; a history merge would put about 171 MB of binary
blobs into this repository for good, against its rule that no binary is
committed.

Where it stands: in the dev shell, the imported app builds, its 5 unit tests
and its type check pass, and it checks `Main.agda` in headless Chromium with
`crossOriginIsolated` true (§ 3).

Where it goes: a mirror for the compiler and a rebuild recipe ([#4]), the
site as a Nix package ([#3]), CI with a browser check ([#5]), hosting
([#6]), and the second lane, the plain checker as the verdict of record
([#30]).

---

## 1.  The fork

(See also [#2], the [proposal]'s § 1, and [`docs/notes/runtime.md`][note].)

**Decision**.  The runtime is plfa-playground, rather than its ancestor
agda-web/als-demo or the plain batch checker; its architecture is kept as it
is until Milestone 1 changes it deliberately.

+  **Kept**: the two workers joined by shared memory, the language-server
   transport, the give rule (an edit wholly inside one goal is checked with
   `Cmd_give`; anything else is a full `Cmd_load`), the library archive
   format (stored zips with interfaces under `_build/2.8.0/agda/`, mounted
   by `mountDriveArchives`), and the IndexedDB persistence.
+  **Not kept, later**: PLFA ([#20]), the Cloudflare tooling ([#3]), and
   upstream's hand-maintained cache tokens ([#3]); none is removed here.

**Evidence**.

+  **What the fork has that its ancestor lacks**.  agda-web/als-demo
   ("A teaser of Agda REPL", its description) is where the worker, the
   filesystem, the highlighting, the input method and the transport began
   (upstream's `NOTICE.md`).  Its controller sends one Agda command,
   `Cmd_load`, and has no give rule, no archive mounting and no persistence
   (`src/lib/controller.svelte.ts` on its `public` branch, 12,470 bytes,
   read 2026-10-04); plfa-playground's controller (33,161 bytes) adds the
   goal commands, the give rule, `mountDriveArchives` and the IndexedDB
   cache, and its repository carries the recipe that built its compiler
   from pinned sources (`compiler/build-agda-wasm.sh`).
+  **What the plain checker lacks**.  `agda-opt.wasm` is a batch program:
   it has no language server (hover, completion), and agda-algebras PR
   [585][pr-585] had to build a host that paces its standard input to get
   goal commands from it (§ 5).  It is the second lane, not the first.
+  **The fork works as imported**.  Built and driven here (§ 3), and in the
   investigation ([#2]'s findings).
+  **The license permits it**: MIT, with "Copyright 2026 Andy Pan", the line
   als-demo's license carries (upstream's `LICENSE` is byte-identical to
   als-demo's), while every upstream commit is Seungheon Oh's ([#48]).

**Status**.  Adopted.  Open: everything Milestone 1 changes, starting with
the drive's lookups ([#50]) and the builtin interfaces ([#49]).

---

## 2.  The import

(See also [#2] and [`docs/provenance.md`][provenance].)

**Decision**.  Upstream comes in as a snapshot of its tree at
`ae0aa84c24363a8d6dadc292b6eb8f88f7f38705` (2026-08-31), in one commit whose
files are upstream's, byte for byte, without its binaries, with a provenance
record and an `upstream` remote for later syncs; not as a merge of its
history.

+  **The record**, in `upstream/`: every file of upstream's tree with its
   SHA-256 (`plfa-playground.sha256`, as `scripts/upstream-record.sh`
   prints it), the imported files still byte-identical to upstream
   (`unchanged.sha256`, checked by `make provenance-check`), and the pins
   (`assets.sha256`, § 3).  `docs/provenance.md` says what became of each
   file.
+  **Collisions**: upstream's `README.md`, `LICENSE` and CI workflow come in
   as `README.plfa-playground.md`, `LICENSE.plfa-playground` (verbatim) and
   `.github/workflows/app.yml`; its `.gitignore` is merged into this
   repository's; `wrangler.jsonc` (upstream's Cloudflare account) is left
   out.
+  **Changes**: each change to an imported file is its own commit, says so
   in a header comment naming the upstream file and commit (or, for JSON, in
   `docs/provenance.md`), and leaves `unchanged.sha256`.  This pull request
   changes the workflow (it builds from the pins, without the deploy job)
   and `package.json` (no `deploy` script), and removes upstream's
   `NOTICE.md`, which `NOTICE` supersedes.
+  **Syncing** is file by file: the README's "Syncing with upstream" diffs
   a later commit's record against the committed one, takes the files still
   upstream's, merges the changed ones three ways with `git merge-file`, and
   updates the records and the pins.

**This departs from the plan's wording**.  [#2]'s title says "history and
attribution intact", and Milestone 0's description says "The fork comes in
with its history".  The history does not come in; the attribution does, in
`LICENSE`, `NOTICE` and the record.  Proposed wording, for William to
adopt or refuse: [#2]'s title "Fork plfa-playground into this repository,
as a recorded snapshot with its attribution", and Milestone 0's sentence
"The fork comes in as a recorded snapshot, with its attribution".

**Evidence**.

+  **Upstream's binaries**, measured 2026-10-04 in a clone of upstream:
   at `ae0aa84c`, `static/` holds 60,183,062 bytes, 59,422,474 of them in 37
   binary files (`git diff --numstat` against the empty tree marks them
   binary).  Across upstream's four commits there are 67 distinct binary
   blobs totalling 171,397,049 bytes (172,157,637 with the text under
   `static/`), three compiler builds among them (28,841,108, 28,921,665 and
   32,996,332 bytes), and a fresh clone's pack is 94.25 MiB.  A history
   merge would add them all to every clone of this repository, against
   CLAUDE.md's rule that no binary is committed.
+  **The snapshot is exact**: every one of the 89 imported files has the
   blob id of its upstream file (`git ls-files -s` joined with upstream's
   `git ls-tree`); `make provenance-check` re-verifies the unchanged ones
   by SHA-256.
+  **The sync procedure was run**: on a scratch clone, against a constructed
   later upstream commit changing five files (one still upstream's, one
   renamed, one changed here, one new, one pinned binary), the record diff
   named exactly those five, and `git merge-file` merged upstream's change
   to `package.json` while keeping this repository's removal of `deploy`.
   One trap was found and documented: in zsh, `"$NEW:path"` reads `:s` as a
   history modifier ("bad substitution"), so the README writes
   `"${NEW}:path"`.

**Status**.  Adopted.  Open: the wording above, William's to change: [#2]'s
title on GitHub (keeping its `[M0-2]` prefix), and Milestone 0's
description in `docs/GITHUB_PROJECT.md`.

---

## 3.  The pins

(See also [#4], [#3], and [`docs/provenance.md`][provenance].)

**Decision**.  Every binary the app needs from upstream is pinned by
SHA-256 and fetched by the flake, one fixed-output fetch per file, from
upstream's tree at the imported commit; the build checks the files it
consumes against the same pins.

+  **The pins**: `upstream/assets.sha256`, 36 files, 49,234,067 bytes: the
   compiler (`als-2.8ext.wasm`), Agda's builtin library (`agda-data.zip`),
   the standard library 2.3 (`agda-stdlib-2.3.zip`), six JuliaMono fonts,
   the favicon's PNG, and PLFA's 26 archives.  The flake reads the file and
   makes a `fetchurl` per line from
   `raw.githubusercontent.com/SeungheonOh/plfa-playground/<commit>/<path>`;
   `nix build .#assets` is the set.  A fixed-output fetch (one whose output
   hash is declared in advance) fails when the bytes differ.
+  **The checks**: `make assets` copies the set into `static/` and checks
   it; `make build` checks every file in `static/` against its pin
   (`sha256sum --check --strict`) before `npm run build`.
+  **Not pinned**: upstream's `als-2.8ext.wasm.gz`, because the build writes
   its own and the dev server falls back to the raw compiler without it.
+  **The dev shell** gains node 22 (22.22.2, `pkgs.nodejs_22`), so that
   `nix develop --command npm ...` works: the dev-shell clause of [#3],
   taken early because [#2]'s acceptance needs npm.

**Evidence** (2026-10-04, this machine, headless Chrome 153.0.8010.47).

+  **The pins hold**: `nix build .#assets` fetched all 36 in 66 s, and every
   file matched; the compiler's pin is the one [#4] verified
   (`sha256-U8YrCtVpqdEj90SxksE3gMSUreDN3vTaqgDbQezX96E=`, SHA-256
   `53c62b0a...`, the hash upstream's `compiler/README.md` records).
+  **A changed pin fails the fetch**: with the last hex digit of
   `agda-data.zip`'s pin changed from 3 to 0, `nix build .#assets` stopped
   with "hash mismatch in fixed-output derivation" (specified
   `sha256-J9gd...nqA=`, got `sha256-J9gd...nqM=`), exit 1.
+  **A changed file fails the build**: with one byte of
   `static/agda-stdlib-2.3.zip` flipped (offset 998,948, 0x8c to 0x8d),
   `make build` stopped at "static/agda-stdlib-2.3.zip: FAILED", exit 2,
   before `npm run build` ran; `make assets` restored the file.
+  **The pinned app builds and runs**, from a clean tree (no
   `node_modules`, no `build/`, no materialized binaries) on an idle
   machine: `make assets`, then `npm ci` (167 packages), `npm run check`
   (svelte-check: 4302 files, 0 errors, 0 warnings), `npm test` (5 of 5)
   and `make build` (9.4 s; 300 files, 29,239,191 bytes in `build/`: the
   app's 83 files, 28,705,637 bytes as the investigation measured, plus
   `NOTICE.txt` and the license texts) all pass.  Served with the
   isolation headers and driven headless with the investigation's server
   and driver, three fresh profiles were "Agda ready" at 0.85 to 0.96 s and
   had checked `Main.agda` at 1.87 to 2.19 s (2 open goals; the check
   itself 0.93 to 1.18 s), with `crossOriginIsolated` true; each first
   visit made 25 requests for 15,630,931 bytes (the investigation's
   15,630,936, less five bytes: SvelteKit names each build with an
   identifier that appears five times in the page, and this build's,
   `__sveltekit_qipo0l`, is one character shorter), and each warm reload
   made none and checked by 1.26 to 1.48 s.  The runs are in the pull
   request that adds this record.
+  **Where upstream got the binaries** (`docs/provenance.md`): the compiler
   exists only in upstream's git tree ([#4]); the six fonts are
   byte-identical to JuliaMono's `webfonts/` at `v0.060`; the standard
   library's 1,391 files equal agda-stdlib `v2.3`'s by CRC-32;
   `agda-data.zip` is byte-identical to agda-web/als-demo's.  The fonts and
   the standard library therefore have second sources for [#4]'s mirror.
+  **The gzip**: `npm run build` wrote a 10,154,917-byte gzip that inflates
   to the pinned compiler; with no `.gz` in `static/`, `npm run dev` served a
   404 for it, the page fetched the raw compiler, and Agda checked
   `Main.agda` (2 open goals, isolated).

**Status**.  Adopted.  Open on [#4]: a mirror this organization controls
(the compiler has one source, a personal repository), and the rebuild
recipe as a flake app, with its outcome recorded.

---

## 4.  The notice

(See also [#48] and [`NOTICE`][notice].)

**Decision**.  A root `NOTICE` names every artifact the built site ships,
with its copyright and license, and `licenses/` holds every license text,
each read at its source; `make build` publishes both beside the site, as
`NOTICE.txt` and `licenses/`.  Upstream's `NOTICE.md` is removed, and its
lineage paragraphs are carried into `NOTICE` verbatim.

+  **GMP**: the compiler statically links GMP 6.3.0, which is offered under
   LGPL-3.0-or-later or GPL-2.0-or-later; the notice takes the LGPL, ships
   its text and the GPL-3.0's (which the LGPL incorporates), and meets the
   LGPL's relinking condition by pointing at the pinned sources of every
   part of the compiler and at the recipe that links them, so that anyone
   can rebuild it with a modified GMP.  This is a judgment, not counsel's,
   and William's to confirm; the GPL's source clause also leaves the
   distributor responsible for those sources staying available, so the GMP
   tarball belongs in [#4]'s mirror beside the compiler.
+  **The favicon** is Agda's official mark, adapted; agda/agda ships the
   mark in its package as an `extra-doc-files` entry under its MIT license
   and states no other terms, so the notice credits it under Agda's license
   and no replacement is needed.

**Evidence**.

+  **Every text was read at its source**, at the commit or tag `NOTICE`
   names, and copied verbatim (`.gitattributes` keeps git from changing
   their line endings).
+  **The page's packages** were listed from a build with source maps, not
   from the lockfile: 35 npm packages, four more embedded in `jszip`'s
   prebuilt file, and the bundler's helpers.  Only comlink's license
   comment survives minification, so the page's code credits almost none
   of them itself.
+  **The compiler's packages** come from a cabal build plan solved with the
   pinned toolchain at index state 2026-08-31T23:24:32Z, the time the
   binary was committed (the recipe pins no index state): 150 packages in
   the executable's link closure.  The binary's strings carry 57 unit ids,
   35 of them with a content hash that fixes the package's source, flags
   and dependencies; every one is in the plan and none disagrees.  Any
   index state from 2026-08-29T13:20:56Z, the newest upload among the
   planned packages, gives the same plan.
+  **The C and C++ code the plan does not list**: GMP 6.3.0 (the GHC
   bindist's own header says so, and its `ghc-bignum` archive holds GMP's
   objects), wasi-libc and compiler-rt's builtins (the toolchain's clang
   adds both to every link), libc++ and libc++abi (the binary names
   libc++abi), and simdutf (bundled by `text`).

**Status**.  Adopted.  Open: the GMP judgment above, and the notice's
upkeep when the dependencies change ([#3] trims them).

---

## 5.  The second lane

(See also [#30], the [proposal]'s § 1, and agda-algebras PR [585][pr-585].)

**Decision**.  The plain checker, `agda-opt.wasm` from agda-web/agda-wasm-dist
(release `v2.8.0-ghc9.10.3-r0`), is not adopted here.  It is recorded as the
planned verdict of record, the lane whose batch exit code decides whether a
file checks, beside the language server's interactive lane ([#30],
Milestone 3).

**Evidence**.  agda-algebras PR [585][pr-585], measured in headless
Chromium 153 on 2026-10-04 and recorded in its [ADR-011][adr-011]:

+  **The plain checker answers every goal command without isolation**.
   Driven through Agda's interaction protocol (`--interaction-json`) with a
   standard input paced from Agda's own answers, it gave, refined, split
   cases and inferred types on three agda-algebras exercises, with
   `crossOriginIsolated` false in every run.  It shares no memory between
   threads, so it needs no `SharedArrayBuffer`.
+  **One process can stay alive across commands, still without
   isolation**.  A probe using JavaScript Promise Integration (JSPI, which
   lets WebAssembly suspend on a JavaScript promise instead of blocking a
   thread) kept one Agda process across commands: on a 244-module image,
   12.9 s for the first load, then 1.45 s per reload and 45 to 55 ms per
   goal query, against about ten seconds per command as shipped.  Only
   Chromium was tried.

**What it means for isolation**.  Only the language-server lane needs
cross-origin isolation; the batch lane runs on any static host, and in a
browser or a context where isolation is unavailable (where service workers
are disabled, so the fork's service-worker fallback cannot run, [#6]).
A page that cannot isolate itself can still check a file, slower, through
the batch lane, and JSPI would make that lane interactive where it exists;
where JSPI is missing, PR 585's shipped path (one process per command,
about ten seconds each on that image) still works.  So the isolation
requirement is the interactive lane's, not the IDE's.

**Status**.  Recorded, not adopted.  Open: [#30].

---

## 6.  What the measurements already settled

(See also [#13], [#49], and [#50].)

These were measured during the investigation, are recorded on their issues,
and are cited here rather than measured again.

+  **Interfaces built by the flake's native Agda are accepted** by the
   browser's Agda ([#13]).  Both use interface version 202507030; a `Main`
   importing agda-algebras' `Overture.Basic` type-checked only `Main` (one
   `Checking` line in Agda's running info), where the sources-only control
   checked all 66 modules.  So the library archives of Milestone 1 can be
   built natively.
+  **Most of a check's time is the drive's lookups** ([#50]): the in-memory
   filesystem scans every file and builds a regular expression per file on
   each lookup.  With interfaces accepted, a `Main` importing
   `Overture.Basic` took 13.6 to 18.5 s per check, and 1.8 to 3.7 s with an
   index on the lookups.
+  **The builtin interfaces are stale** ([#49]): `agda-data.zip` holds Agda
   2.7.0.1's interfaces (version 202406290), so a fresh profile's first
   check type-checks the builtins it imports again.  Re-observed here: the
   default `Main.agda`'s first check printed four `Checking` lines (`Main`,
   `Agda.Builtin.Nat`, `Agda.Builtin.Bool`, `Agda.Builtin.Equality`), as on
   the live site.  That is upstream's behavior, kept unchanged by this
   import.

**Status**.  Settled; the fixes are [#49] and [#50].

---

## 7.  Decision log

| # | Decision | Status | Evidence |
|---|---|---|---|
| 1 | Fork plfa-playground whole, not als-demo or the plain checker; keep its two workers, transport, give rule, archive format and persistence | Adopted ([#2]) | als-demo sends only `Cmd_load`; the fork builds, tests and checks `Main.agda` here (§ 3) |
| 2 | Import a snapshot of `ae0aa84c`, 89 files byte for byte, with a per-file SHA-256 record; no history merge | Adopted ([#2]) | 67 binary blobs, 171,397,049 bytes, in upstream's history; blob ids equal |
| 3 | Keep upstream's colliding files at new paths (`README.plfa-playground.md`, `LICENSE.plfa-playground`, `app.yml`); merge its `.gitignore`; leave out `wrangler.jsonc` | Adopted ([#2]) | `docs/provenance.md` |
| 4 | Every change to an imported file is its own commit, with a header comment or a provenance row, and leaves `upstream/unchanged.sha256` | Adopted ([#2]) | `make provenance-check` |
| 5 | Sync file by file from the record, with `git merge-file` for changed files | Adopted ([#2]) | Rehearsed on a constructed later commit (§ 2) |
| 6 | Pin the 36 binaries by SHA-256, one fixed-output fetch per file; check `static/` before every build | Adopted (part of [#4]) | A changed pin fails the fetch; a flipped byte fails the build (§ 3) |
| 7 | Do not pin upstream's compiler gzip | Adopted | The build writes its own; `npm run dev` falls back (§ 3) |
| 8 | Node 22 in the dev shell | Adopted (part of [#3]) | 22.22.2, inside upstream's engines range |
| 9 | `NOTICE` plus `licenses/`, published as `NOTICE.txt` and `licenses/`; upstream's `NOTICE.md` removed | Adopted ([#48]) | Every text read at its source (§ 4) |
| 10 | GMP under LGPL-3.0-or-later, relinking met by the pinned sources and the recipe | Adopted, a judgment for William | § 4 |
| 11 | The Agda mark stays, under Agda's MIT license | Adopted ([#48]) | `Agda.cabal`'s `extra-doc-files` |
| 12 | The plain checker is the planned verdict of record, not adopted here | Recorded ([#30]) | PR 585: no isolation; JSPI 1.45 s reloads, 45 to 55 ms queries |
| 13 | Native interfaces are accepted; the drive is the cost; the builtins are stale | Settled | [#13], [#50], [#49] |

---

## References

+  **Issues**: [#2] (the fork), [#3] (the Nix build), [#4] (the pins), [#5]
   (CI), [#6] (hosting), [#7] (this record), [#8] (a page that cannot
   isolate itself), [#13] (interface acceptance), [#20] (PLFA's removal),
   [#30] (the second lane), [#48] (the notice), [#49] (the builtins), [#50]
   (the drive).
+  **Elsewhere**: agda-algebras PR [585][pr-585] and its [ADR-011][adr-011];
   agda-native-air's [browser IDE proposal][proposal]; [plfa-playground][upstream]
   at `ae0aa84c`.
+  **Documents**: [`docs/notes/runtime.md`][note] (how the runtime works),
   [`docs/provenance.md`][provenance] (the record), [`NOTICE`][notice].
+  **Code**: `flake.nix` (`packages.assets`, the pins), `Makefile` (`assets`,
   `assets-check`, `build`, `provenance-check`), `upstream/` (the records),
   `scripts/upstream-record.sh`, `.github/workflows/app.yml`.

[#2]: https://github.com/formalverification/agda-native-ide/issues/2
[#3]: https://github.com/formalverification/agda-native-ide/issues/3
[#4]: https://github.com/formalverification/agda-native-ide/issues/4
[#5]: https://github.com/formalverification/agda-native-ide/issues/5
[#6]: https://github.com/formalverification/agda-native-ide/issues/6
[#7]: https://github.com/formalverification/agda-native-ide/issues/7
[#8]: https://github.com/formalverification/agda-native-ide/issues/8
[#13]: https://github.com/formalverification/agda-native-ide/issues/13
[#20]: https://github.com/formalverification/agda-native-ide/issues/20
[#30]: https://github.com/formalverification/agda-native-ide/issues/30
[#48]: https://github.com/formalverification/agda-native-ide/issues/48
[#49]: https://github.com/formalverification/agda-native-ide/issues/49
[#50]: https://github.com/formalverification/agda-native-ide/issues/50
[pr-585]: https://github.com/ualib/agda-algebras/pull/585
[adr-011]: https://github.com/ualib/agda-algebras/blob/577-an-interactive-agda-proof-environment/docs/adr/011-interactive-playground.md
[proposal]: https://github.com/formalverification/agda-native-air/blob/main/docs/notes/browser-ide-proposal.md
[upstream]: https://github.com/SeungheonOh/plfa-playground
[note]: ../notes/runtime.md
[provenance]: ../provenance.md
[notice]: ../../NOTICE
