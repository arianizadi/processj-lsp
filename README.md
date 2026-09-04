# processj-lsp

A language server for [ProcessJ](https://github.com/mattunlv/ProcessJ), with first-class Neovim and VS Code clients.

[![CI](https://github.com/arianizadi/processj-lsp/actions/workflows/ci.yml/badge.svg)](https://github.com/arianizadi/processj-lsp/actions/workflows/ci.yml)

- Errors as you type, with messages that say what to fix and often a one-key fix
- A type checker that knows channels, records, protocols and `par`
- Causal deadlock explanations, channel-role hints, procedure effect summaries and protocol exhaustiveness checks
- A source-linked concurrency graph plus conservative refactors for extracting procedures, introducing channels and safe parallelization
- Formatting, semantic highlighting, hover, exact rename/references, fuzzy workspace search, scope-aware completion with auto-imports
- ▶ Run: compile and run the current file from the editor

## Install

Add this to your lazy.nvim plugins (AstroNvim: `~/.config/nvim/lua/plugins/processj.lua`) and restart Neovim:

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

Open any `.pj` file. That's it.

## Before you start

| you need | why |
| --- | --- |
| Neovim 0.11+ | uses the built-in LSP client |
| Node.js 20+ and npm on PATH | the server runs on Node; lazy.nvim builds it once |
| a ProcessJ install, with `installdir=/path/to/ProcessJ` in `~/processjrc` | only for compiler diagnostics and ▶ Run; everything else works without it |
| a JDK on PATH | same: only for the compiler |

If a `.pj` file opens with no diagnostics at all, run `:checkhealth processj-lsp`. It checks the Node
version, server build, optional ProcessJ/JDK setup, and whether the client attached. If the server is not
built, run `:Lazy build processj-lsp`.

## Using it

| action | AstroNvim | plain Neovim |
| --- | --- | --- |
| hover (shows the type) | `K` | `K` |
| go to definition | `gd` | `gd` |
| quick fix | `<Leader>la` | `:lua vim.lsp.buf.code_action()` |
| format | `<Leader>lf` | `:lua vim.lsp.buf.format()` |
| rename | `<Leader>lr` | `:lua vim.lsp.buf.rename()` |
| inspect effects / protocol / topology | run the code lens above a declaration, or `:ProcessJEffects` / `:ProcessJProtocols` / `:ProcessJGraph` | `:lua vim.lsp.codelens.run()` or the same commands |
| extract / parallelize / repair a channel | select code or place the cursor on a diagnostic, then `<Leader>la` | `:lua vim.lsp.buf.code_action()` |
| ▶ Run / Build | `<Leader>ll` on `main`, or `:ProcessJRun` / `:ProcessJBuild` | `:lua vim.lsp.codelens.run()` |

## VS Code

Built from source, so you always have the latest. Needs Node.js 20+ and the `code` command on PATH:

```sh
git clone https://github.com/arianizadi/processj-lsp
cd processj-lsp/vscode
npm run install-extension
```

To update: `git pull`, then run the same command again. Settings are under "ProcessJ" in the settings UI.
Each successful GitHub Actions run also publishes a ready-to-install VSIX artifact if you do not want to build locally.

Open a `.pj` file and use the play button in the editor title, the **▶ Run** code lens above `main`, or
**ProcessJ: Run Current File** from the Command Palette. The language status menu shows whether the server
is ready; click it for logs. Settings take effect automatically, and **ProcessJ: Restart Language Server**
is available when troubleshooting. Unsaved ProcessJ editors work too after choosing the ProcessJ language mode.

Use **ProcessJ: Show Concurrency Graph** for the filterable, source-linked process/channel topology and
**ProcessJ: Show Protocol Flow** for protocol inheritance, cases and observed producers/consumers. Inlay hints
summarize channel direction, traffic, sharing and hazards at each declaration; hover gives the longer explanation.
**ProcessJ: Show Procedure Effects** opens the complete direct/transitive effect report without needing a code lens.

Using Remote SSH? Extensions run on the remote machine, so run those commands there (over SSH), then reload the window.

## Options

Pass them in `opts`:

```lua
opts = {
  init_options = {
    installDir = "~/Documents/ProcessJ", -- instead of ~/processjrc
    checkOnChange = true,                -- also run the real compiler on every edit (default: open and save)
    lint = false,                        -- turn the static analysis off
    codeLens = false,                    -- hide inline Run, Build, effect, graph, and protocol lenses
  },
}
```

VS Code exposes these plus the compiler debounce and timeout, Java path, server path, and protocol tracing
under **Settings → ProcessJ**; no JSON editing or window reload is required.

## Good to know

- The real compiler only runs on open and save, in a temp directory. Your `~/workingpj` is never touched.
- The checker finds things the compiler does not: data races in `par`, a channel end used by two processes, a process reading its own channel, branches whose reads and writes cannot pair up, loops that starve every other process, `skip` shadowing the guards after it in a `pri alt`. See `examples/` for one small program per message.
- It also flags programs this compiler accepts and then gets wrong, each one verified by building and running it: a `shared` channel operated without the runtime's lock (it hangs), `t.timeout(1000)` (an absolute deadline, so it returns at once), a multi-statement `par for` body (every statement becomes its own process), a value-returning procedure that suspends, and `!` as a whole condition.
- Deadlock findings include the exact blocked operation in every branch. Dashed graph edges and “partial” effect summaries mean the server deliberately retained uncertainty instead of claiming a runtime fact it could not prove.
- Protocol flow and inferred transitions describe what this source constructs, sends, receives and matches; they are not a session-type promise about every runtime ordering.
- Files that import each other are re-checked when either changes. Neovim and VS Code push file events;
  simpler clients fall back to an on-demand workspace refresh at most once every 5 seconds.
- More: [docs/DETAILS.md](docs/DETAILS.md) covers every feature, the numbers, and how it works.

## Developing

```sh
git clone https://github.com/arianizadi/processj-lsp && cd processj-lsp
npm ci && npm run build
npm test
```

Apache License 2.0. Example programs in `test/fixtures` are from the ProcessJ compiler (UNLV), also Apache 2.0.
