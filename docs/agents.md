<!-- File: docs/agents.md -->

# Agent harnesses in this repository

An *agent harness* is the program that runs a language model as an agent in
a terminal: Claude Code, OpenAI's Codex CLI and GitHub's Copilot CLI are
three.  This page says what each needs to work in this repository, and what
goes wrong here that does not elsewhere.  The general setup (plans and
prices, installation, sign-in, the model and its reasoning effort, and
registering agda-mcp) is agda-native-air's page, [Connecting an agent to
agda-mcp][air-page], which defines the terms as well; this page repeats none
of it.

Two harnesses have worked on issues here: Claude Code, on most of them, and
Codex CLI with GPT-6.1 Sol, on [#17] and [#63] (2026-10-10).  Copilot CLI
has not; its listings are recorded beside the others for comparison.
Everything below was observed on 2026-10-12, on Ubuntu 24.04, with Claude
Code 2.1.282, Codex CLI 0.162.1 and Copilot CLI 1.0.95, at a worktree's
root, and Codex's sandbox again on 2026-10-13, after the two fixes this page
called for; the record is
[`docs/measurements/agent-harnesses-2026-10-12.json`][record].

## At a glance

| Harness | Instructions loaded | Skills listed | MCP servers | Gates from a session |
| --- | --- | --- | --- | --- |
| Claude Code 2.1.282 | global and project | 39 global, 7 project (5 by name only) | none of this repository's | all four |
| Codex CLI 0.162.1 | global and project | 39 global, 7 project, 4 of its own | none | `check` in its sandbox; `test` and `build` by saved approvals; not `browser-check` |
| Copilot CLI 1.0.95 | global and project | 39 global, 7 project, 2 built-in | its built-in GitHub server | not run |

## Instructions and skills

**The repository tracks neither**.  On William's machine, claude-tooling (his
configuration repository, which is private) installs them as untracked
links, each excluded in the main checkout's `.git/info/exclude`, as follows:

+  In the directory above the checkouts (which holds `main/` and
   `worktrees/`): `CLAUDE.md` and `AGENTS.md`, two links to one file whose
   last line is `PROBE-MARKER: claude-tooling/agda-native-ide`; and the
   project's skills, in `.claude/skills/`, with `.agents/skills` a link to
   that directory.
+  At each checkout's root: `.claude` and `AGENTS.md`, links to the
   parent's, and a real `.agents/` whose `skills` links to the parent's
   `.agents/skills`.  claude-tooling's `link-worktrees.sh` makes them, and
   William runs it after `git worktree add`.  Until 2026-10-13 `.agents`
   was itself a link to the parent's, which kept Codex's sandbox from
   starting (below); [claude-tooling#49] changed it.
+  For every project: `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` and
   `~/.copilot/copilot-instructions.md`, three names for one file, and the
   same 39 skills in `~/.claude/skills` and `~/.agents/skills`.

On any other machine a harness starts here with no instructions and no
skills of this project's; the README and this page are the guide.

**How it was observed**.  Each harness's own listing came first; then one
prompt (*print every line of your instructions that begins
`PROBE-MARKER:`, name the skills you see, quote the first sentence of
`timing-checks-in-the-page`'s description, name your MCP servers*), whose
answer was checked against two facts the model could not guess: the global
file's marker, and the description in the skill's `SKILL.md`.  What each
harness loaded at a worktree's root, inside `nix develop`, was the
following:

+  **Claude Code**.  The global file and the project's `CLAUDE.md`, from the
   directory above, each once; the worktree's `AGENTS.md` is not loaded
   beside it.  The skills: 39 global and 7 project ones (the session's init
   event lists them), beside Claude Code's own.  Five of the seven project
   skills are listed by name with no description, since the listing's
   budget runs out before them: `building-agda-for-wasi`,
   `checking-an-agda-library-under-a-new-agda`,
   `testing-the-vscode-companion`, `timing-checks-in-the-page` and
   `wiring-agda-libraries-into-a-nix-devshell`.  Asked for
   `timing-checks-in-the-page`'s description, the model said it had none.
   A session finds these five by name only, so a prompt that needs one
   should name it.  MCP servers (`claude mcp list`): the signed-in account's
   claude.ai connectors, and no server of this repository's.  Claude Code
   also loads its memory index for the project, from the main checkout's
   entry under `~/.claude/projects/`.
+  **Codex CLI**.  `codex debug prompt-input`, which renders what the model
   is shown without calling it: `~/.codex/AGENTS.md` and the worktree's
   `AGENTS.md`, and 50 skills, each with its description, from
   `~/.agents/skills` (39), Codex's own (4), and this project's through the
   worktree's `.agents` (7).  `codex mcp list`: none.  The prompt (GPT-6.1
   Sol at `low`) quoted both markers and the description's first sentence
   verbatim.  On 2026-10-13, with `.agents` a real directory, the listing
   still held both files and this project's skills (8 by then, a shared
   Agda skill having been added).
+  **Copilot CLI**.  `copilot instruction list`: the worktree's `AGENTS.md`,
   and `~/.copilot/copilot-instructions.md`.  `copilot skill list`: 7
   project, 39 personal and 2 built-in skills, each with its description.
   `copilot mcp list`: its built-in `github-mcp-server`.  No prompt was run,
   since Copilot has not worked on an issue here.

**Before 2026-10-11**, the links at a checkout's root were `.claude` alone.
Codex's own logs of the trials on [#17] and [#63] show what it loaded then:
`~/.codex/AGENTS.md` and nothing of the project's, which the sessions read
by path because their kickoff prompts told them to.  The second set of
links ([claude-tooling#27], `AGENTS.md` and `.agents`) is what changed it,
and since then no workaround is needed in a worktree where
`link-worktrees.sh` has run.  Whether the repository should track an
`AGENTS.md` or an `.agents/` of its own is claude-tooling#27's decision,
not this page's.

## The dev shell and the gates

**Starting a session**.  Start the harness at the worktree's root.  For
Claude Code, start it there rather than inside `nix develop`, and run each
gate as `nix develop --command make <gate>`: a shell entered first goes
stale when the session changes the flake, which sessions here often do.
The Codex trials were started inside `nix develop`.  The instructions and
skills load the same either way (Claude Code was observed both ways).

**A fresh worktree** has no binaries in `static/`: run `make assets` first
(README, "Working on the app").  Without it `make build` stops at its
assets check (33 files could not be read), and `make browser-check`, which
needs `build/`, cannot start.

The four gates, after `make assets`, were as follows (seconds where timed;
the record has the commands).  Codex's sandbox column is 2026-10-13's,
`codex sandbox -P :workspace -- make <gate>` after the two fixes below; on
2026-10-12 all four failed there before they started.  Its other column is
`-P :danger-full-access`, which is how a command runs that a saved approval
or `--sandbox danger-full-access` lets out.

| Gate | Claude Code | Codex, in its sandbox | Codex, outside it | Copilot CLI |
| --- | ---: | --- | ---: | --- |
| `make check` | 20 | passes, 7 | 13 | not run |
| `make test` | 8 | 19 native-engine tests fail | 7 | not run |
| `make build` | 23 | fails: Nix's database is read-only | 23 | not run |
| `make browser-check` | 23 | fails: Nix's database is read-only | 24 | not run |

+  **Claude Code** has no sandbox here (its sandbox is off by default, and
   William's settings do not turn it on), and runs in the `auto` permission
   mode.  Every gate ran from the session, `make browser-check` included,
   which runs Nix (here a single-user install, which writes its store's
   database under `/nix/var/nix` itself) and starts headless Chromium on
   loopback.
+  **Codex CLI** runs here in its `workspace-write` sandbox, with approval
   `on-request` in an interactive session (the trials' settings, from their
   logs) and `never` under `codex exec`.  On 2026-10-12 no command ran in
   that sandbox, for two reasons, both fixed on 2026-10-13, as follows:
   1.  Ubuntu 24.04 restricts unprivileged user namespaces
       (`kernel.apparmor_restrict_unprivileged_userns = 1`), so bubblewrap
       failed with `bwrap: loopback: Failed RTM_NEWADDR: Operation not
       permitted`, while `codex doctor` reported the sandbox healthy.  The
       fix is the AppArmor profile agda-native-air's page gives ([Codex:
       known issues][air-codex-known]), `bwrap-userns-restrict` from
       Ubuntu's `apparmor-profiles` package; it needs root, and William
       loaded it.
   2.  The worktree's `.agents` was a link to a directory, and Codex's
       workspace profile refused to build its sandbox across it: `cannot
       enforce sandbox read-only path <worktree>/.agents because it crosses
       writable symlink`.  A real `.agents/` holding a `skills` link passes
       that step, so the AppArmor fix alone was not enough here;
       [claude-tooling#49] made `.agents` that shape, from this report on
       [claude-tooling#27].

   With both fixed, the sandbox starts here, and in it the gates fared as
   the table shows, for the following reasons:
   +  `make test` fails 19 of the native engine's tests, because inside the
      sandbox Node's `spawnSync` returns `EPERM` for every child, although
      the child runs and its output arrives (the asynchronous `execFile`
      works), and the tests' fake Agdas are asked their version that way.
   +  `make build` and `make browser-check` stop at `error: opening lock
      file "/nix/var/nix/db/big-lock": Read-only file system`.  Nix here is a
      single-user install, which opens its store's database itself, and the
      sandbox mounts `/nix` read-only.  A `sandbox_workspace_write`
      `writable_roots` override did not change that under `codex sandbox`,
      and opening the store to sandboxed commands would defeat the sandbox.

   So `make test`, `make build` and `make browser-check` run only outside
   the sandbox, and only once approved.  In the trial of [#17] William
   approved each request as it came (71 of them), and Codex keeps an
   approval it is told to keep as a prefix rule in
   `~/.codex/rules/default.rules`.  The trial of [#63] ran with Codex's
   automatic reviewer instead (`approvals_reviewer = "auto_review"`): its
   tool calls asked for escalation 216 times, and the reviewer, a second
   model, gave 207 verdicts, every one "allow".  This machine's rules, from
   the first trial, hold `make check`, `make test` and `make build`, which is
   why those three passed from `codex exec` sessions on 2026-10-12.  `make
   browser-check` has no rule: approve it in an interactive session the
   first time one needs it, or start the session with `--sandbox
   danger-full-access`, under which all four gates passed.
+  **Copilot CLI**'s sandbox is off by default and is not turned on here, so
   a session's commands would run as Claude Code's do; no gate was run from
   a Copilot session.

**Commits**.  The ten commits of the Codex trials ([#17] and [#63]) carry
William's identity and the provenance line, and no `Co-authored-by`
trailer.

## agda-mcp here

**Which issues need it**.  Most issues here are TypeScript and Svelte and
need no Agda server, and the repository registers none (it tracks no
`.mcp.json`, and claude-tooling installs none for it).  The issues that
check Agda are the following:

+  [#61], agda-algebras and its standard library under Agda 2.9.0.  Its
   checks run in agda-algebras' own checkouts, which have their own
   registration; a check from here against the page's pin of agda-algebras
   needs a libraries file that names that pin.
+  Milestone 1's library archives ([#12], [#13]), which the page's wasm32
   Agda builds and gates, under Nix and in Chromium.  A native verdict is a
   cross-check there, never the evidence: an archive is accepted when the
   wasm32 Agda's `Checking` lines say so.
+  The PLFA chapters under `static/plfa/content/`, until [#20] retires
   them.  A chapter cannot be checked where it sits: its module,
   `plfa.part1.Naturals`, names the path the page gives it by mounting
   `static/plfa/project.zip`, which holds `plfa.agda-lib` at its root and
   the chapters under `plfa/`.  `check_file` on the tracked file answers
   `ModuleNameDoesntMatchFileName` (exit 42); a copy laid out as the page
   lays it out checks.

**Which Agda**.  On 2026-10-12 the page's Agda and both native ones came
from one commit, as follows:

+  The page's compiler is built from agda/agda at `da66a8c7` (2026-10-05;
   Agda has no `v2.9.0` tag), as `compiler/build-agda-2.9.0.sh` pins it.
+  This repository's native Agda, the `.#vscode` shell's `$AGDA`, comes
   from Agda's own flake at the same commit:
   `/nix/store/1axa6adsvwbz7wbck03d7wbsfdr1x8hq-Agda-2.9.0-bin`.
+  agda-native-air moved to 2.9.0 with its issue 234, and its flake pins
   the same commit.  The launcher's shell runs a wrapper around the same
   store path.
+  The standard libraries match too: the page's v2.3 with the five patches
   in `stdlib/patches/`, and agda-native-air's `formalverification/agda-stdlib`
   at `fb5d1840` (tag `v2.3-agda-2.9.0`), have identical `src/` and
   `standard-library.agda-lib`.
+  agda-algebras does not: the launcher's shell registers agda-native-air's
   pin, `4662373d` (2026-09-07), and the page pins `f067d57d`.

**Whether the native Agda must match the page's**.  For a verdict, it
must.  A session's `check_file` is evidence about the page only when it ran
the page's Agda and standard library; with another Agda (nixpkgs' 2.8.0,
or a later 2.9.0 commit) a verdict can change wherever the language changed
between the two, and the patches the page carries exist because Agda 2.9.0
rejects the standard library v2.3 as released ([#61]).  At the same
commit, ADR 0003's conformance suite found the native engine's answers and
the page's identical on the 12 scenarios the two share.  For interfaces,
matching is not enough: the native Agda writes 64-bit interfaces, which the
page's wasm32 Agda checks again or hangs on ([ADR 0001][adr-0001],
decision 20).
A session's `_build/` never reaches the page, and its times say nothing
about the page's.  `.gitignore` has no rule for `_build/`, so check
outside the worktree, as below.

**The registration**.  A session on such an issue registers the server for
that session alone, with this repository's Agda and standard library.  The
launcher, `scripts/run-server.sh`, is agda-native-air's, from a checkout of
it where the server has been built once ([Before any harness: the
server][air-server]); with `AGDA_MCP_BIN` and `--agda-bin` it starts the
server directly, without its own shell.  First, from the worktree's root,
lay out a chapter and a libraries file outside the worktree, and find the
two binaries, as follows:

```sh
scratch=/path/to/scratch       # outside the worktree
air=/path/to/agda-native-air   # a checkout whose server is built
agda=$(nix develop .#vscode --command printenv AGDA)
server=$(cd "$air" && nix develop .#backend --command bash -c 'cd agda-mcp && cabal list-bin exe:agda-mcp' | tail -n 1)
zip=$(nix build .#stdlib --no-link --print-out-paths)/agda-stdlib-2.3-patched.zip
mkdir -p "$scratch/plfa/part1"
unzip -q -o -d "$scratch" "$zip"
echo "$scratch/agda-stdlib-2.3/standard-library.agda-lib" > "$scratch/libraries"
printf 'name: plfa\ndepend: standard-library\ninclude: .\n' > "$scratch/plfa.agda-lib"
cp static/plfa/content/part1/Naturals.lagda.md "$scratch/plfa/part1/"
```

`$agda` is a store path, which depends on the system and on the flake's
pins: on x86_64-linux at this repository's `flake.lock` it was
`/nix/store/1axa6adsvwbz7wbck03d7wbsfdr1x8hq-Agda-2.9.0-bin/bin/agda`.  The
registrations below are written from the variables in the same shell,
rather than copied, so they name what this machine built.  Then the
registration, per harness, as follows:

+  **Claude Code**: a file outside the worktree, and `claude --mcp-config
   "$scratch/agda-mcp.json" --strict-mcp-config`, which takes the servers
   from that file for one session and ignores the others.  The file is
   written as follows:

   ```sh
   cat > "$scratch/agda-mcp.json" <<JSON
   {
     "mcpServers": {
       "agda": {
         "command": "$air/scripts/run-server.sh",
         "args": [
           "--agda-bin", "$agda",
           "--agda-flags", "--library-file=$scratch/libraries",
           "--timeout", "600"
         ],
         "env": { "AGDA_MCP_BIN": "$server" }
       }
     }
   }
   JSON
   ```

+  **Codex CLI**: the same as `-c` overrides, with the timeouts and the
   approval agda-native-air's page explains ([Codex: registering
   agda-mcp][air-codex-register]).  `codex` itself takes the same
   overrides; the run below was `codex exec`, with the task in `$PROMPT`,
   as follows:

   ```sh
   codex exec -s read-only \
     -c "mcp_servers.agda.command=\"$air/scripts/run-server.sh\"" \
     -c "mcp_servers.agda.args=[\"--agda-bin\", \"$agda\", \"--agda-flags\", \"--library-file=$scratch/libraries\", \"--timeout\", \"600\"]" \
     -c "mcp_servers.agda.env={AGDA_MCP_BIN=\"$server\"}" \
     -c 'mcp_servers.agda.startup_timeout_sec=120' \
     -c 'mcp_servers.agda.tool_timeout_sec=660' \
     -c 'mcp_servers.agda.required=true' \
     -c 'mcp_servers.agda.tools.check_file.approval_mode="approve"' \
     "$PROMPT" < /dev/null
   ```

+  **Copilot CLI**: `--additional-mcp-config @<file>`, with a file of the
   shape agda-native-air's page gives ([Copilot: registering
   agda-mcp][air-copilot-register]); not run here.

Without `--agda-bin` and `AGDA_MCP_BIN`, the launcher enters
agda-native-air's own shell, which today runs the same Agda and the same
standard library, but agda-native-air's agda-algebras, and takes up to half
a minute to start when that checkout's working tree is dirty.

**Run** on 2026-10-12, from the worktree's root, with `check_file` on the
laid-out chapter and on the tracked one, the results were as follows:

+  Claude Code, Sonnet 5 at `low`: the server connected; the laid-out
   chapter answered `success: true`, exit 0, no holes and no errors; the
   tracked one `success: false`, exit 42, `ModuleNameDoesntMatchFileName`.
   With the standard library's interfaces built first, the session took 13
   s; from a fresh scratch directory, run with the commands above verbatim,
   the server's check took 4.0 s and the session 13 s.
+  Codex CLI, GPT-6.1 Sol at `low`, with the overrides above: the same two
   answers, in 30 s.  It called `check_file` a third time with `verbose:
   true`, whose answer adds a `command` block naming the Agda binary and the
   libraries file; the plain answer names only the project's root.

## What leaves the machine

A session sends its provider the instructions it loaded, the files it
reads, the output of its commands and the tool results.  This repository
has been public since 2026-10-11, so its tracked tree is not the exposure.
What a session here sends that is not public is the following:

+  the instructions and skills every session loads, from claude-tooling, a
   private repository;
+  unpushed branches and uncommitted work;
+  the run directories beside the checkouts (measurements, probes, compiler
   builds), and whatever else it reads under the home directory.

Whether the provider may train on it is the account's setting, per harness
and plan, as agda-native-air's page gives it (read there on 2026-10-11), as
follows:

| Harness | On a personal plan | The setting | Details |
| --- | --- | --- | --- |
| Claude Code | Pro and Max: trained on while the setting is on, which it is unless turned off | "Help Improve our AI models", under Privacy in claude.ai's settings | [Claude Code: plan and cost][air-claude-plan] |
| Codex CLI | Plus and Pro: decided by the setting; the plans do not offer "no training by default" | ChatGPT's data controls, read signed in | [Codex: plan and cost][air-codex-plan] |
| Copilot CLI | Free, Pro, Pro+ and Max: GitHub may train, since 2026-04-24 | "Allow GitHub to use my data for AI model training", at `github.com/settings/copilot/features`; and the CLI syncs sessions to the account unless `remote` is off | [Copilot: plan and cost][air-copilot-plan] |

Under commercial terms (Anthropic's Team, Enterprise and API keys; OpenAI's
Business, Enterprise, Edu and API; Copilot Business and Enterprise) the
providers do not train by default.  Before a session reads this
repository, check the setting for the account the harness is signed in
with, which `claude auth status` and `codex login status` name; for Copilot
CLI it is the GitHub account it signed in with.

## This project's own servers

When the local bridge of [#38] and the MCP server definition of [#65] land,
this page gains how each harness registers them.

[air-page]: https://formalverification.github.io/agda-native-air/agda-mcp/connecting-an-agent/
[air-server]: https://formalverification.github.io/agda-native-air/agda-mcp/connecting-an-agent/#before-any-harness-the-server
[air-claude-plan]: https://formalverification.github.io/agda-native-air/agda-mcp/connecting-an-agent/#plan-and-cost
[air-codex-plan]: https://formalverification.github.io/agda-native-air/agda-mcp/connecting-an-agent/#plan-and-cost_2
[air-codex-register]: https://formalverification.github.io/agda-native-air/agda-mcp/connecting-an-agent/#registering-agda-mcp_2
[air-codex-known]: https://formalverification.github.io/agda-native-air/agda-mcp/connecting-an-agent/#known-issues_2
[air-copilot-plan]: https://formalverification.github.io/agda-native-air/agda-mcp/connecting-an-agent/#plan-and-cost_3
[air-copilot-register]: https://formalverification.github.io/agda-native-air/agda-mcp/connecting-an-agent/#registering-agda-mcp_3
[record]: measurements/agent-harnesses-2026-10-12.json
[adr-0001]: adr/0001-runtime.md
[#12]: https://github.com/formalverification/agda-native-ide/issues/12
[#13]: https://github.com/formalverification/agda-native-ide/issues/13
[#17]: https://github.com/formalverification/agda-native-ide/issues/17
[#20]: https://github.com/formalverification/agda-native-ide/issues/20
[#38]: https://github.com/formalverification/agda-native-ide/issues/38
[#61]: https://github.com/formalverification/agda-native-ide/issues/61
[#63]: https://github.com/formalverification/agda-native-ide/issues/63
[#65]: https://github.com/formalverification/agda-native-ide/issues/65
[claude-tooling#27]: https://github.com/williamdemeo/claude-tooling/issues/27
[claude-tooling#49]: https://github.com/williamdemeo/claude-tooling/pull/49
