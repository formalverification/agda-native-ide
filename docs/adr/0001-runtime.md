<!-- File: docs/adr/0001-runtime.md -->

# ADR 0001: the runtime

File: `agda-native-ide/docs/adr/0001-runtime.md`

+  **Status**: Accepted when the pull request that adds it merges.  The
   fork, its import, its pins and its notice land with this record; the
   second lane is recorded and not adopted ([#30]).  Since 2026-10-07 the
   page runs this repository's own build of Agda 2.9.0 (§ 7), and since
   2026-10-08 the server's reactor build, with the drive in its worker, so
   that the page needs no cross-origin isolation (§ 8), and it says so when
   a browser cannot run it (§ 9).
+  **Date**: 2026-10-04; § 7 2026-10-07; § 8 and § 9 2026-10-08; § 10
   2026-10-11 and 2026-10-12; § 11 2026-10-12.
+  **Tracking**: [#7] (this record); [#2] (the fork), [#48] (the notice),
   [#4] (the pins; its mirror and rebuild stay open), [#3] (its dev-shell
   clause); [#30] (the second lane); [#53] (the license questions deferred
   until before the repository goes public); [#58] (the 2.9.0 compiler,
   § 7); [#59] (the reactor and the drive in one worker, § 8); [#8] (the
   page's notices, § 9); [#12] and [#13] (the library archives, § 10);
   [#11] (the playground's project, § 11).
+  **Ancestry**: agda-native-air's [browser IDE proposal][proposal], § 1
   "Fork the runtime"; agda-algebras PR [585][pr-585] and its
   [ADR-011][adr-011], which built and measured the second lane; the
   2026-10-04 investigation of the fork, whose findings are recorded on
   [#2] to [#6], [#13], [#48], [#49] and [#50].

## Executive summary

The IDE's runtime is [plfa-playground][upstream], forked whole.  It runs the
Agda Language Server (Agda with a language-server front end), compiled to WASI
(the WebAssembly System Interface, the POSIX-like imports through which a
WebAssembly program reaches files and streams), in a browser worker.  As
forked, a second worker owned the in-memory filesystem Agda reads, and the two
shared memory, which is why the page had to be served cross-origin isolated
(with the two response headers, `Cross-Origin-Opener-Policy` and
`Cross-Origin-Embedder-Policy`, without which a browser withholds shared
memory).  Since 2026-10-08 the server is its *reactor* build, which exports
functions JavaScript calls with messages, in one worker with the filesystem,
so nothing is shared and any static host serves the page (§ 8).  The page
drives Agda through its interaction protocol, and an edit that stays inside
one goal is checked with a give (Agda's command that checks one expression
against one goal) rather than a full reload.  [`docs/notes/runtime.md`][note]
explains the architecture.

It comes in as a snapshot, not a history merge: 89 of upstream's 128 files,
byte for byte, at commit `ae0aa84c`, with a provenance record of every file's
SHA-256; and no binary the app needs is committed: 35 of them (the
compiler, the archives, the fonts and an icon) were pinned by SHA-256 in the
flake and fetched, and Agda's builtin library is built by the flake from a
pinned Agda ([#49]).  Since 2026-10-07 the compiler is this repository's
own build, pinned by its hashes, and the standard library is built here,
patched (§ 7), so 33 of upstream's pins remain.  The build refuses a file
that differs from its pin, and `NOTICE` names everything the built site
ships, with the license texts beside it.

Why this shape: the fork already does what every later milestone builds
on, under the MIT license; a history merge would put about 171 MB of binary
blobs into this repository for good, against its rule that no binary is
committed.

Where it stands: in the dev shell, the imported app builds, its 5 unit tests
and its type check pass, and it checks `Main.agda` in headless Chromium with
`crossOriginIsolated` true (§ 3).  Since 2026-10-05 the site is also a Nix
package that builds reproducibly ([#3]), and CI builds it, runs its unit
tests and type check, and checks `Main.agda` in headless Chromium on every
pull request ([#5]); since 2026-10-08 it checks the page served without the
isolation headers and with them, and the page's notices for a browser it
cannot run in (§ 8, § 9).

Where it goes: the fork's compiler, agda-web's build of Agda 2.8.0, gave
way on 2026-10-07 to this repository's own build of Agda 2.9.0 and its
language server, from a recipe that pins every input, with the standard
library 2.3 patched to check under it, and binaries released from a public
repository of this organization (§ 7); on 2026-10-08 the page moved to the
server's reactor build and stopped needing isolation (§ 8), and it now
names the browsers it is tested in and says so where it cannot run (§ 9).
agda-algebras' archives are built and checked for it since 2026-10-11
(§ 10), and since 2026-10-12 the playground's `Main` is a project of its
own over agda-algebras, under the library's options line (§ 11).
Hosting ([#6]), the license review before the repository goes public
([#53]), and the second lane, the plain checker as the verdict of record
([#30]), remain.

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
the drive's lookups ([#50]) and the builtin interfaces ([#49]).  On
2026-10-05 [#3] removed `wrangler`, the last Cloudflare package, and
replaced the hand-maintained cache tokens with values the build derives
from the files; the rest of upstream's Cloudflare-shaped build, the
post-step that gzips the compiler (`scripts/prepare-cloudflare-assets.mjs`)
and `static/_headers`, waits for the host ([#6]).  On 2026-10-08 [#59]
replaced the two workers joined by shared memory with one worker that holds
the server's reactor build and the drive (§ 8).

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

**This departed from the plan's wording**, and the plan was changed to
match on 2026-10-05, by William's decision.  [#2]'s title had said "history
and attribution intact", and Milestone 0's description "The fork comes in
with its history"; the history does not come in, and the attribution does,
in `LICENSE`, `NOTICE` and the record.  The title now reads "Fork
plfa-playground into this repository, as a recorded snapshot with its
attribution", and the description "The fork comes in as a recorded
snapshot, with its attribution".

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

**Status**.  Adopted, the plan's wording included (2026-10-05).

---

## 3.  The pins

(See also [#4], [#3], and [`docs/provenance.md`][provenance].)

**Decision**.  Every binary the app needs from upstream is pinned by
SHA-256 and fetched by the flake, one fixed-output fetch per file, from
upstream's tree at the imported commit; the build checks the files it
consumes against the same pins.

+  **The pins**: `upstream/assets.sha256`, 35 files, 48,642,786 bytes: the
   compiler (`als-2.8ext.wasm`), the standard library 2.3
   (`agda-stdlib-2.3.zip`), six JuliaMono fonts, the favicon's PNG, and
   PLFA's 26 archives.  The flake reads the file and makes a `fetchurl` per
   line from
   `raw.githubusercontent.com/SeungheonOh/plfa-playground/<commit>/<path>`;
   `nix build .#assets` is the set, with Agda's builtin library
   (`agda-data.zip`), which was a 36th pin (591,281 bytes) until [#49]
   replaced it with a build (§ 6).  A fixed-output fetch (one whose output
   hash is declared in advance) fails when the bytes differ.
+  **The checks**: `make assets` copies the set into `static/` and checks
   it; `make build` checks every pinned file in `static/` against its pin
   (`sha256sum --check --strict`) before `npm run build`, and, since
   [#49], that `agda-data.zip` is the flake's build.
+  **Not pinned**: upstream's `als-2.8ext.wasm.gz`, because the build writes
   its own and the dev server falls back to the raw compiler without it;
   and, since [#49], `agda-data.zip`, which the flake builds (§ 6).
+  **The dev shell** gains node 22 (22.22.2, `pkgs.nodejs_22`), so that
   `nix develop --command npm ...` works: the dev-shell clause of [#3],
   taken early because [#2]'s acceptance needs npm.

**Evidence** (2026-10-04, this machine, headless Chrome 153.0.8010.47).

+  **The pins hold**: with none of them in the Nix store, `nix build
   .#assets` fetched all 36 (49,234,067 bytes) in 32.5 s, and every file
   matched; the compiler's pin is the one [#4] verified
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
   `Main.agda` (2 open goals, isolated).  The built site has no raw
   compiler at all (the post-step deletes it), so a browser without
   `DecompressionStream` (Firefox before 113 and Safari before 16.4, both
   inside the build's declared targets) gets a 404 for the fallback and a
   page that says "Agda ready" and never checks, as on upstream's live
   site; measured 2026-10-05 ([`docs/notes/runtime.md`][note], "Startup"),
   and [#3]'s to decide.

**Status**.  Adopted.  Open on [#4]: a mirror this organization controls (the
compiler has one source, a personal repository), and the rebuild recipe as a
flake app, with its outcome recorded.  On 2026-10-07 [#58] retired two of
these pins, the compiler and the standard library, which the page no longer
ships (§ 7); 33 remain, 13,648,557 bytes.  On 2026-10-05 [#3] decided that the
built site does not ship the raw compiler.  The fallback could serve only
Safari 15.2 to 16.3, since every Firefox without `DecompressionStream` (before
113) also lacks the module workers the page starts (from 114; MDN's
compatibility data), and it would cost 33 MB a deploy, over Cloudflare Pages'
25 MiB limit for one file.  The page's silence when it cannot fetch or
decompress the compiler was answered on 2026-10-08 by [#8]: the page says
why Agda could not start, and the dev server, which the fallback served,
serves the gzip itself (§ 9).

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
   tarball belongs in [#4]'s mirror beside the compiler.  On 2026-10-05
   William deferred this and every other open license question to [#53],
   to be settled before the repository goes public; the notice stood as
   written meanwhile.  On 2026-10-07 William confirmed it ([#53]'s comment
   of that day): GMP is distributed under the LGPL, and each public release
   of the compiler carries GMP's source tarball and GHC's two patches to it,
   with the build plans (the first, `agda-2.9.0-da66a8c-als-8` of
   formalverification/agda-wasm-builds), so decision 10 is adopted.
+  **The favicon** is Agda's official mark, adapted; agda/agda ships the
   mark in its package as an `extra-doc-files` entry under its MIT license
   and states no other terms, so the notice credits it under Agda's license
   and no replacement is needed.

**Evidence**.

+  **Every text was read at its source**, at the commit or tag `NOTICE`
   names, and copied verbatim (`.gitattributes` keeps git from changing
   their line endings).  One could not be: nonempty-vector 0.2.4's
   `LICENSE` is empty in its Hackage tarball and in its repository alike,
   so `NOTICE` supplies the BSD-3-Clause text its cabal file declares, in a
   file that says it was supplied (found in review).
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

**Status**.  Adopted.  Open: [#53], the license review before the
repository goes public (the packages the binary does not confirm,
libffi-wasm, and nonempty-vector's supplied text; GMP was settled on
2026-10-07, above), and the notice's upkeep when the dependencies change
([#3] trims them).  On
2026-10-07 the notice's section 3 moved to the 2.9.0 compiler (§ 7): its
140 packages come from that build's own plan rather than a re-solved one,
the binary names 56 of them exactly, and two texts are new for the
review, zstd's C library's and the patent grant its Haskell package
ships.  On 2026-10-08 it moved to the reactor build that the page ships
(§ 8): 141 packages from the reactor's own plan (the command module's and
`ghc-experimental`), and the reactor's JavaScript glue, GHC's code under
GHC's license; the page bundles 34 npm packages, `spsc` gone with the
rings it served; and `coi-serviceworker.js` is no longer shipped.

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
requirement is the interactive lane's, not the IDE's.  Since 2026-10-08
the interactive lane needs no isolation either (§ 8).

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
   built natively.  That holds for Agda 2.8.0 only: Agda 2.9.0's
   interfaces depend on the word size of the Agda that writes them (§ 7).
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

**The builtins' fix** ([#49], 2026-10-06).  `agda-data.zip` is built by
the flake from the whole of an Agda's own `lib/prim` (sources, library file,
and the interfaces that Agda builds under `_build/<its version>/agda/`), at
the root the page's server reads it from, reproducibly; its input is one
attribute, `agdaDataInput` (today the pinned nixpkgs' Agda 2.8.0 and
`lib/prim`), which [#58]'s move to another Agda changes.  The input must be
the Agda the server embeds, to the commit: the page runs `als --setup`
before every server start, and `--setup` writes every builtin source from
the server's own copy over the drive's.  Measured 2026-10-06 in headless
Chromium 149: a fresh profile's first check of the default `Main.agda`
type-checks `Main` alone (the browser check now asserts it), and so does
each of two `Main`s that between them import all 36 builtins; an archive
holding the fork's 2.7.0.1 sources beside the new interfaces gives the
same in the browser, where native Agda, which reads the archive's sources,
checks 9 and 4 builtins again.  The pull request has the runs.

---

## 7.  The 2.9.0 compiler

(See also [#58], [#59], [#61], [#13], [#4],
[`compiler/build-agda-2.9.0.sh`][recipe], and
[`docs/notes/runtime.md`][note].)

**Decision**.  The page's compiler is this repository's own build of Agda 2.9.0
and the Agda Language Server for `wasm32-wasi`, from a recipe that pins every
input, in place of agda-web's build for Agda 2.8.0 (§ 3).  The page ships it
with the standard library 2.3 patched to check under 2.9.0, and every
interface it ships is built by a 32-bit (wasm32) Agda.

+  **The sources**: agda/agda `da66a8c7`, the `nightly` of 2026-10-05 (2.9.0
   is unreleased), built as it is, since Agda builds for WASI unpatched since
   agda/agda PR 8205; and agda/agda-language-server `v8` (`0f77a209`) against
   it, with two patches in `compiler/patches/`.  The first adds a flag for
   Agda 2.9.0 and 21 branches for its API, guarded by Agda's version so that
   the server still builds against 2.8.0, and fixes the reactor module,
   which does not compile at `v8`.  The second is the server's wasm project
   file: the index state, lsp 2.8 from the server's own submodule (the
   reactor needs it), and lsp's WebSocket support turned off.
+  **Three modules and a glue file**: the server as a command module, which
   the page runs (`static/als-2.9.0.wasm`); the server as a reactor module,
   with the JavaScript glue GHC's post-linker writes, for [#59]; and the plain
   `agda`, which builds the builtins here and is the batch lane's ([#30]).
+  **The toolchain**: ghc-wasm-meta `58260711`, the commit Agda's own flake
   pins at `da66a8c7` (GHC 9.10.3.20260731), as a flake input with its own
   nixpkgs, so that its store paths are those of Agda's dev shell; one
   toolchain for all three modules, where the server's CI uses an older one
   (`c3f44696`) that nothing has proven with Agda 2.9.0.
+  **The data directory**: both builds are without Agda's
   `use-xdg-data-home` flag, so the data directory is `Agda_datadir` itself,
   `/` in the page, and neither the page's layout nor `agda-data.zip`'s root
   changes.
+  **The recipe is a script in a pinned dev shell, run by an optional CI
   job**, not a pure derivation.  `nix develop .#compiler --command
   compiler/build-agda-2.9.0.sh` builds the four files at one fixed path,
   since the binaries record their build paths;
   `.github/workflows/compiler.yml` runs it on demand and when a pull
   request that changes the recipe or its pins opens or is ready for
   review, and fails unless the bytes match
   `compiler/agda-2.9.0.sha256`; `nix build .#compiler` fetches the files by
   those hashes.  A pure derivation would need every Hackage package as a
   fixed-output fetch, a second packaging of a plan cabal already pins by
   its index state, for a build of two Agdas (27 minutes from empty on
   this workstation) that no cache here spares CI from; [#4]'s findings
   recommended the same split.
+  **Where the binaries live**: releases of a public repository of this
   organization, William's decision of 2026-10-07, created the same day:
   formalverification/agda-wasm-builds, whose release
   `agda-2.9.0-da66a8c-als-8` holds the four pinned files, the three build
   plans, and GMP's source with GHC's patches; the flake fetches the files
   from it by their hashes.  The move to Agda's 2.9.0 release is a new
   Agda commit in the recipe, a rebuild, a new release and a new file of
   hashes.
+  **Every interface the page ships is built by a wasm32 Agda**, since
   Agda 2.9.0 writes an interface's integers at the width of the machine
   that writes it (below): the builtins' archive is built by the compiler's
   plain `agda` run under wasmtime in the Nix sandbox (`agdaWasm` in
   `flake.nix`).
+  **The standard library is 2.3, patched** as in [#61]'s row 2b
   (agda-stdlib's `agda-master` commits `1896499f` and `1b7f26af`, and
   `39631ce9` ported to 2.3), William's decision of 2026-10-07, and with
   two commits of its `master` branch, `fbf6ce16` and `b0d29e13`, without
   which `Data.Nat.Primality` does not check; built by the flake from the
   `v2.3` tag and `stdlib/patches/` (`packages.stdlib`).
+  **The 2.8.0 compiler stays pinned, unshipped** (`nix build
   .#compiler-2_8_0`), with its recipe, until the 2.9.0 compiler passes
   [#13]'s gate.

**Evidence**.  Measured 2026-10-07 on this workstation (20 cores, 64 GB,
Linux 7.0.0-31-generic); [#58]'s findings have each phase in full.

+  **Agda builds for WASI unpatched at the pin**: in Agda's own dev shell,
   an exploratory `wasm32-wasi-cabal build
   --index-state=2026-10-05T16:41:29Z -O2 --enable-split-sections
   exe:agda` took 19 min 23 s from an empty store, and `wasm-opt -Oz`
   (binaryen version_131) took its module from 107,483,009 to 34,277,999
   bytes.  The recipe's build, at its fixed path, is the pinned 34,277,969
   bytes (below): the module records the path it was built at.  Under
   wasmtime it reports "Agda version 2.9.0", checks a module of builtins
   with 4 `Checking` lines and then 1 over its own interfaces, and exits 42
   on a type error.
+  **Agda's own suites pass under it**: with the native `agda-tests` built
   by `cabal build -fdebug` (the workaround agda/agda#8756 suggests for the
   `make install-bin` its workflow uses, which fails at the pin) and
   `test/run-agda-wasm.sh`, Succeed passed 2,016 tests of 2,016, Fail 1,853
   of 1,853, and Common passed; Bugs passed 14 of 15, the one failure
   (`Issue8182`) a golden value that holds `-v` debugging output, which a
   build without Agda's `debug` flag does not print.
+  **The server's changes are local**: 10 source files and `package.yaml`,
   every change in a branch for Agda 2.9.0, and the patched server still
   builds against Agda 2.8.0 (natively, unoptimized, both).  Built for
   wasm32, the command module took 20 min 3 s (Agda again, as a package of
   the server's project) and the reactor then 13 s, since the flag changes
   only the server's own executable.  The pinned reactor, with its glue,
   ran `run_setup` (42 ms, 41 builtin sources written) and
   `new_language_server` under node 22.22.2's WASI.
+  **The recipe reproduces its bytes**: its first run, in `nix develop
   .#compiler`, built the four pinned files; a second, from an empty work
   directory at the same path (16:30 to 16:57 MDT, 26 min 49 s: the plain
   `agda` in 12 min 43 s from an empty cabal store, the command module in
   12 min 5 s, the reactor in 8 s), built the same four files and the same
   three build plans, byte for byte.  The pins:

| File | Bytes | SHA-256 |
|---|---:|---|
| `agda.wasm` | 34,277,969 | `da2f1efc6b13e0d8b8a69311511c8ed6fbfbc2759bd8ec299004580fcfba1eb1` |
| `als.wasm` | 35,880,158 | `b1f45936329c529b5677e38bc0e8d22d7a1c9c47277e8f77146f5667c76228e4` |
| `als-reactor.wasm` | 35,817,413 | `a0c7ae5741dd3f11c6be9e9fac4281889f2861ec2b53b5379452d11a4a23e8c9` |
| `als-reactor.js` | 5,044 | `c782dbaca349830299055c71ec9c4f72ec543c0d612d08b7c40fbb364e601dce` |

+  **And on GitHub's runner**: the CI job, on a runner with 2 cores and
   7.8 GiB of memory, built the same four files from the pins in 78
   minutes (the plain `agda` in 32 min 49 s, the command module in 34 min
   26 s), and its `sha256sum --check` passed (run 37708498495).  It needs
   swap: GHC's resident memory peaks at 8.95 GiB compiling Agda's library
   (measured here with GNU time), the run before was shut down in that
   build, and this one, with the 16 GiB swap file the job now adds, used up
   to 5.3 GiB of it.
+  **The page works on it**: the browser check passes on the built site
   (headless Chromium 149): the first check of the default `Main.agda`
   type-checks `Main` alone over the builtins the compiler's `agda` built,
   the give leaves one goal, the type error comes back in 2.9.0's words, and
   the status bar shows "Agda v2.9.0 Language Server v8 (WebAssembly
   build)".  Measured in one sitting against the 2.8.0 page (`main` at
   `c95f10c`), three fresh profiles each, every run started at a 1-minute
   load average of 1.48 to 1.69: "Agda ready" at 887 to 984 ms (2.8.0: 830
   to 862 ms); the first check done at 1,314 to 1,417 ms (1,265 to 1,322),
   325 to 337 ms by the page's own count (339 to 372); a give 453 to 483 ms
   (465 to 477); a warm reload checked at 901 to 953 ms (889 to 915).  A
   first visit fetches 25 files, 16,126,490 bytes against 15,724,238: the
   compiler's gzip is 964,398 bytes more (11,119,315), the standard library
   and the builtins 562,580 fewer, the page's own code 434 more (measured
   before the standard library's last two patches, which add 11 bytes to
   its archive).  On two copies of the site whose default `Main` imports
   every 2.9.0 builtin (the 35 plain ones in one, the 6 cubical ones in the
   other), the same check passes with `Main` alone checked: the server
   accepts all 41 interfaces the compiler's `agda` built.
+  **Agda 2.9.0's interfaces depend on the word size of the Agda that wrote
   them**.  agda/agda PR 8065 (2025-08-16) made the serializer write `Int`
   and `Word` at the machine's width, 8 bytes on x86-64 and 4 on wasm32,
   where 2.8.0's `Data.Binary` wrote a fixed width (which is why § 6's
   finding held).  The wasm32 Agda cannot decode a 64-bit Agda's interface
   and checks the module again, silently, or hangs reading a length it
   misdecodes; a native Agda reading a wasm32 interface stops with "Heap
   exhausted".  Measured under wasmtime with the compiler's `agda`: over
   builtins built by the nightly's static x86-64 binary at the same commit,
   a module importing three builtins checks four modules; over the same
   builtins built by the wasm `agda`, one.  A `Main` importing agda-algebras'
   `Overture.Basic` checks only `Main` over interfaces the wasm `agda` built,
   and all 66 modules over the same closure built natively.  [#59]'s spike
   saw the hang in the page, at 3.4 to 3.7 GiB.
+  **The patched standard library checks whole**: all of its 1,154
   modules check from source under the nightly at the pin (`agda
   --build-library`, exit 0, 108 s, the library's own 50 deprecation
   warnings); with row 2b's three patches alone the check stops 651
   modules in, at `Data/Nat/Primality.agda:214` (`InstanceNoCandidate`),
   since Agda 2.9.0's instance search no longer eta-expands a variable of
   a record type (agda/agda PR 8367), which the last two patches answer.
   Under the compiler's `agda`, `Data.Nat.Primality` checks from source
   (198 modules) and PLFA's `part1/Relations` too (30 modules).  The
   archive's sources are formalverification/agda-stdlib's tag
   `v2.3-agda-2.9.0` (`fb5d1840`), file for file.

**What 2.9.0 changed, as the page meets it**.

+  **The interaction protocol**: an error's text (a type error reads `The
   terms` / `0` / `and` / `1` / `are not equal at type Nat` where 2.8.0
   wrote `0 != 1 of type Nat`; the browser check now expects it); a give
   sent with `noRange` is answered `{"paren": false}` rather than with the
   expression reprinted, and the page inserts the expression it sent
   ([#59]'s spike); running info stays a string in the JSON encoding;
   `Cmd_constraints` takes a normalization level, and `GoalAndHave`,
   `NormalForm`, `InferredType` and `Mimer` answers carry more (Agda's
   changelog), none of which the page sends or reads.  The server answers
   in Agda's own JSON only when started with `--raw` (its PR 40), so the
   page now passes it.
+  **The interface format**: the version is 202610030, stored
   little-endian in bytes 16 to 23 of the header (2.8.0's 202507030 was
   big-endian), the payload is zstd where it was gzip, and its integers have
   the writer's word size (above).  Interfaces built by 2.8.0, such as
   PLFA's archives, live under `_build/2.8.0/` and are not read.
+  **The startup**: the controller ran `als --setup` for 2.9.0 as it did
   for 2.8.0, and the server reads `/lib/prim` as before; since 2026-10-08
   the reactor's `run_setup` does the same (§ 8).

**Status**.  Adopted on 2026-10-07 in [#58]'s pull request: the recipe,
the patches, the pins, the patched standard library, the builtins built
by the wasm `agda`, the page on the new compiler, and the CI job, which
built the pinned bytes on GitHub's runner.  The public repository for
the binaries exists since 2026-10-07, and CI fetches from it; the page has
run the reactor since 2026-10-08 (§ 8).  [#13]'s gate passes under 2.9.0
since 2026-10-12, on archives built by a wasm32 Agda (§ 10): the server
accepts every interface that agda-algebras' 350 roots (its modules, each
of which a reader may import) need.  Open: the move to
Agda's 2.9.0 release; the 2.8.0 compiler's pin, which row 22 kept until
that gate passed.

---

## 8.  The reactor and the drive in one worker

(See also [#59], [#58], [#50], [#6], and [`docs/notes/runtime.md`][note].)

**Decision**.  The page runs the language server's reactor build in one
worker with the drive, so that no memory is shared between threads and the
page needs no cross-origin isolation.

+  **The reactor**: the server built with its `reactor` flag (§ 7), which
   exports functions that JavaScript calls with one message each, through
   GHC's JavaScript FFI, where the command module blocked on standard
   input.  The worker drives it as [#59]'s spike found: the whole argv,
   the program's name first, given through WASI before `_initialize`
   (Runno's `initialize`), then `run_setup` (Agda's `--setup`),
   `new_language_server`, and `run_language_server` never awaited, with
   one `recv_message` always pending and each `send_message` chained on
   the last.
+  **The drive in the server's worker**: a file call is a function call
   on the same thread; the page's writes, the archives it mounts and the
   IndexedDB cache are functions of that worker, which run between the
   server's steps.  [#50]'s index moves unchanged.  The cache reads each
   dirty file from the drive's own record, so files at paths made after
   startup are persisted too, which the drive worker never did.
+  **No isolation**: the page allocates no `SharedArrayBuffer`; the
   isolation headers in `static/_headers` (its cache rules stay), the
   service worker `coi-serviceworker.js` with its script tag, the dev
   server's headers, and the checks of `crossOriginIsolated` in the page
   and the worker are removed.  So any static host serves the page ([#6]).
+  **What ships**: `als-reactor-2.9.0.wasm`, gzipped by the build, and its
   JavaScript glue, `als-reactor-2.9.0.js`, which the worker imports by
   its URL with a cache token rather than letting Vite bundle it, so that
   the file the page runs is the pinned file byte for byte and changes
   only with the module it was generated from.  The command module,
   `als.wasm`, stays pinned for the compiler's records and is not shipped.
+  **The version**: a reactor has no `--version`, and the server reports
   no version of its own, so the controller asks Agda with
   `Cmd_show_version` when the server is first ready, and the status bar
   shows Agda's answer, "Agda 2.9.0".
+  **No RTS options**: the fork's `+RTS -A64m -RTS` is removed (below).
+  **Agda's positions are read against the text it loaded**: the editor
   takes its text as Agda's only when the page sends `Cmd_load`, where it
   did so after every write to the drive (below).

**Evidence**.  Measured 2026-10-08 on this workstation (20 cores, 64 GB,
Linux 7.0.0-31-generic) in headless Chromium 149.0.7827.200 (the flake's),
a fresh profile per run, five per cell, the arms alternating, every run
starting below a 1-minute load average of 2 (0.66 to 1.97).  The stdio
arm is `main` at `5b9a5d6`, served with the isolation headers; the reactor
arm is this change at `e6be0a6`, served without them.  Both carry only the
controller's measuring hooks, both start the server with the fork's argv
(`--raw +RTS -A64m -RTS +AGDA --interaction -AGDA`), and both read the same
builtins, standard library and PLFA archives, so only the transport and
the startup differ.  Each command is timed from its send to Agda's
`ResponseEnd`; "Agda ready" is the status bar's, since navigation.  The
second root is a `Main` that imports 32 of the builtins.  Ranges, in ms,
with medians:

| root | arm | Agda ready | first check | give | warm reload |
|---|---|---:|---:|---:|---:|
| default | stdio, isolated | 901 to 916 (907) | 269 to 287 (279) | 14.4 to 23.2 (18.1) | 77 to 91 (77) |
| default | reactor, not isolated | 641 to 666 (650) | 242 to 259 (254) | 13.7 to 22.4 (19.7) | 70 to 72 (70) |
| 32 builtins | stdio, isolated | 906 to 931 (913) | 514 to 547 (520) | 16.8 to 22.8 (18.7) | 141 to 185 (154) |
| 32 builtins | reactor, not isolated | 646 to 684 (666) | 414 to 452 (416) | 17.9 to 25.6 (24.4) | 122 to 124 (124) |

+  **Every check type-checked what it should**: every first check and every
   warm reload, in both arms, printed one `Checking` line, `Main`.
+  **Startup**: "Agda ready" came about 257 ms sooner (medians 650 and 907
   ms).  The stdio build compiled its module once and instantiated and ran
   it three times (`--version`, `--setup`, the server) beside a second
   worker; the reactor is instantiated once.
+  **Warm reloads** were 9% faster on the default root and 19% on the
   larger (medians); [#59]'s spike measured 27% on its prototype.  A PLFA
   chapter, `Naturals`, five runs a cell: its first check, from source in
   both arms (PLFA's archives hold 2.8.0's interfaces, which 2.9.0 does
   not read; 31 modules), took 9,874 to 11,591 ms (10,410) against 9,295
   to 10,596 (9,514), and its warm reload, the chapter alone, 397 to 431 ms
   (412) against 301 to 350 (320), 22% faster, each by the page's own count.
   `scripts/benchmark-plfa.mjs`'s wall time from the key press was 931 to
   970 ms against 433 to 464, but most of that difference is the harness's
   own waiting: a trace of one run each saw "Checked" 446 and 391 ms after
   the key press.
+  **The give** is the same within the runs' spread.
+  **A drive call**: 20,000 `pathStat` calls on the root ([#50]'s paths,
   30% hits) took 0.19 to 0.21 µs each in four runs and 0.47 µs in a fifth,
   in the page's worker, against 17.1 to 20.1 µs through the proxy ([#50],
   2026-10-06) and 11.4 to 12.8 µs through it on [#59]'s spike.
+  **No isolation, in two browsers**: the browser check passes served
   without the headers (`crossOriginIsolated` false) and with them (true):
   in Chromium 149, in CI and here, and in Firefox 157 (Ubuntu's snap,
   headless, through WebDriver BiDi), 6 runs each way.  A control that
   serves the opposite of what the check expects fails both ways.
+  **The RTS options**: `-A64m` takes effect (the reactor's heap after a
   warm reload was 94 MiB with it and 24 MiB without on the default root,
   121 and 31 MiB on the larger), and made no check faster: warm reloads 68
   to 75 ms (70) with it and 64 to 74 (72) without, 118 to 127 (124) and
   113 to 116 (114) on the larger root, and PLFA's `Naturals` from source
   9,295 to 10,596 ms (9,514) and 9,400 to 10,335 (9,721).
+  **The commit point**: asked with the compiler's own `agda`, the default
   `Main.agda`'s goal 1 keeps its range, 303 to 320, after goal 0 is given
   and the text above it shrinks.  Upstream's controller took the buffer
   as Agda's after every write to the drive, the one that follows a give
   included; when that write completed before the give's interaction
   points arrived, their ranges fell past the end of the text, the mapping
   threw, the router's stream stopped, and the page hung.  In Firefox 157
   the browser check hung so 3 times in 8 runs, with the headers and
   without; with the commit at `Cmd_load` only, 0 times in 12, and 0 in 6
   in Chromium.
+  **The runs**: [#59]'s findings of 2026-10-08 carry the tables, the
   method and the load average of every run.

**Status**.  Adopted 2026-10-08 in [#59]'s pull request.  Open: archive
extraction runs on the server's thread and delays its next step (not
measured); the host is still [#6]'s to choose, now from any static host;
[#62]'s shared core takes this worker as its WebAssembly engine.

---

## 9.  Browsers

(See also [#8], [#59], and the README's "Browsers".)

**Decision**.  A browser that is hard to support is not supported: the page
says so when it cannot run there, and the documentation names the browsers
it is tested in, with no polyfill, shim or fallback (William, 2026-10-07).

+  **What the page checks**, before it starts Agda: module workers,
   `DecompressionStream`, and the five WebAssembly features the compiler
   uses, SIMD, reference types, bulk memory, sign extension and
   non-trapping float-to-int conversions (`src/lib/support.ts`).  IndexedDB
   is optional: without it the page runs, uncached.
+  **What it says**: a browser without one of them gets a notice naming
   what is missing and the browsers the page is tested in.  When a step of
   the startup fails (a request, the compiler's decompression or
   compilation, the drive, the setup), the page shows "Agda could not
   start:" and the step, and its heading and status bar say "Agda did not
   start", where the status bar said "Agda ready" with nothing checked.  A
   server that fails, or exits when the page did not ask it to, shows
   "Agda stopped" the same way.
+  **No fallback**: the page's fallback to the raw compiler, dead in the
   built site since decision 15, is removed; the dev server, which it
   served, serves the gzip itself.
+  **Tested**: Chromium 149, in CI and here, and Firefox 157, here, both
   on 2026-10-08, served with the isolation headers and without.  WebKit
   (Safari) is untested: none was at hand.

**Evidence**.

+  **The compiler's needs**: the reactor's `target_features` section names
   ten WebAssembly features; validated with each left out in turn
   (binaryen 132), it needs the five above and none of the others.  By
   WebAssembly's feature table and MDN's compatibility data (read
   2026-10-08 and 2026-10-05), the page's needs first coincide in Chrome
   96, Firefox 114 and Safari 16.4.  So the browsers decision 15 weighed,
   Safari 15.2 to 16.3, which lack `DecompressionStream`, lack SIMD too:
   the raw compiler could not have run there either.
+  **The notices are tested**: `scripts/browser-check/notices.mjs`, in CI,
   checks a browser without `DecompressionStream` (removed before the page
   loads), a compiler request answered 404, a compiler that is not a gzip,
   and a standard library whose transfer breaks off; all four pass in
   Chromium 149 and Firefox 157.  Against a build of the commit before
   [#8]'s change, the first three fail, the first two showing "Agda ready |
   0 goals" after 60 s, the silence [#8]'s comment of 2026-10-05 found; the
   fourth, added in review, fails against the commit before it, with the
   browser's error and no file named.  A server that exited when the page
   had not asked it to left "Agda ready" on screen; it now shows "Agda
   stopped: the language server exited with code 0." (an LSP `exit` sent
   without `shutdown`, checked through an instrumented build).
+  **IndexedDB is optional**: with `indexedDB` removed from the worker's
   global before it ran, or replaced by one whose `open` throws at once,
   the page checked and reloaded `Main.agda`, and no
   cache database was made; with it, the database was made.

**Status**.  Adopted 2026-10-08 ([#8]).  Open: WebKit.

---

## 10.  The library archives

(See also [#12], [#13], [#14], [#61], [#11], and
[`docs/notes/library-archives.md`][archives-note].)

**Decision**.  agda-algebras' interfaces, and those of the standard-library
modules it imports, are built in the Nix sandbox by the compiler's plain
`agda.wasm` under wasmtime, over a stage laid out as the page's drive, and
packed into stored zips so that the archives an import needs hold its
closure's interfaces and nothing else, with an index taken from Agda's own
dependency graph.  An *interface* is the file Agda writes for a checked
module and reads in place of checking it again; a module's *closure* is
every module it imports, directly or not, itself included.

+  **Built by the page's Agda, at the page's paths**: the compiler's
   `agda.wasm` (decision 20), run with a directory laid out from the
   archives the page mounts (`agda-data.zip`, the standard library's
   archive, agda-algebras' sources) as the guest's root, `HOME=/home/root`
   and `Agda_datadir=/`, as the page's server.  `nix build
   .#agda-algebras-interfaces` builds them, `.#agda-algebras-archives`
   packs them, and `.#agda-algebras-check` checks them.
+  **What is built**: every module of agda-algebras' include path,
   `Legacy/` included (350 at `f067d57d`), with `agda --build-library`,
   which finds them itself in a fixed order; and the standard-library
   modules they import (251 of 1,154), not the whole library.
+  **The pin**: agda-algebras at `f067d57d` (its master on 2026-10-10), a
   `fetchFromGitHub` with its hash beside the standard library's source in
   `flake.nix`, so a move is one edit and leaves `flake.lock` alone.  Its
   sources ship as their own archive, `agda-algebras-sources.zip`, beside
   the standard library's, mounted at `/agda-algebras`.
+  **The packing**: one archive per agda-algebras module; the
   standard-library modules grouped by the set of agda-algebras modules
   that reach them, one archive per group.  A group is needed whole or not
   at all by any set of agda-algebras imports, so nothing is fetched beyond
   the closure but zip headers.  Stored, since the interfaces' payload is
   zstd already; every file under 25 MiB.
+  **The index**: `index.json` beside the archives, schema 1: the Agda
   version and the `agda.wasm` digest, the libraries with their pins and
   paths, the roots, every archive with its bytes and SHA-256, and every
   module with its paths, its archive and its successors in Agda's
   transitively reduced graph, whose reachability is exact.  Closures come
   from that graph, never from the sources.
+  **The check**: every root, on a fresh stage holding only the archives
   the index names for it, type-checks a `Main` importing it with exactly
   one `Checking` line; two controls must print more.
+  **CI**: a job of its own, path-filtered on what the archives are built
   from and what the gate below is made of, which builds nothing when the
   check's derivation is the base's and the gate's code is unchanged; it
   builds, rebuilds, packs and checks when the derivation changed, and
   builds the archives and runs the gate alone when only the gate's code
   did.  It reads the public
   `formalverification` Cachix cache and pushes to it from `main` only.
   The site carries none of it until [#14] mounts the archives.
+  **The gate** ([#13]): the check again under the language server the
   site ships, its reactor, in headless Chromium, through the engine's
   browser transport: every root in a fresh session holding only the
   archives the index names for it must type-check `Main` alone, with no
   error, and the same two controls must type-check more.  A *session*
   (one engine: a worker, its drive and its reactor) per root, not one
   shared by the roots that each of the checks run at once takes in turn,
   since a shared session's drive holds earlier roots' archives and Agda
   keeps what it decoded, so it could not show that a root needs only its
   own.  The same job runs it, every root, when the archives' derivation
   changed or the gate's code did (its app's store path, the engine's core
   and browser transport, its page, the lockfile, the `Makefile`).
+  **The drive's libraries** ([#13]): the engine lays the drive out from a
   list of libraries (`BrowserConfig.archives.libraries`), each a zip
   extracted at the root with its `.agda-lib` path and its name, and writes
   Agda's libraries and defaults files from it after the standard library;
   the page passes PLFA as its one entry.  A *root library* (a project's
   own `.agda-lib`, here `/play/play.agda-lib`) is the host's to write.
+  **Licenses**: agda-algebras' interfaces are Apache-2.0, like its
   sources, since an interface holds its module's source text; the index
   is data under agda-algebras' `LICENSE-data` (Apache-2.0 or CC0-1.0); the
   standard library's interfaces are MIT.

**Evidence**.  Measured 2026-10-11 on this workstation (20 cores, 64 GB,
Linux 7.0.0-31-generic) and on GitHub's runner; [#12]'s findings of that
date have the runs, and `docs/measurements/library-archives-2026-10-11.json`
the local ones.

+  **The build**: in the sandbox, `--build-library` checked all 350 modules of
   agda-algebras and 251 of the standard library, and no builtin (their
   interfaces from `agda-data.zip` were accepted), in 5 min 54 s to 6 min 59 s
   on a quieter machine and 10 min 27 s to 12 min 27 s on a loaded one,
   holding 995 MiB of GHC's total memory in use, a quarter of a wasm32 heap's
   4 GiB.  wasmtime's compile of `agda.wasm`, once per derivation, is the
   peak: 4.4 GiB for 14 to 23 s.
+  **Reproducible**: six builds wrote the same bytes, one of them outside the
   sandbox at a host path, the third by `--rebuild`, and `--rebuild` of the
   archives passes; a timestamp written into the output makes it fail.  Every
   build sees the guest's paths, but the order still matters: built through a
   generated `Everything.agda`, the same inputs gave 600 of 601 interfaces
   identical and the umbrella module `agda-algebras` with 70 more deprecation
   warnings stored (314,087 bytes against 284,544).
+  **The packing**: 395 archives, 70,104,812 bytes, the largest 6,965,690.
   `Setoid.Varieties.HSP` needs 128 of them, 39,251,541 bytes against a floor
   of 39,186,131; [#12]'s 2.8.0 tiers, on the same interfaces, fetch
   15,858,563 bytes for `Overture.Basic` against a floor of 4,306,193.
   Compression buys 0.09% (the payload is zstd).
+  **The check**: 350 of 350 roots type-checked `Main` alone, eight at once
   in 7 min 21 s; the two controls printed 2 `Checking` lines each.
+  **On the runner** (2 cores, 7.8 GiB; run 38153481044): `--build-library`
   in 10 min 33 s (981 MiB), its `--rebuild` passed, and the check, two at
   once, in 30 min 6 s, 350 of 350; the whole job 58 minutes, no swap used.
   Its index is byte-identical to the one built here, so all 395 archives
   reproduce across machines.  A push that left the check's derivation as
   it was built nothing, in 21 s.
+  **The gate** (2026-10-12, headless Chromium 149, this workstation, four
   at once, with other sessions' builds beside it;
   `docs/measurements/library-archives-browser-2026-10-12.json`): 350 of
   350 roots type-checked `Main` alone under the server, which reports
   Agda 2.9.0, in 12 min 49 s; the controls printed 2 `Checking` lines
   each, and archives with `Overture.Basic`'s emptied failed it and its
   importer, exit 1.  Agda's load took a median 7.9 s, the slowest 16.8 s;
   the umbrella module 15.0 s at a heap of 735,248,384 bytes, a sixth of a
   wasm32 heap.  Summed over the roots, 3,020 s, of which the sessions'
   starts were 313 s.  A session shared by each of the four checks run at
   once took 85 s, its heaps ending at 844,693,504 to 906,166,272 bytes,
   so the heap did not decide between them.  On GitHub's runner (4 cores;
   run 38209105006, dispatched on [#13]'s branch), 350 of 350 and the
   controls 2 and 2; four at once each, the check under `agda.wasm` summed
   2,498 s and the gate's loads 3,369 s (3,908 s with the starts and
   mounts), so the browser takes 1.3 to 1.6 times wasmtime's time.  Over
   that run and the pull request's two, the gate's step took 17 min 18 s
   to 23 min 56 s, and the whole job 49 min 0 s to 66 min 28 s (runs
   38209105006, 38213187621, 38243413321).  After the branch was rebased
   onto [#64]'s engine, the gate gave the same counts at 495a793.
+  **The drive's libraries** (2026-10-12): unit tests pin the registry the
   drive writes (the standard library alone, with PLFA as the page has it,
   with two libraries, with none) and a failed fetch's words; the page's
   browser check, both ways, its notices and the browser's conformance
   suite passed in `site.yml` on this branch (run 38243413314), and the
   suite on both engines here; with the PLFA archive removed from a copy
   of the site, the page still says "PLFA could not be downloaded (HTTP
   404 Not Found)".

**Status**.  Adopted 2026-10-11 in [#12]'s pull request; the gate and the
drive's list of libraries 2026-10-12 in [#13]'s.  The site ships the
sources archive since [#11]'s pull request, for the playground's project
(§ 11).  Open: mounting the interface archives in the page, their cache
and their license notice ([#14]); the benchmark over these roots ([#18]);
the cache's write token, without which `main` pushes nothing, so a change
to the gate alone builds the interfaces again.

---

## 11.  The playground's project

(See also [#11], [#13], [#14], [#16], and
[`docs/notes/runtime.md`][note]'s "The playground's project".)

**Decision**.  The playground's `Main.agda` is a module of a project of its
own, `/play/`, whose library depends on the standard library and
agda-algebras, under agda-algebras' own options line, so that a postulate
or a `TERMINATING` pragma is refused there as the library refuses it.  The
*playground* is the page's scratch buffer, which the agda-algebras site's
"Playground" link opens; a *root library* is a project's own `.agda-lib`.

+  **The layout**: `/play/Main.agda` beside `/play/play.agda-lib`
   (`name: play`, `depend: standard-library-2.3 agda-algebras`, `include:
   .`), as `stage.sh` writes it and the gate checks every root under;
   agda-algebras' sources archive in the drive's list of libraries, at
   `/agda-algebras`, before PLFA's, which stays at the root for its
   chapters.
+  **The site ships the sources archive**, `agda-algebras-sources.zip`,
   built by the flake from the pinned commit (decision 31), checked by
   `make assets-check`, with a cache token, in the drive cache's
   namespace, and in `NOTICE` under Apache-2.0.
+  **The host names the drive's first files**: the engine lays out the
   files the host names (`BrowserConfig.files`), after the archives and
   inside the transport's root, where it held an empty `/Main.agda`; the
   page names `play.agda-lib`.
+  **The default `Main`** carries `{-# OPTIONS --without-K --exact-split
   --safe #-}`, imports only builtins, whose interfaces the site ships,
   and opens one goal on the first screen; after a load that leaves goals,
   the page asks for the selected goal's context and shows it with the
   goal.
+  **The stored buffer's key is named by its path**,
   `agda-web-ide-beta:doc:/play/Main.agda`; nothing migrates from the old
   key, since nothing is deployed.

**Evidence**.  Measured 2026-10-12 on this workstation in headless
Chromium 149, with other sessions' builds beside it (load 1.4 to 10);
`docs/measurements/playground-2026-10-12.json` has the runs.

+  **The browser check** passes on the new default: `Main` alone
   type-checked, one goal with its type and its twelve context entries,
   Infer, the give that closes the goal, a type error, a postulate refused
   with `[SafeFlagPostulate]` at its position, and `import
   Overture.Signatures` type-checked from source with its 10
   standard-library modules.  Three controls, each restored afterward,
   fail it: the default without `--safe` (the postulate is accepted),
   agda-algebras left off the drive (the first check fails with Agda's
   `[LibraryError]`, "Library 'agda-algebras' not found"), and no context
   read after a load.
+  **Which flags reach `Main`**: only its own line and its library's
   `flags:`; `--safe` in the standard library's `flags:` left a postulate
   in a play module accepted, and in `play.agda-lib` refused it (native
   Agda 2.9.0 at the compiler's commit).
+  **What it costs**: one more request on a first visit, 985,864 bytes;
   the first check of the default 0.40 s against 0.27 s for the previous
   default (medians of five alternating runs on a quiet machine; the ratio
   held under load); `open import Setoid.Algebras.Basic`, 170 modules from
   source, 1 min 38 s to 6 min 32 s cold over six runs (median 2 min 35 s)
   and 3.3 to 11.9 s after a reload, against 3.7 s from its 50 archives
   (decision 38's gate), which still type-check `Main` alone with PLFA's
   library on the drive.
+  **The engine** passes the conformance suite, 12 of 12 on both engines
   and identical, after the change to the drive's first record.

**Status**.  Adopted 2026-10-12 in [#11]'s pull request.  Open: mounting
the interface archives an import needs, with consent and a cache ([#14]);
the three exercises, which land in `/play/` beside `Main` ([#16]).

---

## 12.  Decision log

| # | Decision | Status | Evidence |
|---|---|---|---|
| 1 | Fork plfa-playground whole, not als-demo or the plain checker; keep its two workers, transport, give rule, archive format and persistence | Adopted ([#2]); its two workers and their shared memory superseded by row 23 | als-demo sends only `Cmd_load`; the fork builds, tests and checks `Main.agda` here (§ 3) |
| 2 | Import a snapshot of `ae0aa84c`, 89 files byte for byte, with a per-file SHA-256 record; no history merge | Adopted ([#2]; the plan's wording changed to match, 2026-10-05) | 67 binary blobs, 171,397,049 bytes, in upstream's history; blob ids equal |
| 3 | Keep upstream's colliding files at new paths (`README.plfa-playground.md`, `LICENSE.plfa-playground`, `app.yml`); merge its `.gitignore`; leave out `wrangler.jsonc` | Adopted ([#2]); `app.yml` later replaced by `site.yml` ([#5]) | `docs/provenance.md` |
| 4 | Every change to an imported file is its own commit, with a header comment or a provenance row, and leaves `upstream/unchanged.sha256` | Adopted ([#2]) | `make provenance-check` |
| 5 | Sync file by file from the record, with `git merge-file` for changed files | Adopted ([#2]) | Rehearsed on a constructed later commit (§ 2) |
| 6 | Pin upstream's binaries by SHA-256 (36; 35 since [#49] builds the builtins), one fixed-output fetch per file; check the pinned files in `static/` before every build | Adopted (part of [#4]) | A changed pin fails the fetch; a flipped byte fails the build (§ 3) |
| 7 | Do not pin upstream's compiler gzip | Adopted | The build writes its own, and since [#8] the dev server serves one; the raw fallback is removed (§ 3, rows 15 and 27) |
| 8 | Node 22 in the dev shell | Adopted (part of [#3]) | 22.22.2, inside upstream's engines range |
| 9 | `NOTICE` plus `licenses/`, published as `NOTICE.txt` and `licenses/`; upstream's `NOTICE.md` removed | Adopted ([#48]) | Every text read at its source (§ 4) |
| 10 | GMP under LGPL-3.0-or-later, relinking met by the pinned sources and the recipe | Adopted (William, 2026-10-07, [#53]'s comment) | Each public release of the compiler carries GMP's source and GHC's patches (§ 4) |
| 11 | The Agda mark stays, under Agda's MIT license | Adopted ([#48]) | `Agda.cabal`'s `extra-doc-files` |
| 12 | The plain checker is the planned verdict of record, not adopted here | Recorded ([#30]) | PR 585: no isolation; JSPI 1.45 s reloads, 45 to 55 ms queries |
| 13 | Native interfaces are accepted; the drive is the cost; the builtins were stale, and are built since by the flake, from the Agda the server embeds | Settled; the builtins' fix adopted ([#49], 2026-10-06) | [#13], [#50], [#49]; § 6 |
| 14 | The open license questions wait until before the repository goes public; the notice stands as written meanwhile | Adopted (William, 2026-10-05; [#53]) | § 4 |
| 15 | The built site does not ship the raw compiler; the page's silence without it is proposed for [#8] | Adopted ([#3], 2026-10-05); the silence answered by row 27 | Only Safari 15.2 to 16.3 could use it; 33 MB a deploy; Cloudflare Pages' 25 MiB file limit (§ 3) |
| 16 | The compiler is this repository's build: Agda 2.9.0 at `da66a8c7` and the language server `v8` with two patches, for wasm32-wasi, with ghc-wasm-meta `58260711` and the Hackage index pinned; no agda-web patch | Adopted ([#58], 2026-10-07) | Agda's suites pass under it; the server needed 21 version-guarded branches; the browser check passes (§ 7) |
| 17 | The recipe is a script in a pinned dev shell and an optional CI job; `nix build .#compiler` fetches its four files by hash | Adopted ([#58]; its first criterion reworded) | Two Agda builds, 27 minutes from empty on 20 cores and 78 on GitHub's 2-core runner, which needs swap; a second run here and the runner built the same bytes (§ 7) |
| 18 | Built without `use-xdg-data-home`: the data directory is `Agda_datadir` itself | Adopted ([#58]) | The page's layout and `agda-data.zip`'s root unchanged (§ 7) |
| 19 | The binaries live in releases of a public repository of this organization | Decided by William, 2026-10-07; created the same day, formalverification/agda-wasm-builds | Its release `agda-2.9.0-da66a8c-als-8` holds the four pins, and CI fetches from it (§ 7) |
| 20 | Every interface the page ships is built by a wasm32 Agda; the builtins by the compiler's `agda` under wasmtime | Adopted ([#58]) | Agda 2.9.0 writes interfaces at its word size: native interfaces are checked again, or hang (§ 7) |
| 21 | The page ships the standard library 2.3 patched as in [#61]'s row 2b, with two later fixes from agda-stdlib's `master` | Adopted (William, 2026-10-07; the two fixes the same day) | No released version checks under 2.9.0 ([#61]); with the five patches the whole library checks (§ 7) |
| 22 | The 2.8.0 compiler stays pinned, unshipped, with its recipe, until the 2.9.0 one passes [#13]'s gate | Adopted ([#58]); the gate passes since 2026-10-12 (row 38), so its removal is open | `nix build .#compiler-2_8_0` (§ 7) |
| 23 | The runtime needs no cross-origin isolation: the page runs the server's reactor build in one worker with the drive, sharing no memory; the headers, the service worker and both checks are removed | Adopted ([#59], 2026-10-08) | The browser check passes with the headers and without, in Chromium 149 and Firefox 157; "Agda ready" 650 against 907 ms, warm reloads 9 to 22% faster, a drive call 0.2 µs against 11 to 20 µs (medians; § 8) |
| 24 | The site ships the reactor and its glue, the glue imported by its URL, not bundled; the command module stays pinned, unshipped | Adopted ([#59]) | The shipped glue is the pinned file (`make assets-check`); NOTICE § 3 from the reactor's own plan, 141 packages (§ 8) |
| 25 | The status bar shows Agda's own version, asked with `Cmd_show_version` when the server is first ready | Adopted ([#59]) | The reactor has no `--version`, and the server sets no `serverInfo`; the browser check asserts "Agda 2.9.0" (§ 8) |
| 26 | The server starts with no RTS options: the fork's `+RTS -A64m -RTS` is removed | Adopted ([#59]) | It takes effect (a heap of 94 against 24 MiB) and made no check faster (§ 8) |
| 27 | A browser that is hard to support is not supported: the page checks what it needs, names what is missing and the browsers it is tested in, and shows a failure to start; no polyfill, shim or fallback | Adopted (William, 2026-10-07; [#8], 2026-10-08) | Four notices tested in CI, failing against the page before; the needs first coincide in Chrome 96, Firefox 114 and Safari 16.4 (§ 9) |
| 28 | The editor takes its text as the one Agda's positions refer to only when the page sends `Cmd_load` | Adopted ([#59]) | Agda keeps a goal's loaded range after a give; the old commit point hung 3 of 8 runs in Firefox, the new none of 18 (§ 8) |
| 29 | agda-algebras' interfaces are built in the Nix sandbox by the compiler's `agda.wasm` under wasmtime, over a stage laid out as the page's drive from the archives it mounts, mounted as the guest's root | Adopted ([#12]) | 350 + 251 modules checked, no builtin; the interfaces land where the server looks; Agda 2.9.0 interfaces do not cross word sizes (row 20) (§ 10) |
| 30 | Every module of agda-algebras' include path is built, with `agda --build-library`; the standard library only as far as it is imported | Adopted ([#12]) | `--build-library` sorts its paths, so its order is fixed; 995 MiB of a 4 GiB heap; the standard library's other 903 modules are not needed (§ 10) |
| 31 | agda-algebras is pinned by `fetchFromGitHub` in `flake.nix`, at `f067d57d`; its sources ship as their own archive, beside the standard library's, at `/agda-algebras` | Adopted ([#12]) | Like the standard library's pin, one edit; `flake.lock` untouched; the sources archive is 985,864 bytes and changes only with agda-algebras (§ 10) |
| 32 | One archive per agda-algebras module; standard-library modules grouped by the agda-algebras modules that reach them; stored zips, each under 25 MiB | Adopted ([#12]); supersedes [#12]'s 2.8.0 tiers | Any set of agda-algebras imports fetches its closure and zip headers: the HSP root 39,251,541 bytes against 39,186,131; the 2.8.0 tiers fetch 15.9 MB for `Overture.Basic` against 4.3 MB (§ 10) |
| 33 | The index is JSON beside the archives, schema 1, its closures from Agda's `--dependency-graph` | Adopted ([#12]) | Agda's graph is built from the interfaces' imports and reduced transitively, so reachability is exact; a regular expression misses nested imports ([#12], 2026-10-04) (§ 10) |
| 34 | Every root is checked cold from the archives the index names, exactly one `Checking` line, with two controls that must fail | Adopted ([#12]) | 350 of 350, here and on GitHub's runner; the controls print 2 lines each (§ 10) |
| 35 | CI builds, rebuilds, packs and checks them in a job of its own, path-filtered, and skipped when the check's derivation is the base's and the gate's code is unchanged (row 39); it reads the `formalverification` Cachix cache and writes it from `main`; the site does not carry them until [#14] | Adopted ([#12]; the cache and the rebuild on pull requests, William, 2026-10-11, the repository public) | 58 minutes on a 2-core runner, uncached; 21 s when nothing changed (§ 10) |
| 36 | agda-algebras' interfaces are Apache-2.0 like its sources, not `LICENSE-data`'s extracted data; the index is `LICENSE-data`'s | Adopted (William, 2026-10-11, on the session's recommendation) | A 2.9.0 interface holds its module's source text (`iSource`); `LICENSE-data` excludes the sources in whole or in part (§ 10) |
| 37 | The engine lays the drive out from a list of libraries (archive, `.agda-lib`, name) and writes Agda's registry from it; the page passes PLFA as one; a root library is the host's | Adopted ([#13]) | One registry written at startup held only the standard library and PLFA ([#11], 2026-10-04); the registry pinned by unit tests, and the page's browser check, notices and conformance suite passing on it (§ 10) |
| 38 | Every root of agda-algebras is checked under the site's reactor in headless Chromium, each in a fresh session with only its archives, exactly one `Checking` line, with two controls that must fail | Adopted ([#13]) | 350 of 350, 12 min 49 s four at once here; the controls 2 and 2; a shared session per job took 85 s but cannot show a root needs only its own archives (§ 10) |
| 39 | CI runs the gate in the archives' job, every root, when the archives' derivation or the gate's code changes | Adopted ([#13]) | On the 4-core runner the gate's step took 17 min 18 s to 23 min 56 s, 350 of 350, in jobs of 49 to 66 minutes (runs 38209105006, 38213187621, 38243413321); it runs only when its own inputs change, so pull requests need no subset of the roots (§ 10) |
| 40 | The playground's `Main` is `/play/Main.agda` in a project of its own, `play.agda-lib` depending on the standard library and agda-algebras; the site ships agda-algebras' sources archive, mounted at startup beside PLFA's | Adopted ([#11]) | The gate's layout; without agda-algebras on the drive the default fails with `[LibraryError]`; one more request, 985,864 bytes (§ 11) |
| 41 | The engine lays out the files the host names in place of an empty `/Main.agda` of its own | Adopted ([#11]) | The conformance suite 12 of 12 on both engines and identical; a file outside the root is refused before anything is fetched (§ 11) |
| 42 | The default `Main` carries agda-algebras' options line, imports only builtins, and opens one goal, whose context the page shows after the check | Adopted ([#11]) | `Main` alone type-checked; a postulate refused with `[SafeFlagPostulate]`; controls without `--safe` and without the context read fail the browser check (§ 11) |
| 43 | The stored buffer's key is named by its path, with no migration from the old key | Adopted ([#11]) | Nothing is deployed, so no reader holds a document under the old key (§ 11) |

---

## References

+  **Issues**: [#2] (the fork), [#3] (the Nix build), [#4] (the pins), [#5]
   (CI), [#6] (hosting), [#7] (this record), [#8] (the page's notices, once a
   page that could not isolate itself), [#11] (the playground's project,
   § 11), [#12] (the library archives, § 10), [#13] (interface acceptance),
   [#14] (mounting the archives), [#16] (the exercises), [#18] (the
   benchmark), [#20] (PLFA's removal), [#30] (the second lane), [#48] (the
   notice), [#49] (the builtins), [#50] (the drive), [#53] (the license review
   before going public), [#58] (the 2.9.0 compiler), [#59] (the reactor),
   [#61] (the library under 2.9.0), [#62] (the shared core), [#64] (the
   native engine).
+  **Elsewhere**: agda-algebras PR [585][pr-585] and its [ADR-011][adr-011];
   agda-native-air's [browser IDE proposal][proposal]; [plfa-playground][upstream]
   at `ae0aa84c`.
+  **Documents**: [`docs/notes/runtime.md`][note] (how the runtime works),
   [`docs/notes/library-archives.md`][archives-note] (the library
   archives), `docs/measurements/library-archives-2026-10-11.json` (their
   runs), `docs/measurements/library-archives-browser-2026-10-12.json`
   (the gate's) and `docs/measurements/playground-2026-10-12.json` (the
   playground's), [`docs/provenance.md`][provenance] (the record),
   [`NOTICE`][notice].
+  **Code**: `flake.nix` (`packages.assets`, the pins; `packages.site`;
   `apps.browser-check`; `packages.compiler`, `packages.stdlib`,
   `packages.compiler-2_8_0`, `devShells.compiler`, `agdaWasm`),
   `compiler/build-agda-2.9.0.sh` with `compiler/patches/` and
   `compiler/agda-2.9.0.sha256`, `stdlib/patches/`,
   `.github/workflows/compiler.yml`, `Makefile` (`assets`, `assets-check`,
   `dev`, `build`, `test`, `check`, `browser-check`,
   `browser-check-notices`, `provenance-check`, `library-gate`),
   `upstream/` (the records),
   `scripts/upstream-record.sh`, `scripts/asset-manifest.mjs` and
   `src/lib/assets.ts` (the derived cache tokens),
   `packages/engine/src/browser/worker/als.ts` and `drive.ts` (the reactor
   and the drive, in `src/lib/worker/` until [#62]),
   `src/lib/support.ts` (what the page needs), `scripts/browser-check/`
   (`run.mjs`, `notices.mjs`, `cdp.mjs`, `bidi.mjs`),
   `.github/workflows/site.yml`; for the playground's project,
   `PLAYGROUND` and the drive's libraries in `src/lib/controller.svelte.ts`,
   `DEFAULT_SOURCE` in `src/routes/+page.svelte`, `BrowserConfig.files` in
   `packages/engine/src/browser/index.ts` with `layOutDrive` in its
   worker's `drive.ts`, and `mkAgdaAlgebrasSources` in `flake.nix`, which
   `packages.assets` installs; for the library archives,
   `packages.agda-algebras-interfaces`, `-archives` and `-check` in
   `flake.nix` (`agdaAlgebras`, the pin), `scripts/library-archives/`
   (`stage.sh`, `build.sh`, `pack.mjs`, `index.mjs`, `check.sh`, and the
   gate, `gate.mjs` and `gate/`, with `apps.library-gate`) and
   `.github/workflows/library-archives.yml`.

[#2]: https://github.com/formalverification/agda-native-ide/issues/2
[#3]: https://github.com/formalverification/agda-native-ide/issues/3
[#4]: https://github.com/formalverification/agda-native-ide/issues/4
[#5]: https://github.com/formalverification/agda-native-ide/issues/5
[#6]: https://github.com/formalverification/agda-native-ide/issues/6
[#7]: https://github.com/formalverification/agda-native-ide/issues/7
[#8]: https://github.com/formalverification/agda-native-ide/issues/8
[#11]: https://github.com/formalverification/agda-native-ide/issues/11
[#12]: https://github.com/formalverification/agda-native-ide/issues/12
[#13]: https://github.com/formalverification/agda-native-ide/issues/13
[#14]: https://github.com/formalverification/agda-native-ide/issues/14
[#16]: https://github.com/formalverification/agda-native-ide/issues/16
[#18]: https://github.com/formalverification/agda-native-ide/issues/18
[#20]: https://github.com/formalverification/agda-native-ide/issues/20
[#30]: https://github.com/formalverification/agda-native-ide/issues/30
[#48]: https://github.com/formalverification/agda-native-ide/issues/48
[#49]: https://github.com/formalverification/agda-native-ide/issues/49
[#50]: https://github.com/formalverification/agda-native-ide/issues/50
[#53]: https://github.com/formalverification/agda-native-ide/issues/53
[#58]: https://github.com/formalverification/agda-native-ide/issues/58
[#59]: https://github.com/formalverification/agda-native-ide/issues/59
[#61]: https://github.com/formalverification/agda-native-ide/issues/61
[#62]: https://github.com/formalverification/agda-native-ide/issues/62
[#64]: https://github.com/formalverification/agda-native-ide/issues/64
[pr-585]: https://github.com/ualib/agda-algebras/pull/585
[adr-011]: https://github.com/ualib/agda-algebras/blob/577-an-interactive-agda-proof-environment/docs/adr/011-interactive-playground.md
[proposal]: ../notes/browser-ide-proposal.md
[upstream]: https://github.com/SeungheonOh/plfa-playground
[note]: ../notes/runtime.md
[archives-note]: ../notes/library-archives.md
[recipe]: ../../compiler/build-agda-2.9.0.sh
[provenance]: ../provenance.md
[notice]: ../../NOTICE
