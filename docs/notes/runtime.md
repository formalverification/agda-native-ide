<!-- File: docs/notes/runtime.md -->

# How the runtime works

This note explains the runtime the IDE forks from plfa-playground: the two
workers, the transport between the page and the language server, the
in-memory drive, and the rule that decides between a give and a full check.
[ADR 0001][adr] records the decisions about it; this note is the explanation
the ADR links.  Every line reference is to this repository's copy of the
fork: upstream's `ae0aa84c`, with the changes `docs/provenance.md` lists;
of those, only the derived `?cache=` tokens and the drive's cache
namespace touch what this note describes, and each is explained where it
arises.  The facts come from reading that source, and the measurements
from the issues that record them (their findings sections condense the
2026-10-04 investigation of the fork).

## The pieces

The page runs three threads.

+  **The main thread** holds the editor (CodeMirror 6), a language-server
   client (`@codemirror/lsp-client`), and the controller
   (`src/lib/controller.svelte.ts`), which owns the state the page shows:
   the goals, the problems, the inspector's results.
+  **The language-server worker** (`src/lib/worker/als.ts`) compiles
   `als-2.8ext.wasm`, the Agda Language Server built for WASI (the
   WebAssembly System Interface, the POSIX-like set of imports a WebAssembly
   program uses to reach files and streams), and runs it under the WASI
   implementation `@runno/wasi` 0.10.0.  The language server embeds Agda
   2.8.0 and runs it in its JSON interaction mode.
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

`runALSWASM` (`controller.svelte.ts:424-506`) starts the runtime.

1. It starts the language-server worker and, in parallel, fetches the
   compiler and the data.  The compiler comes as `als-2.8ext.wasm.gz`,
   decompressed in the page with `DecompressionStream` unless the server
   already sent it with `Content-Encoding: gzip`; without
   `DecompressionStream`, or if the `.gz` cannot be fetched, the page
   fetches the raw `als-2.8ext.wasm` instead (`fetchWASMAndData`,
   `:122-152`).  That fallback is dead in the built site: the build's
   post-step deletes the raw file (`scripts/prepare-cloudflare-assets.mjs`),
   so the request is a 404 (on upstream's live site, the page's own HTML
   labelled `application/wasm`); the controller swallows the failure
   (`:294-301`), so the page says "Agda ready" with no goals and never
   checks, and shows no error.  Measured 2026-10-05 in headless Chrome 153
   with `DecompressionStream` removed from the page: no check after 60 s;
   with the raw file put back in `build/`, two goals in 1.20 s.  Of the
   build's declared targets (`vite.config.js`: Chrome 89, Edge 89, Firefox
   89, Safari 15), Firefox before 113 and Safari before 16.4 have no
   `DecompressionStream` (MDN's compatibility data, read 2026-10-05).
   Whether the built site ships the raw file too, or drops the branch and
   says so, is [#3]'s.  The data are `agda-data.zip` (Agda's builtin
   library), `agda-stdlib-2.3.zip` and `plfa/project.zip`.  Each of these
   URLs, and those of PLFA's interface archives, carries a `?cache=` token
   that the build derives from the file's content (`src/lib/assets.ts`),
   so a changed file is never served from a cache under its old URL.
2. The drive worker extracts the three archives (`drive.ts:214-251`): the
   builtins at `/lib/prim`, with their interfaces moved under
   `/lib/prim/_build/2.8.0/agda/`, where Agda 2.8 looks; the standard
   library's sources at `/stdlib`; PLFA at the root.  It writes Agda's
   library registry, `/home/root/.config/agda/libraries` and `defaults`,
   naming the standard library and PLFA, and restores what an earlier visit
   persisted (below).
3. The controller runs `als --setup` once in a throwaway instance (`:489`),
   then starts the long-lived server with
   `+RTS -A64m -RTS +AGDA --interaction -AGDA` (`:449`), with
   `HOME=/home/root` and `Agda_datadir=/` (`als.ts:143-146`).

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
   (`controller.svelte.ts:749-758`).  A response `CmdRes` with no contents
   means the command was accepted.
+  **Answers**: the server streams Agda's interaction-JSON responses back
   as server-to-client requests, also named `agda` (mostly tagged
   `ResponseJSONRaw`).  The transport acknowledges each with a null result,
   so the server's next write waits for the page, and routes it to the
   handlers for highlighting, goals, gives and case splits
   (`transport.js:103-153`); `ResponseEnd` ends a command.
+  **Goal commands** (`controller.svelte.ts:797-870`): `Cmd_goal_type` and
   `Cmd_context` (normalised), `Cmd_give WithoutForce`,
   `Cmd_refine_or_intro False`, `Cmd_make_case`, `Cmd_infer_toplevel`,
   `Cmd_compute DefaultCompute` (or `Cmd_compute_toplevel` with no goal
   selected), and `Cmd_abort`.  A give or a case split comes back as an edit
   to the buffer, and the edited text becomes the checked snapshot.

## A check, and the give rule

A check is `loadAgdaFile` (`controller.svelte.ts:555-617`).

+  If the buffer is the snapshot last checked and that check had no error,
   nothing is sent.
+  If the only change since that snapshot lies wholly inside one goal's
   braces, `{! ... !}`, in both the old text and the new, and leaves the
   goal non-empty, the controller sends `Cmd_give WithoutForce` for that
   goal with its new contents (`getFastGoalCheck`, `:624-678`).  Agda
   checks the expression against the goal's type, in milliseconds.
+  Anything else (a declaration, an import, an edit spanning two goals, an
   edit outside every goal) writes the buffer to the drive and sends a full
   `Cmd_load "/Main.agda" []`.  The source says why: "Everything else
   deliberately falls back to Cmd_load, so edits to declarations, imports,
   or more than one hole always recheck the module" (`:619-623`).

The rule is conservative by construction: the fast path is taken only when
a give is exactly what the edit means, and a stale result can never stand
for a changed declaration.  Upstream measured goal edits at 20 to 60 ms and
a warm declaration edit at 3.01 s on average across PLFA's 25 chapters
(`README.plfa-playground.md`, "PLFA responsiveness").

## The drive

+  **Layout**: Runno's drive is a flat map from path to file.  A lookup
   scans every key and builds a regular expression for each one
   (`node_modules/@runno/wasi/dist/main.js:475-499`), so its cost grows with
   the number of files on the drive, including files Agda never reads.
+  **Protocol**: message type 0 proxies a Runno drive call (reads and stats
   answer in binary, writes send base64); type 1 writes `/Main.agda`, type 3
   any path, type 4 extracts a zip at `/`, type 5 persists dirty files, and
   type 2 dumps the filesystem to the console (`drive.ts:326-416`).
+  **Persistence**: the drive keeps `/Main.agda`, any source written with
   type 3, and every interface Agda writes in an IndexedDB database named
   `agda-playground-drive-<namespace>` (`drive.ts:122-212`, `:294-318`),
   where the namespace is a digest of everything Agda reads (the compiler,
   the builtins, the standard library and PLFA), which the build derives
   from the files (`scripts/asset-manifest.mjs`, read by
   `src/lib/assets.ts`), so that a cache is never restored against other
   files.
   Mounted archives are not persisted; restored records replace archive
   entries at the same path.
+  **More libraries**: `mountDriveArchives(urls)` (`controller.svelte.ts:709-747`)
   fetches zips and extracts them at `/`; it does not touch the library
   registry, which the drive writes once at startup.

## Interfaces, and what the measurements found

Agda type-checks a module from source unless an interface for it is
accepted, and it accepts one only when the interface was built by the same
Agda, from the same source, under the same options, against imports with
the same hashes; a rejected interface is silently checked again.  So
acceptance is counted, never inferred: the running info prints one
`Checking` line per module type-checked, indented for nested ones.

+  **Interfaces built by a native Agda 2.8.0 are accepted** by the browser's
   Agda, whose interface version is the same, 202507030 ([#13]).
+  **The builtin interfaces the fork ships are not**: `agda-data.zip` holds
   Agda 2.7.0.1's (version 202406290), so a fresh profile's first check of
   the default `Main.agda` type-checks `Main` and three builtins ([#49]).
+  **Most of a check's time is the drive, not Agda**: with interfaces
   accepted, a `Main` importing agda-algebras' `Overture.Basic` took 13.6 to
   18.5 s per check, and 1.8 to 3.7 s with an index on the drive's lookups
   ([#50]).

[adr]: ../adr/0001-runtime.md
[#3]: https://github.com/formalverification/agda-native-ide/issues/3
[#6]: https://github.com/formalverification/agda-native-ide/issues/6
[#8]: https://github.com/formalverification/agda-native-ide/issues/8
[#13]: https://github.com/formalverification/agda-native-ide/issues/13
[#49]: https://github.com/formalverification/agda-native-ide/issues/49
[#50]: https://github.com/formalverification/agda-native-ide/issues/50
