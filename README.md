<!-- File: README.md -->

# agda-native-ide

An Agda workbench for the browser, VS Code and Emacs, sharing one core, on
Agda 2.9.0.  In a browser tab, with no server, the type-checker is loaded by
default and everything else is a plugin: libraries, corpora, models and
tools.  A reader opens a library in an Explorer, writes in a `Main.agda`
buffer, and reads Agda's goals and errors in an info pane.  In VS Code, a
companion extension beside agda-mode-vscode gives an author the same views
and the same tool contract over a native Agda on their own checkout, where
the agents already are.  In Emacs, agda2-mode's commands are exposed to
agents and the corpus is searched from a picker.  Everywhere, a model works
through the tool contract agda-native-air's `agda-mcp` defines, judged by
Agda and never by itself.

The browser IDE forks [plfa-playground], the browser Agda environment behind
<https://plfa.isotopy.xyz/> (SvelteKit, CodeMirror 6, and the Agda Language
Server compiled to WASI).  Its first deliverable is the agda-algebras IDE:
the "Playground" link on the [agda-algebras] site opens it in a new tab,
with every module of that library in the Explorer.  The plan was revised on
2026-10-05 to target all three platforms on Agda 2.9.0; [ADR
0002][adr-0002] records that decision.

## Status

Milestone 0, foundations.  The fork is imported: plfa-playground at
`ae0aa84c`, without its binaries, which the flake pins by hash, and with
the changes [`docs/provenance.md`][provenance] lists.  `nix build .#site`
builds it reproducibly, and on every pull request CI builds it twice and
compares, runs its unit tests and type checks, and checks `Main.agda` in
headless Chromium.  Nothing is deployed.

## Where things are

+  **The app**, as imported from plfa-playground: `src/` (the page, the
   controller, and the language server's worker), `static/` (the files served
   as they are), `scripts/*.mjs` (the build's post-step and the PLFA
   tooling), `compiler/` (the recipe that builds the compiler, Agda 2.9.0 and
   its language server, `build-agda-2.9.0.sh`, with its patches and pins, and
   upstream's recipe for the fork's 2.8.0 compiler), `stdlib/patches/` (the
   standard library 2.3's patches for Agda 2.9.0), and the build's
   configuration (`package.json`, `svelte.config.js`, `vite.config.js`,
   `tsconfig.json`, `tsconfigs/`).  Upstream's own guide is
   [`README.plfa-playground.md`][upstream-readme]; its "Run locally" assumes
   the binaries are committed, so follow "Working on the app" below instead.
+  [`docs/adr/0001-runtime.md`][adr-0001]: ADR 0001, the runtime: why this
   fork, how it is imported and pinned, and the second lane.  Its
   companion, [`docs/notes/runtime.md`][runtime-note], explains how the
   runtime works.
+  [`docs/adr/0002-where-the-workbench-lives.md`][adr-0002]: ADR 0002, where
   the workbench lives: three platforms with different jobs, one shared
   core, and Agda 2.9.0, with the measurements behind them and the risks.
   Its companion,
   [`docs/notes/platform-brief-2026-10-05.md`][platform-note], is the
   platform brief of 2026-10-05 that argued for it, corrected where it has
   since changed or proved wrong.
+  [`docs/provenance.md`][provenance]: where every imported file and every
   pinned binary comes from, with its SHA-256 and its license.  The machine
   records are in [`upstream/`][records].
+  [`NOTICE`][notice]: every artifact the app ships, with its license; the
   build publishes it as `NOTICE.txt`, with the license texts in
   [`licenses/`][licenses].
+  [`docs/GITHUB_PROJECT.md`][plan]: the plan, with nine milestones (the
   foundations, the agda-algebras IDE, plugins, the tool surface, agents in
   the browser, the theory view, the proof view, the VS Code companion, and
   Emacs) and their issues.  The issues on GitHub own their bodies, and many carry the
   measurements that shaped them.
+  [`docs/notes/browser-ide-proposal.md`][proposal]: the proposal this project
   follows, carried from agda-native-air (its header names the source commit).

## Working on the app

Everything here runs in the dev shell (`nix develop`), which carries node
22.22.2, make, gh and the plan file's engine.  The binaries the app ships
(the compiler, the archives, the fonts and one icon) are not in git: `make
assets` fetches them by hash into `static/`, with Agda's builtin library and
the patched standard library, which the flake builds (`nix build
.#agda-data`, `nix build .#stdlib`).  The compiler is fetched by the hashes
in `compiler/agda-2.9.0.sha256` (`nix build .#compiler`) from the release
`agda-2.9.0-da66a8c-als-8` of [formalverification/agda-wasm-builds]
([#58]); the site ships its reactor build and that build's JavaScript glue
([#59]).  `nix develop .#compiler --command compiler/build-agda-2.9.0.sh
OUT` rebuilds the four files from their sources (a run took 27 minutes on
a 20-core workstation).

```sh
make assets                 # fetch the pins and the compiler, build the rest, into static/
make check                  # svelte-check
make test                   # the unit tests (vitest)
make build                  # check the pins, then npm run build, into build/
make browser-check          # check Main.agda in build/ in headless Chromium
make browser-check-notices  # check what build/ says when it cannot run
make dev                    # serve the app at http://localhost:5173
```

`make check`, `make test`, `make build` and `make dev` first install the
locked npm dependencies (`npm ci`) whenever `package.json` or
`package-lock.json` is newer than the last install.  `make build` refuses
to build when a file in `static/` differs from its pin; `make assets` puts
it back.  `build/` is a static site that any static server can serve: the
page shares no memory between threads, so it needs no cross-origin
isolation and no particular headers ([#59]).

`nix build .#site` builds the same site in the Nix sandbox, from a clean
clone: it runs `make build` with the pinned binaries and the npm
dependencies `package-lock.json` names, each fetched by hash, and reaches
the network for nothing else.  The build is named by the commit it is built
from (SvelteKit's version, with `-dirty` for a tree that differs from it),
and two builds of one commit are identical: `nix build .#site --rebuild`
builds it again and fails if a byte differs.  After a change to
`package-lock.json`, update `npmDepsHash` in `flake.nix` (its comment says
how).

`make browser-check` (or `nix run .#browser-check -- <site>`, for any
built site, such as `nix build .#site`'s `result`) serves the site and uses
it in headless Chromium, with node and Chromium pinned by the flake.  It
waits for "Agda ready" and the first check of the default `Main.agda`,
asserts two open goals and the modules that check type-checked (the
`Checking` lines of Agda's running info, read from the inspector after an
Infer), gives at a goal, and checks a deliberate type error.  It serves
the site without the two isolation headers and asserts that the page is
not cross-origin isolated; `make browser-check ISOLATED=1` (`--isolated`)
sends them and asserts that it is.  It writes its timings, every request
and a screenshot into `browser-check/` (`browser-check/isolated/`), and
CI's [`site.yml`][site-ci] runs it both ways on every pull request.  It is
the language server's only test, since the server's reactor build cannot
run under a standalone runtime such as wasmtime: its exports are called
from JavaScript.  With `--browser firefox`, and `FIREFOX` naming a Firefox,
`scripts/browser-check/run.mjs` drives Firefox through WebDriver BiDi
instead (`scripts/browser-check/bidi.mjs`); CI does not.

`make browser-check-notices` (`nix run .#browser-check-notices -- <site>`)
checks what the page says when it cannot run: in a browser without
`DecompressionStream`, it names what is missing and the browsers it is
tested in, and when the compiler's request fails, the compiler does not
decompress, or the standard library's transfer breaks off, it says so; in
each case the status bar says that Agda did not start, never "Agda ready".
CI runs it too.

`make provenance-check` verifies that every imported file recorded as
unchanged still is, and that `docs/provenance.md` lists every pin.  To
change an imported file, say so in a header comment naming the upstream file
and commit (for JSON, which carries no comment, in `docs/provenance.md`
alone), remove its line from `upstream/unchanged.sha256`, and add a row to
the "Changes to upstream files" table in `docs/provenance.md`.

## Theme

The **Theme** control beside the editor tab offers System, Light and Dark.
System follows the operating system's preference, including changes while
the page is open.  A Light or Dark choice applies to the page, CodeMirror
and Agda's highlighting, and persists in localStorage beside the document.
Choosing System clears that override.  The saved choice is read before
first paint; when theme storage is refused, the control still switches
for the current visit.

The colors are tokens in `static/theme.css`, loaded in the document's
head.  `make test` reads that stylesheet and checks text against the page
and highlight surfaces, and UI boundaries and focus against the surfaces.
The Chromium run of `make browser-check` also exercises theme choices,
system changes, saved choices before paint, drawn Agda colors, refused
theme storage and narrow viewports.  It writes `themes/light.png`,
`themes/dark.png` and `themes/themes.json` under `browser-check/`; CI
includes them in the private `browser-check` artifact.  The local
measurement is archived in [`docs/measurements/dark-theme-2026-10-10.json`](docs/measurements/dark-theme-2026-10-10.json).

## Browsers

The page is tested in the browsers below, and other browsers are not
supported: in a browser that lacks what the page needs, the page says what
is missing and where it is tested, and works around nothing ([#8]).

| Browser | Version | How | Last passed |
|---|---|---|---|
| Chromium, headless | 149.0.7827.200, the flake's | `make browser-check`, without the isolation headers and with them, and `make browser-check-notices`; CI, on every pull request | 2026-10-08 |
| Firefox, headless (Ubuntu's snap) | 157.0 | `run.mjs` and `notices.mjs` in `scripts/browser-check/`, with `--browser firefox`, without the headers and with them, by hand | 2026-10-08 |

WebKit (Safari) is untested: none was at hand.  Before it starts Agda,
the page checks for module workers, `DecompressionStream`, and the five
WebAssembly features the compiler uses (SIMD, reference types, bulk
memory, sign extension, and non-trapping float-to-int conversions;
`src/lib/support.ts`).  By MDN's compatibility data and WebAssembly's
feature table, a browser has them all from Chrome 96, Firefox 114 and
Safari 16.4; those are floors, not a promise.  IndexedDB is optional:
without it the page runs, uncached.

## Syncing with upstream

The import is a snapshot, so a later upstream commit comes in file by file,
guided by the records in `upstream/`.  Start from a tree where `make
provenance-check` passes.

1. Add the remote (once), fetch it, and name the two commits:

   ```sh
   git remote add upstream https://github.com/SeungheonOh/plfa-playground
   git fetch upstream
   OLD=ae0aa84c24363a8d6dadc292b6eb8f88f7f38705   # upstream.rev in flake.nix
   NEW=$(git rev-parse upstream/master)
   ```

2. List what upstream changed since the import, against the record:

   ```sh
   scripts/upstream-record.sh "$NEW" | diff upstream/plfa-playground.sha256 -
   ```

   A `<` line is the file as recorded, a `>` line the file at `$NEW`.

3. Bring each change in, by what became of the file here
   (`docs/provenance.md` says):

   +  **Still upstream's** (its path is in `upstream/unchanged.sha256`):
      take the new version, at its path here, for example
      `git show "${NEW}:src/lib/index.js" > src/lib/index.js`, or
      `git show "${NEW}:README.md" > README.plfa-playground.md`.
   +  **Changed here**: merge three ways, and resolve any conflict it marks:

      ```sh
      base=$(mktemp) && theirs=$(mktemp)
      git show "${OLD}:package.json" > "$base"
      git show "${NEW}:package.json" > "$theirs"
      git merge-file package.json "$base" "$theirs"
      ```

   +  **Pinned**: replace its line in `upstream/assets.sha256` with its `>`
      line from step 2, and its row in `docs/provenance.md`.
   +  **New upstream**: import it with `git show` if it is text, or pin it if
      it is binary.  **Removed upstream**: remove it here, unless it was
      changed here.

   In zsh, keep the braces in `"${NEW}:path"`: zsh reads `"$NEW:src/..."`
   as a history modifier and stops with "bad substitution".

4. Update the records and the pins:
   `scripts/upstream-record.sh "$NEW" > upstream/plfa-playground.sha256`;
   re-record in `upstream/unchanged.sha256` each file taken unchanged or
   newly imported (its `sha256sum` line); set `upstream.rev` in `flake.nix`
   to `$NEW`; and update `docs/provenance.md`, the upstream commit
   included.

5. Check, and commit as "Sync with plfa-playground at <commit>":

   ```sh
   make assets && make provenance-check
   make check && make test && make build && nix build .#site
   ```

   then check `Main.agda` in a browser.

## The plan

The shell also carries the plan file's engine, from
[williamdemeo/github-project], pinned in `flake.lock`:

```sh
make lint            # check the plan file's structure (no network)
make update          # mirror the issues' state from GitHub into the plan
make update-check    # is the plan current?  (the drift gate)
make populate-dry    # what populate would create
```

Edit issue bodies on GitHub, not in the plan file's generated regions, and
run `make update` afterwards.  `make help` lists every target.

## License

MIT; see [`LICENSE`](LICENSE), which names upstream's copyright line ("Copyright
2026 Andy Pan", which plfa-playground carries from agda-web/als-demo) and its
author, Seungheon Oh.  Upstream's license is kept verbatim as
[`LICENSE.plfa-playground`][upstream-license].  [`NOTICE`][notice] names
every artifact the app ships, with its license.

[plfa-playground]: https://github.com/SeungheonOh/plfa-playground
[agda-algebras]: https://agda-algebras.universalalgebra.org/
[upstream-readme]: README.plfa-playground.md
[upstream-license]: LICENSE.plfa-playground
[adr-0001]: docs/adr/0001-runtime.md
[runtime-note]: docs/notes/runtime.md
[adr-0002]: docs/adr/0002-where-the-workbench-lives.md
[platform-note]: docs/notes/platform-brief-2026-10-05.md
[provenance]: docs/provenance.md
[site-ci]: .github/workflows/site.yml
[records]: upstream/
[notice]: NOTICE
[licenses]: licenses/
[plan]: docs/GITHUB_PROJECT.md
[proposal]: docs/notes/browser-ide-proposal.md
[williamdemeo/github-project]: https://github.com/williamdemeo/github-project
[formalverification/agda-wasm-builds]: https://github.com/formalverification/agda-wasm-builds
[#8]: https://github.com/formalverification/agda-native-ide/issues/8
[#58]: https://github.com/formalverification/agda-native-ide/issues/58
[#59]: https://github.com/formalverification/agda-native-ide/issues/59
