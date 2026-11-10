;;; agda-for-project.el --- Each project's own Agda  -*- lexical-binding: t; -*-

;; File: emacs/agda-for-project.el
;;
;; Copyright (C) 2026 William DeMeo
;; License: MIT (see LICENSE at the top of the repository)
;; URL: https://github.com/formalverification/agda-native-ide
;; Version: 0.1.0
;; Package-Requires: ((emacs "27.1"))
;; Keywords: languages, tools

;;; Commentary:

;; agda2-mode runs one Agda process for every buffer, the program that
;; `agda2-program-name' names, and reads that variable (and
;; `agda2-program-args') only when `agda2-restart' starts the process.  A
;; file of a project pinned to another Agda, or to other libraries, is then
;; checked by the wrong one, and the error reads as broken code:
;; "Library 'standard-library-classes' not found", or `NotInScope' inside a
;; dependency.
;;
;; `agda-for-project-mode', a global minor mode, makes agda2-mode start each
;; buffer's own project's Agda.  It asks agda-for-project, the resolver of
;; agda-native-ide issue 97 (scripts/agda-for-project/ in this repository),
;; which Agda the buffer's project pins, as follows:
;;
;;  + Around `agda2-restart' it binds `agda2-program-name',
;;    `agda2-program-args' and `process-environment' to the program, the
;;    arguments and the environment the resolver names, and `agda2-version'
;;    to the version that program reports, so that Agda 2.8.0 and 2.9.0 both
;;    pass agda2-mode's version check.  The environment is bound before
;;    anything asks the program for its version.
;;  + Around `agda2-load' it restarts Agda first when the buffer's project
;;    root differs from the one the running process was started for, or
;;    when no process runs.
;;
;; The package knows no project by name.  When the resolver decides nothing
;; for a project with a flake (several environments, a dev shell that is not
;; trusted, no Agda at all), it offers the resolver's candidates through
;; `completing-read' and remembers the pick with the resolver's --choose.
;; When the resolver fails (an evaluation or a build), it shows the
;; resolver's one line and starts no Agda.  A file in no project with a flake
;; and with no remembered choice gets `agda-for-project-fallback'.
;;
;; Commands: `agda-for-project-explain' (the buffer's resolution, in a help
;; buffer), `agda-for-project-choose' (pick an Agda for the buffer's project)
;; and `agda-for-project-forget' (forget the pick).  Installation and limits:
;; docs/notes/emacs.md in this repository.
;;
;; This packages the design tested on 2026-11-07 for one Doom configuration
;; (its `my/agda-restart' and `my/agda-load'), with the resolver in place of
;; that design's hand-kept table of projects.

;;; Code:

(require 'json)
(require 'subr-x)

;; agda2-mode's variables, declared special here so that the `let*' in
;; `agda-for-project--restart' binds them dynamically even before agda2-mode
;; loads and even when this file is byte-compiled.  A lexical binding of
;; `agda2-program-name' would be invisible to `agda2-restart'.
(defvar agda2-program-name)
(defvar agda2-program-args)
(defvar agda2-version)
(defvar agda2-process)
(defvar agda2-in-progress)
(declare-function agda2-restart "agda2-mode" ())
(declare-function agda2-load "agda2-mode" ())
(declare-function agda2-term "agda2-mode" (&optional nicely))

;;;; Options

(defgroup agda-for-project nil
  "Start each Agda buffer's own project's Agda."
  :group 'languages
  :prefix "agda-for-project-")

(defcustom agda-for-project-program "agda-for-project"
  "The resolver: agda-for-project, by name on variable `exec-path' or as a path.
Install it with `nix profile install
github:formalverification/agda-native-ide#agda-for-project'."
  :type 'string)

(defcustom agda-for-project-fallback nil
  "The Agda for a file in no project with a flake, and with no choice.
nil means `agda2-program-name' and `agda2-program-args' as you set them;
a string names a program to run (with no arguments); `ask' offers the
resolver's candidates and remembers the pick for the file's directory or
library, as for a project whose flake decides nothing."
  :type '(choice (const :tag "agda2-program-name" nil)
                 (const :tag "Ask, and remember" ask)
                 (string :tag "Program")))

;;;; State

(defvar agda-for-project--process-root nil
  "The project root the running Agda process was started for, or nil.")

(defvar agda-for-project--process-inputs nil
  "The flake of the running Agda's project when it started, or nil.
In the form `agda-for-project--inputs' gives.")

(defvar agda-for-project--opening nil
  "Non-nil while `agda2-mode' sets up a buffer, which starts Agda.
A start then never asks for a choice and never fails the open: it says
what is missing, and the next `agda2-load' asks or fails in its place.")

(defvar agda-for-project--last nil
  "A plist describing the last start.
Its keys are :file :root :flake :program :args :env :version :how, and
:seconds,
how long the resolution took.")

;;;; The project root

;; The rule is the resolver's own, in the header of
;; scripts/agda-for-project/agda-for-project.sh ("The project and its
;; flake"): the nearest directory at or above the file holding a
;; `.agda-lib', else the file's own directory, both with symbolic links
;; resolved (the resolver uses `pwd -P').  It is computed here, rather than
;; asked of the resolver, so that `agda2-load' never waits on Nix to learn
;; whether to restart.  A change to that rule in the resolver must be made
;; here too.
(defun agda-for-project-root (file)
  "Return the project root of FILE.
That is the directory of its nearest `.agda-lib', else its own directory,
with symbolic links resolved."
  (let ((dir (file-name-directory (file-truename file))))
    (file-name-as-directory
     (or (locate-dominating-file
          dir (lambda (d) (and (file-directory-p d)
                               (directory-files d nil "\\.agda-lib\\'" t))))
         dir))))

;;;; Calling the resolver

(defun agda-for-project--file (file)
  "FILE as the resolver is given it: absolute, with symbolic links resolved.
So the resolver starts from the directory `agda-for-project-root' starts
from, and a choice it remembers is for the root a restart is keyed by.
The resolver resolves the links of the file's directory (`pwd -P') but
not of the file itself."
  (file-truename (expand-file-name file)))

(defun agda-for-project--call (&rest args)
  "Run the resolver with ARGS; return (STATUS STDOUT STDERR).
Signals a `user-error' when the resolver cannot be found."
  (let ((program (if (file-name-absolute-p agda-for-project-program)
                     agda-for-project-program
                   (executable-find agda-for-project-program))))
    (unless (and program (file-executable-p program))
      (user-error "agda-for-project: the resolver `%s' is not installed (see docs/notes/emacs.md); no Agda was started"
                  agda-for-project-program))
    (let ((err (make-temp-file "agda-for-project-stderr")))
      (unwind-protect
          (with-temp-buffer
            (let* ((coding-system-for-read 'utf-8)
                   (status (apply #'call-process program nil (list t err) nil args)))
              (list status
                    (buffer-string)
                    (with-temp-buffer
                      (insert-file-contents err)
                      (string-trim (buffer-string))))))
        (delete-file err)))))

(defun agda-for-project--last-line (text)
  "The last nonempty line of TEXT, or TEXT itself."
  (or (car (last (split-string (or text "") "\n" t))) text))

(defun agda-for-project--json (text)
  "TEXT read as JSON: objects as alists, arrays as lists, false and null nil."
  (let ((json-object-type 'alist)
        (json-array-type 'list)
        (json-key-type 'symbol)
        (json-false nil)
        (json-null nil))
    (json-read-from-string text)))

(defun agda-for-project--explain (file &optional build)
  "The resolver's --explain --json answer for FILE, as an alist.
Without BUILD it passes --no-build, which only looks."
  (pcase-let ((`(,status ,out ,err)
               (apply #'agda-for-project--call
                      (append '("--explain" "--json")
                              (unless build '("--no-build"))
                              (list (agda-for-project--file file))))))
    (if (and (memq status '(0 69)) (string-prefix-p "{" (string-trim-left out)))
        (agda-for-project--json out)
      (user-error "agda-for-project: %s (exit %s); no Agda was started"
                  (agda-for-project--last-line err) status))))

(defun agda-for-project--candidates (file)
  "The resolver's candidates for FILE, as a list of alists."
  (pcase-let ((`(,status ,out ,err)
               (agda-for-project--call "--candidates" "--json" (agda-for-project--file file))))
    (unless (eql status 0)
      (user-error "agda-for-project: %s (exit %s)" (agda-for-project--last-line err) status))
    (agda-for-project--json out)))

;;;; Choosing

(defun agda-for-project--label (candidate)
  "Return the text a chooser shows for CANDIDATE.
A dev shell always says that entering it runs the project's shell hook,
since a choice of one is consent to run that code (ADR 0004, section 7)."
  (let-alist candidate
    (let ((label (or .label .id)))
      (concat label
              (if (and (equal .kind "devshell")
                       (not (string-match-p "shell hook" label)))
                  " (entering it runs the project's shell hook)"
                "")
              (if .chosen "  [chosen]" "")))))

(defun agda-for-project--choose (file &optional reason)
  "Offer the resolver's candidates for FILE, and remember the pick.
REASON, the resolver's own line, heads the prompt.  Returns the ID."
  (let* ((candidates (agda-for-project--candidates file))
         (table (mapcar (lambda (c) (cons (agda-for-project--label c) (alist-get 'id c)))
                        candidates)))
    (unless table
      (user-error "agda-for-project: %s; and there is no Agda to offer"
                  (or reason "nothing decides this project's Agda")))
    (when reason (message "agda-for-project: %s" reason))
    (let* ((pick (completing-read
                  (format "Agda for %s: " (abbreviate-file-name (agda-for-project-root file)))
                  table nil t))
           (id (cdr (assoc pick table))))
      (unless id (user-error "agda-for-project: no Agda chosen; none was started"))
      (pcase-let ((`(,status ,_out ,err)
                   (agda-for-project--call "--choose" id (agda-for-project--file file))))
        (unless (eql status 0)
          (user-error "agda-for-project: %s" (agda-for-project--last-line err))))
      id)))

;;;; Resolving

(defun agda-for-project--refuse (reason)
  "Signal a `user-error' with the resolver's REASON: no Agda starts."
  (user-error "agda-for-project: %s%s" reason
              (if (string-match-p "no Agda was run" reason) "" "; no Agda was started")))

(defun agda-for-project--wants-choice-p (answer)
  "Whether ANSWER, an undecided --explain, is one a choice settles.
The resolver ends every such line with the advice to choose (\"see
--candidates, then --choose\", \"allow it with --choose devshell:default\");
a failed evaluation or build says \"no Agda was run\" instead."
  (string-match-p "--choose" (or (alist-get 'error answer) "")))

(defun agda-for-project--fallback (file root)
  "The start for FILE, in ROOT, that `agda-for-project-fallback' names."
  (list :file file :root root :flake nil :how 'fallback
        :program (if (stringp agda-for-project-fallback)
                     agda-for-project-fallback
                   agda2-program-name)
        :args (if (stringp agda-for-project-fallback) nil agda2-program-args)
        :env nil :version nil))

(defun agda-for-project--resolve (file &optional chosen)
  "How to start FILE's project's Agda, as a plist (see `agda-for-project--last').
Signals a `user-error', having started nothing, when the resolver cannot
name an Agda.  CHOSEN is non-nil on the second pass, after a choice."
  (let* ((root (agda-for-project-root file))
         (answer (agda-for-project--explain file)))
    (cond
     ((alist-get 'decided answer)
      (when (equal (alist-get 'built answer) "missing")
        (message "agda-for-project: building the Agda of %s (%s %s), once per change of the inputs of its flake; Emacs waits until it is built..."
                 (abbreviate-file-name root)
                 (alist-get 'method answer) (alist-get 'name answer))
        (redisplay t)
        (setq answer (agda-for-project--explain file 'build))
        (unless (alist-get 'decided answer)
          (agda-for-project--refuse (alist-get 'error answer))))
      (list :file file :root root :flake (alist-get 'flake answer)
            :how (intern (or (alist-get 'decidedBy answer) "discovered"))
            :program (alist-get 'program answer)
            :args (alist-get 'args answer)
            :env (mapcar (lambda (kv) (format "%s=%s" (car kv) (cdr kv)))
                         (alist-get 'env answer))
            :version (alist-get 'version answer)))
     ((and (null (alist-get 'flake answer))
           (null (alist-get 'choice answer))
           (not (eq agda-for-project-fallback 'ask)))
      (agda-for-project--fallback file root))
     ((and (not chosen) agda-for-project--opening
           (agda-for-project--wants-choice-p answer))
      (user-error "agda-for-project: %s; C-c C-l offers the choices"
                  (alist-get 'error answer)))
     ((and (not chosen) (agda-for-project--wants-choice-p answer))
      (agda-for-project--choose file (alist-get 'error answer))
      (agda-for-project--resolve file t))
     (t
      (agda-for-project--refuse (or (alist-get 'error answer) "nothing decided"))))))

;;;; The version agda2-mode checks

(defun agda-for-project--version (numeric)
  "Return the version agda2-mode compares, from NUMERIC, or nil.
NUMERIC is what --numeric-version prints, perhaps with a suffix such as
-da66a8c."
  (and (stringp numeric)
       (string-match "\\`\\([0-9]+\\(?:\\.[0-9]+\\)*\\)" numeric)
       (match-string 1 numeric)))

(defun agda-for-project-program-version (program)
  "Return the version PROGRAM reports, in the form agda2-mode checks, or nil.
Runs PROGRAM in the current `default-directory' and `process-environment'."
  (with-temp-buffer
    (when (eql 0 (ignore-errors (call-process program nil t nil "--version")))
      (goto-char (point-min))
      (and (re-search-forward "^Agda version \\([0-9.]+\\)" nil t)
           (match-string 1)))))

;;;; The flake's inputs

(defun agda-for-project--flake (root)
  "The directory of the flake the resolver uses for ROOT, or nil.
That is the nearest directory at or above ROOT holding a flake.nix,
looking no higher than the top of ROOT's git checkout.  The rule is the
resolver's (\"The nearest flake.nix at or above the project, within its
repository\"); a change to it there must be made here too."
  (let ((dir (directory-file-name root)) found)
    (while dir
      (cond ((file-regular-p (expand-file-name "flake.nix" dir))
             (setq found dir dir nil))
            ((or (file-exists-p (expand-file-name ".git" dir))
                 (equal dir (directory-file-name (file-name-directory dir))))
             (setq dir nil))
            (t (setq dir (directory-file-name (file-name-directory dir))))))
    found))

(defun agda-for-project--inputs (root)
  "ROOT's flake, as the directory and times of its flake.nix and flake.lock.
Nil when ROOT has no flake.  A flake that appears, moves nearer or goes,
or a change to either file, can change the resolver's answer; comparing
this costs a few `file-attributes' calls, where asking the resolver would
cost a resolution on every load.  A deleted file's time is nil."
  (let ((flake (agda-for-project--flake root)))
    (and flake
         (cons flake
               (mapcar (lambda (name)
                         (file-attribute-modification-time
                          (file-attributes (expand-file-name name flake))))
                       '("flake.nix" "flake.lock"))))))

;;;; The advice

(defun agda-for-project--restart (restart &rest args)
  "Around `agda2-restart': start the Agda of the current buffer's project.
RESTART is the original function and ARGS its arguments.  The
environment is bound first, so that the version check, agda2-mode's dry
run of the arguments and the process itself all run the same program the
same way; agda2-mode is told the version that program reports."
  (let ((file (buffer-file-name)))
    (if (not file)
        (apply restart args)
      (setq agda-for-project--process-root nil
            agda-for-project--process-inputs nil)
      ;; agda2-restart's own first step, taken before the resolver runs:
      ;; a start the resolver refuses then leaves no Agda of another
      ;; project running, for this buffer's commands to reach.
      (condition-case nil (agda2-term) (error nil))
      (let* ((t0 (float-time))
             (start (condition-case err (agda-for-project--resolve file)
                      (user-error
                       (unless agda-for-project--opening
                         (signal (car err) (cdr err)))
                       (message "%s" (error-message-string err))
                       ;; agda2-mode asks for highlighting through
                       ;; `agda2-go', which marks Agda busy before it
                       ;; starts one; with no start, nothing is in
                       ;; progress, and a stale mark would refuse the
                       ;; commands of every other buffer.
                       (setq agda2-in-progress nil)
                       nil)))
             (seconds (- (float-time) t0)))
        (when start
          (let* ((process-environment (append (plist-get start :env) process-environment))
                 (agda2-program-name (plist-get start :program))
                 (agda2-program-args (plist-get start :args))
                 (agda2-version (or (agda-for-project--version (plist-get start :version))
                                    (agda-for-project-program-version agda2-program-name)
                                    agda2-version)))
            (setq agda-for-project--last (append start (list :seconds seconds)))
            (prog1 (apply restart args)
              (setq agda-for-project--process-root (plist-get start :root)
                    agda-for-project--process-inputs
                    (agda-for-project--inputs (plist-get start :root))))))))))

(defun agda-for-project--mode (mode &rest args)
  "Around `agda2-mode': note that a buffer is being set up.
MODE is the original function and ARGS its arguments.  agda2-mode starts
Agda when it opens a file and none runs; a chooser or an error there would
interrupt the open itself (a quit aborts `find-file')."
  (let ((agda-for-project--opening t))
    (apply mode args)))

(defun agda-for-project--load (load &rest args)
  "Around `agda2-load': restart Agda first if the buffer has another root.
LOAD is the original function and ARGS its arguments.  Agda restarts when
the buffer's project root differs from the running process's, when the
project's flake has changed since it started (one has appeared or gone,
or its flake.nix or flake.lock has changed), or when no process runs.
Restarting here, before agda2-mode marks the load busy, means that a
start that fails leaves no load stuck waiting on a process that never
came."
  (let ((file (buffer-file-name)))
    (when (and file
               (or (not (equal (agda-for-project-root file) agda-for-project--process-root))
                   (not (equal (agda-for-project--inputs agda-for-project--process-root)
                               agda-for-project--process-inputs))
                   (not (and (boundp 'agda2-process) (process-live-p agda2-process)))))
      (agda2-restart))
    (apply load args)))

;;;###autoload
(define-minor-mode agda-for-project-mode
  "Start each Agda buffer's own project's Agda, as agda-for-project decides.
Adds advice around `agda2-mode', `agda2-restart' and `agda2-load' when
enabled, and removes it when disabled.  A running Agda keeps the program
it was started with; the next `agda2-load' from a buffer of another
project, or after its project's flake changes, restarts it."
  :global t
  :group 'agda-for-project
  (if agda-for-project-mode
      (progn
        (advice-add 'agda2-mode :around #'agda-for-project--mode)
        (advice-add 'agda2-restart :around #'agda-for-project--restart)
        (advice-add 'agda2-load :around #'agda-for-project--load))
    (advice-remove 'agda2-mode #'agda-for-project--mode)
    (advice-remove 'agda2-restart #'agda-for-project--restart)
    (advice-remove 'agda2-load #'agda-for-project--load)
    (setq agda-for-project--process-root nil
          agda-for-project--process-inputs nil)))

;;;; Commands

(defun agda-for-project--buffer-file ()
  "The current buffer's file, or a `user-error'."
  (or (buffer-file-name) (user-error "agda-for-project: this buffer visits no file")))

;;;###autoload
(defun agda-for-project-explain (&optional build)
  "Show how agda-for-project resolves the current buffer's Agda.
Only looks, unless BUILD (a prefix argument) asks to build first."
  (interactive "P")
  (let* ((file (agda-for-project--buffer-file))
         (root (agda-for-project-root file))
         (result (apply #'agda-for-project--call
                        (append '("--explain") (unless build '("--no-build"))
                                (list (agda-for-project--file file))))))
    (with-help-window "*agda-for-project*"
      (princ (format "agda-for-project for %s\n\n" (abbreviate-file-name file)))
      (pcase-let ((`(,status ,out ,err) result))
        (unless (string-empty-p out) (princ out))
        (unless (string-empty-p err) (princ (format "\n%s\n" err)))
        (princ (format "\nexit status %s%s\n" status
                       (if (eql status 69) " (no Agda can be run as things stand)" ""))))
      (princ (format "\nThis buffer's project root: %s\n" (abbreviate-file-name root)))
      (princ (format "The running Agda was started for: %s\n"
                     (if agda-for-project--process-root
                         (abbreviate-file-name agda-for-project--process-root)
                       "nothing (no Agda started by this mode runs)")))
      (when (and agda-for-project--last
                 (equal (plist-get agda-for-project--last :root) agda-for-project--process-root))
        (princ (format "  with %s %s (%s), resolved in %.2f s\n"
                       (plist-get agda-for-project--last :program)
                       (string-join (plist-get agda-for-project--last :args) " ")
                       (plist-get agda-for-project--last :how)
                       (plist-get agda-for-project--last :seconds)))))))

;;;###autoload
(defun agda-for-project-choose ()
  "Choose the Agda for the current buffer's project, and remember it.
The resolver's candidates are offered, and the pick serves every worktree
of the project.  Restarts Agda when it runs for this project."
  (interactive)
  (let* ((file (agda-for-project--buffer-file))
         (id (agda-for-project--choose file)))
    (message "agda-for-project: remembered %s for %s" id
             (abbreviate-file-name (agda-for-project-root file)))
    (when (equal (agda-for-project-root file) agda-for-project--process-root)
      (setq agda-for-project--process-root nil)
      (agda2-restart))))

;;;###autoload
(defun agda-for-project-forget ()
  "Forget the Agda chosen for the current buffer's project.
The next load from a buffer of the project asks the resolver again."
  (interactive)
  (let ((file (agda-for-project--buffer-file)))
    (pcase-let ((`(,status ,_out ,err)
                 (agda-for-project--call "--forget" (agda-for-project--file file))))
      (message "%s" (if (string-empty-p err) (format "agda-for-project: exit %s" status) err)))
    (when (equal (agda-for-project-root file) agda-for-project--process-root)
      (setq agda-for-project--process-root nil))))

(provide 'agda-for-project)

;;; agda-for-project.el ends here
