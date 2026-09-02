# processj-lsp

A language server for [ProcessJ](https://github.com/mattunlv/ProcessJ), packaged as a Neovim plugin.

[![CI](https://github.com/arianizadi/processj-lsp/actions/workflows/ci.yml/badge.svg)](https://github.com/arianizadi/processj-lsp/actions/workflows/ci.yml)

- Errors as you type, with messages that say what to fix and often a one-key fix
- A type checker that knows channels, records, protocols and `par`
- Formatting, semantic highlighting, hover, go to definition, rename, completion
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

If a `.pj` file opens with no diagnostics at all, run `:checkhealth vim.lsp`. If it says the server is not built, run `:Lazy build processj-lsp`.

## Using it

| action | AstroNvim | plain Neovim |
| --- | --- | --- |
| hover (shows the type) | `K` | `K` |
| go to definition | `gd` | `gd` |
| quick fix | `<Leader>la` | `:lua vim.lsp.buf.code_action()` |
| format | `<Leader>lf` | `:lua vim.lsp.buf.format()` |
| rename | `<Leader>lr` | `:lua vim.lsp.buf.rename()` |
| run / build the file | `:ProcessJRun` / `:ProcessJBuild` | same |

## VS Code

Built from source, so you always have the latest. Needs Node.js 20+ and the `code` command on PATH:

```sh
git clone https://github.com/arianizadi/processj-lsp
cd processj-lsp/vscode
npm run install-extension
```

To update: `git pull`, then run the same command again. Settings are under "ProcessJ" in the settings UI.

## Options

Pass them in `opts`:

```lua
opts = {
  init_options = {
    installDir = "~/Documents/ProcessJ", -- instead of ~/processjrc
    checkOnChange = true,                -- also run the real compiler on every edit (default: open and save)
    lint = false,                        -- turn the static analysis off
  },
}
```

## Good to know

- The real compiler only runs on open and save, in a temp directory. Your `~/workingpj` is never touched.
- The checker finds things the compiler does not: data races in `par`, a channel end used by two processes, a process reading its own channel, branches whose reads and writes cannot pair up, loops that starve every other process, `skip` shadowing the guards after it in a `pri alt`. See `examples/` for one small program per message.
- Files that import each other are re-checked when either changes; nothing is polled.
- More: [docs/DETAILS.md](docs/DETAILS.md) covers every feature, the numbers, and how it works.

## Developing

```sh
git clone https://github.com/arianizadi/processj-lsp && cd processj-lsp
npm ci && npm run build
npm test
```

Apache License 2.0. Example programs in `test/fixtures` are from the ProcessJ compiler (UNLV), also Apache 2.0.
