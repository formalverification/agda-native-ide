;;; agda-for-project-test.el --- unit tests of agda-for-project.el  -*- lexical-binding: t; -*-

;; File: emacs/test/agda-for-project-test.el
;;
;; The package's logic against a stub resolver (stub-agda-for-project.sh,
;; beside this file) and stub agda2-mode functions, so that it runs with
;; nothing but Emacs and bash: what each resolver answer starts, when the
;; chooser is offered and what it says, that a failure starts nothing, the
;; fallback, the project root, the restart on a change of root, and the
;; agda2-mode variables bound dynamically by the byte-compiled package.
;; The batch runs against the real agda2-mode, the real resolver and real
;; projects are recorded in docs/measurements/emacs-2026-11-08.json.
;;
;;   emacs --batch -Q -l emacs/test/agda-for-project-test.el -f ert-run-tests-batch-and-exit

(require 'ert)
(require 'cl-lib)
(require 'subr-x)

(defconst aft/dir (file-name-directory (or load-file-name buffer-file-name)))
(defconst aft/stub (expand-file-name "stub-agda-for-project.sh" aft/dir))

;;;; Stub agda2-mode, defined before the package is loaded

(defvar agda2-program-name "agda")
(defvar agda2-program-args nil)
(defvar agda2-version "2.9.0")
(defvar agda2-process nil)
(defvar agda2-in-progress nil)
(defvar aft/starts nil "What each call of the stub `agda2-restart' saw, newest first.")
(defvar aft/loads 0 "How many times the stub `agda2-load' ran.")

(defun agda2-restart ()
  "Stub: record the settings agda2-mode would start Agda with."
  (push (list :program agda2-program-name :args agda2-program-args
              :version agda2-version
              :agda-dir (getenv "AGDA_DIR")
              :directory default-directory)
        aft/starts)
  (setq agda2-process (make-pipe-process :name "stub-agda" :noquery t)))

(defun agda2-load ()
  "Stub: count the load."
  (setq aft/loads (1+ aft/loads)))

(defun agda2-mode ()
  "Stub: start Agda, as agda2-mode does when it opens a file and none runs.
Then ask for highlighting as `agda2-highlight-reload' does: `agda2-go'
marks Agda busy before its command starts Agda if none runs."
  (unless (process-live-p agda2-process) (agda2-restart))
  (setq agda2-in-progress 'not-so-busy)
  (unless (process-live-p agda2-process) (agda2-restart)))

;;;; The package, byte-compiled, so the dynamic bindings are tested as shipped

;; The compile runs in a fresh Emacs, where no agda2-mode variable is
;; special unless the package itself declares it; compiled here, after the
;; stubs above, a missing declaration would go unnoticed.
(let* ((src (expand-file-name "../agda-for-project.el" aft/dir))
       (tmp (make-temp-file "aft-" t))
       (copy (expand-file-name "agda-for-project.el" tmp)))
  (copy-file src copy)
  (unless (eql 0 (call-process (expand-file-name invocation-name invocation-directory)
                               nil nil nil "--batch" "-Q"
                               "--eval" "(setq byte-compile-error-on-warn t)"
                               "-f" "batch-byte-compile" copy))
    (error "agda-for-project.el did not byte-compile cleanly"))
  (load (concat copy "c") nil t))

;;;; Fixtures

(defvar aft/stub-dir nil)

(defun aft/write (name text)
  "Write TEXT to NAME in the stub's directory."
  (with-temp-file (expand-file-name name aft/stub-dir) (insert text)))

(defun aft/calls ()
  "The stub's command lines so far."
  (let ((f (expand-file-name "calls" aft/stub-dir)))
    (and (file-exists-p f)
         (split-string (with-temp-buffer (insert-file-contents f) (buffer-string)) "\n" t))))

(defun aft/decided (&rest fields)
  "An --explain --json answer that decides, with FIELDS overriding."
  (let ((base (list :decided t :error nil :flake "/repo" :decidedBy "discovered"
                    :method "package" :name "env" :program "/store/agda/bin/agda"
                    :args [] :env (make-hash-table) :version "2.8.0" :built "no"
                    :choice nil)))
    (while fields (setq base (plist-put base (pop fields) (pop fields))))
    (aft/json base)))

(defun aft/undecided (error &rest fields)
  "An undecided --explain --json answer with ERROR, FIELDS overriding."
  (let ((base (list :decided :json-false :error error :flake "/repo"
                    :decidedBy "discovered" :method nil :name nil :program nil
                    :args [] :env (make-hash-table) :version nil :built "no" :choice nil)))
    (while fields (setq base (plist-put base (pop fields) (pop fields))))
    (aft/json base)))

(defun aft/json (plist)
  "PLIST as a JSON object."
  (let ((json-encoding-pretty-print nil)
        (json-null :null))
    (json-encode
     (cl-loop for (k v) on plist by #'cddr
              collect (cons (substring (symbol-name k) 1) (if (null v) :null v))))))

(defmacro aft/with-project (spec &rest body)
  "Run BODY in a buffer visiting a file of a scratch project.
SPEC is (FILE-VAR &key lib), where LIB non-nil puts an .agda-lib at the
project's root and the file in its src/ directory."
  (declare (indent 1))
  (let ((file (car spec)) (lib (plist-get (cdr spec) :lib)))
    `(let* ((root (make-temp-file "aft-project-" t))
            (aft/stub-dir (make-temp-file "aft-stub-" t))
            (process-environment (cons (concat "STUB_DIR=" aft/stub-dir) process-environment))
            (agda-for-project-program aft/stub)
            (agda-for-project-fallback nil)
            (agda-for-project--process-root nil)
            (agda-for-project--last nil)
            (agda2-program-name "agda")
            (agda2-program-args nil)
            (agda2-process nil)
            (agda2-in-progress nil)
            (aft/starts nil)
            (aft/loads 0)
            (,file (expand-file-name (if ,lib "src/M.agda" "M.agda") root)))
       (when ,lib
         (make-directory (expand-file-name "src" root))
         (with-temp-file (expand-file-name "p.agda-lib" root) (insert "name: p\n")))
       (with-temp-file ,file (insert "module M where\n"))
       (agda-for-project-mode 1)
       (unwind-protect
           (with-current-buffer (find-file-noselect ,file)
             (unwind-protect (progn ,@body)
               (set-buffer-modified-p nil)
               (kill-buffer)))
         (agda-for-project-mode -1)
         (when (process-live-p agda2-process) (delete-process agda2-process))
         (delete-directory root t)
         (delete-directory aft/stub-dir t)))))

;;;; Tests: starting

(ert-deftest aft/decided-starts-the-resolved-program ()
  "A decided answer starts its program with its args, env and version."
  (aft/with-project (file :lib t)
    (aft/write "explain-nobuild.json"
               (aft/decided :args ["--library-file=/cache/r.libraries"]
                            :env '(("AGDA_DIR" . "/repo/.agda"))
                            :version "2.9.0-da66a8c"))
    (agda2-restart)
    (let ((start (car aft/starts)))
      (should (equal (plist-get start :program) "/store/agda/bin/agda"))
      (should (equal (plist-get start :args) '("--library-file=/cache/r.libraries")))
      (should (equal (plist-get start :version) "2.9.0"))
      (should (equal (plist-get start :agda-dir) "/repo/.agda")))
    (should (equal (length (aft/calls)) 1))
    (should (string-prefix-p "--explain --json --no-build " (car (aft/calls))))
    (should (equal agda-for-project--process-root (agda-for-project-root file)))
    ;; The environment binding does not outlive the start.
    (should-not (equal (getenv "AGDA_DIR") "/repo/.agda"))))

(ert-deftest aft/missing-build-says-so-then-builds ()
  "An answer whose Agda is not built yet is announced, then built."
  (aft/with-project (file)
    (aft/write "explain-nobuild.json" (aft/decided :built "missing" :program nil :version nil))
    (aft/write "explain-build.json" (aft/decided :built "yes"))
    (let ((messages nil))
      (cl-letf (((symbol-function 'message)
                 (lambda (fmt &rest args) (push (apply #'format fmt args) messages))))
        (agda2-restart))
      (should (cl-some (lambda (m) (string-match-p "building the Agda of" m)) messages)))
    (should (equal (mapcar (lambda (c) (car (split-string c))) (aft/calls)) '("--explain" "--explain")))
    (should-not (string-match-p "--no-build" (cadr (aft/calls))))
    (should (equal (plist-get (car aft/starts) :program) "/store/agda/bin/agda"))))

(ert-deftest aft/version-unknown-is-probed ()
  "With no version in the answer, the program's own --version is read."
  (aft/with-project (file)
    (let ((agda (expand-file-name "fake-agda" aft/stub-dir)))
      (aft/write "fake-agda" "#!/bin/sh\necho 'Agda version 2.7.0.1'\n")
      (set-file-modes agda #o755)
      (aft/write "explain-nobuild.json" (aft/decided :program agda :version nil))
      (agda2-restart)
      (should (equal (plist-get (car aft/starts) :version) "2.7.0.1")))))

;;;; Tests: refusing

(ert-deftest aft/failure-starts-nothing ()
  "A failed evaluation or build shows the resolver's line and starts nothing."
  (aft/with-project (file)
    (aft/write "explain-nobuild.json" (aft/decided :built "missing" :program nil))
    (aft/write "explain-build.json"
               (aft/undecided "nix build /repo#env failed (exit 1; offline, or a broken flake?); no Agda was run"
                              :method "package" :name "env"))
    (aft/write "explain-build.status" "69")
    (let ((err (should-error (agda2-restart) :type 'user-error)))
      (should (string-match-p "nix build /repo#env failed" (cadr err))))
    (should (null aft/starts))
    (should (null agda-for-project--process-root))
    (should-not (cl-some (lambda (c) (string-prefix-p "--candidates" c)) (aft/calls)))))

(ert-deftest aft/missing-resolver-is-named ()
  "A resolver that is not installed is named, and nothing starts."
  (aft/with-project (file)
    (let ((agda-for-project-program "/nonexistent/agda-for-project"))
      (should-error (agda2-restart) :type 'user-error)
      (should (null aft/starts)))))

(ert-deftest aft/usage-error-is-reported ()
  "An answer that is not JSON (exit 64) is reported, and nothing starts."
  (aft/with-project (file)
    (aft/write "explain-nobuild.json" "")
    (aft/write "explain-nobuild.err" "agda-for-project: unknown option --bogus\n")
    (aft/write "explain-nobuild.status" "64")
    (let ((err (should-error (agda2-restart) :type 'user-error)))
      (should (string-match-p "unknown option --bogus" (cadr err))))
    (should (null aft/starts))))

;;;; Tests: choosing

(defconst aft/candidates
  (concat "[{\"id\":\"devshell:default\",\"kind\":\"devshell\",\"version\":null,"
          "\"label\":\"the agda of the dev shell default of /repo\",\"chosen\":false},"
          "{\"id\":\"path:/store/a/bin/agda\",\"kind\":\"built\",\"version\":\"2.9.0\","
          "\"label\":\"Agda 2.9.0, built from default of /other\",\"chosen\":false}]"))

(ert-deftest aft/undecided-offers-the-candidates-and-remembers ()
  "An answer a choice settles offers the candidates, chooses, and starts."
  (aft/with-project (file :lib t)
    (aft/write "explain-nobuild.json"
               (aft/undecided "/repo exports no Agda environment; its dev shell may give one, but entering it runs the project's shell hook as you: allow it with --choose devshell:default, or list a directory at or above it in ~/.config/agda-for-project/trusted"))
    (aft/write "explain-nobuild.status" "69")
    (aft/write "explain-chosen.json"
               (aft/decided :decidedBy "choice" :method "devshell" :name "default"
                            :program "/repo/.agda/bin/agda" :choice "devshell:default"))
    (aft/write "candidates.json" aft/candidates)
    (let (offered)
      (cl-letf (((symbol-function 'completing-read)
                 (lambda (_prompt collection &rest _)
                   (setq offered (mapcar #'car collection))
                   (car offered))))
        (agda2-restart))
      ;; A dev shell is offered with the warning, though its label lacks it.
      (should (string-match-p "entering it runs the project's shell hook" (car offered)))
      (should (equal (length offered) 2)))
    (should (member (format "--choose devshell:default %s" file) (aft/calls)))
    (should (equal (plist-get (car aft/starts) :program) "/repo/.agda/bin/agda"))))

(ert-deftest aft/no-candidates-starts-nothing ()
  "An answer a choice would settle, with nothing to offer, starts nothing."
  (aft/with-project (file)
    (aft/write "explain-nobuild.json"
               (aft/undecided "/repo exports no Agda environment and no default dev shell; see --candidates, then --choose"))
    (aft/write "explain-nobuild.status" "69")
    (aft/write "candidates.json" "[]")
    (should-error (agda2-restart) :type 'user-error)
    (should (null aft/starts))))

(ert-deftest aft/no-flake-uses-the-fallback ()
  "A file in no project with a flake, and no choice, gets agda2-program-name."
  (aft/with-project (file)
    (aft/write "explain-nobuild.json"
               (aft/undecided "no flake.nix at or above /tmp/x, and no Agda chosen for it; see --candidates, then --choose"
                              :flake nil :decidedBy nil))
    (aft/write "explain-nobuild.status" "69")
    (let ((agda2-program-name (expand-file-name "fake-agda" aft/stub-dir))
          (agda2-program-args '("--some-flag")))
      (aft/write "fake-agda" "#!/bin/sh\necho 'Agda version 2.9.0'\n")
      (set-file-modes agda2-program-name #o755)
      (agda2-restart)
      (should (equal (plist-get (car aft/starts) :program) agda2-program-name))
      (should (equal (plist-get (car aft/starts) :args) '("--some-flag")))
      (should (equal (plist-get agda-for-project--last :how) 'fallback)))
    (should-not (cl-some (lambda (c) (string-prefix-p "--candidates" c)) (aft/calls)))))

(ert-deftest aft/no-flake-asks-when-told-to ()
  "With `agda-for-project-fallback' set to `ask', a file in no project asks."
  (aft/with-project (file)
    (aft/write "explain-nobuild.json"
               (aft/undecided "no flake.nix at or above /tmp/x, and no Agda chosen for it; see --candidates, then --choose"
                              :flake nil :decidedBy nil))
    (aft/write "explain-nobuild.status" "69")
    (aft/write "explain-chosen.json"
               (aft/decided :flake nil :decidedBy "choice" :method "path"
                            :program "/store/a/bin/agda" :choice "path:/store/a/bin/agda"))
    (aft/write "candidates.json" aft/candidates)
    (let ((agda-for-project-fallback 'ask))
      (cl-letf (((symbol-function 'completing-read)
                 (lambda (_prompt collection &rest _) (car (nth 1 collection)))))
        (agda2-restart)))
    (should (member (format "--choose path:/store/a/bin/agda %s" file) (aft/calls)))
    (should (equal (plist-get (car aft/starts) :program) "/store/a/bin/agda"))))

(ert-deftest aft/opening-a-file-never-asks-nor-fails ()
  "The start agda2-mode makes on opening a file defers a choice and errors.
The open says what is missing; the next load asks."
  (aft/with-project (file)
    (aft/write "explain-nobuild.json"
               (aft/undecided "/repo exports no Agda environment and no default dev shell; see --candidates, then --choose"))
    (aft/write "explain-nobuild.status" "69")
    (aft/write "explain-chosen.json" (aft/decided :decidedBy "choice" :choice "path:/store/a/bin/agda"))
    (aft/write "candidates.json" aft/candidates)
    (let ((asked 0) messages)
      (cl-letf (((symbol-function 'completing-read)
                 (lambda (_prompt collection &rest _)
                   (setq asked (1+ asked))
                   (car (nth 1 collection))))
                ((symbol-function 'message)
                 (lambda (fmt &rest args) (push (apply #'format fmt args) messages))))
        (agda2-mode)                    ; no error, no question, no start
        (should (equal asked 0))
        (should (null aft/starts))
        (should (null agda2-in-progress)) ; nothing left marked busy
        (should (cl-some (lambda (m) (string-match-p "C-c C-l offers the choices" m)) messages))
        (agda2-load)                    ; the load asks, and starts
        (should (equal asked 1))
        (should (equal (length aft/starts) 1))
        (should (equal aft/loads 1))))))

;;;; Tests: restarting on a change of root

(ert-deftest aft/load-restarts-only-on-another-root ()
  "A load restarts Agda when the root differs or no process runs, not else."
  (aft/with-project (file :lib t)
    (aft/write "explain-nobuild.json" (aft/decided))
    (agda2-load)
    (should (equal (length aft/starts) 1))      ; no process ran: started
    (agda2-load)
    (should (equal (length aft/starts) 1))      ; same root, live: no restart
    (setq agda-for-project--process-root "/somewhere/else/")
    (agda2-load)
    (should (equal (length aft/starts) 2))      ; another root: restarted
    (delete-process agda2-process)
    (agda2-load)
    (should (equal (length aft/starts) 3))      ; the process died: restarted
    (should (equal aft/loads 4))))

(ert-deftest aft/failed-restart-skips-the-load ()
  "When the restart a load needs fails, the load is not sent at all."
  (aft/with-project (file)
    (aft/write "explain-nobuild.json"
               (aft/undecided "nix eval failed; no Agda was run: Nix could not evaluate /repo"))
    (aft/write "explain-nobuild.status" "69")
    (should-error (agda2-load) :type 'user-error)
    (should (equal aft/loads 0))
    ;; A failed evaluation is no question a choice answers: no chooser.
    (should-not (cl-some (lambda (c) (string-prefix-p "--candidates" c)) (aft/calls)))))

;;;; Tests: the root, the version, the mode

(ert-deftest aft/root-is-the-nearest-agda-lib-else-the-directory ()
  "The root is the nearest .agda-lib's directory, else the file's own."
  (let* ((top (file-truename (make-temp-file "aft-root-" t)))
         (lib (expand-file-name "lib/" top))
         (deep (expand-file-name "src/A/B.agda" lib))
         (loose (expand-file-name "loose/C.agda" top))
         (link (expand-file-name "link" top)))
    (unwind-protect
        (progn
          (make-directory (file-name-directory deep) t)
          (make-directory (file-name-directory loose) t)
          (with-temp-file (expand-file-name "x.agda-lib" lib) (insert "name: x\n"))
          (with-temp-file deep (insert ""))
          (with-temp-file loose (insert ""))
          (make-symbolic-link lib link)
          (should (equal (agda-for-project-root deep) lib))
          (should (equal (agda-for-project-root loose) (file-name-directory loose)))
          (should (equal (agda-for-project-root (expand-file-name "src/A/B.agda" link)) lib)))
      (delete-directory top t))))

(ert-deftest aft/version-forms ()
  "Versions as --numeric-version prints them become agda2-mode's form."
  (should (equal (agda-for-project--version "2.8.0") "2.8.0"))
  (should (equal (agda-for-project--version "2.9.0-da66a8c") "2.9.0"))
  (should (equal (agda-for-project--version "2.6.4.3") "2.6.4.3"))
  (should (null (agda-for-project--version nil)))
  (should (null (agda-for-project--version "unknown"))))

(ert-deftest aft/mode-adds-and-removes-the-advice ()
  "Enabling the mode advises both functions; disabling removes the advice."
  (agda-for-project-mode 1)
  (should (advice-member-p #'agda-for-project--mode 'agda2-mode))
  (should (advice-member-p #'agda-for-project--restart 'agda2-restart))
  (should (advice-member-p #'agda-for-project--load 'agda2-load))
  (agda-for-project-mode -1)
  (should-not (advice-member-p #'agda-for-project--mode 'agda2-mode))
  (should-not (advice-member-p #'agda-for-project--restart 'agda2-restart))
  (should-not (advice-member-p #'agda-for-project--load 'agda2-load)))

(ert-deftest aft/forget-and-choose-commands ()
  "The forget command calls --forget; choose remembers and restarts."
  (aft/with-project (file)
    (aft/write "explain-nobuild.json" (aft/decided))
    (aft/write "candidates.json" aft/candidates)
    (agda2-restart)
    (agda-for-project-forget)
    (should (member (format "--forget %s" file) (aft/calls)))
    (should (null agda-for-project--process-root))
    (agda2-restart)
    (cl-letf (((symbol-function 'completing-read)
               (lambda (_prompt collection &rest _) (car (nth 1 collection)))))
      (agda-for-project-choose))
    (should (member (format "--choose path:/store/a/bin/agda %s" file) (aft/calls)))
    (should (equal (length aft/starts) 3))))

;;; agda-for-project-test.el ends here
