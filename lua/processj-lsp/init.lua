--- processj-lsp: Neovim integration for the ProcessJ language server.
---
--- Install with lazy.nvim:
---   { "arianizadi/processj-lsp", build = "npm install && npm run build", ft = "processj", opts = {} }
---
--- The plugin registers the `processj` filetype (ftdetect/), bundles syntax
--- highlighting and ftplugin settings, and starts the server from its own
--- checkout with Neovim's built-in LSP client (0.11+). Works with AstroNvim as-is:
--- AstroLSP's capabilities, on_attach and mappings apply through vim.lsp.config("*").
local M = {}

M.did_setup = false

--- Root of this plugin (the git checkout lazy.nvim made), derived from this file's path.
function M.root()
  local source = debug.getinfo(1, "S").source:sub(2)
  return vim.fn.fnamemodify(source, ":h:h:h")
end

--- Default server configuration; `setup(opts)` deep-merges user options into it.
function M.default_config()
  return {
    cmd = { "node", M.root() .. "/bin/processj-lsp.js", "--stdio" },
    filetypes = { "processj" },
    root_markers = { ".git", "processjrc" },
    workspace_required = false,
    init_options = {
      -- installDir = "~/Documents/ProcessJ", -- defaults to installdir in ~/processjrc or $PROCESSJ_HOME
      debounceMs = 400,
      timeoutMs = 20000,
      runTimeoutMs = 30000,
      checkOnChange = false, -- run the real compiler only on open and save; the checker runs as you type
      lint = true,
    },
  }
end

--- Is the server built? Reports what to do if not.
function M.check_build()
  local server = M.root() .. "/dist/src/server.js"
  if vim.fn.filereadable(server) == 1 then return true end
  vim.notify(
    "processj-lsp: server not built (missing dist/). Run `npm install && npm run build` in " .. M.root() .. " (with lazy.nvim: :Lazy build processj-lsp).",
    vim.log.levels.WARN
  )
  return false
end

--- @param opts table|nil  Overrides merged into the vim.lsp.config for processj_ls
function M.setup(opts)
  if M.did_setup then return end
  M.did_setup = true
  if vim.fn.executable "node" ~= 1 then
    vim.notify("processj-lsp: `node` is not on PATH; the server cannot start", vim.log.levels.ERROR)
    return
  end
  if not (vim.lsp.config and vim.lsp.enable) then
    vim.notify("processj-lsp: needs Neovim 0.11 or newer (vim.lsp.config)", vim.log.levels.ERROR)
    return
  end
  local config = vim.tbl_deep_extend("force", M.default_config(), opts or {})
  vim.lsp.config("processj_ls", config)
  vim.lsp.enable "processj_ls"
  -- Warn once, on the first .pj buffer, if the build step was skipped.
  vim.api.nvim_create_autocmd("FileType", {
    pattern = "processj",
    once = true,
    callback = function() M.check_build() end,
  })
end

return M
