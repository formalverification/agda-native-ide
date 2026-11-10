<!-- File: docs/emacs.md -->

# In Emacs

agda2-mode, which ships with Agda, is the reference implementation of
Agda's interactive editing, and where most Agda is still written.  The
workbench does not replace it.  In Emacs it builds only what Emacs is good
for, and measures the rest.

## What it does today

+  **Each buffer's project's own Agda** ([#98]): `agda-for-project.el`, in
   the repository's `emacs/`, a global minor mode that makes agda2-mode
   start each buffer's project's own Agda through the shared resolver,
   agda-for-project ([#97]), restart it when `C-c C-l` comes from a buffer
   of another project, and tell agda2-mode the version the resolved Agda
   reports, so that projects on Agda 2.8.0 and 2.9.0 both load in one
   session.  When nothing decides, it offers the resolver's candidates
   through `completing-read` and remembers the pick.  See
   [Each project's own Agda](each-projects-own-agda.md), and
   [the package's note][note] for its commands, options and limits.

agda2-mode itself is unchanged, and works with any Agda as it always has;
the package only chooses which Agda it starts.

## Installing it

The package is not on MELPA; it installs from GitHub.  First install the
resolver, so that Emacs finds `agda-for-project` (before Nix 2.30, the
command is `nix profile install`):

```sh
nix profile add github:formalverification/agda-native-ide#agda-for-project
```

**Doom Emacs**: add the package to `packages.el`,

```elisp
(package! agda-for-project
  :recipe (:host github :repo "formalverification/agda-native-ide"
           :files ("emacs/agda-for-project.el")))
```

turn the mode on in `config.el`,

```elisp
(agda-for-project-mode 1)
```

then run `doom sync` and restart Emacs.

**Emacs 30**, with `use-package`:

```elisp
(use-package agda-for-project
  :vc (:url "https://github.com/formalverification/agda-native-ide"
       :lisp-dir "emacs" :rev :newest)
  :config (agda-for-project-mode 1))
```

The resolver runs a project's Agda only for a flake you trust.  So the
first `C-c C-l` in a repository opens the chooser; pick the entry that
begins "trust the repository", which trusts it and every worktree of it.
To trust every checkout
under a directory at once instead, run `agda-for-project --choose
trust:$HOME/git` in a shell.  [The note][note] has the rest: a fixed path
for the resolver, whatever PATH Emacs inherited; a key for the chooser;
and what to do when `doom sync` cannot fetch MELPA.

## What is being built

+  **agda2-mode's commands as agent tools** ([#71]): load, goals, give,
   refine and case split, registered with claude-code-ide.el's MCP server,
   so that a Claude Code session beside Emacs works at the buffer's goals.
+  **agda-mcp from inside Emacs** ([#72]), through gptel or ellama.
+  **Corpus search as a picker** ([#73]): the corpus index through
   `completing-read`, finding a definition by name or type.
+  **What Emacs can show of the views** ([#74]): a static derivation as an
   SVG with hot-spots, measured, and kept only if it is useful.

Every setup is tested in `emacs --batch`, against the real agda2-mode and
a real Agda, with a control that reproduces the failure first, as
`agda-for-project.el`'s was.  [Milestone 8 of the plan](GITHUB_PROJECT.md)
has the exit criterion.

[note]: notes/emacs.md
[#71]: https://github.com/formalverification/agda-native-ide/issues/71
[#72]: https://github.com/formalverification/agda-native-ide/issues/72
[#73]: https://github.com/formalverification/agda-native-ide/issues/73
[#74]: https://github.com/formalverification/agda-native-ide/issues/74
[#97]: https://github.com/formalverification/agda-native-ide/issues/97
[#98]: https://github.com/formalverification/agda-native-ide/issues/98
