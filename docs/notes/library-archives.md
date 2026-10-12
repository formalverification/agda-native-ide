<!-- File: docs/notes/library-archives.md -->

# agda-algebras' archives

This note explains how the IDE's copy of agda-algebras is built for the page:
its interfaces built by the Agda the page runs, packed so that a reader's
imports fetch what they need and nothing else, and indexed from the
dependency graph Agda itself computes ([#12]).  [ADR 0001][adr] § 10 records
the decisions; this note is the explanation it links.  Nothing here is
mounted by the page yet: that is [#14]'s work, the playground project that
imports the library is [#11]'s, and the Explorer that lists its modules is
[#9]'s.  Every figure is from the runs of 2026-10-11 that [#12]'s findings
describe: the local ones in
[`docs/measurements/library-archives-2026-10-11.json`][record], with the
machine and its load, and the runner's in its run; and the gate's, which
checks them under the page's own language server ([#13]), from the runs of
2026-10-12 in
[`docs/measurements/library-archives-browser-2026-10-12.json`][gate-record].

An *interface* (`.agdai`) is what Agda writes after it type-checks a module:
the module's definitions in a binary form, which a later check that imports
the module reads instead of checking it again.  Agda accepts an interface
only when the same Agda wrote it, from the same source, under the same
options, against imports with the same hashes, and a rejected one is checked
again without a word.  Under Agda 2.9.0 the interface's integers also have
the word size of the Agda that wrote it, so the page's 32-bit (wasm32) Agda
reads only what a wasm32 Agda wrote ([#58]; ADR 0001 § 7).  So every
interface here is built by the compiler's own plain `agda.wasm`, and
acceptance is counted, never inferred: Agda prints one `Checking` line for
each module it type-checks (indented for nested ones, so the count is
unanchored), and a check that found every interface it needed prints one,
for the module checked.

## What the package builds

`nix build .#agda-algebras-archives` is the one command.  Its output is the
following:

+  `index.json`, the index (below);
+  `agda-algebras-sources.zip`, agda-algebras' sources as the page will
   mount them: `agda-algebras/agda-algebras.agda-lib`, `agda-algebras/src/`,
   and the license texts its `NOTICE` names for them (`LICENSE`,
   `LICENSE-data`, `NOTICE`), deflated;
+  `interfaces/*.zip`, the interface archives: one per agda-algebras
   module, named by the module (`interfaces/Setoid.Varieties.HSP.zip`), and
   one per group of standard-library modules (below), named by a digest of
   the group's members (`interfaces/stdlib-bbd88e40b6f4.zip`);
+  `summary.md`, the sizes: by library, the archives, a fixed set of
   roots, and the spread over every root.

It is built in three derivations, so that each step reruns only when its
own inputs change:

| Package | Script | What it does |
|---|---|---|
| (internal) | `flake.nix`, `mkAgdaAlgebrasSources` | Zips the pinned sources. |
| `agda-algebras-interfaces` | `scripts/library-archives/build.sh` | Builds the interfaces and the graph, under wasmtime. |
| `agda-algebras-archives` | `scripts/library-archives/pack.mjs` | Packs them and writes the index. |
| `agda-algebras-check` | `scripts/library-archives/check.sh` | Checks every root from the archives the index names. |

Each derivation copies only its own scripts into the store, so a change to
the check does not rebuild the interfaces.

## The build

(`scripts/library-archives/build.sh` and `stage.sh`.)

+  **The inputs**: agda-algebras at the commit `flake.nix` pins
   (`agdaAlgebras`, a `fetchFromGitHub` with its hash, beside the standard
   library's `stdlibSource`); the three archives the page mounts, exactly as
   it ships or will ship them: `agda-data.zip` (the builtins, with their
   interfaces, built by the same `agda.wasm`; `mkAgdaData`),
   `agda-stdlib-2.3-patched.zip` (`mkStdlib`) and
   `agda-algebras-sources.zip`; the compiler's `agda.wasm` (`nix build
   .#compiler`); and nixpkgs' wasmtime, 38.0.4 at this flake's nixpkgs.
+  **The stage**: a directory laid out as the page's drive (`layOutDrive`,
   in the engine's `packages/engine/src/browser/worker/drive.ts`), from those
   archives, and mounted as the guest's root (`wasmtime run --dir
   <stage>::/`), with `HOME=/home/root` and `Agda_datadir=/`, as the page's
   server has them (`packages/engine/src/browser/worker/als.ts`):

| Path on the drive | From |
|---|---|
| `/lib/prim` | `agda-data.zip`: the builtins' sources and interfaces |
| `/stdlib` | the standard library's archive: `src/` and `standard-library.agda-lib`, as `layOutDrive` takes them |
| `/agda-algebras` | agda-algebras' sources archive: `agda-algebras.agda-lib` and `src/` |
| `/home/root/.config/agda/libraries` | written: the two `.agda-lib` files |

+  **What the layout buys**, each measured: every interface lands under its
   library's `_build/2.9.0/agda/src/`, where the server looks (mounted as
   the guest's root, Agda's walk for a project root ends at `/`); the
   builtins' interfaces from `agda-data.zip` are accepted (no `Checking`
   line has a path under `/lib/prim`); and the paths Agda stores in an
   interface (with a deprecation warning, for one) are the page's, not the
   build machine's.  Where agda-algebras sits, `/agda-algebras`, is the
   layout [#11]'s finding of 2026-10-04 used; [#11] and [#14] settle it.
+  **What is built**: every module of agda-algebras' include path, `Legacy/`
   included, since a reader may import any of them, and the standard-library
   modules they import, not the whole standard library.  `agda
   --build-library`, run at `/agda-algebras`, does this: it finds every Agda
   file in the library's include path, sorts the paths, and checks them one at
   a time, so its order does not depend on the filesystem
   (`Agda.Interaction.BuildLibrary` at the pin), and no generated
   `Everything.agda` is needed (agda-algebras' own Makefile writes two, which
   are not tracked).  It took 5 min 54 s to 6 min 59 s in three builds here
   with the machine quieter, 10 min 27 s to 12 min 27 s in three while other
   sessions loaded it (1-minute loads of 2.1 to 3.5 before them), and 10 min
   33 s on GitHub's runner: this workstation's cores fall to 2.2 GHz under
   load, from a peak of 5 GHz, so its times move with its load.
+  **The graph**: a module `All` in `/play`, importing every module of
   agda-algebras, checked with `--dependency-graph` over the built stage, so
   that only `All` is checked (11.2 to 22.5 s here).  Agda builds the graph
   from each interface's own list of imports and reduces it transitively
   (`Agda.Interaction.Highlighting.Dot.Backend`): reachability in it is exact,
   though its edges are not a module's imports.  The index takes every closure
   from it, never from the sources: the fork's PLFA index reads imports with a
   regular expression, which misses an `open import` inside a parameterized or
   nested module ([#12]'s finding of 2026-10-04).
+  **wasmtime compiles `agda.wasm` before it runs it**: 13.6 to 22.9 s and 4.4
   GiB of resident memory here (4,549,816 to 4,568,428 KiB), and 1 min 12 s on
   the runner's two cores.  It caches the result under `$HOME/.cache`, so each
   derivation gives it a writable `HOME` and pays the compile once; without
   the cache every run pays it.  The 4.4 GiB at once is the build's peak, on a
   runner with 7.8 GiB.
+  **The heap**: a wasm32 heap cannot pass 4 GiB, and running out is an error,
   not swapping.  The whole build, one process, held 995 MiB of GHC's total
   memory in use (`+RTS -s`; maximum residency 584,345,808 bytes; 981 MiB on
   the runner), about a quarter of the cap.  If the library outgrows it, the
   build stops with an error and nothing is shipped; the remedy is to split it
   into several `agda` processes over the same stage (by top-level directory,
   say, in a fixed order), since what a process holds is what its own session
   has loaded, and the interfaces persist between processes.  The page's own
   heap is a separate question: a check of the umbrella module
   `agda-algebras`, which reaches 603 modules, peaked at 1,029,252 KiB under
   wasmtime here, and 1,048,188 KiB on the runner.

## Reproducibility

+  **The bytes reproduce**: six builds of the interfaces here wrote the same
   output (the third by `nix build .#agda-algebras-interfaces --rebuild`,
   which builds again and fails if a byte differs, and the fifth by `build.sh`
   outside the sandbox, at a host path), and `--rebuild` of the archives
   passes.  The control shows that the comparison can fail: with a timestamp
   written into the archives' output (an uncommitted line in `pack.mjs`),
   `--rebuild` stopped with "may not be deterministic: output ... differs",
   and `diff -r` named the file.  On GitHub's runner the same `--rebuild`
   passed, and the index it wrote, which holds every archive's SHA-256, is
   byte for byte the one built here (run [38153481044][run]): all 395 archives
   reproduce across machines.
+  **One fixed procedure**: how many deprecation warnings an interface
   stores depends on the order the build checks the modules in.  The probe
   of 2026-10-10 built the same inputs through a generated `Everything.agda`
   and then `--build-library`; 600 of its 601 interfaces equal the
   package's byte for byte, and the umbrella module `agda-algebras` differs:
   314,087 bytes against 284,544, its payload holding 70 deprecation
   warnings that name `Legacy/` sources, where the package's holds none.
   So the order is part of the build, and `--build-library`'s is fixed.
+  **No host path enters**: the guest's paths are the same in every build,
   so the 65 interfaces that native builds in two directories wrote
   differently ([#61]) cannot differ by path here.

## The packing

(`scripts/library-archives/pack.mjs`.)

**The rule**: one archive per agda-algebras module, holding its interface;
and the standard-library modules grouped by the set of agda-algebras modules
that reach them, one archive per group.

+  **Why it costs nothing extra**: two standard-library modules in one group
   are reached by exactly the same agda-algebras modules, so a set of
   imports from agda-algebras needs either every module of a group or none
   of them.  The archives an import needs therefore hold exactly its
   closure's interfaces, for any set of agda-algebras roots: the bytes
   fetched exceed the floor (the closure's own interfaces) by the zip
   headers alone.  An agda-algebras module is reached by itself, so no two
   share a group, which is why each has its own archive.  A reader who
   imports a standard-library module that agda-algebras does not reach
   checks it from source; one that agda-algebras does reach may bring the
   rest of its group.
+  **What it gives** (agda-algebras `f067d57d`): 395 archives, 350 of
   agda-algebras and 45 groups of the standard library, 70,104,812 bytes in
   all.  The largest, 6,965,690 bytes, is a group of 45 standard-library
   modules that 293 of the 350 roots need; every archive is far under the
   25 MiB that Cloudflare Pages allows a file ([ADR 0001][adr] § 3), though
   183 of the 350 closures need more than 25 MiB, so a closure is never one
   file.  For the fixed roots (the modules count a closure's builtins too,
   which are on the drive from the start; the floor is the closure's other
   interfaces):

| Imports | Modules | Archives | Bytes fetched | Floor |
|---|---:|---:|---:|---:|
| `Overture.Basic` | 66 | 14 | 4,318,471 | 4,306,193 |
| `Setoid.Algebras.Basic` | 179 | 50 | 16,974,016 | 16,939,046 |
| `Setoid.Varieties.HSP` | 313 | 128 | 39,251,541 | 39,186,131 |
| the three together | 313 | 128 | 39,251,541 | 39,186,131 |
| `agda-algebras`, the umbrella module, the heaviest root | 603 | 385 | 69,376,238 | 69,242,574 |

Under Agda 2.8.0, [#12]'s packing fetched 99 files and 54.6 MB for the
three together, against a floor of 54.3 MB.

+  **Against the alternatives**, on the same interfaces: [#12]'s
   recommendation from 2.8.0's numbers, the standard library in tiers by the
   first top-level directory of agda-algebras that needs a module
   (reconstructed here in the order `Overture`, `Order`, `Setoid`,
   `Classical`, `Examples`, `Exercises`, `Legacy`), fetches 15,858,563 bytes
   for `Overture.Basic` against a floor of 4,306,193, since its tier carries
   everything any `Overture` module needs, and 4.0% over the floor for the HSP
   root; and grouping agda-algebras' own modules by their first two name
   components cuts the HSP root from 128 archives to 58, at 6.2% over the
   floor there and 18.9% for the median root.  The cost of the rule is the
   number of files: 82 for the median root, 128 for the HSP root, 385 for the
   umbrella module.  The page fetches them at once: the controller's
   `mountDriveArchives` (`src/lib/controller.svelte.ts`) hands them to the
   engine's browser transport, whose `mountArchives`
   (`packages/engine/src/browser/index.ts`) fetches them in parallel, over
   HTTP/2 from any of the hosts [#6] weighs.
+  **Stored zips**: the payload of a 2.9.0 interface is already zstd, so
   gzip saves 0.09% on the HSP closure (the probe), and a stored zip costs
   nothing to unpack; but the name matters, since Cloudflare caches `.zip`
   and `.gz` at its edge and not `.agdai` or `.json`, and the drive's
   `mountArchive` takes a zip.  Entries are sorted, at their paths on the
   drive (`agda-algebras/_build/2.9.0/agda/src/...`, `stdlib/_build/...`),
   with one fixed time, so an archive's bytes depend on its inputs alone.
+  **The names**: an agda-algebras archive is named by its module; a
   standard-library group by a digest of its members' names, so its name
   changes only when its membership does.  The index carries each archive's
   SHA-256, which [#14] uses for the cache and the URL's `?cache=` token.
+  **The sources come beside the standard library's, not inside it**:
   `agda-algebras-sources.zip`, 985,864 bytes, deflated, holding every module
   (the Explorer lists them, [#9]).  It is a different library, at a
   different pin, under a different license, and the standard library's
   archive is an asset the page already ships under its own cache token;
   joining them would change that archive whenever agda-algebras moves.
   The page mounts it eagerly with the standard library's.

## The index

`index.json`, schema 1, is the contract with the issues that read it: [#14]
reads which archives an import needs and their bytes before it fetches,
[#13] reads the roots to check, and [#9] reads every module with its path.
`scripts/library-archives/index.mjs` reads it through two functions,
`closure` and `needs`, which compute what those issues are to compute, and
the check stages each root from what `needs` says.

| Field | What it holds |
|---|---|
| `schema` | 1 |
| `agda` | `version` (the `_build/<version>` the interfaces live under) and `wasm`, the SHA-256 of the `agda.wasm` that built them |
| `libraries` | per library (`agda-algebras`, `standard-library`, `builtins`): its `root` on the drive, its `.agda-lib` (`agdaLib`), its `name` as a `depend:` line names it, and its `sources` archive (`path`, `bytes`, `sha256`); agda-algebras' also its `commit` |
| `roots` | every module of agda-algebras, sorted: what a reader can import |
| `archives` | per interface archive, by its path in the output: `bytes`, `sha256`, and the number of `modules` it holds |
| `modules` | per module of the closure of agda-algebras (its 350, the standard library's 251, and 12 builtins): its `library`, its `source` and `interface` paths on the drive, the interface's `bytes`, its `archive` (`null` for a builtin, whose interface is in `agda-data.zip`), and `deps`, its successors in Agda's graph |

To find what a set of imports needs: walk `deps` from the imported modules
(everything reached is the closure, since Agda's graph keeps reachability
exact), and take each reached module's `archive`, less `null`.  An import
the index does not list (a standard-library module agda-algebras does not
reach, or a reader's own) has no archive here, and Agda checks it from
source; `needs` returns it in `unknown`.  The index
is one archive and one module per line, so that two indexes diff by line.
It is 285,618 bytes, 42,353 gzipped.

## The check

(`scripts/library-archives/check.sh`, `nix build .#agda-algebras-check`.)

+  **What it proves**, [#12]'s second criterion: for each root, a fresh
   stage with the builtins, both libraries' sources, and only the archives
   the index names for that root; a `/play/Main.agda` that imports the root
   under agda-algebras' options line (`{-# OPTIONS --without-K --exact-split
   --safe #-}`, which all 350 modules carry), in a play library that
   depends on both libraries; and the compiler's `agda.wasm`, which must
   exit 0 having printed one `Checking` line.  Anything else fails.
+  **Every root, every time**: 350 of 350 in the sandbox here, eight at once,
   in 7 min 21 s (the checks' own times sum to 3,271 s, at the machine's clock
   under that load); the slowest root, `Examples.Classical`, 25.7 s, and the
   largest memory, the umbrella module's, 1,029,252 KiB.  An earlier run,
   before the script's last change, took 7 min 25 s; the runner's, two at
   once, 30 min 6 s.  Each check is one thread, so the job scales with the
   cores it is given.
+  **Two controls**, run after the roots on `Overture.Basic`, each of which
   must print more than one `Checking` line, or the check could not fail:
   the root's own archive left out (Agda checks `Overture.Basic` again, and
   exits 0 with 2 lines), and the first byte of its source changed under
   its interface (Agda checks it again and then cannot write its interface,
   2 lines, exit 42).
+  **How a root is staged**: each archive is extracted once, and a root's
   stage hard-links the files it needs from those copies and from a base
   stage of the sources; every shared file is read-only, so a check that
   rejected an interface cannot overwrite what another check reads (the
   second control shows it trying).  Staging costs little, and the checks
   run in parallel (`JOBS`).
+  **A proxy for the server**: the page's Agda is the language server's
   reactor build, a separate binary of the same Agda commit at the same
   word size, which cannot run under wasmtime; the plain `agda` stands in
   for it here, and the gate below proves the same under the server itself.

## The gate

(`scripts/library-archives/gate.mjs` and `gate/`, `make library-gate`;
[#13].)

+  **What it proves**, [#13]'s two criteria: the check above, under the
   language server the site ships, its reactor
   (`als-reactor-2.9.0.wasm`), in headless Chromium.  For each root, a
   fresh session of the engine's browser transport, over a drive laid out
   from the site's own builtins and standard library and agda-algebras'
   sources archive; a play library beside `/play/Main.agda`, written as
   `stage.sh` writes it; the archives the index names for the root
   (`index.mjs`'s `needs`, as `check.sh` stages them), mounted with the
   transport's `mountArchives` as the page mounts archives; then a load of
   a `Main` that imports the root under agda-algebras' options line.  It
   passes when the load's `Checking` lines (the session's
   `LoadValue.checking`) name `Main` alone and Agda reports no error.
   Before it starts, the site's builtins and standard library must have
   the digests the index records, or it stops: archives built against
   other inputs would be checked again, and the gate would measure that.
+  **The drive's libraries**: the drive wrote Agda's registry once, as
   fixed text naming the standard library and PLFA, so agda-algebras
   could not be on it ([#11]'s finding of 2026-10-04).  The engine now
   takes a list of libraries (`BrowserConfig.archives.libraries`), each a
   zip extracted at the root, its `.agda-lib` on the drive and its name,
   the fields `index.json` records under `libraries`; `layOutDrive` writes
   the libraries file from it after the standard library's `.agda-lib`,
   which is the stage's file, and a defaults file from the names, which
   Agda reads only for a file in no library.  The page passes PLFA as the
   list's one entry, so its drive is as it was; the gate passes
   agda-algebras'.  A list rather than a slot for agda-algebras, since the
   engine is every host's, and [#14] and [#11] mount the same library.
+  **Every root, every time**: 350 of 350 on 2026-10-12 here (headless
   Chromium 149, four at once, a 1-minute load of 3.0 at the start and 8.4
   at the end, from other sessions' builds), in 12 min 49 s.  Per root,
   the engine's start took 0.53 to 2.19 s (median 0.86 s), the mount
   median 0.23 s, and Agda's load median 7.9 s, the slowest 16.8 s
   (`Classical.Structures.Group.SubgroupClassification`); summed over the
   roots, 3,020 s, of which the starts are 313 s.  An earlier run, before
   the gate's last edits, gave the same counts in 13 min 36 s at a load of
   6 to 8.5.  The fixed roots:

| Imports | Archives | Bytes mounted | Load | Heap |
|---|---:|---:|---:|---:|
| `Overture.Basic` | 14 | 4,318,471 | 2.0 s | 57 MiB |
| `Setoid.Algebras.Basic` | 50 | 16,974,016 | 3.7 s | 181 MiB |
| `Setoid.Varieties.HSP` | 128 | 39,251,541 | 8.5 s | 351 MiB |
| `agda-algebras`, the umbrella module | 385 | 69,376,238 | 15.0 s | 701 MiB |

+  **The heap** is the reactor's linear memory when the check has ended,
   which never shrinks, so it is the check's peak: a probe in the gate's
   worker (`gate/memory.ts`) keeps the instance's memory and reports its
   size.  The umbrella module's 735,248,384 bytes are the largest, a sixth
   of a wasm32 heap's 4 GiB; wasmtime's 1,029,252 KiB for the same check
   is its process's resident set, the runtime's and the compiled code's
   with Agda's.
+  **Against wasmtime**: the check's own times summed to 3,271 s eight at
   once, the gate's to 3,020 s four at once, under different loads; the
   umbrella module took 16.2 s there and 15.0 s here.  So in this
   measurement the browser is not slower than wasmtime once the drive is
   indexed, where [#50]'s figures had put it at two to five times; the
   counts, not these times, are the finding.
+  **Two controls**, after the roots, each in a fresh session, on
   `Overture.Basic`, each of which must type-check more than `Main`: its
   own archive left out, and the first byte of its source changed under
   its interface (a zip of the changed source, mounted after the
   archives).  Each type-checked `Main` and `Overture.Basic`, 2 lines, in
   2.0 and 2.2 s; here the drive is writable, so Agda writes the new
   interface and reports no error, where `check.sh`'s read-only stage made
   it exit 42.  And the gate's own exit: over a copy of the archives whose
   `Overture.Basic.zip` holds nothing, both `Overture.Basic` and `Overture`,
   which imports it, type-checked 2 modules, and the gate exited 1.
+  **A fresh session per root, not one per job**: with `--shared`, each of
   four sessions checks its roots in turn, mounting each root's archives as
   it comes, and the 350 roots took 85 s, where fresh sessions took 769 s,
   since Agda keeps the interfaces it decoded and a later root reads only
   what is new.  The heap does not decide it: the four sessions ended at
   844,693,504 to 906,166,272 bytes, the umbrella module among one
   session's roots.  What decides it is the criterion: a shared session's
   drive holds every archive mounted for its earlier roots, so a root whose
   index entry lacked an archive would still pass, and a root's closure is
   not read from the drive again.  So the gate opens a session per root,
   and pays its start, a tenth of its time, and the decoding of every
   closure; `--shared` stays as a quick run while iterating.
+  **What the record holds**: per root, its `Checking` lines, the archives
   mounted and their bytes, the three times, and the heap; the controls;
   the site's and the archives' digests and Agda's version as the server
   reports it; the machine and its load
   ([`docs/measurements/library-archives-browser-2026-10-12.json`][gate-record]).

## CI

(`.github/workflows/library-archives.yml`.)

+  **What it runs**: it builds the interfaces, packs the archives (and
   rebuilds them, a matter of seconds), checks every root, and writes the
   sizes, the check's counts and the build's time and memory to the step
   summary, uploading the index, the summary, the report and the check's
   log.  It also builds the interfaces a second time with `--rebuild`, which
   fails if a byte differs.  The archives are not uploaded: the package
   rebuilds them from the pins.
+  **When**: on demand, and on a push to `main` or a pull request that changes
   what the archives are built from (the flake and its lock, the standard
   library's patches, the compiler's hashes, the scripts, the workflow), as a
   path filter; and then only if the check's derivation differs from the
   base's, or the workflow changed.  The job evaluates
   `.#agda-algebras-check.drvPath` at the base (the pull request's base, or
   the commit before a push) and at the head, in seconds, and builds nothing
   when they are equal, since that derivation is the one the base proved.
   Nearly every change touches `flake.nix`, so without the guard an
   unrelated change would build everything (58 minutes on a 2-core runner);
   with it, a push that changed nothing the archives are built from took
   21 s (run [38159537130][skip]).  A newer run cancels one in
   progress on a pull request, never on `main`, since a later push's guard
   compares against the commit before it.
+  **What it measured** on GitHub's runner while the repository was private
   (2 cores, 7.8 GiB, 3 GiB of swap, none used; 2026-10-11, run
   [38153481044][run]), 58 minutes in
   all: the interfaces with their inputs in 13 min 43 s, `--build-library`
   itself 10 min 33 s (981 MiB of GHC's total memory in use) after
   wasmtime's compile, 1 min 12 s at 4,501,604 KiB; their `--rebuild` in 12
   min 3 s, passed; the archives in 8 s; and the check, two at once, in 30
   min 6 s, 350 of 350, the controls 2 and 2.  The memory sampled every two
   minutes never passed 2,923 MiB of 7,938 (the compile's peak falls
   between samples), and the disk went from 14 to 13 GB free.
+  **The gate**, after the check: it builds the site (`nix build .#site`)
   and runs `make library-gate` with every root, as many at once as the
   runner has cores, writing its counts, its summed times, the slowest load
   and the largest heap to the step summary and uploading its report and
   log with the records.  It runs when the check's derivation changed, and
   also when what the gate is made of did, which the derivation does not
   cover: the engine (it lays out the drive and counts the `Checking`
   lines), the gate's scripts and `index.mjs`, the DevTools driver and the
   static server it shares with the browser check, and the lockfile; the
   path filter names them, and the guard compares them with the base.  It
   runs every root wherever it runs, pull requests included, since it runs
   only when what it proves may have changed.  On GitHub's runner (4 cores,
   an AMD EPYC 9V74, 15.6 GiB; 2026-10-12, run [38209105006][gate-run],
   dispatched on [#13]'s branch, so everything was built): 350 of 350 and
   the controls 2 and 2, the gate itself in 16 min 33 s and its step,
   with `npm ci` and the page's build, in 17 min 18 s; Agda's load a median
   10.3 s and at most 23.7 s (`Examples`), the umbrella module 19.1 s at
   768,081,920 bytes.  The whole job took 48 min 56 s: the interfaces 9
   min 47 s, their `--rebuild` 9 min 6 s, the check under `agda.wasm` four
   at once 11 min 45 s, the site 29 s.  A change to the gate alone builds
   the interfaces once, without the `--rebuild`, and runs the gate: about
   half an hour while nothing is cached.
+  **Not in the site**: the site's build carries none of this until [#14]
   mounts the archives, since 71 MB the page never reads would cost every
   build and deploy.
+  **The cache**: the job reads the public `formalverification` Cachix
   cache, which agda-algebras' CI also uses, so a derivation built before is
   fetched rather than built, and it pushes what it builds from `main` only,
   since a pull request's run executes what the pull request changed (the
   write token, `CACHIX_AUTH_TOKEN`, reaches the action on `main` alone).
   It pushes none of what the flake fetches by hash from GitHub anyway: the
   compiler's files and the sources' tarballs.  `--rebuild` is never
   fetched: it builds again on the runner and compares with the first
   build, built or fetched, so on a cached run it proves the bytes
   reproduce across machines.  William's decision of 2026-10-11, with the
   repository public, where runners cost no minutes.  The token has not
   reached the action yet: `main`'s run of 2026-10-12 says "Pushing is
   disabled", so nothing is cached yet, and a change to the gate alone
   builds the interfaces again before it runs.  It does not push the site
   or its npm dependencies, which `site.yml` builds without the cache.

## Licenses

What the archives carry is licensed as its source is, since a 2.9.0
interface holds its module's source text (`iSource` in Agda's `Interface`,
kept "so that the HTML and LaTeX backends can generate their output";
`Overture.Basic`'s decompressed interface holds its front matter and prose).

+  **agda-algebras' sources and interfaces: Apache-2.0**.  The sources
   archive carries `LICENSE`, `NOTICE` and `LICENSE-data`.  An interface is
   the work in object form, which Apache-2.0 covers by name, not a
   machine-extracted representation: agda-algebras' `LICENSE-data` excludes
   "the source files under src/ themselves, in whole or in part", and an
   interface contains them whole.
+  **The index: Apache-2.0 or CC0-1.0, at the recipient's option**
   (`LICENSE-data`): module names and paths, dependency metadata, sizes and
   digests, which that file names.
+  **The standard library's interfaces: MIT**, like its sources, whose
   archive the page already ships with its `LICENCE`; **the builtins'**
   are already in `agda-data.zip`, under Agda's MIT license.
+  **When the site ships them** ([#14]), `NOTICE` and `docs/provenance.md`
   name them in the same change: agda-algebras at its commit under
   Apache-2.0 with its `NOTICE`'s text, and the index under `LICENSE-data`.

(William's decision of 2026-10-11, on the session's recommendation.)

## Moving to another commit, or another Agda

+  **agda-algebras**: change `rev` and `hash` in `flake.nix`'s
   `agdaAlgebras` together (set `hash` to `lib.fakeHash` and the build
   reports it), then `nix build .#agda-algebras-check`.  The index records
   the commit; archives whose modules changed get new digests, and the
   standard-library groups may regroup if agda-algebras' imports changed.
+  **Agda**: a new compiler (its pins in `compiler/agda-2.9.0.sha256`)
   rebuilds the builtins, the interfaces and the archives, since each takes
   the compiler as an input; the interfaces move to `_build/<version>/`,
   which `pack.mjs` reads from the build and the index records.  A new
   standard library is a new `stdlib/patches/` or source pin, and the same
   rebuild.
+  **The page's cache**: when [#14] ships the archives, their digests (or
   the index's) join the drive cache's namespace
   (`scripts/asset-manifest.mjs`), so that a cache is never restored against
   other archives.

[adr]: ../adr/0001-runtime.md
[record]: ../measurements/library-archives-2026-10-11.json
[gate-record]: ../measurements/library-archives-browser-2026-10-12.json
[gate-run]: https://github.com/formalverification/agda-native-ide/actions/runs/38209105006
[run]: https://github.com/formalverification/agda-native-ide/actions/runs/38153481044
[skip]: https://github.com/formalverification/agda-native-ide/actions/runs/38159537130
[#6]: https://github.com/formalverification/agda-native-ide/issues/6
[#9]: https://github.com/formalverification/agda-native-ide/issues/9
[#11]: https://github.com/formalverification/agda-native-ide/issues/11
[#12]: https://github.com/formalverification/agda-native-ide/issues/12
[#13]: https://github.com/formalverification/agda-native-ide/issues/13
[#14]: https://github.com/formalverification/agda-native-ide/issues/14
[#50]: https://github.com/formalverification/agda-native-ide/issues/50
[#58]: https://github.com/formalverification/agda-native-ide/issues/58
[#61]: https://github.com/formalverification/agda-native-ide/issues/61
