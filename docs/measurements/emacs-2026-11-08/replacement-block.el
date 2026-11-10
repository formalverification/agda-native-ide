;; Agda: each buffer's own project's Agda (2026-11-08).  Replaces the "Agda
;; versions" and "Agda per checkout" blocks (2026-10-28, 2026-10-02).
;; agda-for-project-mode (agda-native-ide's emacs/agda-for-project.el)
;; starts the Agda each buffer's project pins, as the resolver
;; agda-for-project decides from the project's flake (agda-native-ide
;; issues 97 and 98), and restarts Agda when C-c C-l comes from a buffer of
;; another project; agda-mode is told each Agda's version, so 2.8.0 and
;; 2.9.0 both start.  No project is named here: fls and each of its
;; worktrees get their own lock's Agda 2.8.0, agda-algebras its flake's
;; Agda 2.9.0, and agda-lattices, agda-flrp and agda-native-air their dev
;; shell's, once chosen (C-c C-x C-t) or trusted (a line in
;; ~/.config/agda-for-project/trusted).  agda-native-ide's
;; docs/notes/emacs.md has the rest.
;;
;; A file in no project with a flake gets `agda2-program-name': the Agda
;; 2.9.0 that agda-algebras' flake exports, kept alive by a gc root.
(setq agda2-program-name (expand-file-name "~/.cache/agda-2.9.0/bin/agda"))
;; The resolver, kept alive by a gc root:
;;   nix build github:formalverification/agda-native-ide#agda-for-project \
;;     -o ~/.cache/agda-for-project-bin
(setq agda-for-project-program
      (expand-file-name "~/.cache/agda-for-project-bin/bin/agda-for-project"))
(agda-for-project-mode 1)
(with-eval-after-load 'agda2-mode
  (define-key agda2-mode-map (kbd "C-c C-x C-t") #'agda-for-project-choose))
(add-to-list 'auto-mode-alist '("\\.lagda.md\\'" . agda2-mode))
