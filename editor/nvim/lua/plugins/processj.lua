-- ProcessJ support for AstroNvim v5 (or any lazy.nvim setup).
-- Copy this file to ~/.config/nvim/lua/plugins/processj.lua. lazy.nvim clones the
-- language server from GitHub, builds it, and the plugin wires up the filetype,
-- syntax highlighting and the server. Requires node and npm on PATH.
return {
  {
    "arianizadi/processj-lsp",
    build = "npm ci && npm run build",
    ft = "processj",
    opts = {
      init_options = {
        checkOnChange = false, -- run the real compiler only on open and save; the checker runs as you type
      },
    },
  },
}
