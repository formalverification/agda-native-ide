;;; batch-probe.el --- what the Agda serving each load really runs  -*- lexical-binding: t; -*-

;; File: emacs/test/batch-probe.el
;;
;; Changed from upstream: begun as probe.el of the Emacs design of
;; 2026-11-07 (William's notes, ~/fls-plans/2026-11/emacs-agda/probe.el,
;; not in a repository); it now also reports AGDA_DIR, the time of each
;; load, and how agda-for-project resolved it.
;;
;; A CONFIG for the batch harness of the testing-agda-mode-in-batch-emacs
;; skill (agda-mode-harness.el), as follows:
;;
;;   CONFIG=emacs/test/batch-probe.el CONFIG_UNDER_TEST=<elisp under test> \
;;     emacs --batch -Q -l <harness> FILE...
;;
;; It loads CONFIG_UNDER_TEST, then, after each load's verdict, prints the
;; binary the Agda process runs (read from /proc, after any wrapper has
;; exec'd it), the arguments it got, its AGDA_DIR, the seconds from the
;; call of `agda2-load' (including any restart and resolution) to the
;; verdict, and, when agda-for-project-mode started it, how the resolver
;; decided and how long the resolution took.  Linux only (/proc).

(require 'seq)
(require 'subr-x)
(load (expand-file-name (getenv "CONFIG_UNDER_TEST")) nil t)

(defvar probe/t0 nil "When the current `agda2-load' was called.")

(defun probe/proc (pid what)
  "The NUL-separated strings of /proc/PID/WHAT, or nil."
  (ignore-errors
    (with-temp-buffer
      (insert-file-contents (format "/proc/%d/%s" pid what))
      (split-string (buffer-string) "\0" t))))

(defun probe/start-clock (load &rest args)
  "Around `agda2-load', outermost: note when LOAD was called with ARGS."
  (setq probe/t0 (float-time))
  (apply load args))

(defun probe/report (verdict)
  "After the harness's verdict VERDICT: print what the process runs."
  (let ((seconds (and probe/t0 (- (float-time) probe/t0))))
    (if (not (and (boundp 'agda2-process) (process-live-p agda2-process)))
        (message "  probe: no live Agda process (%.1f s)" (or seconds 0))
      (let ((pid (process-id agda2-process)) (n 0) line)
        ;; A wrapper (a shell script) execs Agda; wait until /proc shows it.
        (while (and (< n 40)
                    (progn (setq line (probe/proc pid "cmdline"))
                           (or (null line)
                               (member (file-name-nondirectory (car line))
                                       '("bash" "sh" "agda-for-project" "agda-for-flake.sh")))))
          (accept-process-output nil 0.25)
          (setq n (1+ n)))
        (message "  probe: real agda %s\n  probe: args %s\n  probe: AGDA_DIR=%s\n  probe: load %.1f s%s"
                 (car line)
                 (string-join (cdr line) " ")
                 (or (seq-some (lambda (e) (and (string-prefix-p "AGDA_DIR=" e) (substring e 9)))
                               (probe/proc pid "environ"))
                     "(unset)")
                 (or seconds 0)
                 (if (and (boundp 'agda-for-project--last) agda-for-project--last)
                     (format "\n  probe: resolved by %s, version %s, in %.2f s"
                             (plist-get agda-for-project--last :how)
                             (or (plist-get agda-for-project--last :version) "(probed)")
                             (plist-get agda-for-project--last :seconds))
                   "")))))
  verdict)

(advice-add 'agda2-load :around #'probe/start-clock)
;; `harness/verdict' is defined after this file loads; nadvice keeps the
;; advice across that definition.
(advice-add 'harness/verdict :filter-return #'probe/report)

;;; batch-probe.el ends here
