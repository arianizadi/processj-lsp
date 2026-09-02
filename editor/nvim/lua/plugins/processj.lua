-- ProcessJ support for AstroNvim v5 (Neovim 0.11+).
--
-- Copy this file to ~/.config/nvim/lua/plugins/processj.lua and edit `lsp_repo`
-- if the language server lives somewhere other than ~/Documents/processj-lsp.
--
-- What it does:
--   * registers *.pj as the "processj" filetype
--   * adds the repo's editor/nvim directory to the runtimepath so the bundled
--     syntax highlighting and ftplugin settings load
--   * defines and enables the processj_ls language server

local lsp_repo = vim.fn.expand "~/Documents/processj-lsp"

vim.opt.runtimepath:append(lsp_repo .. "/editor/nvim")
vim.filetype.add { extension = { pj = "processj" } }

local server = {
  cmd = { "node", lsp_repo .. "/bin/processj-lsp.js", "--stdio" },
  filetypes = { "processj" },
  root_markers = { ".git", "processjrc" },
  -- Works on a single file with no project root.
  workspace_required = false,
  init_options = {
    -- installDir = vim.fn.expand "~/Documents/ProcessJ", -- defaults to installdir in ~/processjrc
    debounceMs = 400,
    timeoutMs = 20000,
    runTimeoutMs = 30000,
    checkOnChange = true,
    lint = true,
  },
}

-- Register with core Neovim as well as AstroLSP. AstroLSP enables its servers on
-- its own "AstroFile" event; doing it here too means the server starts for any
-- .pj buffer no matter which plugin loaded first. AstroLSP's capabilities,
-- on_attach and mappings still apply: they are merged from vim.lsp.config("*")
-- and an LspAttach autocommand when the client attaches.
if vim.lsp.config and vim.lsp.enable then
  vim.lsp.config("processj_ls", server)
  vim.lsp.enable "processj_ls"
end

return {
  {
    "AstroNvim/astrocore",
    ---@type AstroCoreOpts
    opts = {
      filetypes = {
        extension = { pj = "processj" },
      },
    },
  },
  {
    "AstroNvim/astrolsp",
    ---@type AstroLSPOpts
    opts = {
      servers = { "processj_ls" },
      config = { processj_ls = server },
    },
  },
}
