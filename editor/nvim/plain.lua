-- ProcessJ support for plain Neovim 0.11+ without a plugin manager: clone the repo,
-- build it, put it on the runtimepath, and call setup().
--   git clone https://github.com/arianizadi/processj-lsp ~/.local/share/processj-lsp
--   cd ~/.local/share/processj-lsp && npm install && npm run build
vim.opt.runtimepath:append(vim.fn.expand "~/.local/share/processj-lsp")
require("processj-lsp").setup {
  init_options = { checkOnChange = false },
}
