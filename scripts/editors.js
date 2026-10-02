#!/usr/bin/env node
// One command to install or uninstall ProcessJ support in Neovim, VS Code and Emacs.
//
//   npm run setup  -- [nvim] [vscode] [emacs]      install (default: every editor found on this machine)
//   npm run remove -- [nvim] [vscode] [emacs]      uninstall
//
// Nothing is copied: editors are pointed at this checkout, so `git pull` plus
// `npm run setup` updates them. Add --dry-run to see what would change.
'use strict';
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EDITORS = ['nvim', 'vscode', 'emacs'];
const VSCODE_EXTENSION_ID = 'arianizadi.processj-lsp-vscode';
const MARK_BEGIN = ';; >>> processj-lsp (managed by `npm run setup -- emacs`; remove with `npm run remove -- emacs`)';
const MARK_END = ';; <<< processj-lsp';
const WINDOWS = process.platform === 'win32';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const words = args.filter((a) => !a.startsWith('--'));
const action = words[0];
let targets = words.slice(1);
if (!['install', 'uninstall'].includes(action)) {
  console.error('usage: node scripts/editors.js <install|uninstall> [nvim] [vscode] [emacs] [--dry-run]');
  process.exit(2);
}
for (const t of targets) {
  if (!EDITORS.includes(t)) {
    console.error(`unknown editor '${t}'; choose from ${EDITORS.join(', ')}`);
    process.exit(2);
  }
}
const explicit = targets.length > 0;
if (!explicit) targets = EDITORS;

const failures = [];
const log = (line) => console.log(`${dryRun ? '[dry-run] ' : ''}${line}`);
const fail = (editor, message) => {
  failures.push(editor);
  console.error(`\n${editor}: ${message}`);
};

function which(command) {
  const result = spawnSync(WINDOWS ? 'where' : 'which', [command], { encoding: 'utf8' });
  if (result.status !== 0) return undefined;
  return result.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
}

function run(command, commandArgs, cwd) {
  log(`$ ${[command, ...commandArgs].join(' ')}   (in ${path.relative(ROOT, cwd) || '.'})`);
  if (dryRun) return;
  execFileSync(command, commandArgs, { cwd, stdio: 'inherit', shell: WINDOWS });
}

function requireNode20() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) {
    console.error(`Node.js 20 or newer is required (found ${process.versions.node}). Install it from https://nodejs.org or with your package manager.`);
    process.exit(1);
  }
}

/** Build the server unless dist/ is newer than every source file. */
function ensureBuilt() {
  const server = path.join(ROOT, 'dist', 'src', 'server.js');
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) run('npm', ['ci', '--no-audit', '--no-fund'], ROOT);
  let stale = !fs.existsSync(server);
  if (!stale) {
    const built = fs.statSync(server).mtimeMs;
    const stack = [path.join(ROOT, 'src')];
    while (stack.length && !stale) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.endsWith('.ts') && fs.statSync(full).mtimeMs > built) {
          stale = true;
          break;
        }
      }
    }
  }
  if (stale) run('npm', ['run', 'build'], ROOT);
  else log('server already built (dist/ is current)');
}

// ---------------------------------------------------------------------------
// Neovim
// ---------------------------------------------------------------------------

function nvimDirs() {
  if (WINDOWS) {
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return { config: path.join(local, 'nvim'), data: path.join(local, 'nvim-data') };
  }
  const config = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'nvim');
  const data = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'nvim');
  return { config, data };
}

function usesLazy(dirs) {
  return fs.existsSync(path.join(dirs.data, 'lazy', 'lazy.nvim'))
    || fs.existsSync(path.join(dirs.config, 'lazy-lock.json'))
    || fs.existsSync(path.join(dirs.config, 'lua', 'plugins'));
}

function luaString(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function nvimInstall() {
  if (!which('nvim')) {
    if (explicit) return fail('nvim', 'Neovim is not on PATH. Install Neovim 0.11+ (https://neovim.io) and run this again.');
    return log('nvim: not installed, skipping');
  }
  const dirs = nvimDirs();
  const spec = path.join(dirs.config, 'lua', 'plugins', 'processj.lua');
  const pack = path.join(dirs.config, 'pack', 'processj', 'start', 'processj-lsp');
  if (usesLazy(dirs)) {
    const text = [
      '-- Written by `npm run setup -- nvim` in processj-lsp; `npm run remove -- nvim` deletes this file.',
      '-- The server runs from the checkout below, so `git pull` there updates it.',
      'return {',
      '  {',
      '    "arianizadi/processj-lsp",',
      `    dir = ${luaString(ROOT)},`,
      '    ft = "processj",',
      '    opts = {},',
      '  },',
      '}',
      '',
    ].join('\n');
    log(`write ${spec}`);
    if (!dryRun) {
      fs.mkdirSync(path.dirname(spec), { recursive: true });
      fs.writeFileSync(spec, text);
    }
    if (!fs.existsSync(path.join(dirs.config, 'lua', 'plugins')) && !dryRun) {
      console.log('   note: your lazy.nvim setup must import the `plugins` module, e.g. `{ import = "plugins" }` (AstroNvim and LazyVim already do).');
    }
    removePath(pack);
  } else {
    // Plain Neovim: a native package; plugin/processj-lsp.lua sets everything up on start.
    log(`link ${pack} -> ${ROOT}`);
    if (!dryRun) {
      fs.mkdirSync(path.dirname(pack), { recursive: true });
      removePath(pack, true);
      fs.symlinkSync(ROOT, pack, WINDOWS ? 'junction' : 'dir');
    }
    removePath(spec);
  }
  console.log('   restart Neovim and open a .pj file; `:checkhealth processj-lsp` verifies the setup.');
}

function nvimUninstall() {
  const dirs = nvimDirs();
  const spec = path.join(dirs.config, 'lua', 'plugins', 'processj.lua');
  const pack = path.join(dirs.config, 'pack', 'processj', 'start', 'processj-lsp');
  let removed = false;
  if (fs.existsSync(spec) && fs.readFileSync(spec, 'utf8').includes('processj-lsp')) removed = removePath(spec) || removed;
  removed = removePath(pack) || removed;
  removePath(path.join(dirs.config, 'pack', 'processj', 'start'), true);
  removePath(path.join(dirs.config, 'pack', 'processj'), true);
  console.log(removed ? 'nvim: removed (restart Neovim; lazy.nvim users may also run :Lazy clean)' : 'nvim: nothing to remove');
}

/** Remove a file, symlink or empty directory. Returns whether something was removed. */
function removePath(target, quiet = false) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return false;
  }
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    if (fs.readdirSync(target).length > 0) return false;
    if (!quiet) log(`remove ${target}`);
    if (!dryRun) fs.rmdirSync(target);
    return true;
  }
  if (!quiet) log(`remove ${target}`);
  if (!dryRun) fs.rmSync(target, { force: true });
  return true;
}

// ---------------------------------------------------------------------------
// VS Code
// ---------------------------------------------------------------------------

function codeCommand() {
  for (const candidate of ['code', 'code-insiders', 'codium']) {
    const found = which(candidate);
    if (found) return candidate;
  }
  if (process.platform === 'darwin') {
    for (const app of ['Visual Studio Code', 'Visual Studio Code - Insiders']) {
      const bin = path.join('/Applications', `${app}.app`, 'Contents', 'Resources', 'app', 'bin', 'code');
      if (fs.existsSync(bin)) return bin;
    }
  }
  return undefined;
}

function vscodeInstall() {
  const code = codeCommand();
  if (!code) {
    if (explicit) return fail('vscode', "the `code` command is not on PATH. In VS Code run \"Shell Command: Install 'code' command in PATH\" from the Command Palette, then run this again.");
    return log('vscode: `code` command not found, skipping');
  }
  const dir = path.join(ROOT, 'vscode');
  if (!fs.existsSync(path.join(dir, 'node_modules'))) run('npm', ['ci', '--no-audit', '--no-fund'], dir);
  run('node', ['scripts/build.js'], dir);
  run('npx', ['vsce', 'package', '--no-dependencies', '--out', 'processj.vsix'], dir);
  run(code, ['--install-extension', path.join(dir, 'processj.vsix'), '--force'], dir);
  console.log('   reload VS Code windows that are already open (Developer: Reload Window).');
}

function vscodeUninstall() {
  const code = codeCommand();
  if (!code) return console.log('vscode: `code` command not found; uninstall "ProcessJ" from the Extensions view instead');
  const listed = spawnSync(code, ['--list-extensions'], { encoding: 'utf8', shell: WINDOWS });
  if (listed.status === 0 && !listed.stdout.toLowerCase().includes(VSCODE_EXTENSION_ID.toLowerCase())) return console.log('vscode: extension not installed, nothing to remove');
  run(code, ['--uninstall-extension', VSCODE_EXTENSION_ID], ROOT);
}

// ---------------------------------------------------------------------------
// Emacs
// ---------------------------------------------------------------------------

function emacsInitFile() {
  const home = os.homedir();
  const candidates = [];
  const xdg = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'emacs');
  if (!WINDOWS && fs.existsSync(xdg)) candidates.push(path.join(xdg, 'init.el'));
  if (WINDOWS && process.env.APPDATA) candidates.push(path.join(process.env.APPDATA, '.emacs.d', 'init.el'));
  candidates.push(path.join(home, '.emacs.d', 'init.el'), path.join(home, '.emacs'), path.join(home, '.emacs.el'));
  return candidates.find((file) => fs.existsSync(file)) ?? candidates.find((file) => fs.existsSync(path.dirname(file))) ?? path.join(home, '.emacs.d', 'init.el');
}

function emacsInstall() {
  if (!which('emacs')) {
    if (explicit) return fail('emacs', 'Emacs is not on PATH. Install Emacs 29 or newer (it includes the eglot LSP client) and run this again.');
    return log('emacs: not installed, skipping');
  }
  const init = emacsInitFile();
  const modeFile = path.join(ROOT, 'editor', 'emacs', 'processj-mode.el').split(path.sep).join('/');
  const block = `${MARK_BEGIN}\n(load "${modeFile}" nil t)\n${MARK_END}\n`;
  const existing = fs.existsSync(init) ? fs.readFileSync(init, 'utf8') : '';
  const stripped = stripEmacsBlock(existing);
  const next = `${stripped.replace(/\s*$/, '')}${stripped.trim() ? '\n\n' : ''}${block}`;
  log(`${existing ? 'update' : 'create'} ${init}`);
  if (!dryRun) {
    fs.mkdirSync(path.dirname(init), { recursive: true });
    fs.writeFileSync(init, next);
  }
  console.log('   restart Emacs and open a .pj file; eglot (Emacs 29+) or lsp-mode starts the server.');
}

function stripEmacsBlock(text) {
  const start = text.indexOf(MARK_BEGIN);
  if (start < 0) return text;
  const end = text.indexOf(MARK_END, start);
  if (end < 0) return text;
  return text.slice(0, start) + text.slice(end + MARK_END.length).replace(/^\r?\n/, '');
}

function emacsUninstall() {
  const init = emacsInitFile();
  if (!fs.existsSync(init)) return console.log('emacs: nothing to remove');
  const existing = fs.readFileSync(init, 'utf8');
  const stripped = stripEmacsBlock(existing);
  if (stripped === existing) return console.log('emacs: nothing to remove');
  log(`update ${init}`);
  if (!dryRun) fs.writeFileSync(init, stripped);
}

// ---------------------------------------------------------------------------

requireNode20();
if (action === 'install') {
  try {
    ensureBuilt();
  } catch (error) {
    console.error(`building the server failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
for (const editor of targets) {
  console.log(`\n== ${editor}`);
  try {
    if (action === 'install') ({ nvim: nvimInstall, vscode: vscodeInstall, emacs: emacsInstall })[editor]();
    else ({ nvim: nvimUninstall, vscode: vscodeUninstall, emacs: emacsUninstall })[editor]();
  } catch (error) {
    fail(editor, error instanceof Error ? error.message : String(error));
  }
}
if (failures.length) {
  console.error(`\n${action} failed for: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`\n${action === 'install' ? 'Done. Restart your editor and open a .pj file.' : 'Done.'}`);
