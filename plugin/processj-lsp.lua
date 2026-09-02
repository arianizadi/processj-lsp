-- Runs when the plugin loads. Sets the server up with defaults unless the user
-- has already called require("processj-lsp").setup() or opted out.
if vim.g.loaded_processj_lsp then return end
vim.g.loaded_processj_lsp = true
if vim.g.processj_lsp_no_auto_setup then return end
vim.schedule(function()
  local ok, mod = pcall(require, "processj-lsp")
  if ok and not mod.did_setup then mod.setup() end
end)
