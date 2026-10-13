<!-- File: docs/notes/runtime.md -->

# How the runtime works

This note explains the runtime the IDE forks from plfa-playground: the
language server's worker, the transport between the page and the server,
the in-memory drive, the page's startup and its notices, and the rule that
decides between a give and a full check.  [ADR 0001][adr] records the
decisions about it; this note is the explanation the ADR links.  Every line
reference is to this repository's copy of the fork: upstream's `ae0aa84c`,
with the changes `docs/provenance.md` lists; of those, the derived
`?cache=` tokens, the drive's cache namespace, the drive's index, the
builtins' archive, the compiler and standard library of Agda 2.9.0 ([#58]),
the server's reactor build with the drive in its worker ([#59]), the
playground's own project ([#11]), and the editor's state per open file
with agda-algebras' modules read-only ([#10]) touch what this note
describes, and each is explained where it arises.  The facts
come from reading that source, and the measurements from the issues that
record them (their findings sections condense the 2026-10-04 investigation
of the fork).

## Since the shared core, 2026-10-11

The runtime works as this note says, but its code has moved into the
shared packages ([#62]; [ADR 0003][adr-0003] and
[`docs/engine/overview.md`][engine]), so the line references below are to
commit `c18e3d6`, the last before that move.  Where each piece is now, as
follows:

+  **The worker and the drive** (`als.ts`, `drive.ts`, `drive-index.ts`,
   and `types.d.ts` as `protocol.ts`) are the engine package's browser
   transport's, in `packages/engine/src/browser/worker/`;
   `src/lib/worker/als.ts` is the page's one-line entry from which Vite
   bundles it.  The drive also reads a source back.
+  **The startup** (the compiler's download and decompression, the
   archives, the worker, the setup and the server, and the failures the
   page shows after "Agda could not start:") is
   `packages/engine/src/browser/index.ts`, which the controller gives its
   URLs.
+  **The transport**: the router (`transport.js`), its framing (`lsp.js`,
   and `createPortByteStreams` in `src/lib/index.js`) and its schemas of the
   server's own forms (`schema.js`) are removed.  The browser transport
   speaks to the worker one JSON message at a time, with no framing,
   acknowledges each of the server's requests, and ends each command at
   `ResponseEnd`; the engine's core validates Agda's answers.  CodeMirror's
   language-server client, for hover, reaches the same server through the
   transport's editor channel, but not the session's loaded file: the
   server answers a hover with a load of its own ("The editor's states",
   below).
+  **The version query** is the engine's: a session asks Agda its version
   when it opens.
+  **The give rule** is the engine's `planCheck`, which a session applies
   to its snapshot; the page commits its offsets in the check's plan hook,
   when the plan is a load, as before.  A check after a case split now
   loads.
+  **The controller** keeps the page's state, its editor, its URLs, its
   PLFA conversion and when to persist; `src/lib/agda/handlers.js` applies
   each answer to the editor.

## The pieces

The page runs two threads.

+  **The main thread** holds the editor (CodeMirror 6), a language-server
   client (`@codemirror/lsp-client`), and the controller
   (`src/lib/controller.svelte.ts`), which owns the state the page shows:
   the goals, the problems, the inspector's results.
+  **The language server's worker** (`src/lib/worker/als.ts`) compiles
   `als-reactor-2.9.0.wasm`, the Agda Language Server built for WASI (the
   WebAssembly System Interface, the POSIX-like set of imports a WebAssembly
   program uses to reach files and streams) as a *reactor* (below), and
   runs it under the WASI implementation `@runno/wasi` 0.10.0.  The server
   embeds Agda 2.9.0 and runs it in its JSON interaction mode.  It is this
   repository's build, from agda/agda-language-server `v8` and Agda's own
   sources, with two patches (`compiler/build-agda-2.9.0.sh`, [#58]); the
   fork shipped agda-web's build for Agda 2.8.0, `als-2.8ext.wasm`, as a
   command module.  The same worker holds the drive
   (`src/lib/worker/drive.ts`): the in-memory filesystem Agda reads and
   writes, with the user's buffer, Agda's builtin library, the standard
   library, agda-algebras' sources, PLFA, and the interfaces Agda
   produces.

The worker is a module worker that Vite inlines and emits as a separate
file (`src/lib/index.js:73`), loaded relative to the bundle, so it works
under any base path.

## No shared memory, and no isolation

A WASI program built as a *command* runs from its `_start` to its exit and
blocks wherever it waits: GHC's runtime waits on standard input, and every
file operation is a synchronous WASI call.  The fork ran the server so, and
made it work with shared memory between threads in two places: the
server's standard input and output were rings of 4 KiB over a
`SharedArrayBuffer`, on which the server's worker waited with
`Atomics.wait`; and every file call was proxied to a second worker, which
held the drive, through a lock and two rings of 1 MiB.  Browsers expose
`SharedArrayBuffer` only to a cross-origin isolated page, one served with
`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, so every host had to send
those headers, or the page had to carry a service worker that added them
(at the cost of a reload on a first visit, and a race that left some first
visits on a dead page, [#6] and [#8]).

Since [#59] neither is shared.

+  **The server is a reactor**: the same server built with its `reactor`
   flag (agda-language-server's `app/Reactor.hs`), which exports functions
   that JavaScript calls (`run_setup`, `new_language_server`,
   `run_language_server`, `send_message`, `recv_message`), each through
   GHC's JavaScript FFI and so asynchronous, instead of blocking on
   standard input.  It imports the 24 WASI functions the command module
   does, and 19 more from `ghc_wasm_jsffi`, which a JavaScript file GHC's
   post-linker writes for it supplies: `als-reactor-2.9.0.js`, the glue,
   which the worker imports by its URL (below).  The reactor made no
   `poll_oneoff` call, which matters with Runno, whose `poll_oneoff`
   busy-waits on a clock ([#59]'s spike).
+  **The drive is the worker's own**: the server's WASI drive, so a file
   call is a function call on the same thread.  The page's writes, the
   archives it mounts and the IndexedDB cache are functions the worker
   exposes (through Comlink), run between the server's steps.

So the page allocates no `SharedArrayBuffer`, and needs no isolation: no
headers (`static/_headers` keeps only its cache rules), no service worker,
and no check of `crossOriginIsolated`, which the page and the worker each
made.  No deployment ever served the service worker ([#6] has not chosen a
host), so no visitor holds a registration of it.  The browser check runs
the page served with the headers and without, and asserts
`crossOriginIsolated` as the server made it ([below](#the-checks)).

## Startup

The page starts Agda in its `onMount` (`src/routes/+page.svelte:467`), and
`startALSWASM` and `runALSWASM` (`controller.svelte.ts:304` and `:451`)
carry it on.

0. **What the browser needs**.  Before anything else the page checks for
   module workers, `DecompressionStream`, and the five WebAssembly features
   the compiler uses: SIMD, reference types, bulk memory, sign extension and
   non-trapping float-to-int conversions (`src/lib/support.ts`, each feature
   by `WebAssembly.validate` of a module of one instruction).  The reactor's
   `target_features` section names ten; validated with each left out in
   turn, it needs these five and none of the others.  A browser without one
   of them gets a notice naming what is missing and the browsers the page is
   tested in, and the page stops there ([#8]; [below](#when-agda-cannot-start)).
   IndexedDB is not checked: the drive's cache is optional.
1. **The compiler and the data**.  The page fetches the compiler as
   `als-reactor-2.9.0.wasm.gz` and decompresses it as it arrives with
   `DecompressionStream`, unless the server already sent it with
   `Content-Encoding: gzip` (`fetchWASMAndData`, `:145`), and streams it to
   the worker, which compiles it while it imports the glue, by its URL
   with its cache token (`/* @vite-ignore */`, so Vite does not bundle it:
   the file the page runs is the pinned file, byte for byte, and changes
   only with the module it was generated from).  There is no other path:
   the built site has not shipped the raw compiler since [#3], so its old
   fallback was a 404 the page swallowed, and the dev server now serves the
   gzip itself, compressing the raw file in `static/` (`vite.config.js`).
   Meanwhile the page fetches the data: `agda-data.zip` (Agda's builtin
   library), `agda-stdlib-2.3-patched.zip` (the standard library 2.3 with
   the five patches that make it check under Agda 2.9.0,
   `stdlib/patches/`, [#61]) and `plfa/project.zip`.  Each of these URLs,
   the glue's, and those of PLFA's interface archives, carries a `?cache=`
   token that the build derives from the file's content
   (`src/lib/assets.ts`), so a changed file is never served from a cache
   under its old URL.
2. **The drive**.  The worker lays out the drive from the archives
   (`layOutDrive`, in `packages/engine/src/browser/worker/drive.ts`): the
   builtins at `/lib/prim`, whose interfaces the archive already holds under
   `/lib/prim/_build/<version>/agda/`, where Agda looks (the flake builds it
   from an Agda's own `lib/prim`, [#49], with the compiler's own plain
   `agda` run under wasmtime, below); the standard library's sources at
   `/stdlib`; and a list of libraries, each a zip extracted at the root with
   its `.agda-lib` path and its name (the engine's
   `BrowserConfig.archives.libraries`, [#13]), where the page passes one,
   PLFA, at the root.  It writes Agda's library registry,
   `/home/root/.config/agda/libraries` and `defaults`, naming the standard
   library and then each library of the list, and restores what an earlier
   visit persisted (below).
3. **The reactor**.  The worker instantiates the reactor over that drive,
   with `{ wasi_snapshot_preview1, ghc_wasm_jsffi: glue(exports) }` and the
   exports filled in afterwards, and Runno's `initialize` runs its
   `_initialize`, where GHC's runtime starts and reads the argv and the
   environment from WASI (`als.ts:121-143`): the program's name first, then
   `--raw +AGDA --interaction -AGDA` (`controller.svelte.ts:477`), with
   `HOME=/home/root` and `Agda_datadir=/` (`als.ts:114`).  The server reads
   them when it is created.  `--raw` makes the server answer in Agda's own
   JSON (below); `Agda_datadir=/` is the data directory itself, since the
   server is built without Agda's `use-xdg-data-home` flag ([#58]).  The
   fork's `+RTS -A64m -RTS` (a nursery of 64 MB for GHC's collector) is
   gone: the reactor's runtime takes such options from the argv, and this
   one grew the heap from 24 to 94 MiB on the default `Main.agda` (31 to
   121 MiB on a larger root) and made no check faster ([#59]).
4. **The setup**.  The controller calls the reactor's `run_setup`, Agda's
   `--setup`, which writes every data file the server embeds over the
   drive's, the builtins' sources and `agda-builtins.agda-lib` among them
   (Agda's `dumpDataDir` writes them whether or not they exist), so the
   builtins' sources Agda reads are always the server's own.  The stdio
   build ran `als --setup` in a throwaway instance, and `als --version` in
   another; the reactor cannot run as a command, and the second has no
   replacement (below).
5. **The server**.  `start` (`als.ts:149`) creates the server with
   `new_language_server` and runs it with `run_language_server`, never
   awaited (it settles when the server exits), and the page's language
   client opens the session.  When the server is first ready, the
   controller asks Agda for its version with `Cmd_show_version`, and lets
   the page see the server ready only once Agda has answered
   (`updateIOTCMStatus`, `:787`), so that the question never overlaps the
   page's first check.  The status bar shows Agda's answer, "Agda 2.9.0":
   the server sets no `serverInfo`, and its version string is printed only
   by the command module's `--version`.  The page then checks `Main.agda`.

"Agda ready" in the status bar means that the server is running (the
controller's `alsWorkerStatus` is `active`), from step 5.  Measured
2026-10-08 in headless Chromium 149, five fresh profiles each, it came 641
to 666 ms after navigation (median 650), where the stdio build, which
compiled the same size of module but instantiated and ran it three times
(`--version`, `--setup`, the server) beside a second worker for the drive,
came at 901 to 916 ms (907), served isolated ([#59]).

### When Agda cannot start

Every step from 1 to 4 that fails says so: a failed request names the file
and the HTTP status, and so does a body that breaks off while it is read; a
decompression or compilation that fails says that the compiler could not be
loaded, with the browser's own words; and so on for the drive and the setup
(`startupFailure`, `controller.svelte.ts:371`, with `describeError`,
`fetchOrFail` and `readOrFail`, `:179`, `:188` and `:206`).  The page shows
"Agda could not start: ..." in its banner, and its inspector's heading and
its status bar say "Agda did not start", where the fork swallowed the
failure and the status bar said "Agda ready" with no goals and nothing
checked (measured 2026-10-05 in headless Chrome 153 with
`DecompressionStream` removed: no check after 60 s; [#8]'s comment).  A
server that fails, or exits when the page did not ask it to, is reported the
same way, as "Agda stopped" (`_startALSWASM`, `:388`), where the page went
on saying "Agda ready".  `scripts/browser-check/notices.mjs` checks four
cases in CI: a browser without `DecompressionStream`, a compiler request
answered 404, a compiler that is not a gzip, and a standard library whose
transfer breaks off.

The playground's buffer is `/play/Main.agda`, a module of a project of
its own ("The playground's project", below); until [#11] it was
`/Main.agda`, a module of the PLFA library at the drive's root.

## The transport

The page speaks the Language Server Protocol to the server, and drives
Agda through one custom method.  The router
(`src/lib/agda/transport.js`, upstream's, unchanged until [#62] removed
it) reads and writes `Content-Length`-framed bytes (`:47-73`), as it did
over the rings; the reactor takes and gives one JSON
message per call, with no framing (its `prepareOutwards` is the identity,
and its `parseInwards` takes the whole message).  So the page's end of a
`MessageChannel` frames each message from the worker and unframes each one
the router writes (`createPortByteStreams`, `src/lib/index.js:23`), and
the worker passes each message on with `send_message`, one at a time,
chaining each on the last, and keeps one `recv_message` pending, posting
each answer back (`als.ts:149-170`).

+  **Commands**: every Agda command is an IOTCM string (the form Agda's
   interaction mode reads, as Emacs's agda-mode sends it), carried in a
   request named `agda` whose parameters are
   `{tag: "CmdReq", contents: 'IOTCM "/Main.agda" NonInteractive Direct (<command>)'}`
   (`controller.svelte.ts:807-816`).  A response `CmdRes` with no contents
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
+  **Goal commands** (`controller.svelte.ts:855-928`): `Cmd_goal_type` and
   `Cmd_context` (normalised), `Cmd_give WithoutForce`,
   `Cmd_refine_or_intro False`, `Cmd_make_case`, `Cmd_infer_toplevel`,
   `Cmd_compute DefaultCompute` (or `Cmd_compute_toplevel` with no goal
   selected), and `Cmd_abort`.  A give or a case split comes back as an edit
   to the buffer, and the edited text becomes the checked snapshot.

## A check, and the give rule

A check is `loadAgdaFile` (`controller.svelte.ts:594-656`).

+  If the buffer is the snapshot last checked and that check had no error,
   nothing is sent.
+  If the only change since that snapshot lies wholly inside one goal's
   braces, `{! ... !}`, in both the old text and the new, and leaves the
   goal non-empty, the controller sends `Cmd_give WithoutForce` for that
   goal with its new contents (`getFastGoalCheck`, `:663-717`).  Agda
   checks the expression against the goal's type, in milliseconds.
+  Anything else (a declaration, an import, an edit spanning two goals, an
   edit outside every goal) writes the buffer to the drive and sends a full
   `Cmd_load "/Main.agda" []`.  The source says why: "Everything else
   deliberately falls back to Cmd_load, so edits to declarations, imports,
   or more than one hole always recheck the module" (`:658-662`).

The rule is conservative by construction: the fast path is taken only when
a give is exactly what the edit means, and a stale result can never stand
for a changed declaration.  Upstream measured goal edits at 20 to 60 ms and
a warm declaration edit at 3.01 s on average across PLFA's 25 chapters
(`README.plfa-playground.md`, "PLFA responsiveness").

Agda's answers place things (goals, highlighting) by offsets in the text it
last loaded, and the editor maps them through the edits made since, which
it records from the moment it takes a text as Agda's (the offsets'
*commit*, `src/lib/codemirror/offsets.js`).  After a give or a case split,
Agda goes on giving the remaining goals' ranges in the text it loaded:
asked with the compiler's own `agda`, the default `Main.agda`'s goal 1
keeps its range, 303 to 320, after goal 0 is given and the text above it
shrinks.  So the controller commits only when it writes the buffer for a
`Cmd_load`, at the moment it reads it (`syncEditorToDrive`, `:722-739`).
Upstream committed after every write to the drive, the write that follows
a give included; when that write completed before Agda's interaction points
arrived, their ranges fell past the end of the text, the mapping threw, and
the router's stream stopped, so the page hung on its give.  The race was
upstream's; the reactor's transport exposed it in Firefox, 3 times in 8
runs of the browser check ([#59]).

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
   `rename`) and the page's writes and mounted archives (`writeFile` and
   `mountArchive`, `drive.ts:313` and `:326`).  It
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
   that the 46 directories Agda opens and lists.  Then the round trip
   through the proxy from the language server's worker cost more than the
   lookup: 20,000 lookups took 17.1 to 20.1 µs each through the proxy and
   0.87 to 1.18 µs in the drive worker ([#50]), and 11.4 to 12.8 µs
   through the proxy on [#59]'s spike.  Since the drive moved into the
   server's worker, a call is a function call: on the built page, 20,000
   `pathStat` calls on the root ([#50]'s paths, 30% hits) took 0.19 to
   0.21 µs each in four runs and 0.47 µs in a fifth (2026-10-08, headless
   Chromium 149; the spike's page measured 0.21 to 0.24 µs).
+  **What the page asks of it**: `writeFile` (a source, at any path),
   `mountArchive` (a zip, extracted at `/`) and `persist` (below), which the
   worker exposes beside the server's functions (`drive.ts:313-358`), where
   the drive worker took numbered messages over shared rings.  They run on
   the server's thread, between its steps: extracting an archive delays the
   server's next step (not measured).
+  **Persistence**: the drive keeps every source the page writes (the
   playground's `/play/Main.agda` and its copies of agda-algebras' modules,
   a chapter's buffer; never a module of agda-algebras, which the page
   does not write, [#10]), and every interface
   Agda writes in an IndexedDB database named
   `agda-playground-drive-<namespace>` (`drive.ts:171-242`, `:332`), where
   the namespace is a digest of everything Agda reads (the compiler and its
   glue, the builtins, the standard library, agda-algebras' sources and
   PLFA), which the build derives from the files
   (`scripts/asset-manifest.mjs`, read by `src/lib/assets.ts`), so that a
   cache is never restored against other files.  Mounted archives are not
   persisted; restored records replace archive entries at the same path.
   It reads each dirty file from the drive's own record, `drive.fs`, where
   Agda's writes land, so files at paths made after startup (`Main`'s
   interface, a mounted archive's) are persisted too.  The drive worker
   read them from the record the drive was built from, which Runno copies,
   and so persisted only files at paths that existed when the drive was
   built: measured 2026-10-06, after a cold check that rewrote 8 builtin
   interfaces and wrote `Main`'s and 8 PLFA modules' interfaces, the
   database held `/Main.agda` and the builtins' interfaces, and none of the
   others ([#59]).  IndexedDB is optional: in
   a worker without it the page checks and reloads, uncached (2026-10-08,
   headless Chromium 149, with `indexedDB` removed from the worker's global
   before it ran; no database was made).
+  **More libraries**: the registry is written once, at startup, from the
   engine's list of libraries ([#13]), so a library the page will use is
   named in that list, its sources archive fetched with the standard
   library's; the page names agda-algebras' and PLFA's ([#11]).
   `mountDriveArchives` (`controller.svelte.ts`, through the transport's
   `mountArchives`) extracts zips at `/`, which is how interface archives
   arrive, fetched or read from the browser's archive store ([#14]); it
   does not touch the registry, and a mounted archive's paths leave the
   drive's cache.
+  **The host's files**: the drive starts with the files the host names
   (`BrowserConfig.files`), written after the archives and over what the
   cache restores, before Agda starts (`prepareDrive`), so a cached copy
   never stands in for one; the page names its playground's library file,
   below.  The transport refuses one outside its root before it fetches
   anything.  Until [#11] the drive held an empty `/Main.agda` of its own.

## The playground's project

The playground's `Main.agda` is a module of a project of its own, which
depends on the standard library and agda-algebras, so that what the library
refuses, `Main` refuses ([#11]).

+  **Where it lives**: `/play/Main.agda`, beside `/play/play.agda-lib`
   (`name: play`, `depend: standard-library-2.3 agda-algebras`, `include:
   .`), the play library that `scripts/library-archives/stage.sh` writes and
   [#13]'s gate checks every root of agda-algebras under.  The page names
   that file among the drive's first files (`PLAYGROUND` in
   `controller.svelte.ts`).  Agda takes the nearest `.agda-lib` at or above
   a module's directory as its project, so `/play/play.agda-lib` governs
   `Main`, while PLFA's chapters, under `/plfa/`, keep `/plfa.agda-lib` at
   the root (`include: .`), as before.
+  **The libraries**: agda-algebras' sources archive,
   `agda-algebras-sources.zip` (985,864 bytes; the flake's
   `mkAgdaAlgebrasSources`, the bytes agda-algebras' interfaces were built
   from), is first in the drive's list, extracted at the root so that it
   lands at `/agda-algebras`; PLFA's follows.  The libraries file names
   `/stdlib/standard-library.agda-lib`,
   `/agda-algebras/agda-algebras.agda-lib` and `/plfa.agda-lib`, and
   agda-algebras' `depend: standard-library-2.3` resolves because the
   shipped standard library, 2.3 with five patches, keeps that name.
   Without agda-algebras in the list even the default `Main` fails, with
   Agda's `[LibraryError]`, "Library 'agda-algebras' not found".
+  **Which flags apply to `Main`**: its own options line, `{-# OPTIONS
   --without-K --exact-split --safe #-}`, which every module of
   agda-algebras carries; `play.agda-lib` has no `flags:` line, and a
   library's flags do not reach the modules of a library that depends on
   it.  The standard library's `--warning=noUnsupportedIndexedMatch`
   applies to its own modules when Agda checks them from source, and
   silences a warning only `--cubical-compatible` raises.  Checked with the
   native Agda at the compiler's commit: `--safe` added to the standard
   library's `flags:` left a postulate in a module of the play library
   accepted, and the same flag in `play.agda-lib` refused it.  The line is
   `--without-K`, not `--cubical-compatible`, since a `--cubical-compatible`
   module cannot import a `--without-K` one (`CoInfectiveImport`, [#61]).
+  **The default `Main`**: Agda's builtins alone (`Agda.Builtin.Equality`,
   `.List` and `.Nat`), whose interfaces `agda-data.zip` ships, so a first
   visit type-checks `Main` alone; and one goal, the last step of a proof
   that the composite of two homomorphisms is one, placed to show on the
   first screen, whose context holds the two hypotheses that fill it.
   `--safe` refuses a postulate there (`[SafeFlagPostulate]`) and a
   `TERMINATING` pragma (`[SafeFlagTerminating]`).  After a load that
   leaves goals the controller asks for the selected goal's context, so
   the inspector shows the goal with it, where it waited for a selection.
+  **The stored buffer**: the localStorage key is
   `agda-web-ide-beta:doc:/play/Main.agda`, named by the buffer's path,
   where it was `agda-web-ide-beta:doc`, so a document stored for the old
   `/Main.agda` is not shown in its place.  Nothing is deployed, so only a
   developer's browser holds one, and it stays there, unread.  The drive's
   cache namespace now digests the sources archive too, so a drive
   persisted under the old layout is not restored.  Each copy of a library's
   module in the playground has a key of its own, named by its path
   ([#10], "The editor's states").
+  **What it costs** (2026-10-12, headless Chromium 149, this workstation
   with other sessions' builds beside it;
   [`docs/measurements/playground-2026-10-12.json`][playground-record]): a
   first visit makes one more request, the sources archive's 985,864
   bytes, fetched with the standard library's.  The first check of the
   default took a median 0.40 s as the page reports it, against 0.27 s for
   the previous default on the same layout, five runs of each, alternating,
   on a quiet machine; the ratio held at loads near 3 and 10 (1.5 s against
   1.0 s, 2.0 s against 1.3 s), and natively the whole check is about 100
   ms.  A `Main` importing `Overture.Signatures`, which needs itself and 10
   standard-library modules from source, took 2.0 s cold on the quiet
   machine (7.9 s and 12.8 s under load); `Setoid.Algebras.Basic`, 170
   modules from source, 1 min 38 s to 6 min 32 s cold over six runs (median
   2 min 35 s; 1 min 38 s on the quiet machine), and 3.3 to 11.9 s on a
   reload, from what the drive persisted.  With its 50
   archives mounted, the same import type-checked `Main` alone in 3.7 s
   ([#13]'s gate record), and still did with PLFA's library on the drive
   beside agda-algebras; since [#14] the page mounts them itself, after
   asking, and checks it in 3.2 s (`docs/notes/library-archives.md`, "The
   mount in the page").

## The editor's states

The page has one CodeMirror view and an editor state per open file
([#10]), where the fork swapped one document through one state.

+  **Why**: the fork's `setDocument` replaced the whole text in one
   transaction of the state on screen, which its history recorded, so undo
   crossed files: on the live site on 2026-10-04, Ctrl-Z after opening a
   chapter put `Main.agda`'s text into the chapter, and the autosave, whose
   timer then wrote under the chapter's key, stored it there.
+  **A state per file**: each open file's `EditorState` holds its text,
   selection, history, language (`agdaSourceLanguage` for an `.agda` file,
   `literateAgdaLanguage` for a `.lagda.md` one), Agda's highlighting and
   goals, and a facet naming its file (`src/lib/documents.ts`).  The
   controller keeps the states not on screen and shows one with
   `EditorView.setState`, which rebuilds the view's plugins from it; each
   file's scroll position is kept beside its state, and a file opened for
   the first time shows its top.  What every state shares (the page's keys,
   its update listener, its theme) is made once, with the editor.  The
   open files are tabs: Main's is fixed, and closing another forgets its
   state and its history, not its text.
+  **The language server's client** follows the file on screen: the
   plugin of `@codemirror/lsp-client` is only in that state, so a switch
   closes one file on the server (`didClose`) and opens the next with its
   text (`didOpen`).
+  **What Agda answered** is the file's it answered for.  A switch bumps
   the controller's epoch and calls the session's `reloadNext`, so a check
   still running is not applied, the inspector starts afresh, and the next
   check of the file shown loads it, since the session holds one file.  A
   file shown again that Agda does not hold shows no goals, and a goal
   command there is refused until it is checked.  A playground file is
   checked again when it is shown, as Main was; Infer
   and Normalize check the file on screen first when Agda holds another
   (`holdCurrentFile`).
+  **The autosave** follows the state: each file's edits are saved under
   its own key 250 ms after its last edit, whichever file is on screen when
   the save runs (`DocumentSaver`), and what waits is saved when the page
   is left (`pagehide`), where the fork dropped it.  The keys are
   `agda-web-ide-beta:doc:<path>` for the playground's files and
   `agda-web-ide-beta:plfa-lagda:<id>` for a chapter.
+  **PLFA's chapters** are editable as before.  What the states change: a
   chapter opened again in a visit shows its kept state, with its history,
   rather than its stored text, and opening one no longer writes its text
   to the browser until it is edited.
+  **The color scheme**: the editor's scheme follows the theme by
   comparing it with the scheme the state on screen holds
   (`src/lib/codemirror/theme.ts`), since a state kept off screen holds the
   scheme of the theme in force when it was last shown.

### A module of agda-algebras, read-only

+  **Opening one**: Enter on a module's row in the Explorer (or a click on
   its label) opens it in a tab, while Agda is idle; its rows are
   aria-disabled while Agda starts or is busy, since opening one loads it
   (the playground's and the chapters' only while it is busy).  A module
   open already is shown again whether or not Agda is up.  Its text is read
   from the drive (`readSource`), which holds the sources archive the build
   made from agda-algebras' pin, so the tab shows exactly the text Agda
   reads.  The page never writes it, so the
   drive's cache never holds it, and the next visit's drive is laid out
   from the archive again.
+  **Read-only**: the state has `EditorState.readOnly`, `EditorView.editable`
   false with a `tabindex` (so the arrows, selection, copying and the
   page's keys still work), and a change filter that refuses every change,
   so neither a keystroke, a paste, an undo, the input method's own edit
   nor an edit of Agda's changes it.  A line above it says that it is the
   checked library, at its pin, and links its page on agda-algebras' site,
   which renders each module at its path
   (`https://agda-algebras.universalalgebra.org/Overture/Signatures/`).
+  **The load**: the session's `load(path)` without text, which reads the
   source and writes nothing.  Before it, the page mounts the archives of
   the module's own closure: its name, not the imports of its text, so its
   own archive is among them, after asking as for Main ([#14]).  The load's
   `Checking` lines say whether Agda accepted the module's own interface
   (none) or type-checked it again.  When the closure is checked from
   source (the build has no archives, the reader declined the fetch, or the
   index could not be read), the note says how long the last such load of
   that module took in this browser, or that it can take minutes.  Agda
   then answers Infer and Normalize in its scope.
+  **Hover** is the language server's own: it loads the hovered file from
   the drive in a fresh Agda state, with the drive's interfaces, and infers
   the token under the pointer in its scope, so its answer does not depend
   on the session's load (the server's `onHover` handler, at the server's
   pinned commit).  The server counts a position's character in code
   points, where CodeMirror's client sends UTF-16 code units: on a line
   with a character outside the Basic Multilingual Plane before the
   pointer, the server read the token that many characters to the right,
   and 258 of agda-algebras' 351 files have such lines.
   `src/lib/codemirror/lsp-hover.ts` now sends, and reads back, code
   points.  Since the server's hover is a load, it costs about the
   module's load, and the server reads no other message meanwhile, so a
   command the page sends waits for it.
+  **What it costs** (2026-10-13, headless Chromium 149, this workstation
   at a load of 2 to 3, three rounds on fresh profiles;
   [`docs/measurements/library-tabs-2026-10-13.json`][tabs-record]):
   `Overture.Signatures`, `Setoid.Algebras.Basic` and
   `Setoid.Varieties.HSP`, opened on a first visit, mounted their 3, 50 and
   128 archives in 16 to 28, 171 to 186 and 388 to 417 ms after the reader
   agreed, and loaded in 0.18 to 0.22, 2.9 to 3.9 and 6.1 to 6.8 s, every
   load with no `Checking` line; on a second visit, from the browser's
   store, the same.  A hover over a name took 0.5 to 0.7, 5.8 to 7.1 and
   11.1 to 12.7 s.  From source (the reader's "Check from source"),
   `Overture.Signatures` type-checked 11 modules in 2.1 s, and
   `Setoid.Algebras.Basic` its 170 in 2 min 10 s at a load near 9; after a
   reload each opened in 0.21 and 3.7 s, with nothing type-checked, from the
   interfaces the drive kept.

### A copy in the playground

+  **A module's copy**: the read-only tab's line copies the module to
   `/play/<Name>.lagda.md`, its module line renamed to the name the reader
   gives: `play.agda-lib` has `include: .`, so a path under `/play/` names
   its module (`/play/X/Y.lagda.md` is `X.Y`).  The rename is the first
   `module` line in the module's code, which keeps a parameterized module's
   parameters.
+  **A selection's copy**: `/play/<Name>.agda`, the module's code from its
   start through the selection's last line, with prose left out (Agda reads
   prose as blank lines, so the code means what it meant), and the cursor
   at the selection.  The selection alone, under the module's imports, does
   not check when it uses a name defined above it in the module
   (`NotInScope`); checked natively at the compiler's commit over 278
   selections (the last defining code block of every module that has one),
   this rule's copies all checked, with no module of the library checked
   again.
+  **The name** offered is the module's last part, or that with a number
   when Agda finds it already.  A name Agda finds anywhere on the
   playground's include path (`/play`, agda-algebras' `src`, the standard
   library's `src`, the builtins), with any suffix Agda tries, or a file of
   the playground's own (Main among them, before its first check writes it
   to the drive), is refused before anything is written, as are `λ`, `_`,
   a part with `__`, and a name in Agda's namespace (`Agda.…`, which the
   import planner takes for a builtin).  A copy that kept the library's
   name fails with `LibTooFarDown` at `/play/Signatures.lagda.md` (its
   library is too close to the file for a two-part name), and at
   `/play/Overture/Signatures.lagda.md` with `AmbiguousTopLevelModuleName`,
   which also breaks Main's import of the library's module in the next
   session.
+  **Where it is kept**: the copy is written where Agda reads it
   (`writeSource`), and its text kept in the browser under its own key,
   `agda-web-ide-beta:doc:<path>`.  Those keys are the list of the
   playground's files (so two tabs that each make a copy cannot drop each
   other's), which the Explorer's playground section shows and the page
   writes to the drive when Agda starts (`BrowserConfig.files`), so that
   Main can import a copy whatever the drive's cache holds.  It opens
   editable, in its own state, and is checked.
+  **An import in Main**: the line also adds `open import` of the module to
   Main, after Main's last import, as an edit undo takes back, and Main is
   checked.

## The checks

The language server's only test is the page itself, since a reactor's
exports are called from JavaScript and no standalone runtime calls them.

+  **The browser check** (`scripts/browser-check/run.mjs`, `make
   browser-check`) serves a built site, opens it with a fresh profile, and
   uses it as a reader would: "Agda ready", the first check of the default
   `Main.agda` with `Main` alone type-checked and its one goal with its
   context, Infer, a give, a type error at its position, a postulate
   refused under `--safe`, and a module of agda-algebras imported and
   type-checked from source, with the version Agda reports in the status
   bar; then the editor's states ([#10]): a module of agda-algebras opened
   read-only and loaded with nothing type-checked or written, a keystroke
   that changes nothing, hover and Infer in its scope, undo kept to its
   file, a copy that checks and whose goal answers, and the control, the
   library's name in the copy's module line, which Agda refuses.
   It serves the site without the isolation headers and asserts
   `crossOriginIsolated` false, or with them (`--isolated`, `make
   browser-check ISOLATED=1`) and asserts it true; it fails at once on an
   uncaught exception in the page.  CI runs it both ways in headless
   Chromium; `--browser firefox` runs it in Firefox through WebDriver BiDi
   (`bidi.mjs`), by hand.
+  **The notices** (`scripts/browser-check/notices.mjs`, `make
   browser-check-notices`), in CI too: a browser without
   `DecompressionStream`, a compiler request answered 404, a compiler that
   is not a gzip, and a standard library whose transfer breaks off, each
   with its notice, the heading and the status bar saying that Agda did not
   start, and the compiler asked for only where the browser can run it.
+  **The gate** (`scripts/library-archives/gate.mjs`, `make library-gate`,
   [#13]) runs the engine's browser transport in headless Chromium against
   a built site's reactor, a fresh session per root of agda-algebras with
   only the archives its index names, and asserts that each check
   type-checks `Main` alone; `docs/notes/library-archives.md` describes it.
   CI runs it in `library-archives.yml`.
+  **The browsers** the page is tested in, and what it needs, are in the
   README's "Browsers": Chromium 149 and Firefox 157, both ways, on
   2026-10-08; WebKit untested.

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
[#10]: https://github.com/formalverification/agda-native-ide/issues/10
[#11]: https://github.com/formalverification/agda-native-ide/issues/11
[#13]: https://github.com/formalverification/agda-native-ide/issues/13
[#14]: https://github.com/formalverification/agda-native-ide/issues/14
[#49]: https://github.com/formalverification/agda-native-ide/issues/49
[#50]: https://github.com/formalverification/agda-native-ide/issues/50
[#58]: https://github.com/formalverification/agda-native-ide/issues/58
[#59]: https://github.com/formalverification/agda-native-ide/issues/59
[#61]: https://github.com/formalverification/agda-native-ide/issues/61
[#62]: https://github.com/formalverification/agda-native-ide/issues/62
[adr-0003]: ../adr/0003-the-shared-core.md
[engine]: ../engine/overview.md
[playground-record]: ../measurements/playground-2026-10-12.json
[tabs-record]: ../measurements/library-tabs-2026-10-13.json
