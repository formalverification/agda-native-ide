<!-- File: docs/notes/runtime.md -->

# How the runtime works

This note explains the runtime the IDE forks from plfa-playground: the two
workers, the transport between the page and the language server, the
in-memory drive, and the rule that decides between a give and a full check.
[ADR 0001][adr] records the decisions about it; this note is the explanation
the ADR links.  Every line reference is to this repository's copy of the
fork: upstream's `ae0aa84c`, with the changes `docs/provenance.md` lists;
of those, only the derived `?cache=` tokens, the drive's cache namespace,
the drive's index, the builtins' archive, and the compiler and standard
library of Agda 2.9.0 ([#58]) touch what this note describes, and each is
explained where it arises.  The facts come from
reading that source, and the measurements from the issues that record
them (their findings sections condense the 2026-10-04 investigation of
the fork).

## The pieces

The page runs three threads.

+  **The main thread** holds the editor (CodeMirror 6), a language-server
   client (`@codemirror/lsp-client`), and the controller
   (`src/lib/controller.svelte.ts`), which owns the state the page shows:
   the goals, the problems, the inspector's results.
+  **The language-server worker** (`src/lib/worker/als.ts`) compiles
   `als-2.9.0.wasm`, the Agda Language Server built for WASI (the
   WebAssembly System Interface, the POSIX-like set of imports a WebAssembly
   program uses to reach files and streams), and runs it under the WASI
   implementation `@runno/wasi` 0.10.0.  The language server embeds Agda
   2.9.0 and runs it in its JSON interaction mode.  It is this
   repository's build, from agda/agda-language-server `v8` and Agda's own
   sources, with two patches (`compiler/build-agda-2.9.0.sh`, [#58]); the
   fork shipped agda-web's build for Agda 2.8.0, `als-2.8ext.wasm`.
+  **The drive worker** (`src/lib/worker/drive.ts`) owns the in-memory
   filesystem Agda reads and writes: the user's buffer, Agda's builtin
   library, the standard library, PLFA, and the interfaces Agda produces.

Both workers are module workers that Vite inlines and emits as separate
files (`src/lib/index.js:155` and `:193`), loaded relative to the bundle, so
they work under any base path.

## Shared memory, and why the page must be isolated

The language server is a blocking program: GHC's runtime waits on standard
input, and every file operation is a synchronous WASI call.  The workers
make that work with shared memory.

+  **Agda's standard input and output** are single-producer,
   single-consumer ring buffers (the `spsc` package) of 4 KiB each, over a
   `SharedArrayBuffer`.  The worker's patched `poll_oneoff` waits on the
   input ring with `Atomics.wait` (`als.ts:190-195`, through the `spsc` reader's `pollRead`).
+  **Every filesystem call** the WASI shim makes is proxied to the drive
   worker through two 1 MiB rings, under a 4-byte mutex taken with
   `Atomics.compareExchange` and `Atomics.wait`
   (`src/lib/worker/proxy-wasi-drive.ts:78-98`).  The page allocates all of
   these when its component is created (`src/routes/+page.svelte:102-113`).

Browsers expose `SharedArrayBuffer` only to a cross-origin isolated page:
one served with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`).  The
worker refuses to start otherwise (`als.ts:28-30`).  The fork meets the
requirement three ways:

+  **real headers**: upstream's Cloudflare deployment sends them from
   `static/_headers`, and the Vite dev and preview servers add them
   (`vite.config.js`, the `coi-plugin`);
+  **a service worker**: `static/coi-serviceworker.js` re-serves the page
   with the headers on a host that cannot set them, at the cost of one
   reload on a first visit, and with a race that left some measured first
   visits unisolated ([#6]);
+  **nothing else**: without isolation the page throws when it allocates
   its buffers, before its own check (`+page.svelte:452`) can explain why
   ([#8]).

The plain Agda checker of the second lane needs none of this (ADR 0001,
"The second lane"): it runs as one batch process per command, so nothing
blocks on memory another thread writes.

## Startup

`runALSWASM` (`controller.svelte.ts:420-504`) starts the runtime.

1. It starts the language-server worker and, in parallel, fetches the
   compiler and the data.  The compiler comes as `als-2.9.0.wasm.gz`,
   decompressed in the page with `DecompressionStream` unless the server
   already sent it with `Content-Encoding: gzip`; without
   `DecompressionStream`, or if the `.gz` cannot be fetched, the page fetches
   the raw `als-2.9.0.wasm` instead (`fetchWASMAndData`, `:118-164`).  That
   fallback is dead in the built site: the build's post-step deletes the raw
   file (`scripts/prepare-cloudflare-assets.mjs`), so the request is a 404 (on
   upstream's live site, the page's own HTML labelled `application/wasm`); the
   controller swallows the failure (`:290-297`), so the page says "Agda ready"
   with no goals and never checks, and shows no error.  Measured 2026-10-05 in
   headless Chrome 153 with `DecompressionStream` removed from the page: no
   check after 60 s; with the raw file put back in `build/`, two goals in 1.20
   s.  Of the build's declared targets (`vite.config.js`: Chrome 89, Edge 89,
   Firefox 89, Safari 15), Firefox before 113 and Safari before 16.4 have no
   `DecompressionStream` (MDN's compatibility data, read 2026-10-05).  [#3]
   decided that the built site does not ship the raw file: the fallback could
   serve only Safari 15.2 to 16.3, since a Firefox without
   `DecompressionStream` also lacks module workers (until 114), which the page
   starts, and it would cost 33 MB a deploy, over Cloudflare Pages' 25 MiB
   limit for one file.  The page's silence when it cannot fetch or decompress
   the compiler stays open, proposed for [#8].  The data are `agda-data.zip`
   (Agda's builtin library), `agda-stdlib-2.3-patched.zip` (the standard
   library 2.3 with the five patches that make it check under Agda 2.9.0,
   `stdlib/patches/`, [#61]) and `plfa/project.zip`.  Each of these URLs, and
   those of PLFA's interface archives, carries a `?cache=` token that the
   build derives from the file's content (`src/lib/assets.ts`), so a changed
   file is never served from a cache under its old URL.
2. The drive worker extracts the three archives (`drive.ts:228-256`): the
   builtins at `/lib/prim`, whose interfaces the archive already holds
   under `/lib/prim/_build/<version>/agda/`, where Agda looks (the flake
   builds it from an Agda's own `lib/prim`, [#49], with the compiler's own
   plain `agda` run under wasmtime, below); the standard library's
   sources at `/stdlib`; PLFA at the root.  It writes Agda's
   library registry, `/home/root/.config/agda/libraries` and `defaults`,
   naming the standard library and PLFA, and restores what an earlier visit
   persisted (below).
3. The controller runs `als --setup` once in a throwaway instance (`:487`),
   which writes every data file the server embeds over the drive's, the
   builtins' sources and `agda-builtins.agda-lib` among them (Agda's
   `dumpDataDir` writes them whether or not they exist), so the builtins'
   sources Agda reads are always the server's own; it then starts the
   long-lived server with
   `--raw +RTS -A64m -RTS +AGDA --interaction -AGDA` (`:447`), with
   `HOME=/home/root` and `Agda_datadir=/` (`als.ts:143-146`).  `--raw`
   makes the server answer in Agda's own JSON (below); the fork's server
   had no other mode and took no such option.  `Agda_datadir=/` is the
   data directory itself, since the server is built without Agda's
   `use-xdg-data-home` flag ([#58]).

The user's buffer is `/Main.agda`, beside `/plfa.agda-lib` (`include: .`),
so Agda treats `Main` as a module of the PLFA library, which depends on the
standard library.

## The transport

The page speaks the Language Server Protocol to the worker, with
`Content-Length` framing over the stdin and stdout rings
(`src/lib/agda/transport.js:47-73`), and drives Agda through one custom
method.

+  **Commands**: every Agda command is an IOTCM string (the form Agda's
   interaction mode reads, as Emacs's agda-mode sends it), carried in a
   request named `agda` whose parameters are
   `{tag: "CmdReq", contents: 'IOTCM "/Main.agda" NonInteractive Direct (<command>)'}`
   (`controller.svelte.ts:747-756`).  A response `CmdRes` with no contents
   means the command was accepted.
+  **Answers**: the server streams Agda's interaction-JSON responses back
   as server-to-client requests, also named `agda` (mostly tagged
   `ResponseJSONRaw`, each Agda's own JSON encoding of one response, which
   the server sends only when started with `--raw`; without it, it
   translates Agda's responses into its own forms, `ResponseStatus`,
   `ResponseRunningInfo` and the rest, which the transport does not read,
   so the page would see no `Checking` line).  The transport acknowledges
   each with a null result, so the server's next write waits for the page,
   and routes it to the handlers for highlighting, goals, gives and case
   splits (`transport.js:103-153`); `ResponseEnd` ends a command.
+  **What Agda 2.9.0 changed in these answers**, as the page meets them
   ([#58]): an error's text (a type error now reads `The terms`, `0`,
   `and`, `1`, `are not equal at type Nat` on five lines, where 2.8.0
   wrote `0 != 1 of type Nat`); a give sent with `noRange` is answered
   `giveResult` `{"paren": false}` rather than with the expression
   reprinted, and the page inserts the expression it sent; running info
   is still a string, since Agda's JSON encoding of 2.9.0's document trees
   is their text.  Commands the page does not send changed too:
   `Cmd_constraints` takes a normalization level, and `GoalAndHave`,
   `NormalForm`, `InferredType` and `Mimer` answers carry more (Agda's
   changelog for 2.9.0).
+  **Goal commands** (`controller.svelte.ts:795-868`): `Cmd_goal_type` and
   `Cmd_context` (normalised), `Cmd_give WithoutForce`,
   `Cmd_refine_or_intro False`, `Cmd_make_case`, `Cmd_infer_toplevel`,
   `Cmd_compute DefaultCompute` (or `Cmd_compute_toplevel` with no goal
   selected), and `Cmd_abort`.  A give or a case split comes back as an edit
   to the buffer, and the edited text becomes the checked snapshot.

## A check, and the give rule

A check is `loadAgdaFile` (`controller.svelte.ts:553-615`).

+  If the buffer is the snapshot last checked and that check had no error,
   nothing is sent.
+  If the only change since that snapshot lies wholly inside one goal's
   braces, `{! ... !}`, in both the old text and the new, and leaves the
   goal non-empty, the controller sends `Cmd_give WithoutForce` for that
   goal with its new contents (`getFastGoalCheck`, `:622-676`).  Agda
   checks the expression against the goal's type, in milliseconds.
+  Anything else (a declaration, an import, an edit spanning two goals, an
   edit outside every goal) writes the buffer to the drive and sends a full
   `Cmd_load "/Main.agda" []`.  The source says why: "Everything else
   deliberately falls back to Cmd_load, so edits to declarations, imports,
   or more than one hole always recheck the module" (`:617-621`).

The rule is conservative by construction: the fast path is taken only when
a give is exactly what the edit means, and a stale result can never stand
for a changed declaration.  Upstream measured goal edits at 20 to 60 ms and
a warm declaration edit at 3.01 s on average across PLFA's 25 chapters
(`README.plfa-playground.md`, "PLFA responsiveness").

## The drive

+  **Layout**: Runno's drive is a flat map from path to file, and its root
   directory answers each membership test (is this path a file, is it a
   directory) by scanning every key and building a regular expression for
   each one (`node_modules/@runno/wasi/dist/main.js:475-499`).  Unaided, a
   lookup's cost therefore grows with the number of files on the drive,
   including files Agda never reads.
+  **The index** (`src/lib/worker/drive-index.ts`, [#50]) answers those
   tests instead, from the drive's keys, counted by the paths and the
   directories they name.  It is built once the drive is constructed
   (Runno copies the record it is given), and it follows every call that
   adds or removes a key (`open` with `O_CREAT`, `pathCreateDir`, `unlink`,
   `rename`) and the drive worker's own writes (message types 3 and 4).  It
   also answers a directory's `pathStat` without the filter of the whole
   drive that Runno builds and its stat never reads.  Runno's own methods
   still compute every result, so no answer changes:
   `drive-index.test.ts` runs a plain and an indexed drive side by side
   over random call sequences and requires the same results, errors and
   keys.  What stays linear in the drive's size is rare: opening a
   directory (Runno snapshots its files by filtering every key), listing
   one, and an unlink or a rename, whose own loops visit every key.
+  **What a call costs**, measured 2026-10-06 in headless Chromium 149 on
   a warm reload of a `Main` importing PLFA's `part2.Properties` (7,371
   lookups; [#50]'s pull request has the method and the runs): a lookup
   answered in the drive worker takes 0.9 to 1.7 µs with 1,361 to 5,361
   files on the drive, where the scan took 0.75 to 0.97 ms with 1,361 and
   3.5 to 3.9 ms with 5,361.  The reload took 0.51 to 0.73 s at every size,
   against 6.7 to 8.9 s with 1,361 files and 28.1 to 31.7 s with 5,361
   before the index, and the drive's share of it is 34 to 97 ms, most of
   that the 46 directories Agda opens and lists.  The round trip through
   the proxy from the language server's worker now costs more than the
   lookup: 20,000 lookups took 17.1 to 20.1 µs each through the proxy and
   0.87 to 1.18 µs in the drive worker, so about 0.15 s of that reload is
   the round trip, which the reactor build's drive in the server's worker
   removes ([#59]).
+  **Protocol**: message type 0 proxies a Runno drive call (reads and stats
   answer in binary, writes send base64); type 1 writes `/Main.agda`, type 3
   any path, type 4 extracts a zip at `/`, type 5 persists dirty files, and
   type 2 dumps the filesystem to the console (`drive.ts:332-424`).
+  **Persistence**: the drive means to keep `/Main.agda`, any source
   written with type 3, and every interface Agda writes in an IndexedDB
   database named `agda-playground-drive-<namespace>` (`drive.ts:136-226`,
   `:300-324`), where the namespace is a digest of everything Agda reads
   (the compiler, the builtins, the standard library and PLFA), which the
   build derives from the files (`scripts/asset-manifest.mjs`, read by
   `src/lib/assets.ts`), so that a cache is never restored against other
   files.  Mounted archives are not persisted; restored records replace
   archive entries at the same path.  But the persisting code reads each
   dirty path from the record the drive was constructed from
   (`drive.ts:203`), not from the drive's own copy of it, so a file at a
   path made later is never persisted: measured 2026-10-06, after a cold
   check that rewrote 8 builtin interfaces and wrote `Main`'s and 8 PLFA
   modules' interfaces, the database held `/Main.agda` and the builtins'
   interfaces, whose paths came from `agda-data.zip`, and none of the
   others ([#59]).
+  **More libraries**: `mountDriveArchives(urls)` (`controller.svelte.ts:707-745`)
   fetches zips and extracts them at `/`; it does not touch the library
   registry, which the drive writes once at startup.

## Interfaces, and what the measurements found

Agda type-checks a module from source unless an interface for it is
accepted, and it accepts one only when the interface was built by the same
Agda, from the same source, under the same options, against imports with
the same hashes; a rejected interface is silently checked again.  So
acceptance is counted, never inferred: the running info prints one
`Checking` line per module type-checked, indented for nested ones.

+  **Interfaces built by a native Agda 2.8.0 were accepted** by the
   fork's browser Agda, whose interface version was the same, 202507030
   ([#13]).
+  **Under Agda 2.9.0 they are not, whatever the version**: 2.9.0 writes an
   interface's integers at the width of the machine that wrote it (agda/agda
   PR 8065's serializer), so the wasm32 Agda cannot read what a native
   64-bit Agda writes, and checks the module again, silently, or hangs
   reading a length it misdecodes ([#58]).  Measured 2026-10-07 under
   wasmtime with the compiler's plain `agda`: a `Main` importing
   agda-algebras' `Overture.Basic` checks only `Main` over interfaces that
   the wasm `agda` built (2.3 s, against 38.5 s from source), and all 66
   modules over the same closure built by the native x86-64 nightly.  So
   every interface the page ships is built by a wasm32 Agda: the builtins'
   archive by the compiler's plain `agda` run under wasmtime (`agdaWasm`
   in `flake.nix`), whose interfaces the server accepts.  2.9.0's
   interfaces also carry their version, 202610030, little-endian, and a
   zstd payload where 2.8.0's was gzip.
+  **The builtin interfaces the fork shipped were not**: its `agda-data.zip`
   held Agda 2.7.0.1's (version 202406290), so a fresh profile's first check
   of the default `Main.agda` type-checked `Main` and three builtins.  The
   flake now builds the archive from the shipped Agda's version ([#49]), and
   the same check type-checks `Main` alone, as did two `Main`s that between
   them import all 36 of 2.8.0's builtins (measured 2026-10-06), and as the
   browser check asserts under 2.9.0.  Because `--setup` rewrites the sources
   (above), what must match is the Agda that built the interfaces and the one
   the server embeds; an archive holding the fork's old sources beside the new
   interfaces checked only `Main` too.
+  **Most of a check's time was the drive, not Agda** ([#50]): with
   interfaces accepted, a `Main` importing agda-algebras' `Overture.Basic`
   took 13.6 to 18.5 s per check (2026-10-04).  With the drive indexed, a
   warm reload of a `Main` importing `Setoid.Varieties.HSP` (313
   interfaces, 41,692 lookups a check) takes 1.80 to 1.94 s, against 52.4
   to 53.5 s before, and native Agda's 0.37 to 0.46 s over the same
   staging (2026-10-06, the interim figure on [#50]).

[adr]: ../adr/0001-runtime.md
[#3]: https://github.com/formalverification/agda-native-ide/issues/3
[#6]: https://github.com/formalverification/agda-native-ide/issues/6
[#8]: https://github.com/formalverification/agda-native-ide/issues/8
[#13]: https://github.com/formalverification/agda-native-ide/issues/13
[#49]: https://github.com/formalverification/agda-native-ide/issues/49
[#50]: https://github.com/formalverification/agda-native-ide/issues/50
[#58]: https://github.com/formalverification/agda-native-ide/issues/58
[#59]: https://github.com/formalverification/agda-native-ide/issues/59
[#61]: https://github.com/formalverification/agda-native-ide/issues/61
