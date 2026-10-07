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
   controller, and the two workers), `static/` (the files served as they
   are), `scripts/*.mjs` (the build's post-step and the PLFA tooling),
   `compiler/` (the recipe that built the compiler), and the build's
   configuration (`package.json`, `svelte.config.js`, `vite.config.js`,
   `tsconfig.json`, `tsconfigs/`).  Upstream's own guide is
   [`README.plfa-playground.md`][upstream-readme]; its "Run locally"
   assumes the binaries are committed, so follow "Working on the app"
   below instead.
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
assets` fetches them by hash into `static/`, with Agda's builtin library,
which the flake builds from a pinned Agda (`nix build .#agda-data`).

```sh
make assets        # fetch the 35 pinned binaries, and build agda-data.zip, into static/
make check         # svelte-check
make test          # the unit tests (vitest)
make build         # check the pins, then npm run build, into build/
make browser-check # check Main.agda in build/ in headless Chromium
make dev           # serve the app at http://localhost:5173
```

`make check`, `make test`, `make build` and `make dev` first install the
locked npm dependencies (`npm ci`) whenever `package.json` or
`package-lock.json` is newer than the last install.  `make build` refuses
to build when a file in `static/` differs from its pin; `make assets` puts
it back.  The dev server sends the two headers the language server's shared
memory needs (`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`), and so must any server of
`build/`.

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
built site, such as `nix build .#site`'s `result`) serves the site with the
two headers and uses it in headless Chromium, with node and Chromium pinned
by the flake.  It waits for "Agda ready" and the first check of the
default `Main.agda`, asserts two open goals and the modules that check
type-checked (the `Checking` lines of Agda's running info, read from the
inspector after an Infer), gives at a goal, and checks a deliberate type
error.  It writes
its timings, every request and a screenshot into `browser-check/`.  CI's
[`site.yml`][site-ci] runs it on every pull request.  It is the language
server's only test, since the server cannot be driven under wasmtime (its
standard input cannot be made nonblocking there).

`make provenance-check` verifies that every imported file recorded as
unchanged still is, and that `docs/provenance.md` lists every pin.  To
change an imported file, say so in a header comment naming the upstream file
and commit (for JSON, which carries no comment, in `docs/provenance.md`
alone), remove its line from `upstream/unchanged.sha256`, and add a row to
the "Changes to upstream files" table in `docs/provenance.md`.

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
