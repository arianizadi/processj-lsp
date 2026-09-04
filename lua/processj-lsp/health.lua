local M = {}
local health = vim.health

local function stat(path)
  return path and path ~= "" and vim.uv.fs_stat(path) or nil
end

local function first_line(text)
  return (vim.trim(text or ""):match("[^\r\n]+") or "")
end

local function run(command)
  local ok, result = pcall(function() return vim.system(command, { text = true }):wait() end)
  if not ok then return false, tostring(result) end
  local output = vim.trim(((result.stdout or "") .. "\n" .. (result.stderr or "")))
  return result.code == 0, output
end

local function active_options()
  local clients = vim.lsp.get_clients({ name = "processj_ls" })
  local client = clients[1]
  local configured = require("processj-lsp").config
  return client and client.config.init_options or (configured and configured.init_options) or {}, client
end

local function rc_install_dir()
  local rc = vim.fn.expand("~/processjrc")
  local ok, lines = pcall(vim.fn.readfile, rc)
  if not ok then return nil end
  for _, raw in ipairs(lines) do
    local line = vim.trim(raw)
    if not line:match("^#") then
      local value = line:match("^installdir%s*=%s*(.-)%s*$")
      if value and value ~= "" then return vim.fn.expand(value) end
    end
  end
  return nil
end

local function find_install(options)
  local candidates = {}
  local function add(candidate)
    if candidate and candidate ~= "" then candidates[#candidates + 1] = candidate end
  end
  add(options.installDir and vim.fn.expand(options.installDir) or nil)
  add(vim.env.PROCESSJ_HOME)
  add(rc_install_dir())
  for _, candidate in ipairs(candidates) do
    local root = vim.fs.normalize(candidate)
    local required = {
      "/bin/ProcessJc.class",
      "/resources/jars/java_cup_runtime.jar",
      "/resources/jars/ST-4.0.7.jar",
      "/resources/jars/asm-all-5.2.jar",
    }
    local usable = true
    for _, relative in ipairs(required) do
      if not stat(root .. relative) then usable = false break end
    end
    if usable then return root end
  end
  return nil, candidates
end

function M.check()
  health.start("processj-lsp runtime")
  if vim.fn.has("nvim-0.11") == 1 then
    local version = vim.version()
    health.ok(("Neovim %d.%d.%d"):format(version.major, version.minor, version.patch))
  else
    health.error("Neovim 0.11 or newer is required", { "Upgrade Neovim, then restart the editor" })
  end

  if vim.fn.executable("node") ~= 1 then
    health.error("Node.js is not on PATH", { "Install Node.js 20 or newer", "Restart Neovim so it inherits the updated PATH" })
  else
    local ok, output = run({ "node", "--version" })
    local version = first_line(output)
    local major = tonumber(version:match("^v?(%d+)"))
    if not ok then
      health.error("Could not run Node.js: " .. output)
    elseif not major or major < 20 then
      health.error("Node.js 20 or newer is required; found " .. version, { "Upgrade Node.js and restart Neovim" })
    else
      health.ok("Node.js " .. version)
    end
  end

  local root = require("processj-lsp").root()
  local server = root .. "/dist/src/server.js"
  if stat(server) then
    health.ok("Language server is built: " .. server)
  else
    health.error("Language server build is missing: " .. server, {
      "Run `npm ci && npm run build` in " .. root,
      "With lazy.nvim, run `:Lazy build processj-lsp`",
    })
  end

  health.start("ProcessJ compiler integration (optional)")
  local options, client = active_options()
  local install, candidates = find_install(options)
  if install then
    health.ok("ProcessJ install: " .. install)
    local java = options.javaBin
    if not java or java == "" then
      java = (vim.env.JAVA_HOME and vim.env.JAVA_HOME ~= "" and (vim.env.JAVA_HOME .. "/bin/java")) or "java"
    end
    java = vim.fn.expand(java)
    if vim.fn.executable(java) == 1 then
      local ok, output = run({ java, "-version" })
      if ok then health.ok("Java: " .. first_line(output))
      else health.error("Java failed: " .. output) end
    else
      health.error("Java executable not found: " .. java, {
        "Install a JDK or set init_options.javaBin",
        "Restart Neovim if Java was added to PATH",
      })
    end
  else
    local tried = {}
    for _, candidate in ipairs(candidates or {}) do
      if candidate and candidate ~= "" then tried[#tried + 1] = vim.fs.normalize(candidate) end
    end
    local suffix = #tried > 0 and (" Tried: " .. table.concat(tried, ", ")) or ""
    health.warn("No usable ProcessJ install found; compiler diagnostics and Run are disabled." .. suffix, {
      "Set `installdir=/path/to/ProcessJ` in ~/processjrc",
      "Or set opts.init_options.installDir in your plugin spec",
      "The parser, lints, formatting, completion, and navigation still work without the compiler",
    })
  end

  health.start("processj-lsp attachment")
  if client then
    local version = client.server_info and client.server_info.version or "unknown version"
    local buffers = vim.tbl_count(client.attached_buffers or {})
    health.ok(("processj_ls is running (%s, %d attached buffer%s)"):format(version, buffers, buffers == 1 and "" or "s"))
    health.info("LSP log: " .. vim.lsp.log.get_filename())
  else
    health.info("No processj_ls client is active. Open a .pj file after calling require('processj-lsp').setup().")
  end
end

return M
