;;; batch-config.el --- agda-for-project-mode under the batch harness  -*- lexical-binding: t; -*-

;; File: emacs/test/batch-config.el
;;
;; The configuration under test for the batch runs recorded in
;; docs/measurements/emacs-2026-11-08.json: CONFIG_UNDER_TEST for
;; batch-probe.el, under the testing-agda-mode-in-batch-emacs skill's
;; harness.  It loads the package from this directory's parent and enables
;; the mode, as an installed configuration would.
;;
;; Environment:
;;   AGDA_FOR_PROJECT   the resolver to run (default: agda-for-project on PATH)
;;   AGDA_FALLBACK      `agda2-program-name' for a file in no project with a
;;                      flake (default: agda2-mode's own, "agda")
;;   AFP_FALLBACK_ASK   nonempty: `agda-for-project-fallback' is `ask'
;;   AFP_PICK           a regexp; when the package offers candidates, the
;;                      first whose ID matches is picked, in place of the
;;                      minibuffer that batch Emacs does not have.  Unset,
;;                      an offer is an error, so a run that should not ask
;;                      fails if it does.

(add-to-list 'load-path
             (expand-file-name ".." (file-name-directory (or load-file-name buffer-file-name))))
(require 'agda-for-project)

(when-let* ((program (getenv "AGDA_FOR_PROJECT")))
  (setq agda-for-project-program program))
(when-let* ((program (getenv "AGDA_FALLBACK")))
  (setq agda2-program-name program))
(when (< 0 (length (getenv "AFP_FALLBACK_ASK")))
  (setq agda-for-project-fallback 'ask))

(defun batch-config/completing-read (prompt collection &rest _)
  "Print PROMPT and COLLECTION's labels; pick by AFP_PICK, or fail."
  (message "  chooser: %s" prompt)
  (dolist (c collection) (message "  chooser:   %s  [%s]" (car c) (cdr c)))
  (let* ((want (getenv "AFP_PICK"))
         (pick (and want (seq-find (lambda (c) (string-match-p want (cdr c))) collection))))
    (unless pick (error "batch-config: the package offered a choice, and AFP_PICK picks none"))
    (message "  chooser: picked %s" (cdr pick))
    (car pick)))
(advice-add 'completing-read :override #'batch-config/completing-read)

(agda-for-project-mode 1)

;;; batch-config.el ends here
