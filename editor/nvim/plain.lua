-- ProcessJ support for plain Neovim 0.11+ (no AstroNvim).
-- Put this in your init.lua or require() it from there.

local lsp_repo = vim.fn.expand "~/Documents/processj-lsp"

vim.filetype.add { extension = { pj = "processj" } }
vim.opt.runtimepath:append(lsp_repo .. "/editor/nvim")

vim.lsp.config("processj_ls", {
  cmd = { "node", lsp_repo .. "/bin/processj-lsp.js", "--stdio" },
  filetypes = { "processj" },
  root_markers = { ".git", "processjrc" },
  workspace_required = false,
  init_options = { debounceMs = 400, timeoutMs = 20000, checkOnChange = true },
})
vim.lsp.enable "processj_ls"
