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

Milestone 0, foundations: the repository holds the plan and its tooling,
and the fork has not been imported yet.  Nothing is deployed.

## Where things are

+  [`docs/GITHUB_PROJECT.md`][plan]: the plan, with seven milestones (the
   foundations, the agda-algebras IDE, plugins, the browser as a tool
   server, models in the loop, the theory view, and the proof view) and
   their issues.  The issues on GitHub own their bodies, and many carry the
   measurements that shaped them.
+  `docs/adr/`, not yet created: the decision records, starting with ADR
   0001 on the runtime, which issue [M0-7][adr-0001] writes.
+  The proposal this project follows: agda-native-air's
   [`docs/notes/browser-ide-proposal.md`][proposal].

## Working on it

Enter the dev shell with `nix develop`.  The app's toolchain arrives with
the fork; until then the shell carries the plan file's engine, from
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

MIT; see [`LICENSE`](LICENSE).  The forked code and every artifact the app
ships will carry their own notices in `NOTICE`.

[plfa-playground]: https://github.com/SeungheonOh/plfa-playground
[agda-algebras]: https://agda-algebras.universalalgebra.org/
[plan]: docs/GITHUB_PROJECT.md
[proposal]: https://github.com/formalverification/agda-native-air/blob/main/docs/notes/browser-ide-proposal.md
[williamdemeo/github-project]: https://github.com/williamdemeo/github-project
[adr-0001]: https://github.com/formalverification/agda-native-ide/issues/7
