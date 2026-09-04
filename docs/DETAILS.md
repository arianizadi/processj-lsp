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
Unknown statement 'retrun'; did you mean 'return'?
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
A constant can only be initialised with literals and other constants; this ProcessJ build computes it before the procedure runs, so the value would be 0 (or the build fails in a non-suspending procedure)
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
| `pj/shared-channel-end`    | a non-`shared` channel end used in two branches of a `par`, per side (`shared write chan<T>` still leaves one reader); quick fix adds `shared` and propagates it to the parameters the end is passed to |
| `pj/shared-unlocked-end`   | a `shared` channel operated by two processes without the runtime's lock. The generated code claims `claimRead`/`claimWrite` only for a parameter declared `shared chan<T>.read/.write`, never for an operation written on the channel variable, so the processes share the runtime's single reader/writer slot and the program can hang |
| `pj/channel-direction`     | `in.write(..)` on a `chan<T>.read` end, or chains like `c.read.write(..)`          |
| `pj/channel-write-type`    | `c.write("hi")` on a `chan<int>` (the compiler never type-checks writes)           |
| `pj/channel-no-writer`     | a channel read in a proc that never writes it or passes it on: blocks forever      |
| `pj/channel-no-reader`     | a channel write in a proc that never reaches a reader or passes the channel on     |
| `pj/channel-self-deadlock` | both ends of a channel used by the same sequential process: the first use blocks forever |
| `pj/par-deadlock`          | straight-line par branches for which every legal channel-pairing order gets stuck (crossed order, missing peer): bounded rendezvous proof. Any call to a procedure with a body makes its branch opaque, since the callee may diverge, so the proof is deliberately narrower than the branches it can see |
| `pj/par-for-body`          | a `par for` body with several statements: each one becomes its own process, so they run in parallel rather than in sequence and a local declared in one is not visible to the others. Wrapping the body in an inner block makes each iteration one process |
| `pj/timeout-deadline`      | `t.timeout(1000)` with a constant: the argument is the absolute millisecond to wake up, not a delay, so it returns immediately. Quick fix rewrites it to `t.read() + 1000`, except inside an `alt` guard, where that spelling does not compile and the deadline has to be a variable |
| `pj/starving-loop`         | an infinite loop with no communication, sync, timeout, alt or par: the cooperative scheduler never runs anyone else |
| `pj/pri-alt-skip`          | `skip` before other guards in a `pri alt`: those guards can never be chosen |
| `pj/barrier-not-enrolled`  | `sync()` on a local barrier nothing enrolled on: returns immediately              |
| `pj/assign-in-condition`   | `if (b = true)`: assignment where a comparison was meant                            |
| `pj/unreachable`           | code after `return`, `break`, `continue` or `stop` in the same block               |
| `pj/trivial-par`, `pj/trivial-alt` | a `par` with one branch, an `alt` with one guard: nothing concurrent happens   |
| `pj/multiple-alts`         | a second `alt` in the same generated process cannot be built (its guard array is declared twice); one alt per par branch is fine |
| `pj/read-placement`        | a channel read inside `?:` or inside a write's value; it must be its own statement (quick fix hoists it) |
| `pj/call-as-condition`     | a bare call as the whole `if`/`while` condition; compare its result (quick fix adds `== true`) |
| `pj/compiler-limit`        | a feature this ProcessJ build cannot compile, at the point of use: arrays of channels, variables holding a channel end, `claim`, `chan<string>`, nested record literals, record/protocol literals anywhere but a declaration initialiser, protocol parameters, `is`, assigning `null`, `break`/`continue` anywhere inside a par branch, a loop with `break` inside a switch case, records/protocols that refer to themselves through fields, reading through a `shared chan<T>.read` parameter, a value-returning procedure that can suspend, `!` as a whole condition, a read inside an `alt` timeout guard, and a second `par for` in one process. The program is fine; it just will not build with this compiler |
| `pj/needs-yield-annotation` | a procedure that suspends through calls or a `par for` scheduler boundary that the compiler's own yield walkers overlook (the compiler does mark ordinary communication in the body, a channel-end, barrier or timer parameter, `suspend`, or `main`); quick fix adds `[yield=true]` right after the parameter list. The server also adds it in its private copy before every compiler run, so Run works regardless |
| `pj/shadows-parameter`     | a local with the same name as a parameter (silently accepted)                      |
| `pj/unused`                | unused locals and parameters                                                        |
| `pj/missing-import`        | `println` without `import std.*;`; quick fix adds the import                       |

Yield propagation follows the exact overload selected by the checker, treats
`new mobile(...)` and `par for` as suspending, and follows imported callees in
each callee file's own import scope. That traversal is iterative, call-driven,
cycle-safe and capped at 128 body-bearing imported files per snapshot; an
unreadable or budget-truncated body is treated as potentially yielding instead
of guessed from a same-named root overload. The quick fix replaces an existing
`[yield=false]` value instead of creating a duplicate;
when several local callers need the annotation, a second action repairs the
whole call chain. Compiler checks and Run apply the same augmentation only to
their private temporary copy—the editor buffer and imported sources are never
silently rewritten.

**Causal deadlock explanations and a concurrency model.** The checker keeps a
source-mapped model instead of throwing its analysis away after producing a
message. A confirmed straight-line rendezvous deadlock names every blocked
branch and attaches each wait as related diagnostic information, so an editor
can jump through the whole causal chain. The model contains procedures, mobile
processes, `par` spawn/join points, `alt` choices, channels, barriers and timers,
plus call/read/write/pass/sync/timeout edges. Every node and edge is labelled
`exact`, `conditional`, or `unknown`; uncertainty is displayed rather than
silently upgraded into a claim about runtime behavior.

When several peers are ready on one channel, the proof explores alternative
rendezvous choices instead of depending on source branch order. It emits the
exact deadlock only if every explored legal schedule is stuck; exceeding the
bounded state budget produces no claim. Missing peers and genuine circular
waits are classified separately.

VS Code renders that model with **ProcessJ: Show Concurrency Graph**. The view is
filterable, keyboard accessible, source-linked, theme-aware, and can copy its
stable JSON representation. Other clients get a Mermaid/Markdown report from
the **Concurrency graph** code lens. The underlying portable request is
`processj/concurrencyGraph`.

**Procedure effect summaries.** Each procedure gets direct and transitive
conservative “may” effects: channel read/write, possible suspension, `par`,
`alt`, barrier, timer and mobile-process behavior. Calls use the exact overload
chosen by the checker; channel parameter effects are substituted through call
sites and graph labels retain their one-based parameter positions; recursive
call components are solved to a fixed point without recursive
JavaScript traversal. An unresolved, native or unavailable callee makes the
summary partial rather than falsely pure. The compact summary is a code lens and
appears in hover; running the lens opens the evidence-oriented report.

**Protocol intelligence.** Protocol declarations are modeled as tagged unions
including inherited cases, declaration identity and ambiguous inherited tags.
Protocol switches are checked for missing cases and duplicate defaults. A
non-exhaustive switch has a quick fix that generates only the missing case
stubs. The server also records observed construction, send, receive, `switch`
match and `is` test sites. VS Code's **ProcessJ: Show Protocol Flow** visualizes
that structure and observed flow; the declaration code lens opens a portable
report in other clients. “Inferred transitions” are explicitly observations in
one procedure, not a session-type guarantee.

**Channel role hints.** One inlay per channel declaration or parameter summarizes
read/write direction, direct traffic, branch count, sharing, escape/unknown state
and proven hazards. The detailed tooltip explains what evidence is direct versus
transitive. Semantic tokens separately mark read targets, write targets, shared
ends, blocking operations and passed/escaped ends, allowing themes to distinguish
concurrency roles without recoloring ordinary variables.

**Concurrency-aware refactors.** Code actions validate a complete candidate by
parsing and checking it before offering the edit. They can extract selected
statements into a procedure with inferred parameters and channel-end direction;
wrap independent straight-line statements in `par` only after dependency and
rendezvous proofs; correct private channel-end signatures and exact in-file
callers; propagate the minimum required shared side through private callees; and
replace a narrowly proven one-producer/one-consumer `par` data race with a
rendezvous channel. When a proof is missing, the disabled action explains why
instead of guessing. Clients that support versioned workspace edits get the
document version on every action; pre-CodeAction-literal clients receive a
compatible command carrying the legacy edit shape, and stale diagnostic
requests are still rejected before an action is made. Refused actions are shown
with their reason when the client advertises disabled-action support.

**Run from the editor.** Code lenses above `main` offer **▶ Run** and
**Build** (Neovim also has `:ProcessJRun` and `:ProcessJBuild`; its analysis reports are directly available as
`:ProcessJGraph`, `:ProcessJEffects` and `:ProcessJProtocols`). Run performs the whole `pjc` pipeline
(ProcessJc, `javac --release 8`, the two ASM rewrites, `java`) in a temp
directory, judged by exit codes rather than by grepping output, then opens a
report with the program's output. A program that never finishes is killed after
30 s and flagged as a probable deadlock.

**Semantic highlighting.** The server sends semantic tokens for every identifier,
classified from the parse tree and the checker's resolutions: procedure names,
records, protocols and their cases, fields, parameters, locals, constants
(`readonly`), standard-library calls (`defaultLibrary`), package names, and the
channel-role modifiers described above.
Keywords, literals and comments stay with the bundled syntax file. Neovim applies
the tokens on top of syntax highlighting automatically.

**Cross-file imports.** `import geom.*;` and `import lib.shapes;` resolve to files
next to the importing file, under the workspace roots, or under the install's
include directory (which is how `import std.*;` finds the standard library).
Imported declarations are typed, completed, hovered and navigable; an import that
resolves nowhere gets a warning saying where it looked. Only what a file imports
is visible to its checker; the workspace index is used for navigation and
auto-import candidates. Selecting an unimported workspace or standard-library
declaration from completion inserts the narrow import without disturbing the
existing package, pragma, or import header. Effect and yield analysis checks only
body-bearing files reached by exact calls, rather than eagerly checking the whole
workspace or standard library. Its transitive dependency set ensures an edit or
open-buffer overlay in a reached file invalidates every affected open importer.

**Navigation.** Completion is scope- and declaration-order-aware: an inner local
shadows the outer one, declarations below the cursor are not offered, and locals
from another overload never leak in. It also includes imported procedures,
records, protocols and constants; keywords with explanations; snippets for
`par`, `alt`, `chan`, ...; and type-directed members (`p.` gets record/protocol
fields while a channel end gets only the operations its direction allows).
Unimported workspace candidates are prefix-filtered and capped at 200 per
response; an incomplete result asks the editor to narrow/requery instead of
allocating the entire workspace on every keystroke.

Hover shows expression types, signature help presents overloads, and go to
definition reaches workspace and standard-library declarations. References,
rename, and document highlights follow checker identities for shadowed locals
and the exact selected procedure overload rather than text-matching equal names;
ambiguous fields, cases, recovery-only symbols, and qualified-name cases fail
closed instead of risking an unrelated rename. Fuzzy workspace-symbol search,
document outline, and folding complete the navigation surface.

**Examples.** `examples/` holds one short program per diagnostic (and two clean
ones); each announces the codes it produces on its first line and
`test/examples.test.ts` checks that. They double as a tour of what the server
catches.

## Performance

Everything except the compiler run is synchronous on the keystroke path, so it
has to be fast. `npm run bench` times every in-memory layer separately. One run
on a laptop produced:

```
 lines   parse  symbols  check  effects  protocols  graph  inlays  semantic  format
 1.3k     2.2      0.6    1.5      0.4        1.0    0.8     0.2       1.1     1.7 ms
  10k    10.4      2.3    7.5      2.2        6.7    7.7     1.0       6.1    12.3 ms
  50k    54.7     10.6   34.0     14.0       35.5   33.1     5.2      31.6    64.6 ms
```

(Exact numbers vary by machine; these are warm, steady-state runs rather than
guarantees. `test/perf.test.ts` enforces generous CI budgets on a generated
20,000-line file, checks that parse time grows linearly, and guards a 750-level
protocol hierarchy against inherited-case duplication.)

A separate completion stress run indexed 1,500 files with 30,000 declarations.
The cold request, including the initial workspace walk, took 118 ms; warm
requests took 1.79–3.69 ms and returned 278 items / 55.8 KiB with
`isIncomplete: true`. Before prefix filtering and the 200 auto-import budget,
the same warm request took 109–123 ms and returned 30,078 items / 6.53 MiB.

The server caches parsing, checking, symbols and semantic inputs per document
version, computes effects/protocols once per version, builds the visual graph only
on request, coalesces lint bursts into one pass, and routes real-compiler JVM work
through a latest-wins queue with two workers. A newer edit cancels stale work;
the queue bounds CPU/memory when many files open together without serializing
all compiler feedback.

**Disk and change detection.** Everything on the keystroke path runs in memory.
The only things that touch disk are compiler runs (a few kilobytes of temporary
files, which is why they default to open and save only) and the bounded workspace
index. Files are parsed once and cached by modification time, change time, and
size; name and occurrence indexes serve later completion/navigation requests.
Unsaved open buffers overlay their on-disk entries, including transitively reached
effect/yield dependencies.

When the editor supports dynamic file watching (Neovim and the bundled VS Code
extension do), the server registers one `**/*.pj` watcher and the editor pushes
changes; there is no polling or duplicate client-side watcher. A changed file
re-checks only open documents whose direct or analyzed transitive imports include
it. For a simpler LSP client without
watcher support, a lookup may refresh the workspace at most once every 5 seconds;
the fallback walk is depth/file bounded and never treats a home directory or
filesystem root as a project.

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
checkout. Open any `.pj` file; `:checkhealth processj-lsp` checks the Node version,
server build, optional ProcessJ/JDK setup, and whether `processj_ls` attached. If
it says the server is not built, run `:Lazy build processj-lsp`.

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
`<Leader>lr` rename, `<Leader>ll` run a code lens (▶ Run, Build). The
`:ProcessJGraph`, `:ProcessJEffects` and `:ProcessJProtocols` commands open the
complete analysis reports without locating a lens first. `editor/nvim/lua/plugins/processj.lua` is a ready-made copy of the spec.

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

### 4. VS Code

Build and install the bundled extension from the repository:

```sh
cd vscode
npm run install-extension
```

The play button in the editor title and the code lens above `main` run the current file. Run, Build,
Restart Language Server, and Show Language Server Output are also available under **ProcessJ** in the
Command Palette. The language-status menu reports Starting, Ready, or Stopped and opens the server log.
All ProcessJ settings apply automatically; use `processj.trace.server = verbose` when protocol-level logs
are needed. An untitled editor also gets language features after changing its language mode to ProcessJ.

### 5. Other editors

The server speaks standard LSP over stdio: launch
`node <checkout>/bin/processj-lsp.js --stdio` for files of language id
`processj` (extension `.pj`). Pass the options below as `initializationOptions`.

### 6. Developing

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
| `codeLens`      | `true`  | `false` to hide all inline Run, Build, analysis, and graph lenses |

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
src/checker/effects.ts binding-aware direct/transitive procedure effects and SCC fixed points
src/checker/reachable.ts bounded call-driven imported-body analysis and dependency tracking
src/checker/protocols.ts protocol inheritance, coverage, collisions and observed message flow
src/checker/controlflow.ts executable-prefix statement walking (a return or break ends its block)
src/checker/rendezvous.ts bounded state-space search for a legal straight-line rendezvous schedule
src/concurrency.ts  stable source-mapped process/channel graph and portable Markdown renderer
src/inlays.ts       compact channel-role and topology hints
src/refactors.ts    conservative, validated concurrency refactoring plans
src/semantic.ts     semantic tokens from the parse tree and the checker's resolutions
src/imports.ts      import resolution (file's directory, workspace roots, include directory)
src/astsymbols.ts   symbols and scoped locals from the parse tree
src/navigation.ts   binding-aware local scopes, declaration/reference spans and type uses
src/analysis.ts     lexer-level diagnostics (escape sequences, non-ASCII, empty comments)
src/tokens.ts       tokenizer that also reports the lexer limits and keeps comments
src/compiler.ts     runs ProcessJc in an isolated temp home, cancellable
src/pipeline.ts     full build + run pipeline (ProcessJc, javac, ASM passes, java)
src/diagnostics.ts  parses compiler output into structured diagnostics
src/symbols.ts      regex-based extractor, used to top up symbols while a file has syntax errors
src/library.ts      indexes include/JVM/**/*.pj for std completion and definitions
src/workspace.ts    bounded parsed/symbol/occurrence index, invalidated by editor file events
src/taskqueue.ts    debounced latest-wins compiler queue with bounded concurrency
src/settings.ts     defaults and validation for untrusted initialization options
src/keywords.ts     keyword list and hover docs
test/               node:test unit tests; test/fixtures holds the compiler's example corpus and std headers
test/differential/  programs whose real compiler and runtime outcome is recorded in their header
examples/           one program per diagnostic, self-describing and tested
scripts/smoke.js    talks LSP over stdio to a real server, ends with a real program run
scripts/bench.js    complete in-memory analysis timings on generated large files
scripts/validate.js builds and runs every program, comparing the checker's verdict against reality
lua/, plugin/, ftdetect/, syntax/, ftplugin/   the Neovim plugin (install the repo with lazy.nvim)
editor/nvim/        ready-made lazy.nvim/AstroNvim spec and a plugin-manager-free config
vscode/             VS Code extension: `npm run install-extension` builds the server, bundles it, packages and installs
```

## License

Apache License 2.0 (see `LICENSE`). The example programs under
`test/fixtures/processj` come from the ProcessJ compiler repository, also Apache
2.0, University of Nevada, Las Vegas (see `NOTICE`).

## Validated against the real runtime

`npm run validate [dir]` builds every program with the real compiler and runs it with a timeout. A program the checker says will block must hang; a clean program must finish; a program with type errors must not build and run. It runs over `examples/` by default, over the compiler's own corpus with `npm run validate test/fixtures/processj`, and over `test/differential`, whose programs each record what the real compiler and runtime did with them (`// outcome: runs`, `runs-wrong`, `error`, `compiler-limit`, `deadlocks`) so a rule can never quietly contradict them. Every one of those runs is confirmed or informational, none to investigate. Latest run over the examples (a short timeout was used for expected hangs):

| example | checker says | real program | result |
| --- | --- | --- | --- |
| `bug_lookalikes.pj` | clean | finishes | CONFIRMED |
| `channel_direction.pj` | other | hangs (timeout) | informational |
| `channel_types.pj` | other | compiler crashed | n/a |
| `clean_pipeline.pj` | clean | finishes | CONFIRMED |
| `compiler_limits.pj` | other | compiler crashed | n/a |
| `const_from_variable.pj` | other | finishes with the wrong value | compiler bug (runs) |
| `deadlock_read.pj` | blocks | hangs (timeout) | CONFIRMED |
| `overloads.pj` | other | ProcessJc rejects it | informational |
| `par_deadlock.pj` | blocks | hangs (timeout) | CONFIRMED |
| `par_for_shared.pj` | other | hangs (timeout) | informational |
| `parallel_usage.pj` | other | finishes | race (runs) |
| `pri_alt_skip.pj` | other | hangs (timeout) | informational |
| `protocol_fields.pj` | other | compiler crashed | n/a |
| `read_placement.pj` | other | build failed at javac | n/a |
| `self_deadlock.pj` | blocks | hangs (timeout) | CONFIRMED |
| `shared_channel.pj` | other | hangs (timeout) | informational |
| `starving_loop.pj` | blocks | hangs (timeout) | CONFIRMED |
| `typos.pj` | other | compiler crashed | n/a |
| `par_for_body.pj` | other | finishes with the wrong value | informational |
| `shared_unlocked_end.pj` | other | hangs (timeout) | informational |
| `timer_deadline.pj` | other | finishes without waiting | informational |
| `use_import.pj` | clean | build failed at javac | compiler limit (imports) |
| `yield_through_calls.pj` | other | finishes | private-buffer yield repair works |

`other` rows are programs with type errors, races, compatibility warnings, or known compiler miscompilations: some the compiler rejects, some it builds and they hang or misbehave at runtime, which is the point of the checker. The latest run had 6 confirmed predictions, 0 missing-rule/mismatch investigations, and 0 possible false positives. `compiler limit (imports)` means the program is fine but this compiler build cannot link a user library.
