# processj-lsp in detail

The long version of the [README](../README.md): what every feature does, how it works, and the numbers.

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

Each of these carries a quick fix (code action): change `pa` to `par`, insert the
missing `;`, remove `proc`, add `v = ` before a bare read guard. The compiler's own
"Syntax error" line is suppressed when the parser has a better message for the
same problem.

**A formatter.** `textDocument/formatting` prints the parse tree back in a
canonical layout: 4-space indent, braces on the header line, spaces around
operators, `chan<int>` without inner spaces, one field per line in records,
protocol cases on one line, short alt bodies inline. Comments are kept, blank lines
are preserved up to one, and user parentheses are never added or removed. A file
with syntax errors is left alone (you get a message saying which error to fix
first). The formatter is idempotent and never changes the parse tree; both are
checked over the compiler's example corpus in `test/format.test.ts`.

**A type checker.** `src/checker` resolves every name to its declaration and
types every expression, using the declarations of the file, its imports, and the
standard-library headers (all parsed with the same parser). It reports what the
compiler's own checker misses or gets wrong, with messages that name the
problem and, where possible, carry a quick fix:

```
Cannot find 'cuont'; did you mean 'count'?
Cannot initialise 'j' (int) with a value of type long (long does not fit in int without a cast)
No version of 'show' accepts (string, string): argument 2 ('n') needs int. Available: void show(string s, int n)
No version of 'reader' accepts (chan<int>) (pass an end of the channel: '.read')
No version of 'sharedReader' accepts (chan<int>.read) (declare the channel 'shared chan<int>')
'in' is a read end (chan<int>.read); it cannot write
Writing string to 'c', which carries int
'reason' belongs to case quit of Msg, but here 'm' is known to be case 'move' (fields: dx, dy)
'mvoe' is not a case of protocol Msg (cases: move, quit); did you mean 'move'?
'main' must return a value of type int
```

Rules follow what the generated Java actually does: Java widening (`byte` to
`int` to `long` to `double`, with int literals allowed into `byte`/`short`/`char`),
records narrow when they `extends`, protocols widen when they `extends`
(`protocol Message extends Santa_msg` is the union), channel elements are
invariant for primitives and follow the end's direction for records and
protocols, `shared read chan<T>` shares only its read side, overloads pick the
most specific applicable procedure, and a protocol variable is narrowed to its
case inside `switch` and `if (m is tag)`. Hover shows the type of any expression.

Run over the compiler's own example programs, the checker finds two genuine bugs
in them (`fullAdder.pj` writes to an end declared as read-only and hands one read
end to two processes; `integrate.pj` calls a misspelled `prlongln`); the test
suite pins exactly those.

**Diagnostics from the real compiler.** On open and save (or on every edit with
`checkOnChange`), the file is run through `ProcessJc` in an isolated temp
directory. Name errors get token columns, type errors get the line and are
narrowed to the quoted identifier, and a compiler crash becomes a diagnostic
carrying the exception. Compiler messages are hidden on lines where the checker
already reported something more specific.

**Concurrency lints, computed from real scopes and types in the same walk.** Each
recreates a check the compiler is missing, has disabled, or gets wrong, and says
why:

| code                       | what it catches                                                                 |
| -------------------------- | ------------------------------------------------------------------------------- |
| `pj/parallel-usage`        | a variable written in one `par` branch and read or written in another (the compiler's ParallelUsageCheck pass is switched off) |
| `pj/shared-channel-end`    | a non-`shared` channel end used in two branches of a `par`; quick fix adds `shared` |
| `pj/channel-direction`     | `in.write(..)` on a `chan<T>.read` end, or chains like `c.read.write(..)`          |
| `pj/channel-write-type`    | `c.write("hi")` on a `chan<int>` (the compiler never type-checks writes)           |
| `pj/channel-no-writer`     | a channel read in a proc that never writes it or passes it on: blocks forever      |
| `pj/channel-self-deadlock` | both ends of a channel used by the same sequential process: the first use blocks forever |
| `pj/par-deadlock`          | straight-line par branches whose channel operations cannot pair up (crossed order, extra write): simulated rendezvous |
| `pj/starving-loop`         | an infinite loop with no communication, sync, timeout, alt or par: the cooperative scheduler never runs anyone else |
| `pj/pri-alt-skip`          | `skip` before other guards in a `pri alt`: those guards can never be chosen |
| `pj/barrier-not-enrolled`  | `sync()` on a local barrier nothing enrolled on: returns immediately              |
| `pj/assign-in-condition`   | `if (b = true)`: assignment where a comparison was meant                            |
| `pj/unreachable`           | code after `return`, `break`, `continue` or `stop` in the same block               |
| `pj/trivial-par`, `pj/trivial-alt` | a `par` with one branch, an `alt` with one guard: nothing concurrent happens   |
| `pj/shadows-parameter`     | a local with the same name as a parameter (silently accepted)                      |
| `pj/unused`                | unused locals and parameters                                                        |
| `pj/missing-import`        | `println` without `import std.*;`; quick fix adds the import                       |

**Run from the editor.** In VS Code, code lenses above `main` offer **▶ Run**
and **Build**; in Neovim the same actions are `:ProcessJRun` and
`:ProcessJBuild` (no inline lens text). Run performs the whole `pjc` pipeline
(ProcessJc, `javac --release 8`, the two ASM rewrites, `java`) in a temp
directory, judged by exit codes rather than by grepping output, then opens a
report with the program's output. A program that never finishes is killed after
30 s and flagged as a probable deadlock.

**Semantic highlighting.** The server sends semantic tokens for every identifier,
classified from the parse tree and the checker's resolutions: procedure names,
records, protocols and their cases, fields, parameters, locals, constants
(`readonly`), standard-library calls (`defaultLibrary`), and package names.
Keywords, literals and comments stay with the bundled syntax file. Neovim applies
the tokens on top of syntax highlighting automatically.

**Cross-file imports.** `import geom.*;` and `import lib.shapes;` resolve to files
next to the importing file, under the workspace roots, or under the install's
include directory (which is how `import std.*;` finds the standard library).
Imported declarations are typed, completed, hovered and navigable; an import that
resolves nowhere gets a warning saying where it looked. Only what a file imports
is visible to its checker; the workspace index is used for navigation.

**Navigation.** Completion (locals in scope, procs, records, protocols, the whole
`std` library with signatures, keywords with explanations, snippets for `par`,
`alt`, `chan`, ...; after `p.` the fields of `p`'s record or protocol, after `c.`
only the operations its channel end allows), hover with expression types, go to
definition into the workspace and the standard-library headers, find references,
rename, document outline, folding, signature help with `println` overloads.

**Examples.** `examples/` holds one short program per diagnostic (and two clean
ones); each announces the codes it produces on its first line and
`test/examples.test.ts` checks that. They double as a tour of what the server
catches.

## Performance

Everything except the compiler run is synchronous on the keystroke path, so it
has to be fast. `npm run bench` on a laptop:

```
   1341 lines      7523 tokens  parse   3.4 ms  symbols   0.9 ms  check   4.1 ms  semantic   1.1 ms  format    4.2 ms
  10024 lines     55109 tokens  parse  12.7 ms  symbols   3.6 ms  check  14.9 ms  semantic   5.5 ms  format   13.4 ms
  50054 lines    273940 tokens  parse  45.9 ms  symbols  55.4 ms  check  76.4 ms  semantic  16.5 ms  format  109.5 ms
```

(Exact numbers vary by machine; `test/perf.test.ts` enforces budgets on a
generated 20,000-line file and checks that parse time grows linearly.) The
server caches the parse and the check per document version, coalesces lint runs
so a burst of keystrokes costs one pass, debounces the compiler, and cancels a
compile the moment a newer edit arrives.

**Disk and change detection.** Everything on the keystroke path runs in memory.
The only things that touch disk are the compiler runs (a few kilobytes of temp
files per run, which is why they default to open and save only) and reading
imported files. Other files are read once and cached by modification time. When
the editor supports it (Neovim does), the server registers a `**/*.pj` watcher
and the editor pushes change notifications; there is no polling. A change to a
file, on disk or in another buffer, re-checks only the open documents that import
it. Without watcher support the directory walk falls back to at most once every
5 seconds, and only when a lookup needs it.

## Setup

### 1. Prerequisites

- **Neovim 0.11 or newer** (uses the built-in `vim.lsp.config`).
- **Node.js 20 or newer** with `npm` on PATH (`brew install node`, `apt install nodejs npm`, or nvm).
- **A JDK** on PATH or in `JAVA_HOME`; the compiler was built with JDK 11.
- **A ProcessJ install** for compiler diagnostics and the Run code lens: a
  checkout with a built `bin/` directory and `resources/jars`. Tell the server
  where it is with `installdir=/path/to/ProcessJ` in `~/processjrc` (the same
  file `pjc` reads), `export PROCESSJ_HOME=/path/to/ProcessJ`, or
  `init_options.installDir`. Without one, everything except compiler
  diagnostics and Run still works.

### 2. Neovim with lazy.nvim (AstroNvim, LazyVim, kickstart, ...)

Add one plugin spec, for example in `~/.config/nvim/lua/plugins/processj.lua`:

```lua
return {
  {
    "arianizadi/processj-lsp",
    build = "npm ci && npm run build",
    ft = "processj",
    opts = {},
  },
}
```

Restart Neovim (or run `:Lazy sync`). lazy.nvim clones the repository, runs the
build, and the plugin registers the `processj` filetype for `*.pj`, bundled
syntax highlighting and indentation, and the language server from its own
checkout. Open any `.pj` file; `:checkhealth vim.lsp` should list `processj_ls`
as attached. If it says the server is not built, run `:Lazy build processj-lsp`.

`opts` is merged into the server configuration. Useful keys:

```lua
opts = {
  init_options = {
    installDir = "~/Documents/ProcessJ", -- instead of ~/processjrc
    checkOnChange = true,                -- also run the real compiler on every edit
  },
}
```

With AstroNvim the usual mappings apply: `K` hover, `gd` definition, `gr`
references, `<Leader>lf` format, `<Leader>la` code action (quick fixes),
`<Leader>lr` rename, `<Leader>ll` run a code lens (▶ Run, Build). `editor/nvim/lua/plugins/processj.lua` is a ready-made copy of the spec.

### 3. Neovim without a plugin manager

```sh
git clone https://github.com/arianizadi/processj-lsp ~/.local/share/processj-lsp
cd ~/.local/share/processj-lsp && npm ci && npm run build
```

Then in `init.lua`:

```lua
vim.opt.runtimepath:append(vim.fn.expand "~/.local/share/processj-lsp")
require("processj-lsp").setup {}
```

### 4. Other editors

The server speaks standard LSP over stdio: launch
`node <checkout>/bin/processj-lsp.js --stdio` for files of language id
`processj` (extension `.pj`). Pass the options below as `initializationOptions`.

### 5. Developing

```sh
git clone https://github.com/arianizadi/processj-lsp
cd processj-lsp
npm install
npm run build
npm test          # parser corpus, formatter, checker, semantic tokens, imports, examples, perf budgets
npm run smoke     # end-to-end against a real ProcessJ install, including a full program run
npm run bench     # timings for generated 1k / 10k / 50k-line files
```

`:LspLog` in Neovim shows the server log, including which install directory it
found and how long each compile took.

## Options

Pass these as `init_options` / `initializationOptions`:

| option          | default | meaning                                                   |
| --------------- | ------- | --------------------------------------------------------- |
| `installDir`    | from rc | ProcessJ install directory                                |
| `javaBin`       | `java`  | Java executable                                           |
| `debounceMs`    | `400`   | wait this long after the last keystroke before compiling  |
| `timeoutMs`     | `20000` | kill the compiler after this long                         |
| `runTimeoutMs`  | `30000` | kill a program started from Run after this long           |
| `checkOnChange` | `false` | `true` to also run the real compiler on every edit         |
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

The lints run on the parse tree with real scopes and types. A whole channel
passed to a procedure counts as both of its ends being handed away, so aliasing
through calls is conservative rather than tracked; the rules are tuned to avoid
false positives rather than to be complete.

## Layout

```
src/server.ts       LSP wiring: documents, caches, debounced compiles, every request handler
src/parser/ast.ts   AST node types with source spans
src/parser/parser.ts recursive-descent parser with recovery and "did you mean" suggestions
src/format.ts       AST printer used for textDocument/formatting
src/checker/        type model, declaration index, and the checker with the concurrency lints
src/semantic.ts     semantic tokens from the parse tree and the checker's resolutions
src/imports.ts      import resolution (file's directory, workspace roots, include directory)
src/astsymbols.ts   symbols and scoped locals from the parse tree
src/analysis.ts     lexer-level diagnostics (escape sequences, non-ASCII, empty comments)
src/tokens.ts       tokenizer that also reports the lexer limits and keeps comments
src/compiler.ts     runs ProcessJc in an isolated temp home, cancellable
src/pipeline.ts     full build + run pipeline (ProcessJc, javac, ASM passes, java)
src/diagnostics.ts  parses compiler output into structured diagnostics
src/symbols.ts      regex-based extractor, used to top up symbols while a file has syntax errors
src/library.ts      indexes include/JVM/**/*.pj for std completion and definitions
src/workspace.ts    cache of parsed *.pj files under the workspace, invalidated by editor file events
src/keywords.ts     keyword list and hover docs
test/               node:test unit tests; test/fixtures holds the compiler's example corpus and std headers
examples/           one program per diagnostic, self-describing and tested
scripts/smoke.js    talks LSP over stdio to a real server, ends with a real program run
scripts/bench.js    parse / lint / format timings on generated large files
lua/, plugin/, ftdetect/, syntax/, ftplugin/   the Neovim plugin (install the repo with lazy.nvim)
editor/nvim/        ready-made lazy.nvim/AstroNvim spec and a plugin-manager-free config
vscode/             VS Code extension: `npm run install-extension` builds the server, bundles it, packages and installs
```

## License

Apache License 2.0 (see `LICENSE`). The example programs under
`test/fixtures/processj` come from the ProcessJ compiler repository, also Apache
2.0, University of Nevada, Las Vegas (see `NOTICE`).

## Validated against the real runtime

`npm run validate` builds every example with the real compiler and runs it with a timeout. A program the checker says will block must hang; a clean program must finish. Result of the last run:

| example | checker says | real program | result |
| --- | --- | --- | --- |
| `channel_direction.pj` | other | hangs (>8s) | n/a |
| `channel_types.pj` | other | build failed at ProcessJc n/a | Exception in thread "main" java.lang.NullPointerException |
| `clean_pipeline.pj` | clean | finishes | CONFIRMED |
| `deadlock_read.pj` | blocks | hangs (>8s) | CONFIRMED |
| `overloads.pj` | other | build failed at ProcessJc n/a | error[403]: Procedure 'twise' not found |
| `par_deadlock.pj` | blocks | hangs (>8s) | CONFIRMED |
| `par_for_shared.pj` | other | hangs (>8s) | n/a |
| `parallel_usage.pj` | other | finishes | n/a |
| `pri_alt_skip.pj` | other | hangs (>8s) | n/a |
| `protocol_fields.pj` | other | build failed at ProcessJc n/a | Exception in thread "main" java.lang.NullPointerException |
| `self_deadlock.pj` | blocks | hangs (>8s) | CONFIRMED |
| `shared_channel.pj` | other | hangs (>8s) | n/a |
| `starving_loop.pj` | blocks | hangs (>8s) | CONFIRMED |
| `typos.pj` | other | build failed at ProcessJc n/a | error[405]: Symbol 'cuont' not found |
| `use_import.pj` | clean | build failed at javac | compiler limit /var/folders/yw/c_xqrv6n39d475z2v2d09x8w0000gn/T/processj-lsp-UU7ZHe/.pjlsp-home/work/use_import.java:9: error: package lib does not exist |

`other` rows are programs with type errors or races: some the compiler rejects, some it builds and they hang or misbehave at runtime, which is the point of the checker. `compiler limit` means the program is fine but this compiler build cannot build it (user-library imports).
