-- ProcessJ support for AstroNvim v5 (Neovim 0.11+).
--
-- Copy this file to ~/.config/nvim/lua/plugins/processj.lua and edit the two
-- paths below if the language server or its editor files live elsewhere.
--
-- What it does:
--   * registers *.pj as the "processj" filetype
--   * adds the repo's editor/nvim directory to the runtimepath so the bundled
--     syntax highlighting and ftplugin settings load
--   * defines and enables the processj_ls language server

local lsp_repo = vim.fn.expand "~/Documents/processj-lsp"

vim.opt.runtimepath:append(lsp_repo .. "/editor/nvim")

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
      config = {
        processj_ls = {
          cmd = { "node", lsp_repo .. "/bin/processj-lsp.js", "--stdio" },
          filetypes = { "processj" },
          root_markers = { ".git", "processjrc" },
          -- Works on a single file with no project root.
          workspace_required = false,
          init_options = {
            -- installDir = vim.fn.expand "~/Documents/ProcessJ", -- defaults to installdir in ~/processjrc
            debounceMs = 400,
            timeoutMs = 20000,
            checkOnChange = true,
          },
        },
      },
    },
  },
}
