<!-- File: README.md -->

# agda-native-ide

An Agda IDE that runs in a browser tab, with no server.  The type-checker
is loaded by default, and everything else is a plugin: libraries, corpora,
models and tools.  A reader opens a library in an Explorer, writes in a
`Main.agda` buffer, and reads Agda's goals and errors in an info pane; a
model can work in the same tab through the tool contract agda-native-air's
`agda-mcp` defines, judged by Agda and never by itself.

The IDE forks [plfa-playground], the browser Agda environment behind
<https://plfa.isotopy.xyz/> (SvelteKit, CodeMirror 6, and the Agda Language
Server compiled to WASI).  Its first deliverable is the agda-algebras IDE:
the "Playground" link on the [agda-algebras] site opens it in a new tab,
with every module of that library in the Explorer.

## Status

Milestone 0, foundations.  The fork is imported: plfa-playground at
`ae0aa84c`, every file as upstream has it except its CI workflow and its
deploy script, and without its binaries, which the flake pins by hash.  It
builds, its unit tests and type checks pass, and it checks `Main.agda` in
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
+  [`docs/provenance.md`][provenance]: where every imported file and every
   pinned binary comes from, with its SHA-256 and its license.  The machine
   records are in [`upstream/`][records].
+  [`NOTICE`][notice]: every artifact the app ships, with its license; the
   build publishes it as `NOTICE.txt`, with the license texts in
   [`licenses/`][licenses].
+  [`docs/GITHUB_PROJECT.md`][plan]: the plan, with seven milestones (the
   foundations, the agda-algebras IDE, plugins, the browser as a tool
   server, models in the loop, the theory view, and the proof view) and
   their issues.  The issues on GitHub own their bodies, and many carry the
   measurements that shaped them.
+  The proposal this project follows: agda-native-air's
   [`docs/notes/browser-ide-proposal.md`][proposal].

## Working on the app

Everything here runs in the dev shell (`nix develop`), which carries node
22.22.2, make, gh and the plan file's engine.  The binaries the app ships
(the compiler, the archives, the fonts and one icon) are not in git: `make
assets` fetches them by hash into `static/`.

```sh
make assets        # fetch the 36 pinned binaries into static/, and check them
npm ci             # install the locked npm dependencies
npm run check      # svelte-check
npm test           # the unit tests (vitest)
make build         # check the pins, then npm run build, into build/
npm run dev        # serve the app at http://localhost:5173
```

`make build` refuses to build when a file in `static/` differs from its
pin; `make assets` puts it back.  The dev server sends the two headers the
language server's shared memory needs (`Cross-Origin-Opener-Policy:
same-origin` and `Cross-Origin-Embedder-Policy: require-corp`), and so must
any server of `build/`.

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
   npm ci && npm run check && npm test && make build
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
[provenance]: docs/provenance.md
[records]: upstream/
[notice]: NOTICE
[licenses]: licenses/
[plan]: docs/GITHUB_PROJECT.md
[proposal]: https://github.com/formalverification/agda-native-air/blob/main/docs/notes/browser-ide-proposal.md
[williamdemeo/github-project]: https://github.com/williamdemeo/github-project
