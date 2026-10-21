#!/usr/bin/env node
// The browser build: the language server as a Web Worker, for the web IDE.
// Runs after the Node build (npm run build:browser runs both), whose graph
// viewer script and page renderer it uses, and writes dist/browser/:
//
//   processj-lsp.worker.js   the server, one classic (IIFE) worker script, with
//                            the standard library headers inside (+ .map)
//   elk.<hash>.js            the layout engine (elkjs), which the worker loads
//                            with importScripts when it first lays out a view
//   graph-viewer.html        the graph viewer for <iframe sandbox="allow-scripts">
//   manifest.json            { version, commit, files }
//
// The server is the one the editors run. Here src/connection.ts becomes
// src/connection.browser.ts (LSP over the worker's port) and Node's built-in
// modules become the ones in src/browser/ (files in memory, which the page
// fills). See docs/DETAILS.md, "The browser build".
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const out = path.join(root, 'dist', 'browser');
const src = (file) => path.join(root, 'src', file);
const WORKER = 'processj-lsp.worker.js';
const VIEWER = 'graph-viewer.html';

const viewerScript = path.join(root, 'dist', 'src', 'graph', 'client', 'viewer.js');
const renderHtml = path.join(root, 'dist', 'src', 'graph', 'render-html.js');
if (!fs.existsSync(viewerScript) || !fs.existsSync(renderHtml)) {
  console.error('build-browser: run `npm run build` first (or `npm run build:browser`, which does both)');
  process.exit(1);
}
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// The standard library headers the worker installs: test/fixtures/include matches the compiler's include/JVM.
const include = path.join(root, 'test', 'fixtures', 'include');
const headers = {};
const collect = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full);
    else if (entry.isFile() && entry.name.endsWith('.pj')) headers[path.relative(include, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
  }
};
collect(include);
fs.writeFileSync(src('browser/stdlib.json'), `${JSON.stringify(headers, null, 2)}\n`);

// esbuild only strips types: check the browser modules against the worker's library first.
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', path.join(root, 'tsconfig.browser.json')], { stdio: 'inherit' });

const builtins = {
  fs: src('browser/fs.ts'),
  path: require.resolve('path-browserify'),
  url: src('browser/url.ts'),
  os: src('browser/os.ts'),
  crypto: src('browser/crypto.ts'),
  child_process: src('browser/unavailable.ts'),
  http: src('browser/unavailable.ts'),
  net: src('browser/unavailable.ts'),
};
const browserModules = {
  name: 'processj-lsp-browser',
  setup(build) {
    build.onResolve({ filter: /^elkjs\/lib\/elk\.bundled\.js$/ }, () => ({ path: src('browser/elk.ts') }));
    build.onResolve({ filter: /^(node:)?[a-z_]+$/ }, (args) => {
      const name = args.path.replace(/^node:/, '');
      if (builtins[name]) return { path: builtins[name] };
      if (args.path.startsWith('node:')) return { errors: [{ text: `${args.path} has no browser stand-in (src/browser/); add one or keep it out of the server's path` }] };
      return undefined;
    });
    build.onResolve({ filter: /^\.\/connection$/ }, (args) => (args.importer === src('server.ts') ? { path: src('connection.browser.ts') } : undefined));
  },
};

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// The layout engine as a file of its own (src/browser/elk.ts loads it), named by its content for caching.
const elkCode = (await esbuild.transform(fs.readFileSync(require.resolve('elkjs/lib/elk.bundled.js'), 'utf8'), { minify: true, target: 'es2022', legalComments: 'inline' })).code;
const ELK = `elk.${createHash('sha256').update(elkCode).digest('hex').slice(0, 12)}.js`;
fs.writeFileSync(path.join(out, ELK), elkCode);

const result = await esbuild.build({
  absWorkingDir: root,
  entryPoints: [src('browser/worker.ts')],
  outfile: path.join(out, WORKER),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  inject: [src('browser/globals.ts')],
  define: {
    PROCESSJ_LSP_VERSION: JSON.stringify(version),
    PROCESSJ_VIEWER_SCRIPT: JSON.stringify(fs.readFileSync(viewerScript, 'utf8')),
    PROCESSJ_ELK_FILE: JSON.stringify(ELK),
  },
  plugins: [browserModules],
  metafile: true,
  logLevel: 'warning',
});
const unexpected = Object.keys(result.metafile.inputs).filter((file) => /vscode-languageserver\/lib\/node\/|vscode-jsonrpc\/lib\/node\/|elkjs\//.test(file));
if (unexpected.length) throw new Error(`the browser build pulled in Node's LSP transport or the layout engine: ${unexpected.join(', ')}`);

// The viewer page, built once: payloads reach it by postMessage. Its nonce is fixed with the file, and
// made from the page itself, so the same source always builds the same file (a static file's nonce is no
// secret either way: the page's CSP is what lets only these scripts run).
const { renderEmbeddedViewerHtml } = require(renderHtml);
const NONCE_SLOT = 'processjViewerNonceSlot';
const draft = renderEmbeddedViewerHtml({ nonce: NONCE_SLOT });
const nonce = createHash('sha256').update(draft).digest('base64').slice(0, 24);
fs.writeFileSync(path.join(out, VIEWER), draft.split(NONCE_SLOT).join(nonce));

let commit = 'unknown';
try {
  commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'src', 'scripts', 'package.json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (dirty) commit += '-dirty';
} catch {
  /* not a git checkout */
}
const files = fs.readdirSync(out).sort();
fs.writeFileSync(path.join(out, 'manifest.json'), `${JSON.stringify({ version, commit, files }, null, 2)}\n`);

for (const file of [WORKER, ELK, VIEWER]) {
  const bytes = fs.readFileSync(path.join(out, file));
  console.log(`dist/browser/${file}: ${(bytes.length / 1024).toFixed(0)} KiB, ${(gzipSync(bytes, { level: 9 }).length / 1024).toFixed(0)} KiB gzipped`);
}
