<!-- File: docs/engine/overview.md -->

# The shared core

This note explains the four packages every host of the workbench imports:
the engine client, the tool surface, the manifest and the views, under
`packages/`, and how the page uses them.  [ADR 0003][adr] records the
decisions and the evidence for them; this note is the explanation the ADR
links.  The terms are those of [ADR 0002][adr-0002] (an engine, a lane, a
verdict); the runtime the browser engine wraps is
[`docs/notes/runtime.md`][runtime]'s.

## The packages

The repository is an npm workspace: the page at the root, the packages
under `packages/`, and the VS Code companion in `vscode/`, installed
together from one `package-lock.json`.

| Package | Entry points | What it is |
|---|---|---|
| `@agda-native-ide/engine` | `.` | The engine client's interface: the session, its outcomes, the commands, the response validation (`parseResponse`), the give rule, coordinates and digests.  No platform. |
| | `./browser` | The browser transport: the language server's reactor in a worker, over a message port. |
| | `./browser/worker` | That worker's script, which a host's bundler builds. |
| | `./native` | The native engine: `agda --interaction-json` as a child process and a fresh `agda` per verdict (the transport), one lane per project root (the registry), and which Agda a project uses (the resolution).  Exported under the `node` condition only. |
| | `./conformance` | The conformance suite, which runs through `.` alone. |
| `@agda-native-ide/tools` | `.` | The tool surface over a session: agda-mcp's tools, with JSON Schemas. |
| `@agda-native-ide/manifest` | `.` | The manifests the page reads, validated, and the planning it does with them. |
| `@agda-native-ide/views` | `.` | Svelte components with explicit data and event props. |

They depend on one another as follows:

```text
page (src/)  ->  engine, engine/browser, tools, manifest, views
tools        ->  engine
manifest     ->  engine
engine/browser, engine/native, engine/conformance  ->  engine
vscode/      ->  engine, engine/native, tools (bundled into it)
```

`make packages` builds the engine, the tools and the manifest with
TypeScript's project references (`tsc -b`) into each package's `dist/`,
which the packages' `exports` name; the page's `dev`, `build`, `test` and
`check` targets depend on it.  Each part of the engine is a project of its
own with only the globals it may use, so that a misplaced import does not
compile; the globals are the following:

+  the core, the tool surface, the manifest and the conformance suite:
   ECMAScript 2022 and nothing else (`src/core/platform.d.ts` declares the
   timers, `performance.now` and `console`, which every JavaScript host
   has);
+  the browser transport: the DOM;
+  the worker: a web worker's globals;
+  the native transport: node.

The views are Svelte source, which the page's build compiles; `make check`
type-checks them on their own, with none of the page's aliases.  The site's
build refuses node's built-in modules in the page and in its worker
(`vite.config.js`: Vite would otherwise replace each with an empty module,
with no more than a warning), and then runs `scripts/check-bundle.mjs`, which
refuses a bundle that carries a marker of the native transport (its command
line) or of VS Code's API.

## The engine's interface

A session is one running Agda.  `openSession(transport, options)` asks Agda
its version and returns the session; `startBrowserSession(config)` and
`startNativeSession(config)` start a transport and open a session on it.
Its operations, each a command of Agda's interaction protocol, are the
following:

+  `load(path, text?)`: `Cmd_load`, of `text` (written where Agda reads
   it, after the host's conversion) or of the file as it is;
+  `check(path, text, hooks?)`: the give rule (below): nothing, a give, or
   a load;
+  `goal(ref)`: `Cmd_goal_type_context`, a goal's type and context;
+  `give(ref, term)`, `refine(ref, term)`, `makeCase(ref, variables)`;
+  `infer(term, ref?)`, `normalize(term, ref?)`: at a goal or at the top
   level of the loaded file;
+  `reloadNext(reason)`: no command; the next check loads, whatever the text,
   for a host that has replaced the text it shows;
+  `checkFile(path, { text?, expect? })`: the batch lane's verdict, a fresh
   Agda's exit code on the file, where the engine has one (below);
+  `version()`, `abort()`, `dispose()`.

Every operation but the verdict returns an `Outcome`, one of the following
three types, which a caller cannot confuse:

+  an **answer**, Agda's: its value, every response Agda sent for the
   command (validated), the time it took, the lane (`interaction`), and the
   basis (below).  No answer has a verdict field;
+  a **refusal**, the engine's, before anything is sent: an unsupported
   capability (the batch lane), a stale or unknown goal, nothing loaded,
   invalid input, a full queue, an ended session, or a conversion that
   moves positions;
+  a **failure** to get an answer: a deadline, an abort, Agda's exit, a
   malformed answer, a source that changed while Agda read it, a file that
   could not be read or written, or a start that failed.

A verdict is a fourth type, `Verdict` (`kind: "verdict"`, `lane:
"batch"`), and `checkFile` returns it, a refusal or a failure
(`VerdictOutcome`).  It carries Agda's exit code; `success`, which is that
code being 0 and nothing else; Agda's diagnostics, read from its output;
the modules the run type-checked; the command that ran; and the file and
the digest of the text it read.  The diagnostics say why, and never decide
the verdict: a change in Agda's message format can empty them, and cannot
turn a failing run green.

A host listens to the session too: `onResponse` gives each of Agda's
responses as it arrives, with the command it answers (the page colors its
editor from these), and `onStatus` gives the session's state (ready, busy,
ended).

Agda's answers are validated by `parseResponse` (`src/core/responses.ts`),
with zod schemas of the kinds the engine reads, from Agda's own encoding
(`JSONTop.hs` at the pinned commit).  A kind the engine reads with a field
missing or of the wrong type fails the command as a protocol failure that
quotes zod's account; a kind it does not read is kept whole as `Unread`.

A transport (`EngineTransport`) is all an engine needs to provide: send a
command line, send an abort out of band, resolve a path, write and read a
source, terminate, and deliver events (a response, the end of a command,
output that is not a response, Agda's exit).  A transport with the batch
lane also starts a batch run (`runBatch`): a fresh Agda on a file, with the
lane's executable, arguments and directory, which it can stop.

## What ends a command

The session sends one command at a time and sends the next only after the
transport reports the end of the previous one.  Each transport reports it
at a boundary its protocol defines; neither infers it from silence or a
timer.

+  **In the browser**, Agda runs inside the Agda Language Server, and a
   command is the `contents` of an `agda` request (`CmdReq`).  The server's
   answer to that request (`CmdRes`) says only that the command was queued.
   Agda's responses come back as `agda` requests from the server,
   `ResponseJSONRaw` each (with `--raw`), each of which the transport
   acknowledges, since the server sends nothing more until it is; the
   server sends `ResponseEnd` once Agda's loop has finished the command and
   its responses have been sent (agda-language-server's `src/Agda.hs` and
   `src/Monad.hs` at `v8`).  A `CmdRes` that carries an error means the
   server could not read the command, so Agda never ran it, and the
   transport ends it itself.
+  **Natively**, Agda prints the prompt `JSON> ` from its main loop before
   it takes each command from its queue (`AgdaTop.hs`'s `repl`): the first
   prompt says Agda is ready, and each later one ends a command.  A command
   Agda cannot parse gets `cannot read: ...` and a prompt.
+  **An abort** (`Cmd_abort`) is taken by Agda's command reader while a
   command runs, and produces no end of its own: the running command ends,
   after `DoneAborting` and a `Status`.  Agda then restores its state and
   forgets its loaded file, so the session drops its basis and refuses
   goal operations until the next load.  Sent when nothing runs, it does
   nothing.

Every operation has a deadline, from the moment it reaches the head of the
queue until its answer is read: by default ten minutes for a load, one for
Agda's version, and two for anything else.  At the deadline, an operation not
yet sent (its source still being written, say) fails unsent; one whose
command Agda is running is aborted with `Cmd_abort`, and if Agda has not
ended the command within a grace period (five seconds), the session
terminates the transport and reports the operation failed only once it is
gone; and one whose answer is being read (a load reads its source back)
fails, and its load is not taken.  Terminating stops the worker, or closes
the child's input (Agda exits on end of input when idle) and then sends
SIGTERM and SIGKILL to its process group, each after a grace period.  At most
sixteen operations wait behind the one running.  When a session ends,
everything running or waiting fails, and each failure says who ended it: the
session at a deadline, the host, or Agda.  A host's listener that throws
stops nothing: the session logs the error and goes on.

## Which text an answer is about

Every answer names its **basis**: the engine; the session (a name made
when the session opens); Agda's version; the path; the SHA-256 of the
exact text Agda read (`sha256:` and the digest of its UTF-8 encoding,
computed in the core); and the **generation**, the session's count of
loads.  Positions and goal numbers are valid for one generation.

+  A goal is named by a `GoalRef`, its number with its basis.  A goal of
   another session, file or generation is refused as stale, and one the
   current load does not have (given, or never there) as unknown, before
   anything is sent: Agda itself would load the file again, silently, and
   answer about whatever it read.  The session checks again when an operation
   reaches the head of the queue, since a load or an abort ahead of it may
   have replaced the load it was asked about, or a give ahead of it closed
   its goal.
+  After a load, the session reads the source back and compares its digest
   with the text it wrote; a source changed in between fails the load, with
   no basis.  No load holds from the moment a load is sent until its answer
   is read and its source read back: Agda's file is then the new one,
   whatever comes of the load.
+  A load Agda refused (its answer has an `Error`) leaves Agda with no file,
   and the session refuses an expression at the top level until the next
   load, since Agda would check the file again first.  The errors Agda
   reports among its warnings (a termination problem, say) are not such a
   refusal: Agda keeps the file.  After an abort, a deadline, or a give, a
   refine or a case split whose answer could not be read, no load holds.

The **snapshot** is the text Agda's live state reflects: the loaded text with
the edits Agda's own answers made.  Agda goes on reporting positions in the
loaded text after a give (a later goal keeps its range though the text above
it changed), so the session keeps the goals' spans in the snapshot itself and
moves them by each edit, and reports each edit (`TextEdit`, UTF-16 offsets
into the snapshot as it was) for a host that shows the text.  A `?` that Agda
reports as a goal is recorded as `{!  !}`, as editors show it.  A case
split's clauses replace the goal's clause as Agda's Emacs mode replaces it
(`caseSplitEdit`): a function's line after its indentation, each clause on a
line of its own with that indentation; or, in an extended lambda, the goal's
clause, from the `;` or `{` before it to the goal's end, the clauses joined
by ` ; `.  Agda has not checked them, so the next check loads.

**Coordinates**.  Agda counts positions in code points, 1-based, after
dropping a leading byte-order mark, in the text it reads with each CR LF made
one LF (`Agda.Utils.IO.UTF8.convertLineEndings`, which turns the other line
endings into LF one for one); JavaScript, CodeMirror and VS Code count UTF-16
code units, which differ at every character outside the Basic Multilingual
Plane, and at every CR LF.  `OffsetTable` converts between them for one text.
A literate file's positions are those of the file as written, since Agda's
literate preprocessing keeps them.  A host may convert a source before Agda
reads it (the page aliases PLFA's imports to smaller modules,
`src/lib/agda/browser-source.js`), but the conversion must keep every line's
length in code points, which the session checks before it writes the file,
refusing the load otherwise; the basis's digest is the converted text's.

## The give rule

`planCheck(previous, goals, next)` is the fork's rule as a function of texts:
if `next` is the snapshot, nothing is sent; if the only change lies wholly
inside one live goal's braces, in both texts, and leaves the goal non-empty,
the session gives that goal its new contents with `Cmd_give WithoutForce`;
anything else (a declaration, an import, an edit outside every goal or across
two, a goal emptied, or a goal's text that holds a hole's or a comment's
delimiter, `{!`, `!}`, `{-`, `-}` or `--`, which a load would read
differently from a give) loads.  `check()` applies it to the session's
snapshot, and loads whenever nothing, another file, or a failed load is held,
or a case split is unchecked.

`check()` calls its `onPlan` hook with the plan synchronously, once the
session has taken the check and before anything is sent (a full queue, or a
conversion that moves positions, refuses the check first and tells nothing).
The page takes its editor's text as the text Agda's positions refer to (the
offsets' commit, [`runtime.md`][runtime]) in that hook, when the plan is a
load, in the same tick it read the text: a commit at a give would map Agda's
later ranges from the wrong text.  A give is carried out only against the
snapshot it was planned on.

## What each host owns

| Part | Owns |
|---|---|
| The engine's core | Building commands; validating answers; one command at a time, ended at its transport's boundary; deadlines, aborts and the end of a session; the basis, the snapshot and the goals; the give rule; refusals and failures. |
| The browser transport | The compiler's download, its progress and its failures (in the words the page shows after "Agda could not start:"); the worker, the drive and its cache, with the sources under its root on the drive (the page's is the whole drive) and nothing outside it; the language server's session and its acknowledgements; the editor channel. |
| The native transport | The child process and its kill ladder (on its process group, where the platform has one; tested on Linux only); its standard streams; its batch runs, each in a process group of its own; the files under its project root, and nothing outside it, where it writes a source only when a load gives one. |
| The lane registry | One lane per project root; which request holds a lane; when a file is loaded; a lane's end, its replacement, its idle close and its disposal. |
| The host | Its configuration (URLs, the executable, the project root, the library arguments), what it may fetch, when to persist, its source conversion, and its editor: applying highlighting, goals and edits, and showing results. |
| The views | Showing what they are given, and reporting what the reader does. |

In the page, `src/lib/controller.svelte.ts` is the host: it gives the browser
transport its URLs and a worker bundled from `src/lib/worker/als.ts` (one
line, importing the engine's worker), checks through the session, asks the
inspector's questions through the tool surface, writes the edited buffer to
the drive after a give and persists the drive's cache, and keeps the page's
state.  `src/lib/agda/handlers.js` applies each response to CodeMirror as it
arrives, with the engine's rules for what a give or a case split replaces.
CodeMirror's language-server client, which the page keeps for hover, reaches
the server through the transport's editor channel: the transport holds the
server's one session, answers the editor's `initialize` with the server's own
answer, and keeps the two clients' request numbers apart, a cancellation
included.
Infer and Normalize are answered in the scope of the file Agda holds, so when
that is not the file on screen the page checks the file on screen first (a
PLFA chapter with its interface archives mounted, as a check does); the fork
named the file in the command, and Agda loaded it.  When the page replaces
the editor's text (another chapter, or the playground again), it calls
`reloadNext`, since the editor no longer shows the highlighting or the goals
of what Agda holds, and it applies no answer about another file than the one
on screen.

The companion keeps its delegated commands: it drives agda-mode-vscode's
own commands and reads their effects.  It also hosts the native engine
(issue 64), next.

## The native engine in an editor

The native entry (`@agda-native-ide/engine/native`) has three modules: the
transport, the lane registry and the resolution.  The VS Code companion
uses all three; the native conformance runner opens its sessions through
the same two last ones.

**The batch lane**.  The transport starts `agda <args> <file>` in the
project's root, with the interaction lane's executable and arguments, in a
process group of its own, and keeps its output and its exit code.  The
session queues the run with the lane's commands, so a verdict and a load
never write a checkout's interfaces at once, and gives it the deadline of
a load; at the deadline, an abort or the session's end it stops the run's
Agda (SIGTERM, then SIGKILL to the group) and settles once that Agda is
gone.  It reads the file before the run and after it, and a file that
changed in between has no verdict.  `checkFile(path, { text, expect })`
writes `text` over the file for the run and puts the file back on every
path, unless another writer changed it meanwhile (the file then keeps the
newer text, and the failure carries what it held before); `expect` is the
digest the file must hold first.  The transport keeps the first and the
last megabyte of a run's output, and a verdict says how much it did not
read between them (`omitted`).  agda-native-air's
`fill_hole` checks a candidate this way, in place, since a copy of a
hierarchical module fails to load.  Batch Agda 2.9.0 exits 0 when the
file checks with nothing open, 42 for an error, an open goal, an unsolved
meta or a termination problem, and 71 for options it refuses, and prints
every message on standard output; `parseDiagnostics` reads each
`<file>:<range>: error: [Code]` block, once.

**One lane per project root** (`LaneRegistry`), with agda-native-air's
persistence rules (its interaction lane note, § 3).  The host gives the
registry a function that resolves a file to a root and an Agda; the
registry calls it on every request, keys the lane by the root, and
replaces a lane whose Agda or arguments changed.  `withFile(path, use)`
holds the root's lane while it makes sure the file is loaded and runs
`use`; `withLane(path, use)` holds it without loading anything, for a
verdict.  A request loads its file only when the lane holds none or
another, or the file's text is not the session's snapshot (the text
Agda's live state reflects), or its last load failed, or the request asks;
it says why, in air's words (`first`, `switch`, `changed`, `retry`,
`requested`, or `reused` when nothing is loaded).  The stamp is the text,
so a rewrite that keeps the size and the modification time counts, and a
file that holds the lane's own give is not loaded again.  A crash fails
the request it interrupts, and the host is told of it once (`onLaneEnded`),
whether the lane was busy or idle; the next request starts a new lane.  A
lane idle for fifteen minutes is closed, in its turn in the root's line, by
closing its input, which Agda answers by exiting with code 0; disposal
closes every lane, one still starting included, and the registry refuses
from then on.  A lane's
sessions record a `?` as written, since the lane loads files as they are
on disk.

**Which Agda** (`resolveAgda`, `findProjectRoot`).  A project's root is
the directory of the nearest `.agda-lib` above the file, where Agda finds
its library and writes its interfaces; with none, the host's fallback (the
workspace folder) around the file, else the file's directory.  The host
lists candidates in its order, each an executable (a path, or a name on
PATH, resolved as a spawn in the root would resolve it) with its arguments;
the first that names an executable decides, and is refused, naming the
setting it came from, unless it answers
`--numeric-version`, given its arguments, with the version the project
expects.  The arguments go on the process's command line, and every
`Cmd_load` inherits them (Agda adds a load's own arguments to the
process's).  The companion's order is its own setting, then
agda-mode-vscode's connection paths from the last, then `agda` on PATH, so
without a setting of its own it runs the mode's Agda with the mode's
options, and the two share the checkout's interfaces (when the mode runs an
Agda rather than its language server); `vscode/README.md` has the
settings.

**What the companion loads**.  A lane command saves the module first, as
the mode's own load does, and the lane loads the file as it is: a buffer
is never sent, so every answer and verdict names the file on disk, and the
batch verdict and the lane read the same text.  A give's edit is applied
to the editor and saved, so the file is again the lane's snapshot.

## The tool surface

`createToolSurface(session)` gives five tools, each with a JSON Schema for
model tool calling (from its zod schema), as follows:

+  `get_goal`, `type_of` and `normalize` answer from the interaction lane,
   as knowledge: each answer names its tree (engine, session, Agda's
   version, file, digest, generation) and carries no verdict.  A goal is
   addressed by its number, by a line and column inside it (in the loaded
   text, columns counting code points), or by nothing when the file has
   one goal, and the answer says which it used (`addressed`).  Agda's error
   about an expression is part of its answer.
+  `check_file` and `fill_hole` are verdicts, from the batch lane, where
   the engine has one (natively): `check_file` a fresh check of a file as
   it is on disk (the loaded one by default), `fill_hole` of the loaded
   file with a candidate written over a goal (addressed as `get_goal`'s
   is), put back afterwards.  Each answer has `status: "verdict"` and
   `lane: "batch"`, the tree (the file and the digest of the text the run
   read), the command, and `verdict` (the exit code, a command line that
   reproduces the run, and agda-native-air's sentence for what `success`
   or `status` means); `fill_hole` is `ok` when the run exits 0, or 42 with
   nothing but `UnsolvedInteractionMetas`.  Where the engine has no batch
   lane (the page), both refuse: a give is not a verdict.

Input that the schema does not admit, and a tool the surface does not have,
are refused before Agda is asked.  The page's Goal type and Context buttons
use `get_goal`, its Infer `type_of`, and its Normalize `normalize`.  The
rest of agda-mcp's table, and the searches over a corpus, are issue 29's.

## The manifest, and the plugin format to come

`@agda-native-ide/manifest` validates the three manifests the page reads,
naming the first field that is wrong, and plans a chapter's archives; the
manifests are the following:

+  `static/plfa/manifest.json`: PLFA, its source and license, the commit
   and date it was taken at, and its chapters by part, each with the URL
   of its text and the drive path of its module (an absolute Agda source
   path, by the engine's rules);
+  `static/plfa/interfaces/manifest.json`: for each chapter, the archives
   of interfaces a check of it reads, which must be chapters;
+  `static/agda-algebras-modules.json`, which the build writes from
   agda-algebras' sources archive (issue 9; `scripts/library-modules.mjs`):
   the library, its commit, the directories it includes, and every module
   with its path and title, each name the module at its path, in the
   Explorer's order (`compareModuleNames`).

Issue 24's plugin manifest is what these become; the present formats map
to it as follows, and nothing here loads a plugin:

| Plugin manifest | In the present formats |
|---|---|
| kind | implicit: a corpus (PLFA's chapters, which the page shows and loads) |
| pins: the Agda version, the source commit, the digests | the source commit only; the Agda version is the page's, and the archives' digests are the build's cache tokens, not the manifest's |
| what it mounts | `plfa/project.zip` at the drive's root, named by the page; each chapter's interface archives, from the interface manifest |
| what it registers | the chapters, as the Explorer's tree; no tools or search indices |
| what it costs, in bytes | not stated |

## The views

`GoalList`, `ResultView` and `ProblemList` are the inspector's goal list
(each goal and its type, and the selected goal's context), its result
(Agda's answer and the compiler log) and its problem list.  Each takes
plain data (`GoalSummary`, `ContextEntry`, `Result`, `Problem`) and
reports a selection by a callback; none imports from a host.
`ExplorerTree` is the Explorer's tree (issue 9): it takes `TreeItem`s
(`moduleTree` builds a library's from its module list), the ids of the
rows expanded and the open file's path, and reports a change of what is
expanded, a row opened and the selection; `tree.ts` holds its rows and its
keys as plain functions.  [`docs/notes/explorer.md`][explorer-note]
explains it.  Their styles
moved with them, and the contrast check reads them
(`scripts/browser-check/contrast.mjs`).  The theory and proof views are
issues 41 and 44, and their hosting in the companion's webview issue 66.

## The conformance suite

`@agda-native-ide/engine/conformance` is one suite of scenarios with one
set of assertions, through the interface alone, which each runner gives a
target: a function that opens a fresh session with the suite's fixtures
written where its Agda reads them.  The fixtures (`fixtures.ts`) use
Agda's builtins only.  The scenarios are as follows:

+  a session names its engine, its Agda and its lanes;
+  a load with open goals answers them (their numbers, types and spans,
   the `?` shown as a goal, the module checked), and carries no verdict;
+  a goal's type and context;
+  a valid give edits the goal, keeps the basis, and leaves the other goal
   answerable;
+  a rejected term is Agda's answer (`[UnequalTypes]`), and leaves the
   goal open;
+  an edit inside a goal is a give, a new declaration a load, which
   retires the old goals;
+  a module switch refuses the previous module's goals;
+  a case split rewrites the clause, which the next check loads, and a
   refine opens a goal;
+  positions in Unicode text (a character outside the Basic Multilingual
   Plane before a goal on its line), and terms outside ASCII;
+  positions in a text whose line ends are CR LF, and two gives in it;
+  a literate module: a goal in its code, none in its prose, and a give
   that computes;
+  a verdict, conditional on the batch lane: where the engine has one, the
   goals open exit 42 (`UnsolvedInteractionMetas`), the goals filled exit
   0, a type error exits 42 (`UnequalTypes` at its position), and the file
   holds its own text again after; where it has none, the refusal names
   the issue that adds it;
+  an abort with nothing running.

Each scenario returns a transcript of the values it asserted on (goals,
types, contexts, edits, Agda's errors, refusals, normal forms, digests), with
the engine's root path and the session's name replaced by placeholders.  The
first scenario and the last check the session's own contract, so their
transcripts cannot differ between engines; the verdict scenario records the
batch lane's capability in its transcript; the other ten compare what Agda
answered.  The native runner opens each scenario's session as an editor host
does, through a lane registry with the root and the Agda resolved.  The
runners add the checks of what they own: natively, a missing executable, an
Agda that exits at once, a deadline Agda answers, a child stopped with
SIGSTOP that the kill ladder ends, a child killed mid-command, a disposal
that leaves no process, and the registry's rules against the real Agda (one
lane per root, a crash told once and a new lane next, an idle lane closed by
its input, every lane closed at disposal), options Agda refuses refused
before a lane starts, and a verdict stopped at its deadline; in the browser,
a missing compiler, a compiler that is not one, a deadline Agda answers, a
worker that dies without a word (which the deadline ends), and a disposal.

```sh
nix develop .#vscode --command make conformance-native  # node, native Agda
nix develop --command make conformance-browser          # headless Chromium, build/'s reactor
nix develop --command make conformance-compare          # the two runs, field by field
```

Each writes its record into `conformance/` (`CONFORMANCE=` moves it), and
each runner removes its own record before it starts.  The comparison takes
the scenarios' names from the suite, so a scenario missing from either run is
a difference.  A scenario that depends on a capability two engines declare
differently (the batch lane: the native engine has it, the page's not yet)
is reported as declared, not compared, once each run passed its own branch;
every other scenario must answer identically.  The native runner stops its
Agda on SIGINT, SIGTERM and SIGHUP, which Agda's own process group does not
get.  CI runs the native suite in the companion's workflow, which builds
native Agda, and the browser suite in the site's browser job.

## What is not here yet

+  **The page's batch lane**: the page refuses a verdict; issue 30.  The
   native engine has one (issue 64).
+  **The tools as an MCP server and as VS Code's LM tools**: issue 65.
+  **The rest of the tool surface**, and its searches: issue 29.
+  **The plugin loader** and its format: issue 24.
+  **The theory and proof views**, and the webview's message protocol:
   issues 41, 44 and 66.

[adr]: ../adr/0003-the-shared-core.md
[adr-0002]: ../adr/0002-where-the-workbench-lives.md
[runtime]: ../notes/runtime.md
[explorer-note]: ../notes/explorer.md
