<!-- File: docs/emacs.md -->

# In Emacs

agda2-mode, which ships with Agda, is the reference implementation of
Agda's interactive editing, and where most Agda is still written.  The
workbench does not replace it.  In Emacs it builds only what Emacs is good
for, and measures the rest.

## What it does today

Nothing ships for Emacs from this repository yet.  agda2-mode works with
any Agda as it always has; the packages below are being built.

## What is being built

+  **Each buffer's project's Agda** ([#98], in progress): a small package,
   `agda-for-project.el`, that makes agda2-mode start each buffer's
   project's own Agda through the shared resolver ([#97]), restart it when
   you move to a buffer of another project, and tell agda2-mode the version
   the resolved Agda reports, so that projects on Agda 2.8.0 and 2.9.0 both
   load in one session.  When nothing decides, it offers the candidates
   through `completing-read` and remembers the choice.  See
   [Each project's own Agda](each-projects-own-agda.md).
+  **agda2-mode's commands as agent tools** ([#71]): load, goals, give,
   refine and case split, registered with claude-code-ide.el's MCP server,
   so that a Claude Code session beside Emacs works at the buffer's goals.
+  **agda-mcp from inside Emacs** ([#72]), through gptel or ellama.
+  **Corpus search as a picker** ([#73]): the corpus index through
   `completing-read`, finding a definition by name or type.
+  **What Emacs can show of the views** ([#74]): a static derivation as an
   SVG with hot-spots, measured, and kept only if it is useful.

Every setup is to be tested in `emacs --batch`, against the real
agda2-mode and a real Agda, with a control that reproduces the failure
first.  [Milestone 8 of the plan](GITHUB_PROJECT.md) has the exit
criterion.

[#71]: https://github.com/formalverification/agda-native-ide/issues/71
[#72]: https://github.com/formalverification/agda-native-ide/issues/72
[#73]: https://github.com/formalverification/agda-native-ide/issues/73
[#74]: https://github.com/formalverification/agda-native-ide/issues/74
[#97]: https://github.com/formalverification/agda-native-ide/issues/97
[#98]: https://github.com/formalverification/agda-native-ide/issues/98
