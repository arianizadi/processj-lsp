# processj-lsp

A language server for [ProcessJ](https://github.com/mattunlv/ProcessJ) with one-command setup for Neovim, VS Code and Emacs.

[![CI](https://github.com/arianizadi/processj-lsp/actions/workflows/ci.yml/badge.svg)](https://github.com/arianizadi/processj-lsp/actions/workflows/ci.yml)

Errors as you type, a type checker that knows channels, records, protocols and `par`, causal deadlock explanations, formatting, rename, go to definition, completion with auto-imports, and **▶ Run** from the editor.

## Install

You need [Node.js](https://nodejs.org) 20+ (with `npm`). For compiler diagnostics and ▶ Run you also need a JDK and a ProcessJ checkout, with `installdir=/path/to/ProcessJ` in `~/processjrc`; everything else works without them.

```sh
git clone https://github.com/arianizadi/processj-lsp
cd processj-lsp
npm run setup -- nvim      # Neovim 0.11+ (lazy.nvim, AstroNvim, LazyVim, or plain Neovim)
npm run setup -- vscode    # VS Code (needs the `code` command on PATH)
npm run setup -- emacs     # Emacs 29+ (built-in eglot) or lsp-mode
npm run setup              # every editor found on this machine
```

Restart the editor and open a `.pj` file. The first run builds the server; editors are pointed at this checkout, nothing is copied.

## Update

```sh
git pull && npm run setup
```

## Uninstall

```sh
npm run remove -- nvim
npm run remove -- vscode
npm run remove -- emacs
npm run remove             # all three
```

Neovim: deletes `lua/plugins/processj.lua` (lazy.nvim) or the `pack/processj` link. VS Code: uninstalls the extension. Emacs: removes the marked block from your init file.

## Using it

| action | Neovim | VS Code | Emacs (eglot) |
| --- | --- | --- | --- |
| hover, go to definition | `K`, `gd` | hover, F12 | `C-h .`, `M-.` |
| quick fix / refactor | `<Leader>la` or `:lua vim.lsp.buf.code_action()` | Ctrl+. | `M-x eglot-code-actions` |
| rename | `<Leader>lr` or `:lua vim.lsp.buf.rename()` | F2 | `M-x eglot-rename` |
| format | `<Leader>lf` or `:lua vim.lsp.buf.format()` | Shift+Alt+F | `M-x eglot-format` |
| ▶ Run / Build | `:ProcessJRun`, `:ProcessJBuild` | play button, **ProcessJ: Run Current File** | `M-x eglot-execute-command processj.run` |
| concurrency graph, effects, protocols | `:ProcessJGraph`, `:ProcessJEffects`, `:ProcessJProtocols` | **ProcessJ: Show …** commands | code lenses are not shown by eglot; use the VS Code or Neovim commands |

If a `.pj` file opens with no diagnostics at all, run `:checkhealth processj-lsp` in Neovim, open the ProcessJ language-status menu in VS Code, or check `*EGLOT events*` in Emacs. The server speaks standard LSP over stdio (`node bin/processj-lsp.js --stdio`, language id `processj`), so any other editor can use it too.

## More

[docs/DETAILS.md](docs/DETAILS.md) covers every diagnostic, how the analysis works, the options, performance numbers and development (`npm test`, `npm run smoke`, `npm run bench`).

## License

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
