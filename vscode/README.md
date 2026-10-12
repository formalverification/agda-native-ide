<!-- File: vscode/README.md -->

# Agda Workbench companion

The first VS Code host for agda-native-ide, beside
`banacorn.agda-mode`.  Today its panel shows the active module, buffer
version and last command's summary, with controls for load, give and
refine.  It provides the persistent host for the engine, agent tools and
diagrams that follow in [#64], [#65] and [#66].  Agda's goals and errors
stay in the mode's own panel.

The companion is a package of the repository's npm workspace ([#62]),
installed with the page and the shared packages from the root's
`package-lock.json`.  It imports none of the shared packages yet: its
commands are agda-mode-vscode's, and the native engine it will host, with
the project's own Agda, is [#64]'s.

## Use the companion

Build it from the repository root, as follows:

```sh
nix develop --command make vscode-build
```

Set the following paths to your companion package and library checkout,
then install the tested mode into a separate extension directory:

```sh
COMPANION=/absolute/path/to/agda-native-ide/worktree/vscode
PROJECT_DIR=/absolute/path/to/agda-algebras
code --extensions-dir "$COMPANION/.vscode-test/manual-extensions" \
  --install-extension banacorn.agda-mode@0.10.4
```

Start a separate development window from the library's dev shell:

```sh
cd "$PROJECT_DIR"
nix develop --command code --new-window \
  --user-data-dir "$COMPANION/.vscode-test/manual-profile" \
  --extensions-dir "$COMPANION/.vscode-test/manual-extensions" \
  --extensionDevelopmentPath "$COMPANION" "$PROJECT_DIR"
```

The separate user data directory starts a process with this shell's PATH,
even if VS Code is already running.  In an agda-algebras dev shell that
PATH includes its Agda wrapper and library registry.  The mode uses its
normal connection settings; if it selects another executable, use its
**Switch to a different Agda version** command to select the checkout's
`.agda/bin/agda`.  This package is not published; [#70] owns packaging and
publishing.

Open an `.agda` or `.lagda.md` module and run `Agda Workbench: Open Panel`
from the command palette.  Opening preserves editor focus.  Load
the module, put the cursor inside a goal, write the term there, then use
**Give** or **Refine**, from the panel or the command palette.  **Goal and
context** is the button that displays the goal's type and context in
Agda mode's panel.  Load applies Agda's highlighting to the editor;
**Highlighting** shows a count of the current highlighted tokens in the
companion's command summary after **Load** has run through the companion.
Before that, it asks you to load without starting a provider request.
Retries share a pending request even after its three-second wait expires;
a new request is allowed when the previous one settles.  The mode may
rearrange editor groups when it opens its own panel.

The panel follows the active Agda module and reads the buffer after every
delegated command.  After Give, a summary such as `give returned` means
the mode's command has finished.  If Agda accepts the term, the goal's
braces disappear from the editor.  A rejected candidate remains inside
its braces and the mode's panel shows the error.  Read that panel for
goals and errors; the companion's summary is not an Agda verdict.
If an ordinary text
file is active, goal commands report that it is not an Agda module.  When
the panel has focus, a command restores the module's editor and selection
before invoking the mode.

The only tested mode version is **0.10.4**.  At activation the companion
reads the installed manifest.  A different version opens a warning page
in the panel naming the found and tested versions.  The controls remain
available, and a missing delegated command is reported explicitly.
The mismatch test uses the same 0.10.4 bundle with a temporary manifest
version of `999.0.0`; it establishes the warning path, not support for an
additional release.

## Checks and measurements

The companion's Make targets run in its workspace, as follows:

```sh
nix develop .#vscode --command make vscode-check vscode-unit
nix develop .#vscode --command make vscode-test
```

The integration suite and its dedicated shell currently support Linux.
Type checking and unit tests also run in the default shell.  The full
test downloads VS Code 1.141.0 and agda-mode-vscode 0.10.4 into
isolated storage, and starts Xvfb when no display is supplied.  The
dedicated shell supplies native Agda 2.9.0, Xvfb, xdotool, node, make and
unzip.  It pins the native compiler and fixture in `flake.lock`; its
standard library is the repository's patched 2.3.  On Linux the downloaded
VS Code also needs the host's GTK, NSS, GBM and ALSA libraries, which CI
installs explicitly.  The Make target bounds the suite to five minutes.

The fixture is a copy of agda-algebras' `Overture.Basic`: extract its Agda
fences into `Overture/Basic.agda` and put one level expression in a goal.
Keep the original literate file outside the include root, since two files
declaring the same module make the load ambiguous.  Copy the standard
library into the temporary directory too.  The test writes no file into
the source checkout.

The suite asserts a visible extension development window, a panel beside
the editor, a live webview that saves its state, real give and refine
edits through the mode, nonempty highlighting, an invalid candidate left
in its goal, cursor restoration from panel focus, and the version warning.
A separate test driver in a normal development window checks real
window reloads: `@vscode/test-electron`'s test host exits on reload, so it
cannot establish restoration on its own.  The driver verifies the saved
module, last command and editor column without creating another panel.
It also changes modules while the panel is hidden, leaves a non-Agda
editor active, and checks that the latest module survives reload.
A no-window control, with a process still alive, fails the xdotool assertion.

The tests also check malformed saved state and exact version matching.
No production code consumes the mode's test hooks.  CI is [the companion
workflow][ci].

The webview loads only this package's scripts and stylesheet, through
`asWebviewUri`, with `default-src 'none'` and a fresh script nonce.  Source
paths and messages become text, never interpolated HTML.  Its state is a
schema version, the module URI and the last command's summary, saved with
`getState`/`setState` and restored by a `WebviewPanelSerializer`.  The host
also saves that state in `workspaceState`, since a hidden webview has no
script to receive updates or call `setState`.  Its latest saved state takes
precedence on reload.  Buffer contents are reread from VS Code.
`retainContextWhenHidden` is false.

On 2026-10-10, one run on an Intel Core i9-12900H (20 logical CPUs,
67,068,481,536 bytes RAM), Linux 7.0.0-31, VS Code 1.141.0, native Agda
2.9.0 and mode 0.10.4 measured an explicit extension activation call at
83.07 ms, including 0.54 ms inside `activate`, and the first load of the
copied module at 4,427.20 ms.  The fixture's interfaces were absent before
that load.  This is one observation, not a benchmark or a comparison with
the browser.  The command return values, exact versions, source and bundle
hashes, machine load and timings are archived in [the run record][run].

## The mode's command contract

Read at agda-mode-vscode 0.10.4, commit
`535b3eb8f09132edbad87017562e6cb7aab99a7c`, and exercised against the
installed Marketplace extension of that version in VS Code 1.141.0 with
native Agda 2.9.0.  Its manifest contributes 77 commands.  The reference
points are [command registration][registration], [dispatch][dispatch] and
[response handling][responses].  The companion consumes no activation
exports, test channels, registry entries or returned internal state.

| Command | Input | Document effect | Where the answer goes |
|---|---|---|---|
| `agda-mode.load` | Active editor; arguments ignored | Saves the buffer; a bare `?` can become a braced goal | Goals, errors and running information in the mode's panel; highlighting in the editor |
| `agda-mode.give` | Cursor inside a loaded goal; reads the text inside its braces | On acceptance, removes the braces; the probe changed `ℓ₁ = {! suc 0ℓ !}` to `ℓ₁ = suc 0ℓ` | Errors and goals in the mode's panel |
| `agda-mode.refine` | Cursor inside a loaded goal; reads the text inside its braces | The probe changed `ℓ₁ = {! suc !}` to `ℓ₁ = suc {!   !}` | New goals and errors in the mode's panel |
| `agda-mode.goal-type-and-context[Simplified]` | Cursor inside a loaded goal | No edit | Type and context in the mode's panel |
| `vscode.provideDocumentSemanticTokens` | Document URI, after load | No edit | VS Code's public semantic-token result from the mode's provider |

The mode handlers accept no term or goal-number argument.  Write a term in
the goal and put the cursor there before giving or refining.  Giving an
empty goal opens the mode's own prompt.  Calling a goal command outside a
goal reports the problem in the mode's panel.

In the successful probes, `executeCommand` resolved to a ReScript result
with an `Ok` tag and a private state object.  Dispatch can also return
`undefined` when there is no applicable editor or loaded state.  Neither
is a supported answer format.  The mode catches connection errors and
displays Agda errors itself; a resolved command does not establish that
Agda accepted an edit.  The companion discards this value, then reads the
document's current text and version.  An unchanged buffer is a possible
outcome, not an inferred failure or success.

There is no contributed highlighting command.  Loading requests Agda's
highlighting, and the public VS Code semantic-token command retrieves the
editor's tokens.  These tokens are classifications and ranges, not goal
types, a complete Agda response stream or a verdict.  Queries requiring
those answers belong to the separate native lane in [#64]; [#69] asks
upstream for an explicit client API.

The panel host follows the [VS Code webview guide][webviews].  Paperproof
was read at `05c68e9cb8e881f9e971abb94efd231a269e0229` for its
[panel host][paperproof-host] and [version error][paperproof-version].
No upstream code is copied.

[#62]: https://github.com/formalverification/agda-native-ide/issues/62
[#64]: https://github.com/formalverification/agda-native-ide/issues/64
[#65]: https://github.com/formalverification/agda-native-ide/issues/65
[#66]: https://github.com/formalverification/agda-native-ide/issues/66
[#69]: https://github.com/formalverification/agda-native-ide/issues/69
[#70]: https://github.com/formalverification/agda-native-ide/issues/70
[ci]: ../.github/workflows/vscode.yml
[run]: ../docs/measurements/vscode-companion-2026-10-10.json
[registration]: https://github.com/banacorn/agda-mode-vscode/blob/535b3eb8f09132edbad87017562e6cb7aab99a7c/src/Main/Main.res
[dispatch]: https://github.com/banacorn/agda-mode-vscode/blob/535b3eb8f09132edbad87017562e6cb7aab99a7c/src/State/State__Command.res
[responses]: https://github.com/banacorn/agda-mode-vscode/blob/535b3eb8f09132edbad87017562e6cb7aab99a7c/src/State/State__Response.res
[webviews]: https://code.visualstudio.com/api/extension-guides/webview
[paperproof-host]: https://github.com/Paper-Proof/paperproof/blob/05c68e9cb8e881f9e971abb94efd231a269e0229/extension/src/actions/toggleWebviewPanel/index.ts
[paperproof-version]: https://github.com/Paper-Proof/paperproof/blob/05c68e9cb8e881f9e971abb94efd231a269e0229/extension/src/services/getLeanClient.ts
