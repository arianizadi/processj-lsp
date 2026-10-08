;;; processj-mode.el --- ProcessJ editing with the processj-lsp language server  -*- lexical-binding: t; -*-

;; Loaded by `npm run setup -- emacs` from the processj-lsp checkout.
;; Provides `processj-mode' for .pj files (comments, strings, keywords, a
;; brace-based indenter) and starts the language server through eglot
;; (built into Emacs 29+) or lsp-mode, whichever is available.
;; `processj-show-graph' (C-c C-g) opens the concurrency graph viewer and
;; `processj-export-graph' (C-c C-e) writes it next to the file.
;; `processj-check-with-fdr' (C-c C-f) checks the file with FDR and, when a check
;; fails, opens the graph on what FDR found.
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
                    ;; processj/verificationChanged goes only to clients that ask for it (VS Code's
                    ;; graph panel), processj/fdrReportChanged to every client: the graph page in the
                    ;; browser follows both by itself. Ignore them rather than warn.
                    :notification-handlers (let ((handlers (make-hash-table :test #'equal)))
                                             (puthash "processj/verificationChanged" #'ignore handlers)
                                             (puthash "processj/fdrReportChanged" #'ignore handlers)
                                             handlers)
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

;; Server commands: the concurrency graph, Convert to CSP and Check with FDR

(declare-function eglot-current-server "eglot")
(declare-function eglot-path-to-uri "eglot")
(declare-function eglot--TextDocumentIdentifier "eglot")
(declare-function jsonrpc-async-request "jsonrpc")
(declare-function jsonrpc-request "jsonrpc")
(declare-function lsp-workspaces "lsp-mode")
(declare-function lsp-request "lsp-mode")
(declare-function lsp-request-async "lsp-mode")
(declare-function lsp--buffer-uri "lsp-mode")
(declare-function lsp--text-document-identifier "lsp-mode")

(defconst processj--graph-modes '("viewer" "markdown" "svg" "excalidraw")
  "Ways `processj-show-graph' can show the graph.")

(defconst processj--export-formats '("all" "svg" "excalidraw" "html" "json")
  "Formats `processj-export-graph' can write; \"all\" is svg, excalidraw and html.")

(defun processj--eglot-server ()
  "The eglot server managing this buffer, or nil."
  (and (featurep 'eglot) (fboundp 'eglot-current-server) (eglot-current-server)))

(defun processj--lsp-mode-p ()
  "Non-nil when lsp-mode manages this buffer."
  (and (featurep 'lsp-mode) (fboundp 'lsp-workspaces) (lsp-workspaces)))

(defun processj--document-uri ()
  "The URI the language server knows this buffer by."
  (cond
   ((and (processj--eglot-server) (fboundp 'eglot--TextDocumentIdentifier))
    (plist-get (eglot--TextDocumentIdentifier) :uri))
   ((and (processj--lsp-mode-p) (fboundp 'lsp--buffer-uri)) (lsp--buffer-uri))
   ((fboundp 'eglot-path-to-uri) (eglot-path-to-uri (buffer-file-name)))
   (t (concat "file://" (expand-file-name (buffer-file-name))))))

(defun processj--execute (command &rest arguments)
  "Ask the language server to run COMMAND on this buffer's document.
ARGUMENTS follow the document's URI; nil ones are dropped. The request does
not block Emacs, because an FDR check can take a while. The server reports
how it went itself, so a reply only notes a file it wrote in *Messages*."
  (unless (buffer-file-name) (user-error "processj: save the buffer first"))
  (let* ((args (vconcat (list (processj--document-uri)) (delq nil arguments)))
         (params (list :command command :arguments args))
         (done (lambda (result)
                 (let ((file (and (listp result) (or (plist-get result :reportFile) (plist-get result :cspFile)))))
                   (when file
                     (let ((inhibit-message t))
                       (message "processj: %s wrote %s" command file))))))
         (failed (lambda (error) (message "processj: %s failed: %s" command (or (plist-get error :message) error))))
         (server (processj--eglot-server)))
    (cond
     (server
      (jsonrpc-async-request server :workspace/executeCommand params
                             :success-fn done :error-fn failed :timeout nil))
     ((processj--lsp-mode-p)
      (lsp-request-async "workspace/executeCommand" params done :error-handler failed))
     (t (user-error "processj: no language server manages this buffer (start eglot or lsp-mode)")))))

(defun processj-show-graph (&optional mode)
  "Show the current file's concurrency graph.
MODE is \"viewer\" (the default: an interactive page in your browser that
follows your edits), \"markdown\", \"svg\" or \"excalidraw\". With a prefix
argument, ask for the mode."
  (interactive (list (if current-prefix-arg
                         (completing-read "Show the graph as: " processj--graph-modes nil t nil nil "viewer")
                       "viewer")))
  (processj--execute "processj.showConcurrencyReport" (or mode "viewer")))

(defun processj-export-graph (format &optional directory)
  "Write the current file's concurrency graph next to it.
FORMAT is \"all\" (svg, excalidraw and html), \"svg\", \"excalidraw\",
\"html\" or \"json\". With a prefix argument, also ask for the DIRECTORY to
write into. Files that were not written by processj-lsp are never overwritten."
  (interactive (list (completing-read "Export format: " processj--export-formats nil t nil nil "all")
                     (when current-prefix-arg (expand-file-name (read-directory-name "Export into: ")))))
  (processj--execute "processj.exportConcurrencyGraph" format directory))

(define-key processj-mode-map (kbd "C-c C-g") #'processj-show-graph)
(define-key processj-mode-map (kbd "C-c C-e") #'processj-export-graph)

(defconst processj--procedure-regexp
  (concat "^[ \t]*\\(?:\\(?:public\\|private\\|protected\\|native\\|mobile\\)[ \t]+\\)*"
          "\\([A-Za-z_][A-Za-z0-9_]*\\)\\(?:<[^>\n]*>\\)?\\(?:\\[\\]\\)*[ \t]+"
          "\\([A-Za-z_][A-Za-z0-9_]*\\)[ \t]*(")
  "A procedure header: return type (group 1) and name (group 2).")

(defun processj--server-procedure-names ()
  "Procedure names from the language server's document symbols, or nil."
  (ignore-errors
    (let ((symbols
           (cond
            ((and (fboundp 'eglot-current-server) (eglot-current-server))
             (jsonrpc-request (eglot-current-server) :textDocument/documentSymbol
                              (list :textDocument (eglot--TextDocumentIdentifier))))
            ((and (fboundp 'lsp-workspaces) (lsp-workspaces))
             (lsp-request "textDocument/documentSymbol"
                          (list :textDocument (lsp--text-document-identifier)))))))
      (delete-dups
       (delq nil (mapcar (lambda (symbol)
                           ;; SymbolKind 12 is Function: the procedures.
                           (when (eql (if (hash-table-p symbol) (gethash "kind" symbol) (plist-get symbol :kind)) 12)
                             (if (hash-table-p symbol) (gethash "name" symbol) (plist-get symbol :name))))
                         (append symbols nil)))))))

(defun processj--procedure-names ()
  "Names of the procedures declared in this buffer, for completion.
Asks the language server; without one, scans the buffer."
  (or (processj--server-procedure-names)
      (let (names)
        (save-excursion
          (save-restriction
            (widen)
            (goto-char (point-min))
            (while (re-search-forward processj--procedure-regexp nil t)
              (let ((type (match-string-no-properties 1))
                    (name (match-string-no-properties 2)))
                ;; `syntax-ppss' leaves point where it parsed to: keep it after the match.
                ;; `par for (' and `pri alt (' look like a procedure header with type par or pri.
                (unless (or (save-excursion (nth 8 (syntax-ppss (match-beginning 0))))
                            (member type '("return" "new" "else" "case" "do" "if" "while" "for" "switch" "par" "pri")))
                  (push name names))))))
        (delete-dups (nreverse names)))))

(defun processj--read-procedure (prompt)
  "Read a procedure name with PROMPT; empty input means the whole program."
  (let ((name (completing-read prompt (processj--procedure-names) nil nil)))
    (unless (string-empty-p name) name)))

;;;###autoload
(defun processj-convert-to-csp (&optional procedure)
  "Convert this file's program, or PROCEDURE on its own, to CSPm for FDR.
The model is written next to the file (NAME.csp or NAME.PROCEDURE.csp)."
  (interactive (list (processj--read-procedure "Convert to CSP (empty: the whole program): ")))
  (processj--execute "processj.convertToCsp" procedure))

;;;###autoload
(defun processj-check-with-fdr (&optional procedure)
  "Check this file's program, or PROCEDURE on its own, with FDR.
Stuck statements get diagnostics.  When a check fails, the graph opens
on the result in a browser; otherwise the step-by-step report opens
(the server's fdrShowGraph setting says which)."
  (interactive (list (processj--read-procedure "Check with FDR (empty: the whole program): ")))
  (processj--execute "processj.checkWithFdr" procedure))

;;;###autoload
(defun processj-cancel-fdr ()
  "Stop the FDR check running for this file."
  (interactive)
  (processj--execute "processj.cancelFdr"))

(define-key processj-mode-map (kbd "C-c C-f") #'processj-check-with-fdr)

(provide 'processj-mode)
;;; processj-mode.el ends here
