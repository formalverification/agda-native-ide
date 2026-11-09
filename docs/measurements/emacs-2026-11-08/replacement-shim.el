;; What Doom's package! does for the block: the package on load-path, with
;; its autoloads; then the block as published; then the resolver this run uses.
;; As run, the block was loaded from the scratch directory; this copy loads
;; the archived copy of it, which is the same text.
(add-to-list 'load-path "~/git/formalverification/agda-native-ide/worktrees/98-m9-2-emacs/emacs")
(autoload 'agda-for-project-mode "agda-for-project" nil t)
(autoload 'agda-for-project-choose "agda-for-project" nil t)
(load "docs/measurements/emacs-2026-11-08/replacement-block.el" nil t)
(setq agda-for-project-program "$SCRATCH/afp/bin/agda-for-project")
