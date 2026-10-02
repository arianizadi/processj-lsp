;;; processj-mode.el --- ProcessJ editing with the processj-lsp language server  -*- lexical-binding: t; -*-

;; Loaded by `npm run setup -- emacs` from the processj-lsp checkout.
;; Provides `processj-mode' for .pj files (comments, strings, keywords, a
;; brace-based indenter) and starts the language server through eglot
;; (built into Emacs 29+) or lsp-mode, whichever is available.
;;
;; Manual use: (load "/path/to/processj-lsp/editor/emacs/processj-mode.el")

;;; Code:

(defgroup processj nil "ProcessJ language support." :group 'languages)

(defconst processj--checkout
  (expand-file-name "../.." (file-name-directory (or load-file-name buffer-file-name)))
  "The processj-lsp checkout this file lives in.")

(defcustom processj-lsp-server-command nil
  "Command (a list of strings) that starts the language server.
When nil, the server from this checkout is run with node."
  :type '(repeat string) :group 'processj)

(defcustom processj-lsp-client 'auto
  "Which LSP client to start for ProcessJ buffers.
`auto' prefers eglot and falls back to lsp-mode; nil starts none."
  :type '(choice (const auto) (const eglot) (const lsp-mode) (const nil)) :group 'processj)

(defcustom processj-indent-offset 4 "Spaces per indentation level." :type 'integer :group 'processj)

(defun processj-lsp-command ()
  "The command list used to start processj-lsp."
  (or processj-lsp-server-command
      (list "node" (expand-file-name "bin/processj-lsp.js" processj--checkout) "--stdio")))

(defconst processj--keywords
  '("alt" "break" "case" "chan" "claim" "const" "continue" "default" "do" "else" "enroll"
    "extends" "extern" "for" "fork" "if" "implements" "import" "is" "mobile" "native" "new"
    "package" "par" "pri" "private" "proc" "protected" "protocol" "public" "read" "record"
    "resume" "return" "seq" "shared" "skip" "stop" "suspend" "switch" "sync" "timeout"
    "while" "with" "write"))

(defconst processj--types
  '("boolean" "byte" "char" "short" "int" "long" "float" "double" "string" "void" "timer" "barrier"))

(defconst processj--literals '("true" "false" "null"))

(defvar processj-font-lock-keywords
  `((,(regexp-opt processj--keywords 'symbols) . font-lock-keyword-face)
    (,(regexp-opt processj--types 'symbols) . font-lock-type-face)
    (,(regexp-opt processj--literals 'symbols) . font-lock-constant-face)
    ("\\_<\\(record\\|protocol\\)\\s-+\\([A-Za-z_$][A-Za-z0-9_$]*\\)" 2 font-lock-type-face)
    ("\\_<\\([A-Za-z_$][A-Za-z0-9_$]*\\)\\s-*(" 1 font-lock-function-name-face)))

(defvar processj-mode-syntax-table
  (let ((table (make-syntax-table)))
    (modify-syntax-entry ?/ ". 124b" table)
    (modify-syntax-entry ?* ". 23" table)
    (modify-syntax-entry ?\n "> b" table)
    (modify-syntax-entry ?\r "> b" table)
    (modify-syntax-entry ?\" "\"" table)
    (modify-syntax-entry ?' "\"" table)
    (modify-syntax-entry ?_ "_" table)
    (modify-syntax-entry ?$ "_" table)
    (modify-syntax-entry ?< "." table)
    (modify-syntax-entry ?> "." table)
    table)
  "Syntax table for `processj-mode'.")

(defun processj--brace-depth (pos)
  "Brace nesting depth at POS, ignoring braces inside comments and strings."
  (nth 0 (syntax-ppss pos)))

(defun processj-indent-line ()
  "Indent the current line by its brace depth; a closing brace steps back out."
  (interactive)
  (let* ((depth (save-excursion (back-to-indentation) (processj--brace-depth (point))))
         (closing (save-excursion (back-to-indentation) (looking-at "[}]")))
         (in-string-or-comment (save-excursion (back-to-indentation) (nth 8 (syntax-ppss (point)))))
         (target (* processj-indent-offset (max 0 (if closing (1- depth) depth)))))
    (unless in-string-or-comment
      (if (<= (current-column) (current-indentation))
          (indent-line-to target)
        (save-excursion (indent-line-to target))))))

;;;###autoload
(define-derived-mode processj-mode prog-mode "ProcessJ"
  "Major mode for the ProcessJ concurrent language."
  :syntax-table processj-mode-syntax-table
  (setq-local font-lock-defaults '(processj-font-lock-keywords))
  (setq-local comment-start "// ")
  (setq-local comment-end "")
  (setq-local comment-start-skip "\\(?://+\\|/\\*+\\)\\s-*")
  (setq-local indent-line-function #'processj-indent-line)
  (setq-local indent-tabs-mode nil)
  (setq-local tab-width processj-indent-offset)
  (setq-local electric-indent-chars (append "{}" electric-indent-chars)))

;;;###autoload
(add-to-list 'auto-mode-alist '("\\.pj\\'" . processj-mode))

;; eglot (Emacs 29+, or from GNU ELPA on older Emacs)
(with-eval-after-load 'eglot
  (add-to-list 'eglot-server-programs `(processj-mode . ,(processj-lsp-command))))

;; lsp-mode, when installed
(with-eval-after-load 'lsp-mode
  (add-to-list 'lsp-language-id-configuration '(processj-mode . "processj"))
  (lsp-register-client
   (make-lsp-client :new-connection (lsp-stdio-connection #'processj-lsp-command)
                    :activation-fn (lsp-activate-on "processj")
                    :server-id 'processj-lsp)))

(defun processj--start-lsp ()
  "Start the preferred LSP client for this buffer."
  (cond
   ((and (memq processj-lsp-client '(auto eglot)) (require 'eglot nil t))
    (eglot-ensure))
   ((and (memq processj-lsp-client '(auto lsp-mode)) (require 'lsp-mode nil t))
    (lsp-deferred))
   ((eq processj-lsp-client 'auto)
    (message "processj-mode: no LSP client found; install eglot (Emacs 29+ has it built in) or lsp-mode"))))

(add-hook 'processj-mode-hook #'processj--start-lsp)

(provide 'processj-mode)
;;; processj-mode.el ends here
