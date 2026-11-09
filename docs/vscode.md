<!-- File: docs/vscode.md -->

# In VS Code

In VS Code the workbench is a companion extension that runs beside
[agda-mode-vscode] (`banacorn.agda-mode`), which keeps the editor half: its
commands, its input method and its own panel of goals and errors.  The
companion adds what the workbench shares with the browser: a panel that
follows the active module, and the shared engine, here over a native Agda
on your own checkout, where your git, your terminal and your agents are.

## What it does today

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
+  **The project's own Agda** for the lanes: the mode's, unless a setting
   names another, refused with the setting's name unless it answers the
   version the companion expects ([ADR 0003](adr/0003-the-shared-core.md#13-which-agda)).
+  **Tested in VS Code itself**: the extension-host tests run the real
   companion and the real agda-mode-vscode 0.10.4 under Xvfb, in CI, and
   the only tested version of the mode is 0.10.4; another version opens a
   warning in the panel.

## Installing it

The companion is not yet published to the Visual Studio Marketplace or
Open VSX; packaging and publishing are [#70].  Until then it is built from
a checkout of the repository, with Nix:

```sh
git clone https://github.com/formalverification/agda-native-ide
cd agda-native-ide
nix develop --command make vscode-build
```

Then install agda-mode-vscode 0.10.4 into a separate extensions directory
and open your Agda checkout in a development window, as
[the companion's README][companion] describes, and run **Agda Workbench:
Open Panel** from the command palette.

## What comes next

+  **Each project's own Agda** ([#99]): agda-mode-vscode and the lanes run
   each project's Agda as its flake pins it, with no setting touched, so
   that one window can hold projects on different Agdas.  See
   [Each project's own Agda](each-projects-own-agda.md).
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
[#99]: https://github.com/formalverification/agda-native-ide/issues/99
