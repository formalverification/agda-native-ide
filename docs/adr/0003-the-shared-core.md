<!-- File: docs/adr/0003-the-shared-core.md -->

# ADR 0003: the shared core

File: `agda-native-ide/docs/adr/0003-the-shared-core.md`

+  **Status**: Accepted with [#62] (PR [#85]).  The decisions are this
   record's, taken while building [#62] on 2026-10-11, under the plan
   [ADR 0002][adr-0002] § 3 adopted; each is built and tested here.  What
   they leave to later issues is named in each section's status.
   **Amended** by [#64] on 2026-10-12, which gives the native engine its
   batch lane and hosts it in the VS Code companion: §§ 2, 4 and 6 to 10
   say what changed, §§ 11 to 16 record its decisions, and the log (§ 17)
   amends decisions 3 and 13 and adds 17 to 27.
+  **Date**: 2026-10-11; amended 2026-10-12.
+  **Tracking**: [#62] (this record, and the packages); [#29] (the rest of
   the tool surface); [#30] (the page's batch lane); [#24] (the plugin
   manifest and its loader); [#64] (the native engine in the editor, with
   its batch lane); [#65] (the tools as an MCP server and as VS Code's LM
   tools); [#66] (the views in a webview); [#70] (the companion's
   package).
+  **Ancestry**: [ADR 0002][adr-0002] § 3, which decided that the engine
   client, the tool surface, the manifest and the views are packages over
   one engine interface with two implementations, and left the interface
   and each host's share to this record; [ADR 0001][adr-0001] § 8, whose
   reactor and drive in one worker are the browser engine; agda-native-air's
   [ADR 0002][air-adr-0002], read at `3de85b40`, whose tool contract the
   tool surface keeps, and its [interaction lane note][air-lane], whose
   persistence rules the lane registry keeps; the VS Code companion of
   [#63], PR [#84].

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
   the interaction lane answers, with JSON Schemas, and the verdict tools,
   which the batch lane answers where an engine has one; the PLFA manifests
   the page reads, validated; and the components of the page's inspector
   (the pane that shows goals, results and problems), which import nothing
   from a host.
+  **The page** imports all four, and keeps only what is its own: its
   state, its editor, its URLs, its source conversion and when to persist.
+  **The VS Code companion** imports the engine and the tool surface since
   [#64]: the native engine as child processes of its extension host, one
   interaction lane per project root and a fresh Agda per verdict, running
   the project's own Agda (§§ 11 to 16).

Why it is shaped this way: the fork's code that sent commands and read
answers was written against CodeMirror and the page's controller, so a
second host would have had to copy it; the protocol's two envelopes (the
language server's in the page, none natively) are the only real difference
between the engines, so each transport unwraps its envelope and nothing
more, and the rest is written once.  And a host can only trust an answer
whose basis it can check, so every answer names the text it is about, and
a question about a goal from another session, file or load is refused,
never sent.

Where it stands: built and measured on 2026-10-11, and read again, line by
line, for failure (the self-review), whose fixes are in the sections they
changed.  The suite's 12 shared scenarios pass against both engines, at Agda
2.9.0 `da66a8c7`, and the two engines' answers to them are identical field
for field, once host paths and session names are replaced by placeholders;
each runner's own checks of startup, deadlines, crashes and disposal pass (6
and 6); each of two deliberately broken coordinate conversions fails the same
scenario on both.  The page's gates pass unchanged, served with and without
the two headers that make a page cross-origin isolated, in Chromium and in
Firefox.

[#64] amended it on 2026-10-12: the native engine has the batch lane, whose
verdict is a type of its own; a lane registry keeps one interaction lane per
project root with agda-native-air's rules; a host resolves the Agda a
project uses; and the companion hosts both lanes, running agda-mode-vscode's
Agda with its options unless a setting of its own names another, so that the
two share a checkout's interfaces.  The
suite, now 13 scenarios, passes natively through the registry and the
resolution, and in the browser; the comparison finds 12 identical, and the
verdict scenario different by the batch lane the native engine declares and
the page does not.  Where it goes: the page's batch lane ([#30]), the tools
as an MCP server and LM tools ([#65]), the rest of the tools ([#29]), the
plugin loader ([#24]), the views in the editor ([#66]), the companion's
package ([#70]), and Windows (§ 16).

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
+  **Native entry**: the engine package's `./native` export
   (`packages/engine/src/native/`), its only modules that import node: the
   native transport, and since [#64] the lane registry and the resolution.
+  **Project root**: the directory of the nearest `.agda-lib` above a file,
   where Agda finds the project's library and writes its interfaces (the
   `.agdai` files under `_build/`).  **Lane registry**: the native entry's
   `LaneRegistry`, which keeps one interaction lane per project root
   (§ 12).  **Resolution**: a host's choice of the Agda, and its options,
   that a project's lanes run (§ 13).
+  **air**: agda-native-air, whose agda-mcp server runs the same two lanes
   for agents; its ADR 0002 and its interaction lane note are cited by
   section.
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
   [`docs/measurements/engine-conformance-2026-10-11.json`][record], the runs
   this record's evidence cites; **the probes record**,
   [`docs/measurements/shared-core-probes-2026-10-11.json`][probes], the runs
   of the page and of native Agda that are not the suite's; **the native
   engine's record**,
   [`docs/measurements/native-engine-2026-10-12.json`][native-record], the
   runs and probes of [#64]: the suite and its comparison, three controls,
   the companion's lanes, and the probes of Agda and agda-mode-vscode.
+  **The self-review**: a reading of every line of the pull request for
   failure rather than for conformance, by four readers on 2026-10-11 (the
   core, the transports and the suite, the page and the build, the
   documents), each finding settled by a probe.  It found three defects that
   would have shipped and some twenty smaller ones; each fix is in the
   section whose decision it changed, with its test or control.

---

## 1.  A workspace of four packages

(See also [#62], [`docs/engine/overview.md`][overview] "The packages".)

**Decision**.  The repository is an npm workspace: the page at the root,
`@agda-native-ide/engine`, `/tools`, `/manifest` and `/views` under
`packages/`, and the companion in `vscode/`, from one lockfile.

+  The engine, the tools and the manifest are TypeScript, built by `tsc -b`
   with project references (`make packages`), and imported by their
   `exports`; the views are Svelte source, which the page compiles.
+  Each part of the engine is a project with only the globals it may use: the
   core, the tools, the manifest and the conformance suite with ECMAScript
   and the timers, `performance.now` and `console` that `core/platform.d.ts`
   declares; the browser transport with the DOM; its worker with a worker's;
   the native transport with node.  The native transport is exported under
   the `node` condition only.
+  The companion's lockfile is folded into the root's.  The Nix site's
   source names the packages and the companion's manifest.

**Evidence**.

+  A clean clone of the branch has the same site derivation as the
   worktree, and in it `npm ci`, `make check` (svelte-check of the page,
   and of the views on their own), `make test` and `make vscode-unit` pass;
   `nix build .#site --rebuild` builds the same bytes, and the dev shell's
   `make build` of the same revision equals the Nix site, file for file.
+  A route importing `@agda-native-ide/engine/native` does not build: Vite
   refuses `./native` under the browser's conditions.  An import of `node:fs`
   in the page, or of `fs` in its worker, does not build either: the build
   refuses node's built-in modules (a plugin in `vite.config.js`).  Before
   that plugin, the same import built and passed the bundle check, since Vite
   replaces such a module with an empty one, drops its name and only warns;
   two of the check's markers (`child_process`, `node:fs`) could never match,
   as the self-review found.  `scripts/check-bundle.mjs` now looks, on every
   build, for the markers that remain (the native transport's command line,
   VS Code's API); run on the native transport's own build, it fails.
+  npm 10 dropped the `libc` field of ten platform bindings from the lockfile
   it rewrote.  With those restored, the lockfile only gains entries, except
   for one it loses: `@andy0130tw/vscode-jsonrpc-esm`, a JSON-RPC library
   that only the page's old message router used.  The companion's
   `@vscode/test-electron` now shares the page's jszip 3.10.1, where its own
   lockfile had 3.10.2, and its real suite passes.

**Status**.  Adopted.  The lockfile surgery is recorded in
[`docs/provenance.md`][provenance].

---

## 2.  The engine's interface

(See also [#62], [`docs/engine/overview.md`][overview] "The engine's
interface".)

**Decision**.  The engine's interface is a session over a transport, whose
operations each return one of three types: Agda's answer, the engine's
refusal, or a failure to get an answer; and since [#64] a verdict, a fourth
type, which only the batch lane's operation returns.

+  **Operations**: load, check (the give rule), a goal's type and context,
   give, refine, case split, infer and normalize (at a goal or at the top
   level), Agda's version, abort, and a verdict (the batch lane's, where the
   engine has one, § 11; refused where it has none, § 10); and
   `reloadNext`, which sends nothing and makes the next check a load, for a
   host that has replaced the text it shows.
+  **An answer** carries Agda's value, every response Agda sent for the
   command, its time, its lane (`interaction`), and its basis; it has no
   verdict field.  **A refusal** is made before anything is sent: an
   unsupported capability, a stale or unknown goal, nothing loaded, invalid
   input, a full queue, an ended session, or a conversion that moves
   positions.  **A failure**: a deadline, an abort, Agda's exit, a
   malformed answer, a source that changed while Agda read it, a file that
   could not be read or written, a failed start.
+  **A verdict** is a fourth type, `kind: "verdict"`, `lane: "batch"`,
   which only `checkFile` returns ([#64], § 11).
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
type VerdictOutcome = Verdict | Refusal | Failure;  // the batch lane's (§ 11)
interface Answer<T> {
  kind: "answer"; lane: "interaction"; engine: "browser" | "native";
  session: string; agdaVersion: string; basis?: SourceBasis;
  elapsedMs: number; value: T; responses: AgdaResponse[];
}
interface Refusal { kind: "refusal"; reason: RefusalReason; message: string; capability?: string }
interface Failure { kind: "failure"; reason: FailureReason; message: string; responses?: AgdaResponse[]; detail?: Record<string, unknown> }
interface Verdict {
  kind: "verdict"; lane: "batch"; engine: "browser" | "native"; agdaVersion: string;
  path: string; digest: string; command: { executable: string; args: string[]; cwd: string };
  exitCode: number; success: boolean; diagnostics: Diagnostic[]; checking: string[];
  output: string; elapsedMs: number;
}
type RefusalReason = "unsupported-capability" | "stale-goal" | "unknown-goal" | "no-loaded-file"
  | "invalid-input" | "busy" | "session-ended" | "position-shift" | "configuration";
type FailureReason = "timeout" | "aborted" | "session-ended" | "protocol" | "source-changed" | "io"
  | "startup" | "no-exit-code";
interface SourceBasis { engine; session; agdaVersion; path; digest; generation }
interface GoalRef { id: number; basis: SourceBasis }   // session.goalRef(id), for a live goal
type CheckPlan = { kind: "unchanged" } | { kind: "give"; goal: number; expression: string; span: GoalSpan }
  | { kind: "load"; reason: string };

class AgdaSession {
  load(path: string, text?: string): Promise<Outcome<LoadValue>>;
  check(path: string, text: string, hooks?: { onPlan?(plan: CheckPlan): void }): Promise<Outcome<CheckValue>>;
  plan(path: string, text: string): CheckPlan;
  goal(ref: GoalRef, rewrite?: Rewrite): Promise<Outcome<GoalValue>>;     // type and context
  give(ref: GoalRef, term: string): Promise<Outcome<GiveValue>>;          // also refine
  makeCase(ref: GoalRef, variables: string): Promise<Outcome<MakeCaseValue>>;
  infer(term: string, at?: GoalRef): Promise<Outcome<ExpressionValue>>;  // also normalize
  version(): Promise<Outcome<{ version: string }>>;
  reloadNext(reason: string): void;             // the host replaced its text: the next check loads
  checkFile(path: string, options?: { text?: string; expect?: string }): Promise<VerdictOutcome>;
  abort(): { aborting: OperationKind | undefined };
  onResponse(listener: (event: ResponseEvent) => void): () => void;      // each response, as it arrives
  onStatus(listener: (status: SessionStatus) => void): () => void;       // ready, busy, ended
  dispose(): Promise<void>;
}
```

`check()` calls `onPlan` with the plan synchronously, once the session has
taken the check and before anything is sent (a full queue, or a conversion
that moves positions, refuses the check first and tells nothing): that is the
hook a host uses to act in the same tick as it read the text it checks (§ 5).

**Evidence**.

+  The unit tests drive the session over a scripted transport: a malformed
   payload fails the command and the stream goes on; an unknown kind is kept;
   output that is not an answer fails the command; a full queue refuses; a
   crash fails what runs; a host's listener that throws stops nothing (the
   self-review found that a status listener's error stalled the queue, and a
   response listener's escaped into the transport); a check refused at once
   tells the host no plan.
+  The conformance suite's answers, on both engines, are the comparison of
   § 9.

**Status**.  Adopted.  The companion uses it since [#64] (§ 15); the verdict
type, the `configuration` refusal and the `no-exit-code` failure are
[#64]'s (§§ 11, 13).

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

+  Read at the sources: agda-language-server `v8`'s `src/Agda.hs` (the loop
   calls `waitUntilResponsesSent` and then `signalCommandFinish`, which sends
   `ResponseEnd`) and `src/Server/CommandController.hs`; Agda `da66a8c7`'s
   `AgdaTop.hs` (`repl` prints the prompt, then `maybeAbort runInteraction`
   takes the next command from the queue `initialiseCommandQueue` fills,
   where `Cmd_abort` sets a flag and is not queued), `InteractionTop.hs` (an
   aborted command's state is restored and its file forgotten) and `Base.hs`
   (`parseIOTCM` answers a line it cannot parse with `cannot read: ...`).
+  Probed natively on 2026-10-11 ([the probes record][probes],
   `nativeAbort`): one prompt before the first command and one after each;
   `Cmd_abort`, sent 500 ms into a slow normalization, was answered with
   `DoneAborting`, a `Status` and a prompt about 55 ms later, and the next
   goal command made Agda check the file again (a `Checking` line), so the
   session forgets its basis on an abort.
+  Both runners' deadline checks (§ 6), and the page's STOP during a PLFA
   chapter's first check, which ended it 308 ms after the click; the next
   check then checked the chapter (9.85 s, no problems; [the probes
   record][probes], `page`).

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
+  **Stale goals**: a goal of another session, file or generation is refused
   as stale; one the load does not have, as unknown.  No load holds from the
   moment a load is sent until its answer is read and its source read back,
   nor after an abort, a deadline, or a give, a refine or a case split whose
   answer could not be read: Agda's state is then not the one the session
   knew.  A load Agda refused (an `Error`; not the errors Agda reports among
   its warnings, such as a termination problem, after which it keeps the
   file) refuses an expression until the next load.  The check is made again
   when an operation reaches the head of the queue, so one that waited while
   another load or an abort replaced its load, or a give closed its goal, is
   refused, unsent.
+  **Which file is read**: `load(path, text)` writes `text` where Agda
   reads `path` (the drive in the page; natively, the file under the
   project's root, which the transport never leaves), and `load(path)`
   writes nothing and loads the file as it is.  A host decides which: the
   page writes its buffer; the companion saves the module and loads the
   file as it is ([#64], § 14).
+  **A changed source**: after a load the session reads the file back, and
   a digest that differs from the text Agda was given fails the load.
+  **Coordinates**: Agda counts code points, 1-based, after a leading
   byte-order mark, in the text it reads with each CR LF made one LF
   (`Agda.Utils.IO.UTF8.convertLineEndings`); the session converts to UTF-16
   for the host.  A host's conversion of a source must keep every line's
   length in code points, which the session checks before writing the file;
   the page's PLFA aliases (`browserAgdaSource`) are such a conversion, and
   stay the page's.

**Evidence**.

+  In both engines, Agda places a goal after `𝕓` (outside the Basic
   Multilingual Plane, two UTF-16 units) at column 13, and the session's span
   is the goal's text; a give of `f (f 𝕓)` and a normalization of
   `not (not 𝕥)` answer as expected.  With the conversion broken (code points
   counted as UTF-16 units, in the built package only), that scenario fails
   on both engines, `the goal's text: expected "{! !}"`, and every other
   scenario passes ([the conformance record][record], `controls.unicode`).
+  The self-review found that the session counted a CR LF as two positions,
   so in a CR LF text every goal was placed early by one per line before it,
   and a give edited the wrong text (the core's reader confirmed Agda's count
   against the pinned Agda).  In both engines, Agda now places the two goals
   of a CR LF module where the session puts them, and two gives edit them;
   with the CR LF counted twice in the built package, that scenario fails on
   both, `the first goal's UTF-16 offset: expected 109, got 102` ([the
   conformance record][record], `controls.crlf`).
+  The self-review found that a load whose answer was malformed left the
   previous load live, so a goal of the old file was sent to Agda, which held
   the new one, and that a check made while a load's source was read back saw
   a half-built load; unit tests now drive both, and each fails on the code
   before the fix (a mutation per fix).
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
   as `{!  !}`, by default (a lane registry's sessions record it as
   written, § 12).
+  A case split's clauses replace the goal's clause as Agda's Emacs mode
   replaces it (`agda2-mode.el`'s `agda2-make-case-action` and
   `agda2-make-case-action-extendlam`): a function's line after its
   indentation, each clause on a line of its own with that indentation; an
   extended lambda's clause, from the `;` or `{` before the goal to the
   goal's end, the clauses joined by ` ; `.  The next check loads them: Agda
   has not checked them.  (The fork replaced the whole line and lost the
   first clause's indentation, and in an extended lambda the rest of the
   line; the self-review found both.)
+  The page's editor maps Agda's positions through the edits made since the
   text Agda loaded, and must take a new text as that basis exactly when Agda
   loads it, and only then ([ADR 0001][adr-0001] decision 28).  So it does
   that in `onPlan`, when the plan is a load: synchronously, once the session
   has taken the check and before anything is sent, with the text it read and
   passed to `check()` and no edit between.  A give is carried out only
   against the snapshot it was planned on.
+  A goal's text that holds a hole's or a comment's delimiter (`{!`, `!}`,
   `{-`, `-}`, `--`) loads, since a load would read it differently from a
   give: the self-review found that editing `{! ab !}` into `{! a !} {! b !}`
   planned a give of `a !} {! b`.

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
   the isolation headers, four without; [the probes record][probes],
   `firefox`), where the commit point the page had before [#59] hung 3 times
   in 8 ([ADR 0001][adr-0001] § 8).
+  Driving the real page ([the probes record][probes], `pageScope`): a case
   split inside a `where` block keeps the indentation of both clauses.  Unit
   tests cover a function's clause, an extended lambda's (its first clause, a
   later one, and a `λ where`), and each delimiter.

**Status**.  Adopted.

---

## 6.  Deadlines, aborts and the end of a session

(See also [`docs/engine/overview.md`][overview] "What ends a command".)

**Decision**.  Every operation has a deadline, from the moment it reaches the
head of the queue until its answer is read.  At it, an operation not yet sent
fails unsent; one whose command Agda is running is aborted with `Cmd_abort`,
and if Agda does not end the command within a grace period, the session
terminates the transport and reports the failure once Agda is gone; one whose
answer is being read (a load reads its source back) fails, and its load is
not taken.  Nothing waits on an operation past its deadline.

+  Deadlines: ten minutes for a load, one for Agda's version, two for
   anything else; grace: five seconds; at most sixteen operations waiting
   behind the one running.  A host may set each.  The page sets none, so its
   goal queries, gives, inferences and normalizations end after two minutes,
   where the fork let a command run until the reader pressed STOP: a
   normalization that outruns its deadline is aborted, and Agda forgets the
   file.
+  Terminating stops the worker, or runs the kill ladder on the child's
   process group (where a platform has none, on the child alone).
+  An abort or a deadline makes Agda forget its file, so the next goal
   operation needs a load first; a host pays that load.
+  When a session ends (a deadline, a crash, a disposal), whatever runs or
   waits fails, and the session refuses from then on.  A failure says who
   ended it: the session at a deadline (and whether it terminated Agda), the
   host, or Agda.  A host's listener that throws stops nothing.

**Evidence**.  The runners' own checks, 2026-10-11 ([the conformance
record][record]), are the following:

+  natively: a missing executable and an Agda that exits at once fail to
   start, the second with Agda's words (`--no-such-option`); a deadline of
   500 ms on a slow normalization is answered by `Cmd_abort` (the session
   goes on, with the same child); a child stopped with SIGSTOP is killed
   after a deadline of 400 ms, a grace of 400 ms and kill-ladder steps of 300
   ms (the check took 1,543 ms in all), the queued operation fails, and the
   process is gone; a child killed mid-command ends the session, naming
   SIGKILL; a disposal leaves no process;
+  in the browser: a missing compiler fails the start, naming the file and
   making no worker; a file that is not a compiler fails it and its worker
   is terminated; a deadline is answered by `Cmd_abort`; a worker that dies
   without a word (no event reaches the page) is ended by the deadline and
   grace, and the queued operation fails; a disposal terminates the worker,
   and every worker the page made was terminated.
+  The first native run of the kill check failed: the session reported the
   kill before the child was gone.  It now reports it after.
+  The self-review found three waits with no end, each now a unit test: a
   load whose source was never read back (the deadline had been cleared when
   Agda ended the command); a browser start whose worker failed to load (an
   `error` event, and no answer: the transport's exit did not stop the
   start's waits, nor release the worker); and a drive call to a worker that
   had gone.  It found the native runner's Agda outliving a runner stopped by
   a signal, since a child in a process group of its own does not get the
   terminal's; the runner now terminates its transports on SIGINT, SIGTERM
   and SIGHUP.  And it found messages that said more than their branch knew
   (Agda exiting during an abort's grace reported as killed by the session; a
   host's disposal as Agda stopping), which unit tests now pin.

**Status**.  Adopted.  `Cmd_abort` in place of agda-native-air's kill
ladder is what that record left as follow-on work for its lane.  The
native transport is tested on Linux only; Windows, where a VS Code host
meets it, is a gap [#64] states (§ 16).  A batch run has no `Cmd_abort`:
its deadline stops its Agda (§ 11).

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
| The browser transport | The compiler's download and its startup failures; the worker, the drive and its cache, with the sources under its root on the drive and nothing outside it; the language server's session and acknowledgements; the editor channel |
| The native transport | The child and its kill ladder; its streams; its batch runs ([#64]); the files under its project root (it writes a source only when a load gives one, or a verdict is given a text, which it puts back), and nothing outside it |
| The lane registry ([#64]) | One lane per project root: which request holds it, when a file is loaded, its end, replacement, idle close and disposal |
| A host | Its configuration (URLs, executable, project root, library arguments), what it fetches, when it persists, its source conversion, its editor's effects |
| The views | What they show, and the reader's selections |

+  **The page**: the controller supplies the URLs, the worker bundle and the
   PLFA conversion, and decides persistence; `handlers.js` applies each
   response to CodeMirror; the startup, the router, the version query and the
   give rule left the page for the engine.  CodeMirror's language-server
   client keeps the hover tooltips through the transport's editor channel,
   which shares the server's one session.  Infer and Normalize are answered
   in the scope of the file Agda holds, so when that is not the file on
   screen the page checks the file on screen first (a PLFA chapter with its
   interface archives mounted); the fork named the file in the command, and
   Agda loaded it.  When the page replaces the editor's text, it calls
   `reloadNext`, and it applies no answer about another file than the one on
   screen.
+  **The companion** keeps its delegated commands to agda-mode-vscode, its
   version guard, its shared highlighting requests and its panel's state
   ([#63]).  Since [#64] it imports the engine and the tool surface, and
   hosts the native engine's two lanes; it runs the mode's Agda with the
   mode's options, so the native engine's Agda and the mode's share a
   checkout's interfaces by construction (§§ 13, 15).

**Evidence**.

+  The page's gates pass from the branch: the browser check with and without
   the isolation headers (the two response headers that make a page
   cross-origin isolated) (`Main` alone checked, a give, a type error at its
   position, the themes), its notices word for word as before, the unit tests
   and svelte-check.  Driven by a script ([the probes record][probes],
   `page`): the language server's hover answers (over `Nat`,
   `Data type id=29`), and a PLFA chapter checks from source.
+  The self-review found that Infer in a PLFA chapter that had been opened
   but not checked answered in Main.agda's scope; driven in the page, for
   `_+_` the fixed page answers `ℕ → ℕ → ℕ`, the chapter's, and the page
   before the fix `Nat → Nat → Nat`, Main's.  Coming back to a file Agda
   still held left the editor without its highlighting or goals (as in the
   fork); the fixed page loads it again (2 goals, 4 keyword marks), the page
   before the fix showed none (0 and 0) ([the probes record][probes],
   `pageScope`, `pageReturn`, with their controls).
+  The companion's real suite passed in the workspace at [#62], with native
   Agda 2.9.0 and agda-mode-vscode 0.10.4, including the reloads of a normal
   window, visible and hidden.  Since [#64], the hidden reload fails on this
   machine at the base revision as well (§ 15).
+  The views type-check with none of the page's aliases.  The contrast check
   reads the views' styles: it derives the text colors it measures from its
   style sources, and its report counts 5,318 pairs with the views' styles
   and 4,706 without ([the probes record][probes], `contrast`), a loss no
   assertion caught.

**Status**.  Adopted.  The message protocol between the views and a
webview is [#66]'s.

---

## 8.  The tool surface, the manifest and the views

(See also [#29], [#24], [#41], [#44], [#66].)

**Decision**.  Each of the three is a package over the engine's interface,
consumed by the page, at the size the page uses now.

+  **The tool surface** has agda-mcp's `get_goal`, `type_of` and
   `normalize`, with JSON Schemas, and `fill_hole` and `check_file`, which
   answer from the batch lane where the engine has one ([#64], § 11), and
   refuse as an unsupported capability where it has none: a give is not a
   verdict.  The lane's answers name their tree and how a goal was
   addressed (by number, by a position inside it, or as the only goal), and
   carry no verdict.  The page's Goal type, Context, Infer and Normalize
   use it; the companion's lane commands too.
+  **The manifest** validates the PLFA corpus and interface manifests,
   naming the first wrong field, with the engine's path rules for a
   chapter's module, and plans a chapter's archives as the page did.  It is
   not [#24]'s plugin format and loads nothing; the overview maps the
   present formats to it.
+  **The views** are the inspector's goal list, result and problem list.

**Evidence**.  The tool surface's tests (twelve), over a scripted session:
the schemas, each addressing rule and its refusals, input refused before
Agda is asked, Agda's error about an expression as its answer, the refused
verdicts, and since [#64] the verdicts of `check_file` and `fill_hole` over
a scripted batch lane (a candidate `ok` with another goal open, a type
error, the file put back, a file that is not the goal's text refused).  The manifest's tests (four), over the manifests the
page ships.  The page's gates (§ 7).

**Status**.  Adopted at this size.  Open: the rest of agda-mcp's table and
its searches ([#29]); the tools as an MCP server and VS Code's LM tools
([#65]); the plugin manifest and its loader ([#24]); the theory and proof
views ([#41], [#44]) and their webview ([#66]).

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

+  The scenarios: the session's identity and its lanes; a load with open
   goals; a goal's type and context; a valid give; a rejected term; the give
   rule and a reload; a module switch; a case split and a refine; Unicode;
   CR LF line ends; a literate module; a verdict ([#64]); an idle abort.  The
   first and the last check the session's own contract, so their
   transcripts cannot differ between engines; the other eleven compare what
   Agda answered.
+  **A scenario conditional on a capability** ([#64]): the verdict scenario
   asserts the verdicts where the engine has a batch lane and the refusal
   where it has none, and records which in its transcript as `capability`.
   The comparison reports a difference there as declared, once each run
   passed its own branch, and compares every other scenario as before.
+  Natively, the runner opens each scenario's session as an editor host
   does, through a lane registry with the root and the Agda resolved
   ([#64], §§ 12, 13).
+  Each runner adds the checks of what it owns (§ 6); natively, since [#64],
   the registry's rules against the real Agda too (§ 12).
+  `make conformance-native` and `make conformance-browser`, each run bounded
   to ten minutes, and each removing its record before it starts;
   `make conformance-compare`, which reads the two records and takes the
   scenarios' names from the suite, so a scenario missing from either run is
   a difference (the self-review found that two empty runs had agreed).  CI
   runs the native suite in the companion's workflow and the browser suite in
   the site's.

**Evidence**.  Run on 2026-10-11 at `f37cbb0`, after the self-review's fixes,
on an Intel Core i9-12900H (20 logical CPUs, 64 GB), Linux 7.0.0-31, against
Agda 2.9.0 `da66a8c7` (natively, the flake's build; in Chromium
149.0.7827.200, the site's reactor, served without the isolation headers),
recorded in [`docs/measurements/engine-conformance-2026-10-11.json`][record]:

| Runner | Shared scenarios | Its own checks | Time per scenario |
|---|---:|---:|---:|
| native, node 22 | 12 of 12 | 6 of 6 | 25 to 49 ms |
| browser, Chromium 149 | 12 of 12 | 6 of 6 | 408 to 658 ms |

+  **The comparison**: all 12 transcripts identical, Agda's error texts
   included (the rejected term's `[UnequalTypes]` message, its path
   replaced).  The browser's times include a fresh worker per scenario;
   neither column is a benchmark.
+  **The controls**: with the code-point conversion broken (§ 4), both
   runners pass 11 of 12 and fail the Unicode scenario with the same message;
   with a CR LF counted twice, both pass 11 of 12 and fail the CR LF scenario
   with the same message.

**Evidence since [#64]**.  Run on 2026-10-12 at `1f94e86`, on the same
machine, against the same Agda (in Chromium 149.0.7827.200, the site built
at that revision), recorded in [the native engine's record][native-record]:

| Runner | Shared scenarios | Its own checks |
|---|---:|---:|
| native, node 22, through the registry | 13 of 13 | 12 of 12 |
| browser, Chromium 149 | 13 of 13 | 6 of 6 |

+  **The comparison**: 12 transcripts identical; the verdict scenario
   different by the declared batch lane (the native engine has it, the
   page's not), each run having passed its own branch.
+  **The controls**: each of the following fails the comparison (exit 1): a
   native transcript of the second scenario given another `checking` list
   (`DIFFER`); the browser's verdict scenario marked failed (`FAILED`); the
   browser's verdict transcript stripped of its `capability`
   (`/capability/batch: browser undefined, native true`).

**Status**.  Adopted.  [#64]'s acceptance, that this suite pass against its
native engine once that engine resolves the Agda and the libraries a project
pins and keeps one interaction lane per project root, is met: natively it
passes through the registry and the resolution an editor host uses, the
root found by the fixture's `.agda-lib` and the Agda checked for its
version.  The libraries reach a lane through its Agda's options, which the
runner has none of and the companion's real suite takes from the mode
(§§ 13, 15).

---

## 10.  The batch lane, engine by engine

(See also [#30], [#64].)

**Decision**.  Each engine declares whether it has a batch lane: natively a
verdict is a fresh Agda's exit code ([#64], § 11); in the page a verdict is
refused as an unsupported capability, naming [#30]; no answer of the
interaction lane has a verdict field.

**Evidence**.  Until [#64], the first scenario on both engines:
`checkFile()` refused with `unsupported-capability`, its reason naming [#30]
in the page and [#64] natively.  Since: the verdict scenario, natively the
verdicts and in the page the refusal naming [#30]; the tool surface's
`fill_hole` and `check_file` answer and refuse the same way (§ 9).

**Status**.  Adopted as [#62]'s ceiling, and raised by [#64] for the native
engine on 2026-10-12.  Open: [#30].

---

## 11.  The verdict, natively

(See also [#64], [#65]; agda-native-air's [ADR 0002][air-adr-0002] § 3.)

**Decision**.  A verdict is its own outcome: the exit code of a fresh `agda
<options> <file>`, which the native transport runs in the project's root and
the session queues with the interaction lane's commands.  Its `success` is
that exit code alone, never a reading of Agda's messages.

+  **The type**: `kind: "verdict"`, `lane: "batch"`; Agda's exit code;
   `success`, which is that code being 0 and nothing else; Agda's
   diagnostics (code, file, range, message), read from its output; the
   modules the run type-checked (its `Checking` lines); the command, with
   its arguments and directory; and the file and the digest of the text it
   read.  The session reads the file before the run and after it, and a
   file that changed in between has no verdict.
+  **A given text**: `checkFile(path, { text, expect })` writes `text` over
   the file for the run and puts the file back on every path (a deadline,
   an abort and the session's end included); `expect`, a digest, is the
   text the file must hold first.  agda-native-air's `fill_hole` checks a
   candidate this way, in place, since a copy of a hierarchical module fails
   to load.
+  **Queued with the lane**: a verdict waits for the lane's command in
   progress, and the lane's next command waits for it, so the two never
   write a checkout's interfaces at once.  A third writer, the mode's own
   Agda in the companion, is not in the queue: two Agdas writing one
   interface at once is not prevented, and was not probed.  A verdict's
   deadline is a load's (ten minutes); at it, at an abort, or at the
   session's end, its Agda is stopped by SIGTERM and then SIGKILL to its
   process group, and the operation settles once that Agda is gone and the
   file is back.
+  **No exit code, no verdict**: a run ended by a signal the engine did not
   send has no exit code, and is a failure (`no-exit-code`); so is a run
   that could not start.
+  **The tools**: `check_file` and `fill_hole` answer with it (§ 8), with
   `equivalentTo`, a command line that reproduces the run, and
   agda-native-air's sentences for what `success` and `status` mean, less
   the clause that its server has no interaction mode (this one has) and
   with its dashes made commas.  `fill_hole`'s status is `ok` when the run
   exits 0, or exits 42 with nothing but `UnsolvedInteractionMetas` errors
   (the file's other goals, and the candidate's own new ones), as air's is.
   That status reads the errors' codes, in the safe direction only: output
   with no code it can read leaves a failed run `type_error`, never `ok`.

**Evidence**.

+  Probed on 2026-10-11 with batch Agda 2.9.0 `da66a8c7` ([the native
   engine's record][native-record], `probes.batchExitCodes`): exit 0 for a
   module that checks, and for one whose only message is a warning, which
   Agda printed twice, once before the banner "All done; warnings
   encountered" and once after it; 42 for an open
   goal (`UnsolvedInteractionMetas`, its range from the first goal to the
   last), a type error (`UnequalTypes`), unsolved metas
   (`UnsolvedMetaVariables`) and a termination problem (`TerminationIssue`);
   71 for an option Agda refuses, with no diagnostic header.  Every message
   is on standard output.
+  The verdict scenario natively: the goals open, 42 with
   `UnsolvedInteractionMetas`; the goals filled, 0 with no diagnostic; a
   type error, 42 with `UnequalTypes` at line 7, column 14; and it asserts
   that the lane's next load of the file reads the file's own text again.
+  Unit tests over a scripted transport, among them: the verdict from the
   exit code; a given text written and put back; `expect` refused with
   nothing written; a signal with no verdict; a file changed during the run;
   the deadline, the abort and the session's end each stopping the run and
   putting the file back; the run queued between two lane commands.  With
   the put-back removed, five of them fail; with the deadline's stop
   removed, the deadline's fails.
+  The runner's check: a verdict on a module whose check counts down from a
   billion, under a deadline of 1,500 ms, failed as a timeout after 1,505
   ms; the check asserts that the run's process was gone, and that the lane
   answered next.
+  In the companion, after agda-mode-vscode's own load of the fixture, the
   batch run type-checked only `Overture.Basic` (§ 15).

**Status**.  Adopted (2026-10-12, [#64]).  The page's batch lane is [#30];
[#65] registers the tools.  Not ported: agda-native-air's structured
diagnostics (their `involved` payloads, their ordering and cap) and its hole
listing; the diagnostics here are Agda's messages split by header.

---

## 12.  One lane per project root

(See also [#64]; agda-native-air's [interaction lane note][air-lane] § 3.)

**Decision**.  A lane registry in the native entry keeps one interaction
lane per project root, with agda-native-air's persistence rules, except
where this engine's session lets it do better.

+  **A lane per resolved root**: the host resolves each request's file to
   a root and an Agda on every request (§ 13); the root keys the lane, and a
   resolution that changes replaces it.
+  **Requests serialized per lane**: a request holds its lane from making
   sure its file is loaded until its own operations end, so no other
   request's load comes between; the session's queue orders its commands.
+  **Ensure-loaded by stamp** (the stamp is what decides whether the file
   changed since the lane loaded it): a request loads its file only when
   the lane holds no file or another, or the file's text is not the
   session's snapshot, or the file's last load failed, or the request asks;
   it says why, in air's words (`first`, `switch`, `changed`, `retry`,
   `requested`, else `reused`).  The stamp is the text itself, where air's
   is the modification time, the size and a fingerprint; and since it is
   compared with the snapshot, a file that holds the lane's own give is not
   loaded again, where air's lane, having no snapshot, reloads after a give
   (its `giveCandidate`, from air's [issue 163][air-163]).  An edit inside a
   goal is a change like any other: the registry loads the file, and never
   gives on a host's behalf.
+  **A crash surfaced once**: the request it interrupts fails with the
   session's failure, and the host is told once (`onLaneEnded`), whether
   the lane was busy or idle (air replaces a lane found dead between
   requests silently); the next request starts another.
+  **Idle shutdown** after fifteen minutes (air's bound; the companion's
   setting), by closing the lane's input, which Agda answers by exiting
   with code 0.
+  **Disposal** closes every lane, one still starting included, and the
   registry refuses from then on.
+  **The prompt, not a sentinel**: air frames each command with
   `Cmd_show_version`; this engine ends a command at Agda's prompt (§ 3).
+  A lane's sessions record a `?` as written, since a lane loads files as
   they are on disk and a `?` recorded as `{!  !}` would make every request
   load again.

**Evidence**.

+  Unit tests with a stand-in `agda`, one per rule; each of four mutations
   (the text ignored in the reuse decision, no idle close, a starting lane
   kept after disposal, no serialization) fails its rule's test.
+  Four of the runner's checks against Agda 2.9.0 ([the native engine's
   record][native-record]): the loads `first`, `reused`, `switch`, `first`
   (another root, another process), `changed` (a rewrite of the same
   length) and `requested`; a lane killed with SIGKILL, told once, a new
   process at the next request; an idle lane closed at its bound (300 ms in
   the check), exit code 0, no signal; two lanes disposed, both processes
   gone, a later request refused.

**Status**.  Adopted (2026-10-12, [#64]).

---

## 13.  Which Agda

(See also [#64], [`vscode/README.md`][companion] "The native lanes".)

**Decision**.  A host resolves the Agda a project uses from its
configuration, in its order; the first candidate that names an executable
decides, and is refused, naming the setting it came from, unless it answers
`--numeric-version` with the version the host expects (in the companion, a
setting that stands in for the project's pin).

+  **The root**: the directory of the nearest `.agda-lib` above the file;
   with none, the host's fallback (the workspace folder) around the file,
   else the file's directory.
+  **The companion's order**: `agdaWorkbench.agda.path` with
   `agdaWorkbench.agda.commandLineOptions`, when the path is set, and then
   no other candidate is tried; else agda-mode-vscode's
   `agdaMode.connection.paths` from the last entry to the first, as the
   mode tries them, passing over a URL and a language server, with
   `agdaMode.connection.commandLineOptions` split as the mode splits them;
   else `agda` on PATH, with the mode's options.  A wrapper, such as
   agda-algebras' dev-shell `agda` that adds its library flags, is an
   executable like any other.
+  **The version**: `agdaWorkbench.agda.version`, 2.9.0 by default.  No file
   a project keeps names its Agda's version in a form a host can read
   (agda-algebras pins it in its flake), so the setting stands in for it.
   The version check passes the candidate's options, so options Agda
   refuses are refused before any lane starts.
+  **The options ride the process's arguments**, after `--interaction-json`
   (as the mode puts them after `--interaction`) and before the file in a
   batch run; every `Cmd_load` inherits them.  air sends them with each load
   instead, since it resolves them for each file.
+  **Shared interfaces**: when the companion has no Agda setting of its own
   and the mode runs an Agda, not its language server, the lanes run the
   mode's Agda with the mode's options, and read and write the interfaces
   the mode's Agda does.  With a setting of its own, or with the mode on its
   language server (its default `connection.paths` tries `als` before
   `agda`), they may not.
+  **Not the language server**: the issue's third candidate, the Agda
   Language Server that agda-mode-vscode can download, speaks LSP, not
   `--interaction-json` on its standard streams, and the engine's only LSP
   transport is the browser's.  It is passed over.

**Evidence**.

+  Probed on 2026-10-11 with Agda 2.9.0 `da66a8c7`, each case in a fresh
   tree ([the native engine's record][native-record],
   `probes.processArguments`): include paths on the process's arguments
   reach a `Cmd_load` with none; on the load's alone, the same; the load's
   `--no-libraries` beside the process's paths, the same; with neither,
   `FileNotFound`; one path on each, both apply.  A load's arguments are
   added to the process's.  Each probe sent one load; in the companion's
   real suite a lane loaded twice with the mode's include paths on its
   command line alone, and both loads found the standard library.
+  agda-mode-vscode 0.10.4, read in its bundle (`probes.agdaModeVscode`):
   it spawns `agda --interaction <commandLineOptions>`, sends `Cmd_load
   "<file>" []` to Agda 2.5.0 and later, splits the options on single
   spaces, and tries `connection.paths` from the last to the first.
+  In the companion's real suite, after the mode's own load of
   `Overture.Basic`, with no interfaces before it: the batch run and the
   lane's first load each type-checked only `Overture.Basic`, accepting
   every standard library interface the mode's Agda wrote (§ 15).
+  Unit tests: the order, language servers passed over, another version
   refused naming both settings, refused options with Agda's words (exit
   71), one probe per unchanged executable; the runner's check of options
   Agda refuses, before any lane starts.

**Status**.  Adopted (2026-10-12, [#64]).

---

## 14.  What an editor host loads

(See also § 4, [#64].)

**Decision**.  The companion saves the module before a lane command, as
agda-mode-vscode does before its own load, and the lane loads the file as
it is (`load(path)`); a dirty buffer is never sent.

+  Every answer and every verdict then names the file on disk, which is what
   the mode, the batch lane and a shell read: the batch verdict and the lane
   read the same text.
+  A give's edit is applied to the editor and saved, so the file holds the
   lane's snapshot again and the next request reuses the load; if the
   module changed meanwhile, the edit is not applied, and the lane loads at
   the next request.
+  The alternative, a buffer written elsewhere, would have Agda check a
   module at a path that is not its own, which a hierarchical module
   refuses, and leave the verdict about another text than the lane's.

**Evidence**.  The real suite: every lane command leaves the module saved
(asserted after each); after the give, the module holds `ℓ₁ = suc 0ℓ`, the
editor's text is the file's, and the next verdict is 0.

**Status**.  Adopted (2026-10-12, [#64]).

---

## 15.  The companion as a host

(See also § 7, [#63], [#70], [`vscode/README.md`][companion].)

**Decision**.  The companion bundles the engine and the tool surface into
its CommonJS main with rolldown, and hosts the two lanes as child processes
of its extension host: five commands, the verdict in the panel and the
status bar, and every lane closed at deactivation.

+  **The bundle**: each entry point a CommonJS bundle, with the engine, its
   native entry, zod and the tool surface inside it, and only VS Code's API
   and node's built-in modules outside.  rolldown 1.2.6 is already locked,
   as Vite 8's bundler, so the bundler adds no package.  The other ways were
   `require()` of the engine's ECMAScript modules, which the extension host
   of VS Code 1.141.0 (node 24.21.0) allows but the manifest's floor
   (`^1.100.0`) was never tested for, and which leaves the workspace's
   symlinks for [#70]'s package to resolve; and the companion as ECMAScript
   modules, which this issue did not try.
+  **The commands**: a goal's type and context, an inference and a
   normalization (in the goal at the cursor, else at the top level), a give
   of the term written in the goal, and the batch verdict of the active
   module.  The answers come through the tool surface, as [#65]'s will; the
   delegated commands to the mode are as [#63] left them.
+  **Interfaces shared by construction**, when the lanes run the mode's
   Agda with the mode's options (§ 13).
+  **The lockfile**: the companion's manifest declares its three
   dependencies (`@agda-native-ide/engine`, `@agda-native-ide/tools` and
   `rolldown`), which the lockfile already held, so no package is fetched
   that was not before; the flake's `npmDepsHash` changes all the same,
   since `fetchNpmDeps` keeps the lockfile in its output.

**Evidence**.  The real suite under VS Code 1.141.0, agda-mode-vscode 0.10.4
and Agda 2.9.0, 2026-10-12, at `1f94e86` ([the native engine's
record][native-record], `companion`), after the mode's own first load of
`Overture.Basic` (4,401 ms):

| Step | Agda's time | The command's |
|---|---:|---:|
| The verdict, the goal open (exit 42), which started the lane | 322 ms | 361 ms |
| The goal's type and context (`Level`), the lane's first load | 317 ms load, 1.2 ms goal | 327 ms |
| The same, warm | 0.8 ms | 6.3 ms |
| An inference in the goal | 1.0 ms | 5.8 ms |
| A give of `0ℓ`, after a load of the edited module | 63 ms load, 1.4 ms give | 88 ms |
| The verdict, the module checking (exit 0) | 331 ms | 338 ms |

+  A verdict rides its root's lane (it is queued there), so the first
   verdict started the interaction lane too; the batch run is a process of
   its own.  The give needed a load first: the term was written into the
   goal and saved, so the file was no longer the lane's text, and the
   registry loads such a file rather than give on the host's behalf (§ 12).
+  The batch run and the lane's first load each type-checked only
   `Overture.Basic`.  These are single observations on a machine other
   sessions were using (load average 3.3), not benchmarks.  The issue's
   premise, native speed, rested on a figure of 5.1 s for a native check of
   a `Main` importing `Setoid.Varieties.HSP` (314 modules), which was Agda
   2.8.0's; under 2.9.0 the same native check took 2.09 to 2.11 s ([ADR
   0002][adr-0002] § 2).  This run measured only `Overture.Basic`, and the
   page has not been measured under 2.9.0.
+  The bundle requires `vscode` and node's built-in modules alone.
+  In the same run the window-reload check that follows failed in its
   hidden case.  It failed in four of five runs on this machine that night
   (the first passed), one of them at the base revision `d301045`, while
   CI's last twelve runs of the workflow passed.  A probe traced it to VS
   Code making another Agda editor active for about 15 ms, which the
   companion follows (`probes.hiddenReload`).
+  The Nix site failed with "npmDepsHash is out of date", the two lockfiles'
   diff being the companion's five new lines, until the hash changed; with
   the new hash it built.

**Status**.  Adopted for Linux (2026-10-12, [#64]).  Open: the views in the
webview ([#66]); the package ([#70]), which can ship `out/` and `media/` as
built; the MCP server definition and the LM tools ([#65]); the
hidden-reload check's dependence on VS Code's focus order ([#63]'s).

---

## 16.  Windows

(See also § 6, [#64].)

**Decision**.  The native engine and the companion's lanes are built and
tested on Linux; Windows is a stated gap, not built.

What would have to change is the following:

+  the process groups: node's `detached` makes no process group on Windows,
   and `process.kill(-pid)` reaches none, so the kill ladder falls back to
   the child alone and a child's own children could outlive it (a job
   object, or `taskkill /T`, would take its place);
+  the end of a lane by closing its input, which Agda answers by exiting on
   Linux, unprobed on Windows;
+  the resolution's search of PATH, which does not try `PATHEXT`
   (`agda.exe`);
+  the `.#vscode` shell, which is Linux only, and the real suite's runner,
   which needs Xvfb and xdotool.

**Evidence**.  None run: the list is read from the code (the transport's
`detached` spawn and `process.kill(-pid)`, the resolution's PATH search)
and from node's documentation of `detached` on Windows (a console of its
own, no process group).

**Status**.  A gap, stated here and in the companion's README.

---

## 17.  Decision log

| # | Decision | Status | Evidence |
|---|---|---|---|
| 1 | The repository is an npm workspace of the page, four packages and the companion, from one lockfile; TypeScript packages built by project references, the views as Svelte source | Adopted ([#62], 2026-10-11) | A clean clone checks, tests and builds; the Nix site rebuilds the same bytes (§ 1) |
| 2 | Each part of the engine compiles with only the globals it may use; the native transport is exported under `node` only, and every build checks the bundle | Adopted ([#62]) | Vite refuses the native entry for the browser; the bundle check fails on the native transport's build (§ 1) |
| 3 | The engine's interface: a session over a transport, whose operations return an answer, a refusal or a failure; answers validated with zod; no answer of the lane has a verdict field | Adopted ([#62]); amended by [#64]: a verdict is a fourth type, which only `checkFile` returns | One load, goal and give, then the suite, answered the same on both engines; unit tests of malformed payloads and faults (§ 2); the verdict scenario (§ 11) |
| 4 | A command ends at the language server's `ResponseEnd` in the page, and at Agda's prompt natively; an abort is out of band | Adopted ([#62]) | Read at the sources; probed natively; the runners' deadline checks; STOP in the page (§ 3) |
| 5 | Every answer names its basis; a goal of another session, file or load is refused before anything is sent; the loaded text is read back; no load holds while a load runs, or after a command whose answer could not be read | Adopted ([#62]); the last clause from the self-review | The module switch and reload scenarios; unit tests and their mutations (§ 4) |
| 6 | Positions convert between Agda's code points and UTF-16 in the core, a CR LF counting once; a host's conversion must keep every position | Adopted ([#62]); CR LF from the self-review | The Unicode and CR LF scenarios on both engines, and their controls (§ 4) |
| 7 | The session keeps the snapshot and applies the give rule to it; a goal's text holding a hole's or a comment's delimiter loads; the host commits its offsets in the plan hook, at a load the session has taken | Adopted ([#62]); the delimiters and "taken" from the self-review | The give rule scenario; unit tests; Firefox 8 of 8 (§ 5) |
| 8 | A check after a case split loads; the split edits as Agda's Emacs mode does | Adopted ([#62]); the fork said "Already checked", and lost the first clause's indentation | Found driving the page; the case split scenario; unit tests; the page probe (§ 5) |
| 9 | Every operation has a deadline until its answer is read: unsent, it fails; running, `Cmd_abort`, then termination after a grace period, reported once Agda is gone; being read, it fails; a bounded queue | Adopted ([#62]); "until its answer is read" from the self-review | Six checks per runner; unit tests (§ 6) |
| 10 | The engine owns the protocol, each transport its process and files, the host its configuration, consent, persistence and editor | Adopted ([#62]) | The page's gates and the companion's suite pass (§ 7) |
| 11 | The tool surface, the manifest and the views at the size the page uses; verdict tools refused | Adopted ([#62]); the rest is [#29], [#24], [#41], [#44], [#66] | Their tests; the page's gates (§ 8) |
| 12 | One suite, two runners, transcripts compared field by field, by the suite's names; both in CI | Adopted ([#62]) | 12 of 12 on each, identical; each control fails both (§ 9) |
| 13 | No batch lane yet: a verdict is refused, naming the issue | Adopted as the ceiling ([#62]); raised by [#64] for the native engine (§§ 10, 11); open [#30] | The first scenario, then the verdict scenario (§ 10) |
| 14 | The page answers Infer and Normalize in the file on screen, checking it first when Agda holds another; it calls `reloadNext` when it replaces its text, and applies no answer about another file | Adopted (the self-review, 2026-10-11) | The page probes and their controls: `ℕ → ℕ → ℕ` against `Nat → Nat → Nat`; 4 keyword marks against 0 (§ 7) |
| 15 | The browser build refuses node's built-in modules; the bundle check looks for the markers that remain | Adopted (the self-review) | An import of `node:fs` or `fs` fails the build, which the previous configuration built and passed (§ 1) |
| 16 | Any exit of the browser engine stops every wait on it and releases its worker | Adopted (the self-review) | Unit tests with a fake worker (§ 6) |
| 17 | A verdict is its own outcome: a fresh Agda's exit code, `success` that code being 0, Agda's diagnostics read from its output and never deciding it | Adopted ([#64], 2026-10-12) | The probed exit codes; the verdict scenario; unit tests (§ 11) |
| 18 | A verdict is queued with the lane's commands; a given text is written over the file and put back on every path; a deadline, an abort or the session's end stops its Agda, and it settles once that Agda is gone | Adopted ([#64]) | Unit tests and two mutations; a deadline of 1,500 ms ended at 1,505 ms (§ 11) |
| 19 | `check_file` and `fill_hole` answer from the batch lane, with agda-native-air's meaning sentences, and refuse where there is none | Adopted ([#64]); [#65] registers them | The tool surface's tests (§§ 8, 11) |
| 20 | One lane per project root, with agda-native-air's persistence rules; the stamp is the text, compared with the snapshot, so a lane's own give is not loaded again; a crash is told once, busy or idle; a lane's sessions record a `?` as written | Adopted ([#64]) | Unit tests and four mutations; four checks against Agda (§ 12) |
| 21 | A scenario may be conditional on a capability; the comparison reports a declared difference only once each run passed its own branch | Adopted ([#64]) | 12 identical and 1 declared; three controls each fail the comparison (§ 9) |
| 22 | The Agda: a host's candidates in order, the first that names an executable deciding, refused unless its `--numeric-version` is the expected version; in the companion, its own setting, then the mode's paths from the last, then PATH; the language server is passed over | Adopted ([#64]) | The mode's bundle; unit tests; the runner's check (§ 13) |
| 23 | Options ride the process's arguments, as the mode passes them, and every load inherits them | Adopted ([#64]); proposed as `Cmd_load`'s, as air's lane sends them, until the probe | Five probes of process and load arguments; a lane's two loads in the real suite (§ 13) |
| 24 | An editor host saves the module and loads the file as it is; a buffer is never sent; a give's edit is applied and saved | Adopted ([#64]) | The real suite (§ 14) |
| 25 | The companion is bundled with rolldown, the engine and the tools inside its CommonJS main; without a setting of its own its lanes run the mode's Agda, so the two share interfaces | Adopted ([#64]) | The bundle's externals; the real suite's lanes, each run checking only the module (§ 15) |
| 26 | The companion's manifest declares its dependencies, at the cost of the flake's `npmDepsHash` | Adopted ([#64]) | The Nix site failed until the hash changed, then built (§ 15) |
| 27 | Windows is a stated gap | Adopted ([#64]) | Read from the code and node's documentation, not run (§ 16) |

---

## References

+  **Issues**: [#24] (the plugin manifest), [#29] (the tool surface), [#30]
   (the page's batch lane), [#41] (the theory view), [#44] (the proof
   view), [#59] (the reactor and the drive), [#62] (this record), [#63]
   (the companion), [#64] (the native engine in the editor, this record's
   amendment), [#65] (the tools as an MCP server and LM tools), [#66] (the
   views in a webview), [#70] (the companion's package).
+  **Pull requests**: [#84] (the companion), [#85] (this record).
+  **Documents**: [`docs/engine/overview.md`][overview] (this record's
   companion note); [ADR 0001][adr-0001] and [ADR 0002][adr-0002];
   [`docs/notes/runtime.md`][runtime]; [`docs/provenance.md`][provenance];
   [`docs/measurements/engine-conformance-2026-10-11.json`][record];
   [`docs/measurements/shared-core-probes-2026-10-11.json`][probes];
   [`docs/measurements/native-engine-2026-10-12.json`][native-record];
   [`vscode/README.md`][companion].
+  **Code**: `packages/engine/src/core/` (the interface: `session.ts`,
   `responses.ts`, `commands.ts`, `give-rule.ts`, `text.ts`, and since
   [#64] `diagnostics.ts`), `src/browser/` and `src/native/` (the
   transports, and natively `registry.ts` and `resolve.ts`),
   `src/conformance/` (the suite);
   `packages/tools/`, `packages/manifest/`, `packages/views/`;
   `scripts/conformance/` (the runners); `scripts/check-bundle.mjs`;
   `src/lib/controller.svelte.ts` and `src/lib/agda/handlers.js` (the
   page as host); `vscode/src/extension.ts`, `resolution.ts` and
   `scripts/build.mjs` (the companion as host).
+  **Elsewhere**: agda-native-air's [ADR 0002][air-adr-0002] and its
   [interaction lane note][air-lane];
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
[#65]: https://github.com/formalverification/agda-native-ide/issues/65
[#66]: https://github.com/formalverification/agda-native-ide/issues/66
[#70]: https://github.com/formalverification/agda-native-ide/issues/70
[#84]: https://github.com/formalverification/agda-native-ide/pull/84
[#85]: https://github.com/formalverification/agda-native-ide/pull/85
[overview]: ../engine/overview.md
[adr-0001]: 0001-runtime.md
[adr-0002]: 0002-where-the-workbench-lives.md
[runtime]: ../notes/runtime.md
[provenance]: ../provenance.md
[record]: ../measurements/engine-conformance-2026-10-11.json
[probes]: ../measurements/shared-core-probes-2026-10-11.json
[native-record]: ../measurements/native-engine-2026-10-12.json
[companion]: ../../vscode/README.md
[air-adr-0002]: https://github.com/formalverification/agda-native-air/blob/3de85b40bf08f84debf413b8fe3f4efb92aec21b/docs/adr/0002-agda-mcp.md
[air-lane]: https://github.com/formalverification/agda-native-air/blob/3de85b40bf08f84debf413b8fe3f4efb92aec21b/docs/agda-mcp/agda-mcp-interaction-lane.md
[air-163]: https://github.com/formalverification/agda-native-air/issues/163
[als-v8]: https://github.com/agda/agda-language-server/tree/v8
[agda-da66a8c]: https://github.com/agda/agda/tree/da66a8c75f11d10699a6b38b261efdf244b66f2a
