<!-- File: docs/adr/0003-the-shared-core.md -->

# ADR 0003: the shared core

File: `agda-native-ide/docs/adr/0003-the-shared-core.md`

+  **Status**: Accepted when the pull request that adds it merges.  The
   decisions are this record's, taken while building [#62] on 2026-10-11,
   under the plan [ADR 0002][adr-0002] § 3 adopted; each is built and
   tested here.  What they leave to later issues is named in each section's
   status.
+  **Date**: 2026-10-11.
+  **Tracking**: [#62] (this record, and the packages); [#29] (the rest of
   the tool surface); [#30] (the page's batch lane); [#24] (the plugin
   manifest and its loader); [#64] (the native engine in the editor, with
   its batch lane); [#66] (the views in a webview).
+  **Ancestry**: [ADR 0002][adr-0002] § 3, which decided that the engine
   client, the tool surface, the manifest and the views are packages over
   one engine interface with two implementations, and left the interface
   and each host's share to this record; [ADR 0001][adr-0001] § 8, whose
   reactor and drive in one worker are the browser engine; agda-native-air's
   [ADR 0002][air-adr-0002], read at `3de85b40`, whose tool contract the
   tool surface keeps; the VS Code companion of [#63], PR [#84].

## Executive summary

The workbench is to have three hosts (a browser tab, a VS Code companion,
Emacs) sharing one core ([ADR 0002][adr-0002]).  This record says what that
core is, as built: four packages in an npm workspace, written against one
engine interface with two real implementations, both of which pass one
conformance suite.

+  **The engine client** speaks Agda's interaction protocol once: it builds
   each command, validates each answer, sends one command at a time and
   knows when each has ended, keeps the text every answer is about, and
   decides by the give rule between a give and a load.  It imports no
   platform.  Its browser transport runs the language server's reactor in
   a worker; its native transport runs `agda --interaction-json` as a child
   process.
+  **The tool surface, the manifest and the views** are packages over it:
   the tools of agda-mcp (agda-native-air's tool server for agents) that
   the interaction lane answers, with JSON Schemas, refusing the verdict
   tools for want of a batch lane; the PLFA manifests the page reads,
   validated; and the components of the page's inspector (the pane that
   shows goals, results and problems), which import nothing from a host.
+  **The page** imports all four, and keeps only what is its own: its
   state, its editor, its URLs, its source conversion and when to persist.
   The VS Code companion joins the workspace with its code unchanged.

Why it is shaped this way: the fork's code that sent commands and read
answers was written against CodeMirror and the page's controller, so a
second host would have had to copy it; the protocol's two envelopes (the
language server's in the page, none natively) are the only real difference
between the engines, so each transport unwraps its envelope and nothing
more, and the rest is written once.  And a host can only trust an answer
whose basis it can check, so every answer names the text it is about, and
a question about a goal from another session, file or load is refused,
never sent.

Where it stands: built and measured on 2026-10-11.  The suite's 11 shared
scenarios pass against both engines, at Agda 2.9.0 `da66a8c7`, and the two
engines' answers to them are identical field for field, once host paths and
session names are replaced by placeholders; each runner's own checks of
startup, deadlines, crashes and disposal pass (6 and 6); a deliberately
broken coordinate conversion fails the same scenario on both.  The page's
gates pass unchanged, served with and without the two headers that make a
page cross-origin isolated, in Chromium and in Firefox.  Where it goes: the
batch lane ([#30], [#64]), the rest of the tools ([#29]), the plugin loader
([#24]), and the views in the editor ([#66]).

### Terms

+  **Engine**: one way of running Agda.  The **browser engine** is the
   Agda Language Server built for WebAssembly as a reactor, in a worker
   with the in-memory drive it reads ([ADR 0001][adr-0001] § 8); the
   **native engine** is a native `agda --interaction-json` child process.
+  **Interaction protocol**: Agda's editor command language, one `IOTCM`
   line per command (`Cmd_load`, `Cmd_give`, `Cmd_goal_type_context`, and
   so on), answered by a stream of JSON responses.  The language server
   carries each command inside an LSP request named `agda`, and each
   response inside a request of its own.
+  **Lane, verdict**: as [ADR 0002][adr-0002] defines them.  The
   **interaction lane** is a long-lived Agda that answers about a loaded
   file and tolerates open goals; the **batch lane** is a fresh Agda per
   check, whose exit code is the **verdict**.
+  **Session**: one running Agda, with the state the engine keeps about
   it.  **Transport**: the part of an engine that reaches its Agda.
+  **Basis**: what an answer is about: the session, the file, the digest
   of the text Agda read, and the load's **generation** (the session's
   count of loads).
+  **Snapshot**: the text Agda's live state reflects, the loaded text with
   the edits Agda's own answers made.
+  **Give rule**: a single edit wholly inside one live goal is checked by
   giving that goal its new contents; anything else reloads the module.
+  **Host**: a program that uses the core: the page, the companion, a
   test runner.
+  **Kill ladder**: how a transport stops a child that does not end: it
   closes the child's input, then sends SIGTERM, then SIGKILL, each after a
   grace period.
+  **The conformance record**:
   [`docs/measurements/engine-conformance-2026-10-11.json`][record], the
   runs this record's evidence cites.

---

## 1.  A workspace of four packages

(See also [#62], [`docs/engine/overview.md`][overview] "The packages".)

**Decision**.  The repository is an npm workspace: the page at the root,
`@agda-native-ide/engine`, `/tools`, `/manifest` and `/views` under
`packages/`, and the companion in `vscode/`, from one lockfile.

+  The engine, the tools and the manifest are TypeScript, built by `tsc -b`
   with project references (`make packages`), and imported by their
   `exports`; the views are Svelte source, which the page compiles.
+  Each part of the engine is a project with only the globals it may use:
   the core, the tools, the manifest and the conformance suite with none
   beyond ECMAScript; the browser transport with the DOM; its worker with
   a worker's; the native transport with node.  The native transport is
   exported under the `node` condition only.
+  The companion's lockfile is folded into the root's.  The Nix site's
   source names the packages and the companion's manifest.

**Evidence**.

+  A clean clone of the branch has the same site derivation as the
   worktree, and in it `npm ci`, `make check` (svelte-check of the page,
   and of the views on their own), `make test` and `make vscode-unit` pass;
   `nix build .#site --rebuild` builds the same bytes, and the dev shell's
   `make build` of the same revision equals the Nix site, file for file.
+  A route importing `@agda-native-ide/engine/native` does not build: Vite
   refuses `./native` under the browser's conditions.  The built site has
   none of the native transport's command line, node's process or
   filesystem API, or VS Code's API, which `scripts/check-bundle.mjs`
   checks on every build; run on the native transport's own build, it
   fails.
+  npm 10 dropped the `libc` field of ten platform bindings from the
   lockfile it rewrote.  With those restored, the lockfile only gains
   entries, except for one it loses: `@andy0130tw/vscode-jsonrpc-esm`, a
   JSON-RPC library that only the page's old message router used.  The
   companion's
   `@vscode/test-electron` now shares the page's jszip 3.10.1, where its
   own lockfile had 3.10.2, and its real suite passes.

**Status**.  Adopted.  The lockfile surgery is recorded in
[`docs/provenance.md`][provenance].

---

## 2.  The engine's interface

(See also [#62], [`docs/engine/overview.md`][overview] "The engine's
interface".)

**Decision**.  The engine's interface is a session over a transport, whose
operations each return one of three types: Agda's answer, the engine's
refusal, or a failure to get an answer.

+  **Operations**: load, check (the give rule), a goal's type and context,
   give, refine, case split, infer and normalize (at a goal or at the top
   level), Agda's version, abort, and a verdict, which is refused.
+  **An answer** carries Agda's value, every response Agda sent for the
   command, its time, its lane (`interaction`), and its basis; it has no
   verdict field.  **A refusal** is made before anything is sent: an
   unsupported capability, a stale or unknown goal, nothing loaded, invalid
   input, a full queue, an ended session, or a conversion that moves
   positions.  **A failure**: a deadline, an abort, Agda's exit, a
   malformed answer, a source that changed while Agda read it, a file that
   could not be read or written, a failed start.
+  **A transport** gives the session events: a response, the end of a
   command, output that is not a response, Agda's exit.  Each transport
   unwraps its own envelope (the language server's `ResponseJSONRaw` in
   the page; one line per response natively) and delivers Agda's own JSON.
+  **Answers are validated** with zod schemas of the kinds the engine reads,
   from Agda's encoding at the pinned commit; a known kind that is
   malformed fails its command, quoting what is wrong, and an unknown kind
   is kept whole.
+  **One session is one Agda**, which holds one loaded file at a time; a
   load of another file is a module switch.  The page has one session.

The contract, as `@agda-native-ide/engine` exports it (abridged; the
values each operation answers with are in `src/core/session.ts`), is the
following:

```ts
type Outcome<T> = Answer<T> | Refusal | Failure;   // discriminated by `kind`
interface Answer<T> {
  kind: "answer"; lane: "interaction"; engine: "browser" | "native";
  session: string; agdaVersion: string; basis?: SourceBasis;
  elapsedMs: number; value: T; responses: AgdaResponse[];
}
interface Refusal { kind: "refusal"; reason: RefusalReason; message: string; capability?: string }
interface Failure { kind: "failure"; reason: FailureReason; message: string; detail?: Record<string, unknown> }
type RefusalReason = "unsupported-capability" | "stale-goal" | "unknown-goal" | "no-loaded-file"
  | "invalid-input" | "busy" | "session-ended" | "position-shift";
type FailureReason = "timeout" | "aborted" | "session-ended" | "protocol" | "source-changed" | "io" | "startup";
interface SourceBasis { engine; session; agdaVersion; path; digest; generation }
interface GoalRef { id: number; basis: SourceBasis }   // session.goalRef(id), for a live goal
type CheckPlan = { kind: "unchanged" } | { kind: "give"; goal: number; expression: string } | { kind: "load"; reason: string };

class AgdaSession {
  load(path: string, text?: string): Promise<Outcome<LoadValue>>;
  check(path: string, text: string, hooks?: { onPlan?(plan: CheckPlan): void }): Promise<Outcome<CheckValue>>;
  plan(path: string, text: string): CheckPlan;
  goal(ref: GoalRef, rewrite?: Rewrite): Promise<Outcome<GoalValue>>;     // type and context
  give(ref: GoalRef, term: string): Promise<Outcome<GiveValue>>;          // also refine
  makeCase(ref: GoalRef, variables: string): Promise<Outcome<MakeCaseValue>>;
  infer(term: string, at?: GoalRef): Promise<Outcome<ExpressionValue>>;  // also normalize
  version(): Promise<Outcome<{ version: string }>>;
  checkFile(): Promise<Refusal>;                // the batch lane's verdict: refused
  abort(): { aborting: OperationKind | undefined };
  onResponse(listener: (event: ResponseEvent) => void): () => void;      // each response, as it arrives
  onStatus(listener: (status: SessionStatus) => void): () => void;       // ready, busy, ended
  dispose(): Promise<void>;
}
```

`check()` calls `onPlan` with the plan synchronously, before anything is
sent: that is the hook a host uses to act in the same tick as it read the
text it checks (§ 5).

**Evidence**.

+  Before any file moved, one load, goal query and give went through the
   same interface on both engines and answered the same goals, types,
   ranges, digest and edit (2026-10-11, Chromium 149 and native Agda
   2.9.0).
+  The unit tests drive the session over a scripted transport: a malformed
   payload fails the command and the stream goes on; an unknown kind is
   kept; output that is not an answer fails the command; a full queue
   refuses; a crash fails what runs.
+  The conformance suite's answers, on both engines, are the comparison of
   § 9.

**Status**.  Adopted.  The companion does not use it yet: [#64] hosts the
native engine there.

---

## 3.  What ends a command

(See also [`docs/engine/overview.md`][overview] "What ends a command".)

**Decision**.  The session sends one command at a time, and the next only
when its transport reports the previous one's end, at a boundary the
protocol defines and the transport has verified; never at a timer or a
silence.

+  **The browser**: the language server's `ResponseEnd`, which it sends
   once Agda's loop has ended the command and its responses are sent.  The
   acknowledgement of the `agda` request (`CmdRes`) only says the command
   was queued; one that carries an error means it never ran, and the
   transport ends it itself.
+  **Native**: the prompt `JSON> `, which Agda prints from its main loop
   before it takes each command: the first says it is ready, and each
   later one ends a command.  The prompt has no newline, so the transport
   strips it from the start of whatever follows; every other line is one
   response, and a line that is not JSON (Agda's `cannot read: ...` for a
   command it cannot parse) fails the command.
+  **Abort** is sent out of band and ends nothing itself: the running
   command ends after `DoneAborting`.

**Evidence**.

+  Read at the sources: agda-language-server `v8`'s `src/Agda.hs` (the
   loop calls `waitUntilResponsesSent` and then `signalCommandFinish`,
   which sends `ResponseEnd`) and `src/Server/CommandController.hs`; Agda
   `da66a8c7`'s `AgdaTop.hs` (`repl` prints the prompt, then
   `maybeAbort runInteraction` takes the next command from the queue
   `initialiseCommandQueue` fills, where `Cmd_abort` sets a flag and is not
   queued) and `InteractionTop.hs` (an aborted command's state is restored
   and its file forgotten).
+  Probed natively on 2026-10-11: one prompt before the first command and
   one after each; `Cmd_abort`, sent 500 ms into a slow normalization, was
   answered with `DoneAborting`, a `Status` and a prompt 45 ms later, and
   the next goal command made Agda check the file again (a `Checking`
   line), so the session forgets its basis on an abort; an unreadable line
   answered `cannot read: ...` and a prompt.
+  Both runners' deadline checks (§ 6), and the page's STOP during a PLFA
   chapter's first check, which ended it 310 ms after the click; the next
   check then checked the chapter (11.07 s, no problems).

**Status**.  Adopted.  agda-native-air's lane frames responses with a
`Cmd_show_version` sentinel after every command; the prompt is the same
guarantee with no extra command.

---

## 4.  Which text an answer is about

(See also [`docs/engine/overview.md`][overview] "Which text an answer is
about".)

**Decision**.  Every answer names its basis, and a goal is named with the
basis it came from; the session refuses a goal of another session, file or
load before anything is sent, and reads back the text it loaded.

+  **The basis**: the engine, the session, Agda's version, the path, the
   SHA-256 of the UTF-8 text Agda read (computed in the core, so it needs
   no platform), and the generation.
+  **Stale goals**: a goal of another session, file or generation is
   refused as stale; one the load does not have, as unknown.  An abort or
   a failed load leaves no file in Agda, and the session refuses until the
   next load.  The check is made again when an operation reaches the head
   of the queue, so one that waited while another load or an abort
   replaced its load is refused, unsent.
+  **Which file is read**: `load(path, text)` writes `text` where Agda
   reads `path` (the drive in the page; natively, the file under the
   project's root, which the transport never leaves), and `load(path)`
   writes nothing and loads the file as it is.  A host decides which: the
   page writes its buffer; an editor host may load the saved file, or a
   buffer it writes elsewhere ([#64]'s choice).
+  **A changed source**: after a load the session reads the file back, and
   a digest that differs from the text Agda was given fails the load.
+  **Coordinates**: Agda counts code points, 1-based, after a leading
   byte-order mark; the session converts to UTF-16 for the host.  A host's
   conversion of a source must keep every line's length in code points,
   which the session checks before writing the file; the page's PLFA
   aliases (`browserAgdaSource`) are such a conversion, and stay the
   page's.

**Evidence**.

+  In both engines, Agda places a goal after `𝕓` (outside the Basic
   Multilingual Plane, two UTF-16 units) at column 13, and the session's
   span is the goal's text; a give of `f (f 𝕓)` and a normalization of
   `not (not 𝕥)` answer as expected.  With the conversion broken (code
   points counted as UTF-16 units, in the built package only), that
   scenario fails on both engines, `the goal's text: expected "{! !}"`,
   and every other scenario passes ([the conformance record][record],
   `control`).
+  A module switch's previous goal is refused as stale, and nothing is
   sent for it; a goal of an earlier load of the same file too (§ 9).
+  Unit tests: a source rewritten during a load fails it; a conversion that
   moves a position is refused and no load is sent; the SHA-256 equals
   node's on eleven samples, and the UTF-8 encoding TextEncoder's.

**Status**.  Adopted.

---

## 5.  The snapshot and the give rule

(See also [`docs/engine/overview.md`][overview] "The give rule".)

**Decision**.  The session keeps the snapshot, applies the give rule to
it, and tells the host its plan synchronously, before anything is sent.

+  After a give or a refine Agda reports positions in the loaded text, so
   the session moves the goals' spans by each edit itself, and reports
   each edit for the host; a `?` that Agda reports as a goal is recorded
   as `{!  !}`.
+  A case split's clauses replace the goal's line (one clause per line, as
   Agda prints them and as the fork did), and the next check loads them:
   Agda has not checked them.
+  The page's editor maps Agda's positions through the edits made since
   the text Agda loaded, and must take a new text as that basis exactly
   when Agda loads it, and only then ([ADR 0001][adr-0001] decision 28).
   So it does that in `onPlan`, when the plan is a load: synchronously,
   before anything is sent, with the text it read and passed to `check()`
   and no edit between.  A give is carried out only against the snapshot
   it was planned on.

**Evidence**.

+  In both engines: an edit inside a goal is given, a new declaration
   loads (the second generation) and retires the old goals; after a give
   the remaining goal is still answered in the loaded text's coordinates;
   a case split's clauses (`choose red = ?`, `choose green = ?`) are
   loaded by the next check, and a refine opens one goal (§ 9).
+  Driving the real page on 2026-10-11 found that a check after a case
   split said "Already checked" and sent nothing, as the fork's controller
   did; it now loads, and the page then shows the three goals the clauses
   make.
+  The browser check passes in Firefox 157 eight times in eight (four with
   the isolation headers, four without), where the commit point the page
   had before [#59] hung 3 times in 8 ([ADR 0001][adr-0001] § 8).

**Status**.  Adopted.

---

## 6.  Deadlines, aborts and the end of a session

(See also [`docs/engine/overview.md`][overview] "What ends a command".)

**Decision**.  Every operation has a deadline, at which the session sends
`Cmd_abort` and, if Agda does not end the command within a grace period,
terminates the transport and reports the failure once Agda is gone;
nothing is left running or waiting.

+  Deadlines: ten minutes for a load, two for anything else; grace: five
   seconds; a queue of at most sixteen.  A host may set each.
+  Terminating stops the worker, or runs the kill ladder on the child's
   process group (where a platform has none, on the child alone).
+  An abort or a deadline makes Agda forget its file, so the next goal
   operation needs a load first; a host pays that load.
+  When a session ends (a deadline, a crash, a disposal), whatever runs or
   waits fails, and the session refuses from then on.

**Evidence**.  The runners' own checks, 2026-10-11 ([the conformance
record][record]), are the following:

+  natively: a missing executable and an Agda that exits at once fail to
   start, the second with Agda's words (`--no-such-option`); a deadline of
   500 ms on a slow normalization is answered by `Cmd_abort` (the session
   goes on, with the same child); a child stopped with SIGSTOP is killed
   at the deadline and grace (1,545 ms), the queued operation fails, and
   the process is gone; a child killed mid-command ends the session,
   naming SIGKILL; a disposal leaves no process;
+  in the browser: a missing compiler fails the start, naming the file and
   making no worker; a file that is not a compiler fails it and its worker
   is terminated; a deadline is answered by `Cmd_abort`; a worker that dies
   without a word (no event reaches the page) is ended by the deadline and
   grace, and the queued operation fails; a disposal terminates the worker,
   and every worker the page made was terminated.
+  The first native run of the kill check failed: the session reported the
   kill before the child was gone.  It now reports it after.

**Status**.  Adopted.  `Cmd_abort` in place of agda-native-air's kill
ladder is what that record left as follow-on work for its lane.  The
native transport is tested on Linux only; Windows, where a VS Code host
meets it, is [#64]'s.

---

## 7.  What each host owns

(See also [#64], [#66], [`docs/engine/overview.md`][overview] "What each
host owns".)

**Decision**.  The engine owns the protocol; each transport owns its
process and its files; the host owns its configuration, consent,
persistence and editor; the views own nothing but display.

| Part | Owns |
|---|---|
| The engine's core | Commands, validated answers, one command at a time, deadlines and aborts, the basis, the snapshot and the goals, the give rule, refusals and failures |
| The browser transport | The compiler's download and its startup failures; the worker, the drive and its cache; the language server's session and acknowledgements; the editor channel |
| The native transport | The child and its kill ladder; its streams; the files under its project root (it writes a source only when a load gives one), and nothing outside it |
| A host | Its configuration (URLs, executable, project root, library arguments), what it fetches, when it persists, its source conversion, its editor's effects |
| The views | What they show, and the reader's selections |

+  **The page**: the controller supplies the URLs, the worker bundle and
   the PLFA conversion, and decides persistence; `handlers.js` applies each
   response to CodeMirror; the startup, the router, the version query and
   the give rule left the page for the engine.  CodeMirror's
   language-server client keeps the hover tooltips through the transport's
   editor channel, which shares the server's one session.
+  **The companion** keeps its delegated commands to agda-mode-vscode, its
   version guard, its shared highlighting requests and its panel's state
   ([#63]); it imports no package until [#64], which decides how the
   native engine's Agda and the mode's share a checkout's interfaces.

**Evidence**.

+  The page's gates pass from the branch: the browser check with and
   without the isolation headers (the two response headers that make a
   page cross-origin isolated) (`Main` alone checked, a give, a type
   error at its position, the themes), its notices word for word as before,
   the unit tests and svelte-check.  Driven by a script: the language
   server's hover answers (`Set`), and a PLFA chapter checks from source.
+  The companion's real suite passes in the workspace, with native Agda
   2.9.0 and agda-mode-vscode 0.10.4, including the reloads of a normal
   window, visible and hidden.
+  The views type-check with none of the page's aliases.  The contrast
   check reads the views' styles: it derives the text colors it measures
   from its style sources, and without them measured 612 fewer of its
   5,329 pairs, which no assertion caught.

**Status**.  Adopted.  The message protocol between the views and a
webview is [#66]'s.

---

## 8.  The tool surface, the manifest and the views

(See also [#29], [#24], [#41], [#44], [#66].)

**Decision**.  Each of the three is a package over the engine's interface,
consumed by the page, at the size the page uses now.

+  **The tool surface** has agda-mcp's `get_goal`, `type_of` and
   `normalize`, with JSON Schemas, and `fill_hole` and `check_file`, which
   refuse as an unsupported capability: a give is not a verdict.  Answers
   name their tree and how a goal was addressed (by number, by a position
   inside it, or as the only goal), and carry no verdict.  The page's Goal
   type, Context, Infer and Normalize use it.
+  **The manifest** validates the PLFA corpus and interface manifests,
   naming the first wrong field, with the engine's path rules for a
   chapter's module, and plans a chapter's archives as the page did.  It is
   not [#24]'s plugin format and loads nothing; the overview maps the
   present formats to it.
+  **The views** are the inspector's goal list, result and problem list.

**Evidence**.  The tool surface's tests (nine), over a scripted session:
the schemas, each addressing rule and its refusals, input refused before
Agda is asked, Agda's error about an expression as its answer, and the
refused verdicts.  The manifest's tests (four), over the manifests the
page ships.  The page's gates (§ 7).

**Status**.  Adopted at this size.  Open: the rest of agda-mcp's table and
its searches ([#29]); the plugin manifest and its loader ([#24]); the
theory and proof views ([#41], [#44]) and their webview ([#66]).

---

## 9.  One suite, two runners

(See also [`docs/engine/overview.md`][overview] "The conformance suite";
[the conformance record][record].)

**Decision**.  One suite of scenarios, with one set of assertions, runs
through the interface against each engine's real Agda: under node against
native Agda, and in headless Chromium against the site's reactor.  Each
scenario returns a transcript of the values it asserted on (goals, types,
contexts, edits, Agda's errors, refusals, normal forms, digests), not
whole answers, so no time or engine name is in it; the two runs'
transcripts are compared field by field, with the engine's root path and
the session's name replaced by placeholders, and nothing else removed.

+  The scenarios: the session's identity and its refused verdict; a load
   with open goals; a goal's type and context; a valid give; a rejected
   term; the give rule and a reload; a module switch; a case split and a
   refine; Unicode; a literate module; an idle abort.
+  Each runner adds the checks of what it owns (§ 6).
+  `make conformance-native`, `make conformance-browser` and `make
   conformance-compare`, each bounded to ten minutes; CI runs the native
   suite in the companion's workflow and the browser suite in the site's.

**Evidence**.  Run on 2026-10-11 at this branch's code commit, on an Intel
Core i9-12900H (20 logical CPUs, 64 GB), Linux 7.0.0-31, against Agda
2.9.0 `da66a8c7` (natively, the flake's build; in Chromium 149.0.7827.200,
the site's reactor, served without the isolation headers), recorded in
[`docs/measurements/engine-conformance-2026-10-11.json`][record]:

| Runner | Shared scenarios | Its own checks | Time per scenario |
|---|---:|---:|---:|
| native, node 22 | 11 of 11 | 6 of 6 | 21 to 51 ms |
| browser, Chromium 149 | 11 of 11 | 6 of 6 | 435 to 794 ms |

+  **The comparison**: all 11 transcripts identical, Agda's error texts
   included (the rejected term's `[UnequalTypes]` message, its path
   replaced).  The browser's times include a fresh worker per scenario;
   neither column is a benchmark.
+  **The control**: with the code-point conversion broken (§ 4), both
   runners pass 10 of 11 and fail the Unicode scenario with the same
   message.

**Status**.  Adopted.  [#64]'s acceptance is that this suite passes
against its native engine, once that engine resolves the Agda and the
libraries a project pins and keeps one interaction lane per project root.

---

## 10.  The batch lane's ceiling

(See also [#30], [#64].)

**Decision**.  Neither engine has a batch lane yet, and each says so: a
verdict is refused as an unsupported capability, naming the issue that
adds it, and no answer has a verdict field.

**Evidence**.  The first scenario, on both engines: `checkFile()` refuses
with `unsupported-capability`, its reason naming [#30] in the page and
[#64] natively; the tool surface's `fill_hole` and `check_file` refuse the
same way.

**Status**.  Adopted as the ceiling of this record.  Open: [#30] and [#64].

---

## 11.  Decision log

| # | Decision | Status | Evidence |
|---|---|---|---|
| 1 | The repository is an npm workspace of the page, four packages and the companion, from one lockfile; TypeScript packages built by project references, the views as Svelte source | Adopted ([#62], 2026-10-11) | A clean clone checks, tests and builds; the Nix site rebuilds the same bytes (§ 1) |
| 2 | Each part of the engine compiles with only the globals it may use; the native transport is exported under `node` only, and every build checks the bundle | Adopted ([#62]) | Vite refuses the native entry for the browser; the bundle check fails on the native transport's build (§ 1) |
| 3 | The engine's interface: a session over a transport, whose operations return an answer, a refusal or a failure; answers validated with zod; no answer of the lane has a verdict field | Adopted ([#62]) | One load, goal and give, then the suite, answered the same on both engines; unit tests of malformed payloads and faults (§ 2) |
| 4 | A command ends at the language server's `ResponseEnd` in the page, and at Agda's prompt natively; an abort is out of band | Adopted ([#62]) | Read at the sources; probed natively; the runners' deadline checks; STOP in the page (§ 3) |
| 5 | Every answer names its basis; a goal of another session, file or load is refused before anything is sent; the loaded text is read back | Adopted ([#62]) | The module switch and reload scenarios; unit tests (§ 4) |
| 6 | Positions convert between Agda's code points and UTF-16 in the core; a host's conversion must keep every position | Adopted ([#62]) | The Unicode scenario on both engines, and its control (§ 4) |
| 7 | The session keeps the snapshot and applies the give rule to it; the host commits its offsets in the plan hook, at a load | Adopted ([#62]) | The give rule scenario; Firefox 8 of 8 (§ 5) |
| 8 | A check after a case split loads | Adopted ([#62]); the fork said "Already checked" | Found driving the page; the case split scenario (§ 5) |
| 9 | Every operation has a deadline: `Cmd_abort`, then termination after a grace period, reported once Agda is gone; a bounded queue | Adopted ([#62]) | Six checks per runner (§ 6) |
| 10 | The engine owns the protocol, each transport its process and files, the host its configuration, consent, persistence and editor | Adopted ([#62]) | The page's gates and the companion's suite pass (§ 7) |
| 11 | The tool surface, the manifest and the views at the size the page uses; verdict tools refused | Adopted ([#62]); the rest is [#29], [#24], [#41], [#44], [#66] | Their tests; the page's gates (§ 8) |
| 12 | One suite, two runners, transcripts compared field by field; both in CI | Adopted ([#62]) | 11 of 11 on each, identical; the control fails both (§ 9) |
| 13 | No batch lane yet: a verdict is refused, naming the issue | Adopted as the ceiling ([#62]); open [#30], [#64] | The first scenario (§ 10) |

---

## References

+  **Issues**: [#24] (the plugin manifest), [#29] (the tool surface), [#30]
   (the page's batch lane), [#41] (the theory view), [#44] (the proof
   view), [#59] (the reactor and the drive), [#62] (this record), [#63]
   (the companion), [#64] (the native engine in the editor), [#66] (the
   views in a webview).
+  **Pull requests**: [#84] (the companion).
+  **Documents**: [`docs/engine/overview.md`][overview] (this record's
   companion note); [ADR 0001][adr-0001] and [ADR 0002][adr-0002];
   [`docs/notes/runtime.md`][runtime]; [`docs/provenance.md`][provenance];
   [`docs/measurements/engine-conformance-2026-10-11.json`][record].
+  **Code**: `packages/engine/src/core/` (the interface: `session.ts`,
   `responses.ts`, `commands.ts`, `give-rule.ts`, `text.ts`), `src/browser/`
   and `src/native/` (the transports), `src/conformance/` (the suite);
   `packages/tools/`, `packages/manifest/`, `packages/views/`;
   `scripts/conformance/` (the runners); `scripts/check-bundle.mjs`;
   `src/lib/controller.svelte.ts` and `src/lib/agda/handlers.js` (the
   page as host).
+  **Elsewhere**: agda-native-air's [ADR 0002][air-adr-0002];
   agda-language-server [`v8`][als-v8]; Agda at [`da66a8c7`][agda-da66a8c].

[#24]: https://github.com/formalverification/agda-native-ide/issues/24
[#29]: https://github.com/formalverification/agda-native-ide/issues/29
[#30]: https://github.com/formalverification/agda-native-ide/issues/30
[#41]: https://github.com/formalverification/agda-native-ide/issues/41
[#44]: https://github.com/formalverification/agda-native-ide/issues/44
[#59]: https://github.com/formalverification/agda-native-ide/issues/59
[#62]: https://github.com/formalverification/agda-native-ide/issues/62
[#63]: https://github.com/formalverification/agda-native-ide/issues/63
[#64]: https://github.com/formalverification/agda-native-ide/issues/64
[#66]: https://github.com/formalverification/agda-native-ide/issues/66
[#84]: https://github.com/formalverification/agda-native-ide/pull/84
[overview]: ../engine/overview.md
[adr-0001]: 0001-runtime.md
[adr-0002]: 0002-where-the-workbench-lives.md
[runtime]: ../notes/runtime.md
[provenance]: ../provenance.md
[record]: ../measurements/engine-conformance-2026-10-11.json
[air-adr-0002]: https://github.com/formalverification/agda-native-air/blob/3de85b40bf08f84debf413b8fe3f4efb92aec21b/docs/adr/0002-agda-mcp.md
[als-v8]: https://github.com/agda/agda-language-server/tree/v8
[agda-da66a8c]: https://github.com/agda/agda/tree/da66a8c75f11d10699a6b38b261efdf244b66f2a
