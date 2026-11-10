<!-- File: docs/vscode.md -->

# In VS Code

In VS Code the workbench is a companion extension that runs beside
[agda-mode-vscode] (`banacorn.agda-mode`), which keeps the editor half: its
commands, its input method and its own panel of goals and errors.  The
companion adds what the workbench shares with the browser: a panel that
follows the active module, and the shared engine, here over a native Agda
on your own checkout, where your git, your terminal and your agents are.

## What it does today

+  **Each project's own Agda**: with agda-for-project, the shared
   resolver, as the mode's Agda, one window can hold projects on different
   Agdas and libraries (agda-algebras on Agda 2.9.0 and
   formal-ledger-specifications on 2.8.0, say), and loading a file checks
   it with its own project's Agda.  The companion tells the resolver which
   project is active, restarts the mode when the active file moves to a
   project on another Agda, names the active project's Agda in the status
   bar, and offers the candidates when nothing decides
   ([ADR 0003](adr/0003-the-shared-core.md#17-each-projects-own-agda);
   [Each project's own Agda](each-projects-own-agda.md)).
+  **A panel** that shows the active module, its buffer version and the
   last command's summary, with controls for the mode's load, give and
   refine, which it delegates to agda-mode-vscode's own commands.
+  **Two native lanes**, from the shared engine: an interaction lane per
   project root (the directory of the nearest `.agda-lib`), which answers
   a goal's type and context, an inference, a normalization and a give,
   and a fresh Agda per verdict, whose exit code (0 when the module checks
   with nothing open, 42 for an error or an open goal) the panel and the
   status bar show.  A verdict is that exit code alone, never a reading of
   Agda's messages ([ADR 0003](adr/0003-the-shared-core.md#11-the-verdict-natively)).
+  **The same Agda in the lanes as in the mode**: the resolver's answer,
   or without the resolver the mode's own Agda, unless a setting names
   another.  The engine speaks Agda 2.9.0 and 2.8.0, and an Agda it does
   not speak is refused with the reason
   ([ADR 0003](adr/0003-the-shared-core.md#13-which-agda)).
+  **Tested in VS Code itself**: the extension-host tests run the real
   companion and the real agda-mode-vscode 0.10.4 under Xvfb, in CI, and
   the only tested version of the mode is 0.10.4; another version opens a
   warning in the panel.

## Installing it

The companion is not yet published to the Visual Studio Marketplace or
Open VSX; packaging and publishing are [#70].  Until then it is built from
a checkout of the repository, with Nix.

First install the resolver, so that the VS Code you start next finds
`agda-for-project` on PATH (before Nix 2.30, the command is `nix profile
install`):

```sh
nix profile add github:formalverification/agda-native-ide#agda-for-project
```

Then build the companion, install agda-mode-vscode 0.10.4 into an
extensions directory of its own, and open your Agda checkouts in a
development window, from any shell (no project's dev shell is needed), as
follows:

```sh
git clone https://github.com/formalverification/agda-native-ide
cd agda-native-ide
nix develop --command make vscode-build
C=$PWD/vscode
code --extensions-dir "$C/.vscode-test/manual-extensions" \
  --install-extension banacorn.agda-mode@0.10.4
code --new-window --user-data-dir "$C/.vscode-test/manual-profile" \
  --extensions-dir "$C/.vscode-test/manual-extensions" \
  --extensionDevelopmentPath "$C" \
  ~/git/agda-algebras ~/git/formal-ledger-specifications
```

The last arguments are your checkouts, as many as you like.  The separate
profile leaves your own VS Code settings untouched.  In the new window,
set it up once, as follows:

1.  Open an Agda file.  The companion offers to set
    `agdaMode.connection.paths` to `["agda-for-project"]`; answer **Set
    It**.
2.  The resolver runs a project's Agda only for a flake you trust, so the
    first file of each repository is refused, in a notification and in
    the status bar.  Answer the notification's **Choose an Agda…** (or
    click the status-bar item) to open the chooser, and pick the first
    entry, which trusts that repository and every worktree of it.  To
    trust every checkout under a directory at once instead, run
    `agda-for-project --choose trust:$HOME/git` in a shell.
3.  Load the file with `C-c C-l`.  The status-bar item names the Agda that
    checked it.

Run **Agda Workbench: Open Panel** from the command palette for the panel
and the native lanes.  [The companion's README][companion] describes each
setting, how the mode is steered, and the tests.

## What comes next

+  **Agents** ([#65]): the tool contract registered for the agents already
   in VS Code (an MCP server definition, and language-model tools).
+  **The views** ([#66]): the theory view and the proof view in the panel.
+  **Publishing** ([#70]), on the Marketplace and Open VSX.

[Milestone 7 of the plan](GITHUB_PROJECT.md) has the rest, with its exit
criterion.

[agda-mode-vscode]: https://github.com/banacorn/agda-mode-vscode
[companion]: ../vscode/README.md
[#65]: https://github.com/formalverification/agda-native-ide/issues/65
[#66]: https://github.com/formalverification/agda-native-ide/issues/66
[#70]: https://github.com/formalverification/agda-native-ide/issues/70
