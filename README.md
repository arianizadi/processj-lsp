# processj-lsp

A language server for [ProcessJ](https://github.com/mattunlv/ProcessJ), the CSP-style
concurrent language from UNLV. It has its own full parser and formatter, drives the
real compiler for type errors, and adds static analysis for the concurrency rules the
compiler does not check.

## What you get

**A real parser with real error messages.** `src/parser` is a recursive-descent
parser written from the compiler's CUP grammar. It recovers from errors, so every
problem in a file is reported at once, and each message says what was expected,
what was found, and what was probably meant:

```
Unknown statement 'pa'; did you mean 'par'?
Missing ';' after the variable declaration
Missing '}' to close the block opened at line 12
'else' without a matching 'if'
Unknown type 'itn'; did you mean 'int'?
An alt guard must store the value: write 'v = c.read()'
'c.read' names a channel end; to read use '.read()' and to write use '.write(value)'
'proc' is not accepted by the current compiler; write the return type and name directly
```

The compiler's own "Syntax error" line is suppressed when the parser has a better
message for the same problem.

**A formatter.** `textDocument/formatting` prints the parse tree back in a
canonical layout: 4-space indent, braces on the header line, spaces around
operators, `chan<int>` without inner spaces, one field per line in records,
protocol cases on one line, short alt bodies inline. Comments are kept, blank lines
are preserved up to one, and user parentheses are never added or removed. A file
with syntax errors is left alone (you get a message saying which error to fix
first). The formatter is idempotent and never changes the parse tree; both are
checked over the compiler's example corpus in `test/format.test.ts`.

**Diagnostics from the real compiler.** Every edit is run through `ProcessJc` in
an isolated temp directory. Name errors get token columns, type errors get the
line and are narrowed to the quoted identifier, and a compiler crash becomes a
diagnostic carrying the exception.

**Static analysis, instantly on every keystroke.** Each lint recreates a check the
compiler is missing, has disabled, or gets wrong, and says why:

| code                       | what it catches                                                                 |
| -------------------------- | ------------------------------------------------------------------------------- |
| `pj/parallel-usage`        | a variable written in one `par` branch and read or written in another (the compiler's ParallelUsageCheck pass is switched off) |
| `pj/shared-channel-end`    | a non-`shared` channel end used in two branches of a `par`; quick fix adds `shared` |
| `pj/channel-direction`     | `in.write(..)` on a `chan<T>.read` end, or chains like `c.read.write(..)`          |
| `pj/channel-write-type`    | `c.write("hi")` on a `chan<int>` (the compiler never type-checks writes)           |
| `pj/channel-no-writer`     | a channel read in a proc that never writes it or passes it on: blocks forever      |
| `pj/short-circuit-read`    | `c.read()` on the right of `&&`, `\|\|`, `?:`: the compiler evaluates it unconditionally |
| `pj/alt-timeout`           | a `timeout` guard in an `alt` is compiled as a blocking sleep before the alt        |
| `pj/multiple-alts`         | a second `alt` in one proc makes javac fail on redeclared variables                 |
| `pj/reserved-alt-name`     | a local named `index` or `btemp` next to an `alt` aliases generated code            |
| `pj/timeout-noop`          | timeouts return immediately in this compiler build (`PJTimer.start()`)             |
| `pj/shadows-parameter`     | a local with the same name as a parameter (silently accepted)                      |
| `pj/unused`                | unused locals and parameters                                                        |
| `pj/string-escape`         | `"\n"` in a string crashes the lexer                                                |
| `pj/non-ascii`             | any non-ASCII byte, even in a comment, crashes the 7-bit lexer                      |
| `pj/empty-comment`         | `/**/` is not a comment to the lexer                                                |
| `pj/missing-import`        | `println` without `import std.*;`; quick fix adds the import                       |

**Run and inspect from the editor.** Code lenses above `main` offer **▶ Run**,
**Build**, and **Generated Java**. Run performs the whole `pjc` pipeline
(ProcessJc, `javac --release 8`, the two ASM rewrites, `java`) in a temp
directory, judged by exit codes rather than by grepping output, then opens a
report with the program's output. A program that never finishes is killed after
30 s and flagged as a probable deadlock. Generated Java opens the Java the
compiler produced for the file, the best way to see how a `par` or an `alt`
becomes a resumable state machine.

**Navigation.** Completion (locals in scope, procs, records, protocols, the whole
`std` library with signatures, keywords with explanations, snippets for `par`,
`alt`, `chan`, ...), hover, go to definition into the workspace and the
standard-library headers, find references, rename, document outline, folding,
signature help with `println` overloads.

## Performance

Everything except the compiler run is synchronous on the keystroke path, so it
has to be fast. `npm run bench` on a laptop:

```
   1341 lines      7523 tokens  parse   3.4 ms  symbols   0.8 ms  lint   15.0 ms  format    3.1 ms
  10024 lines     55109 tokens  parse  10.5 ms  symbols   3.0 ms  lint   53.0 ms  format    7.2 ms
  50054 lines    273940 tokens  parse  62.2 ms  symbols  47.3 ms  lint  134.9 ms  format  101.6 ms
```

(Exact numbers vary by machine; `test/perf.test.ts` enforces budgets on a
generated 20,000-line file and checks that parse time grows linearly.) The
server also caches the parse per document version, coalesces lint runs so a
burst of keystrokes costs one pass, debounces the compiler, and cancels a
compile the moment a newer edit arrives.

## Requirements

- Node.js 20 or newer.
- A ProcessJ install with a built `bin/` directory and `resources/jars`. The
  server finds it from `initializationOptions.installDir`, the `PROCESSJ_HOME`
  environment variable, or `installdir=` in `~/processjrc` (the file `pjc` reads).
  Without one, parsing, lints, formatting and navigation still work; compiler
  diagnostics and Run are disabled.
- A JDK on `PATH` (or `JAVA_HOME`). The compiler was built with JDK 11.

## Install

```sh
git clone https://github.com/arianizadi/processj-lsp ~/Documents/processj-lsp
cd ~/Documents/processj-lsp
npm install
npm run build
npm test          # parser corpus, formatter idempotence, lints, output parser, performance budgets
npm run smoke     # end-to-end against a real ProcessJ install, including a full run
npm run bench     # timings for generated 1k / 10k / 50k-line files
```

`bin/processj-lsp.js --stdio` is the executable editors launch.

## Neovim

**AstroNvim v5:** copy `editor/nvim/lua/plugins/processj.lua` into
`~/.config/nvim/lua/plugins/` and restart. It registers the `processj` filetype
for `*.pj`, loads the bundled syntax highlighting, and enables the server.
Format with `<Leader>lf` (or `:lua vim.lsp.buf.format()`); AstroNvim's
format-on-save applies to this server too. Code lenses refresh with
`<Leader>lL` and run with `<Leader>ll`.

**Plain Neovim 0.11+:** see `editor/nvim/plain.lua`; it uses `vim.lsp.config`
and `vim.lsp.enable`.

Both files assume the repo lives at `~/Documents/processj-lsp`; edit `lsp_repo`
otherwise. `:checkhealth vim.lsp` shows whether `processj_ls` attached;
`:LspLog` has the server log, including the install directory it found and how
long each compile took.

## Options

Pass these as `init_options` / `initializationOptions`:

| option          | default | meaning                                                   |
| --------------- | ------- | --------------------------------------------------------- |
| `installDir`    | from rc | ProcessJ install directory                                |
| `javaBin`       | `java`  | Java executable                                           |
| `debounceMs`    | `400`   | wait this long after the last keystroke before compiling  |
| `timeoutMs`     | `20000` | kill the compiler after this long                         |
| `runTimeoutMs`  | `30000` | kill a program started from Run after this long           |
| `checkOnChange` | `true`  | `false` to compile only on open and save                  |
| `lint`          | `true`  | `false` to turn the static analysis off                   |

## How diagnostics work

The compiler has no library API and no "check only" mode, so the server writes
the buffer to a temp directory, points the JVM's `user.home` at a private
`processjrc`, and runs the same command the `pjc` script does. Generated Java
lands in the temp directory and is deleted afterwards; your real `~/workingpj`
is never touched. The three output formats the compiler uses (CUP parser,
`PJBugManager`, legacy `utilities.Error`) are parsed in `src/diagnostics.ts`,
with unit tests pinning real captured output.

Limits inherited from the compiler:

- The compiler stops at its first syntax error; the server's own parser reports
  all of them, so you rarely see the compiler's.
- Some type errors are printed but do not stop the compiler, and some checks are
  silent. The server shows everything the compiler prints, and the lints cover
  the most damaging gaps.
- Imports of your own libraries resolve against the compiler's include directory,
  not the buffer's directory.

The lints are token-based and tolerate half-typed code; they can miss things
(aliasing through procedure calls is not tracked) and are tuned to avoid false
positives rather than to be complete.

## Layout

```
src/server.ts       LSP wiring: documents, caches, debounced compiles, every request handler
src/parser/ast.ts   AST node types with source spans
src/parser/parser.ts recursive-descent parser with recovery and "did you mean" suggestions
src/format.ts       AST printer used for textDocument/formatting
src/astsymbols.ts   symbols and scoped locals from the parse tree
src/analysis.ts     the lints, each documented with the compiler line it works around
src/tokens.ts       tokenizer that also reports the lexer limits and keeps comments
src/compiler.ts     runs ProcessJc in an isolated temp home, cancellable
src/pipeline.ts     full build + run pipeline (ProcessJc, javac, ASM passes, java)
src/diagnostics.ts  parses compiler output into structured diagnostics
src/symbols.ts      regex-based extractor, used to top up symbols while a file has syntax errors
src/library.ts      indexes include/JVM/**/*.pj for std completion and definitions
src/workspace.ts    mtime-cached index of *.pj files under the workspace
src/keywords.ts     keyword list and hover docs
test/               node:test unit tests; test/fixtures/processj is the compiler's example corpus
scripts/smoke.js    talks LSP over stdio to a real server, ends with a real program run
scripts/bench.js    parse / lint / format timings on generated large files
editor/nvim/        AstroNvim plugin spec, plain config, syntax and ftplugin files
```

## License

Apache License 2.0 (see `LICENSE`). The example programs under
`test/fixtures/processj` come from the ProcessJ compiler repository, also Apache
2.0, University of Nevada, Las Vegas (see `NOTICE`).
