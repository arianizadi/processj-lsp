--- processj-lsp: Neovim integration for the ProcessJ language server.
---
--- Install with lazy.nvim:
---   { "arianizadi/processj-lsp", build = "npm ci && npm run build", ft = "processj", opts = {} }
---
--- The plugin registers the `processj` filetype (ftdetect/), bundles syntax
--- highlighting and ftplugin settings, and starts the server from its own
--- checkout with Neovim's built-in LSP client (0.11+). Works with AstroNvim as-is:
--- AstroLSP's capabilities, on_attach and mappings apply through vim.lsp.config("*").
local M = {}

M.did_setup = false
M.config = nil

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
    root_markers = { ".git" },
    workspace_required = false,
    init_options = {
      -- installDir = "~/Documents/ProcessJ", -- defaults to installdir in ~/processjrc or $PROCESSJ_HOME
      debounceMs = 400,
      timeoutMs = 20000,
      runTimeoutMs = 30000,
      checkOnChange = false, -- run the real compiler only on open and save; the checker runs as you type
      lint = true,
      codeLens = true, -- Run, Build, effect, graph, and protocol lenses; commands remain available when hidden
    },
  }
end

--- Send a server command for the current buffer.
local function exec(command)
  local client = vim.lsp.get_clients({ bufnr = 0, name = "processj_ls" })[1]
  if not client then
    vim.notify("processj-lsp: no ProcessJ server attached to this buffer", vim.log.levels.WARN)
    return
  end
  client:exec_cmd({ command = command, arguments = { vim.uri_from_bufnr(0) } }, { bufnr = 0 })
end

--- Is the server built? Reports what to do if not.
function M.check_build()
  local server = M.root() .. "/dist/src/server.js"
  if vim.fn.filereadable(server) == 1 then return true end
  vim.notify(
    "processj-lsp: server not built (missing dist/). Run `npm ci && npm run build` in " .. M.root() .. " (with lazy.nvim: :Lazy build processj-lsp).",
    vim.log.levels.WARN
  )
  return false
end

--- @param opts table|nil  Overrides merged into the vim.lsp.config for processj_ls
function M.setup(opts)
  if M.did_setup then return end
  M.did_setup = true
  local config = vim.tbl_deep_extend("force", M.default_config(), opts or {})
  M.config = config
  if vim.fn.executable "node" ~= 1 then
    vim.notify("processj-lsp: `node` is not on PATH; the server cannot start", vim.log.levels.ERROR)
    return
  end
  if not (vim.lsp.config and vim.lsp.enable) then
    vim.notify("processj-lsp: needs Neovim 0.11 or newer (vim.lsp.config)", vim.log.levels.ERROR)
    return
  end
  vim.lsp.config("processj_ls", config)
  vim.lsp.enable "processj_ls"
  vim.api.nvim_create_user_command("ProcessJRun", function() exec "processj.run" end, { desc = "Compile and run the current ProcessJ file" })
  vim.api.nvim_create_user_command("ProcessJBuild", function() exec "processj.build" end, { desc = "Compile the current ProcessJ file" })
  vim.api.nvim_create_user_command("ProcessJGraph", function() exec "processj.showConcurrencyReport" end, { desc = "Show the current file's concurrency graph" })
  vim.api.nvim_create_user_command("ProcessJEffects", function() exec "processj.showEffectReport" end, { desc = "Show procedure effect summaries for the current file" })
  vim.api.nvim_create_user_command("ProcessJProtocols", function() exec "processj.showProtocolReport" end, { desc = "Show protocol structure and observed flow for the current file" })
  -- AstroNvim applies its LSP keymaps (<Leader>la, <Leader>lf, gd, ...) from AstroLSP's
  -- on_attach, which only runs for servers AstroLSP started itself. Run it for ours too.
  vim.api.nvim_create_autocmd("LspAttach", {
    group = vim.api.nvim_create_augroup("processj_lsp_attach", { clear = true }),
    callback = function(args)
      local client = vim.lsp.get_client_by_id(args.data.client_id)
      if not client or client.name ~= "processj_ls" then return end
      if vim.b[args.buf].processj_lsp_attached then return end
      vim.b[args.buf].processj_lsp_attached = true
      local ok, astrolsp = pcall(require, "astrolsp")
      if ok and type(astrolsp.on_attach) == "function" then astrolsp.on_attach(client, args.buf) end
    end,
  })
  -- Warn once, on the first .pj buffer, if the build step was skipped.
  vim.api.nvim_create_autocmd("FileType", {
    pattern = "processj",
    once = true,
    callback = function() M.check_build() end,
  })
end

return M
