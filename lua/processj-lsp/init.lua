--- processj-lsp: Neovim integration for the ProcessJ language server.
---
--- Install with lazy.nvim:
---   { "arianizadi/processj-lsp", build = "npm ci && npm run build", ft = { "processj", "csp" }, opts = {} }
---
--- The plugin registers the `processj` filetype (ftdetect/), bundles syntax
--- highlighting and ftplugin settings, and starts the server from its own
--- checkout with Neovim's built-in LSP client (0.11+). The server also attaches
--- to CSPm files (Neovim's `csp` filetype, *.csp): there :ProcessJGraph draws the
--- process network and :ProcessJFdr checks the file's own assertions with FDR. Works with AstroNvim as-is:
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
    -- `csp` is Neovim's filetype for *.csp (CSPm for FDR): the graph and FDR only, no ProcessJ analysis.
    filetypes = { "processj", "csp", "cspm" },
    root_markers = { ".git" },
    workspace_required = false,
    init_options = {
      -- installDir = "~/Documents/ProcessJ", -- defaults to installdir in ~/processjrc or $PROCESSJ_HOME
      debounceMs = 400,
      timeoutMs = 20000,
      runTimeoutMs = 30000,
      checkOnChange = false, -- run the real compiler only on open and save; the checker runs as you type
      lint = true,
      codeLens = true, -- Run, Build, effect, graph, protocol and FDR lenses; commands remain available when hidden
      liveViewer = true, -- :ProcessJGraph serves a local page that follows edits; false writes an HTML file instead
      -- fdrPath = "/Applications/FDR4.app/Contents/MacOS/refines", -- found on PATH and in the usual places when unset
      fdrTimeoutMs = 120000,
      fdrMemoryMb = 0, -- stop refines past this much memory; 0: half of this machine's, at most 8 GB
      fdrWorkers = 1, -- 1: the same deadlock and runtime-error counterexamples on every check; 0: every core
      fdrShowGraph = "always", -- after :ProcessJFdr, open the graph on the result: "always", "onFailure" (a defect only) or "never" (the text report opens instead)
    },
  }
end

--- Send a server command for the current buffer, with extra arguments after its URI.
local function exec(command, extra)
  local client = vim.lsp.get_clients({ bufnr = 0, name = "processj_ls" })[1]
  if not client then
    vim.notify("processj-lsp: no ProcessJ server attached to this buffer", vim.log.levels.WARN)
    return
  end
  local arguments = { vim.uri_from_bufnr(0) }
  for _, value in ipairs(extra or {}) do arguments[#arguments + 1] = value end
  client:exec_cmd({ command = command, arguments = arguments }, { bufnr = 0 })
end

local GRAPH_MODES = { "viewer", "markdown", "svg", "excalidraw" }
local EXPORT_FORMATS = { "all", "svg", "excalidraw", "html", "json" }

--- Completion for a command whose first argument comes from a fixed list and, with `path`, whose second is a directory.
local function choices(list, path)
  return function(lead, line, pos)
    -- Count the arguments after the command itself (`:silent ProcessJGraphExport svg ` included).
    local args = line:sub(1, pos):match("ProcessJGraph%a*!?%s+(.*)$") or ""
    local done = #vim.split(args, "%s+", { trimempty = true }) - (lead ~= "" and 1 or 0)
    if done == 0 then return vim.tbl_filter(function(item) return vim.startswith(item, lead) end, list) end
    if path and done == 1 then return vim.fn.getcompletion(lead, "dir") end
    return {}
  end
end

--- Procedure names of the current buffer (from the server's document symbols), for command completion.
local function complete_procedure(arglead)
  -- A CSPm file is checked as a whole: FDR runs its own assertions.
  if vim.bo.filetype == "csp" or vim.bo.filetype == "cspm" then return {} end
  local client = vim.lsp.get_clients({ bufnr = 0, name = "processj_ls" })[1]
  if not client then return {} end
  local response = client:request_sync("textDocument/documentSymbol", { textDocument = vim.lsp.util.make_text_document_params(0) }, 1000, 0)
  local names, seen = {}, {}
  for _, symbol in ipairs((response and response.result) or {}) do
    local name = symbol.name
    if symbol.kind == vim.lsp.protocol.SymbolKind.Function and not seen[name] and vim.startswith(name, arglead) then
      seen[name] = true
      names[#names + 1] = name
    end
  end
  table.sort(names)
  return names
end

--- Run a command on the whole program, or on the procedure named in the command's argument.
local function exec_on(command)
  return function(opts)
    exec(command, opts.args ~= "" and { opts.args } or nil)
  end
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
  vim.api.nvim_create_user_command("ProcessJGraph", function(command)
    local mode = command.fargs[1] or "viewer"
    if not vim.tbl_contains(GRAPH_MODES, mode) then
      vim.notify("processj-lsp: :ProcessJGraph takes one of " .. table.concat(GRAPH_MODES, ", "), vim.log.levels.WARN)
      return
    end
    exec("processj.showConcurrencyReport", { mode })
  end, { nargs = "?", complete = choices(GRAPH_MODES, false), desc = "Show the current file's process network (viewer, markdown, svg or excalidraw)" })
  vim.api.nvim_create_user_command("ProcessJGraphExport", function(command)
    local format = command.fargs[1] or "all"
    if not vim.tbl_contains(EXPORT_FORMATS, format) then
      vim.notify("processj-lsp: :ProcessJGraphExport takes one of " .. table.concat(EXPORT_FORMATS, ", "), vim.log.levels.WARN)
      return
    end
    local extra = { format }
    -- A relative directory is taken from :pwd here, as Vim does with paths; the server would take it from the file's folder.
    if command.fargs[2] then extra[2] = vim.fn.fnamemodify(command.fargs[2], ":p") end
    exec("processj.exportConcurrencyGraph", extra)
  end, { nargs = "*", complete = choices(EXPORT_FORMATS, true), desc = "Write the process network next to the file (all = svg, excalidraw and html; or json)" })
  vim.api.nvim_create_user_command("ProcessJEffects", function() exec "processj.showEffectReport" end, { desc = "Show procedure effect summaries for the current file" })
  vim.api.nvim_create_user_command("ProcessJProtocols", function() exec "processj.showProtocolReport" end, { desc = "Show protocol structure and observed flow for the current file" })
  vim.api.nvim_create_user_command("ProcessJCsp", exec_on "processj.convertToCsp", { nargs = "?", complete = complete_procedure, desc = "Convert the program (or the named procedure) to CSPm for FDR" })
  vim.api.nvim_create_user_command("ProcessJFdr", exec_on "processj.checkWithFdr", { nargs = "?", complete = complete_procedure, desc = "Check the program (or the named procedure) with FDR and show where it gets stuck; in a .csp file, the file's own assertions" })
  vim.api.nvim_create_user_command("ProcessJFdrCancel", function() exec "processj.cancelFdr" end, { desc = "Stop the FDR check running for the current file" })
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
      if ok and type(astrolsp.on_attach) == "function" then
        astrolsp.on_attach(client, args.buf)
      elseif client:supports_method "textDocument/codeLens" then
        -- Plain Neovim renders code lenses only when something asks for them. From 0.12 they are
        -- enabled once and kept up to date (the server asks for a refresh after an FDR check).
        if vim.lsp.codelens.enable then
          vim.lsp.codelens.enable(true, { bufnr = args.buf })
          return
        end
        local group = vim.api.nvim_create_augroup("processj_lsp_codelens_" .. args.buf, { clear = true })
        vim.api.nvim_create_autocmd({ "BufEnter", "CursorHold", "InsertLeave" }, {
          group = group,
          buffer = args.buf,
          callback = function() vim.lsp.codelens.refresh { bufnr = args.buf } end,
        })
        vim.lsp.codelens.refresh { bufnr = args.buf }
      end
    end,
  })
  -- Warn once, on the first .pj or .csp buffer, if the build step was skipped.
  vim.api.nvim_create_autocmd("FileType", {
    pattern = { "processj", "csp", "cspm" },
    once = true,
    callback = function() M.check_build() end,
  })
end

return M
