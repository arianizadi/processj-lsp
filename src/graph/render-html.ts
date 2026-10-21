/**
 * The viewer: one self-contained HTML page (inline CSS and script, no network
 * access beyond its own live server) that shows a ViewerPayload. The same page
 * works opened from a file, served by the live viewer server, and inside a VS
 * Code webview; each mode gets its own Content-Security-Policy, and scripts run
 * only with the page's nonce.
 */
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ViewerPayload } from './payload';
import { buildExcalidrawScene } from './render-excalidraw';
import { machineMarkers } from './render-machine';
import { MSC_COLORS } from './render-msc';
import { LIGHT_THEME } from './render-svg';
import { escapeXml } from './svg';

export interface ViewerOptions {
  mode: 'file' | 'live' | 'webview';
  /** Script nonce; a fresh one is made when omitted. */
  nonce?: string;
  /** `webview.cspSource`, for VS Code. */
  cspSource?: string;
  /** Path prefix of the live server's endpoints (`/<token>/`). */
  liveBase?: string;
}

let clientScript: string | undefined;

/** The compiled page script (dist/src/graph/client/viewer.js). */
function viewerScript(): string {
  if (clientScript === undefined) clientScript = fs.readFileSync(path.join(__dirname, 'client', 'viewer.js'), 'utf8');
  return clientScript;
}

/** Make JSON safe inside a `<script>` element. */
export function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function contentSecurityPolicy(options: ViewerOptions, nonce: string): string {
  const parts = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src ${options.cspSource ? `${options.cspSource} ` : ''}'unsafe-inline'`,
    `img-src ${options.cspSource ? `${options.cspSource} ` : ''}data: blob:`,
    // Only the live page talks to anything: its own server.
    `connect-src ${options.mode === 'live' ? "'self'" : "'none'"}`,
    "base-uri 'none'",
    "form-action 'none'",
  ];
  return parts.join('; ');
}

export function renderViewerHtml(payload: ViewerPayload, options: ViewerOptions): string {
  const nonce = options.nonce ?? randomBytes(16).toString('base64');
  const title = `${payload.title} · process network`;
  const live = options.mode === 'live' ? ` data-base="${escapeXml(options.liveBase ?? './')}"` : '';
  return `<!doctype html>
<html lang="en" data-mode="${options.mode}"${live}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="processj-lsp">
<meta http-equiv="Content-Security-Policy" content="${escapeXml(contentSecurityPolicy(options, nonce))}">
<meta name="referrer" content="no-referrer">
<title>${escapeXml(title)}</title>
<style>${PAGE_CSS}</style>
<style>${payload.style}</style>
</head>
<body>
<div id="app">
  <header class="toolbar">
    <div class="brand">
      <span id="live-state" class="live-state" title="Live: follows your edits and new results"></span>
      <strong id="title">${escapeXml(payload.title)}</strong>
      <label class="sr-only" for="view-select">View</label>
      <select id="view-select" title="Whole program or one procedure"></select>
    </div>
    <div class="search">
      <label class="sr-only" for="search">Search</label>
      <input id="search" type="search" placeholder="Find a process or channel  ( / )" autocomplete="off" spellcheck="false">
      <span id="search-count" class="muted"></span>
    </div>
    <div class="tools">
      <label class="toggle" title="Channel names on the arrows"><input id="toggle-labels" type="checkbox" checked> labels</label>
      <label class="toggle" title="Element types on the labels"><input id="toggle-types" type="checkbox" checked> types</label>
      <label class="toggle" title="Arrows that may not be used"><input id="toggle-conditional" type="checkbox" checked> conditional</label>
      <span class="zoom">
        <button id="zoom-out" type="button" title="Zoom out ( - )" aria-label="Zoom out">−</button>
        <button id="zoom-reset" type="button" title="Actual size ( 1 )">100%</button>
        <button id="zoom-in" type="button" title="Zoom in ( + )" aria-label="Zoom in">+</button>
        <button id="zoom-fit" type="button" title="Fit to the window ( 0 )">Fit</button>
      </span>
      <button id="code-button" type="button" title="Show the source and the timeline">Code</button>
      <button id="details-button" type="button" title="Show the details panel" aria-controls="panel" aria-expanded="false">Details</button>
      <button id="legend-button" type="button" title="What the shapes mean">Legend</button>
      <span class="export">
        <button id="export-button" type="button" aria-haspopup="menu" aria-expanded="false">Export ▾</button>
        <div id="export-menu" class="menu" role="menu" hidden>
          <button type="button" role="menuitem" data-format="svg">SVG of this view</button>
          <button type="button" role="menuitem" data-format="png">PNG (2×)</button>
          <button type="button" role="menuitem" data-format="excalidraw">Excalidraw scene</button>
          <button type="button" role="menuitem" data-format="json">JSON (model and results)</button>
          <button type="button" role="menuitem" data-format="chart">Sequence chart SVG</button>
          <button type="button" role="menuitem" data-format="machine">State machine SVG</button>
        </div>
      </span>
    </div>
  </header>
  <nav id="verdicts" class="verdicts" aria-label="Verification results"></nav>
  <main>
    <section id="stage" tabindex="0" aria-label="Process network: drag to pan, scroll or pinch to zoom">
      <svg id="canvas" class="pj-net" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
        <defs>${MARKERS}</defs>
        <g id="viewport"><g id="graph"></g><g id="dynamic"></g><g id="marks"></g></g>
      </svg>
      <div id="minimap" aria-hidden="true"><svg id="minimap-svg" class="pj-net" xmlns="http://www.w3.org/2000/svg"><use href="#graph"></use><rect id="minimap-frame"></rect></svg></div>
      <div id="legend" class="legend" hidden>${LEGEND}</div>
      <div id="stage-message" class="stage-message" hidden></div>
      <div class="banners">
        <div id="closed-banner" class="banner" hidden>The file was closed in the editor: this is how it was, and its results are gone. Open it again to follow it.</div>
        <div id="stale-banner" class="banner" hidden>Stale: the file changed after this result was computed. Run the check again.</div>
        <div id="caveat-banner" class="banner" role="note" hidden></div>
        <div id="formation-banner" class="banner formation-banner" role="status" aria-live="polite" hidden></div>
      </div>
      <div id="toast" class="toast" role="status" aria-live="polite"></div>
    </section>
    <aside id="panel" aria-label="Details"><div id="panel-body"></div></aside>
  </main>
  <section id="dock" hidden aria-label="Counterexample">
    <div id="dock-resize" class="dock-resize" role="separator" aria-orientation="horizontal" aria-label="Resize the timeline and code" tabindex="0"></div>
    <div class="dock-head">
      <div id="timeline-controls" class="transport">
        <button id="to-start" type="button" title="Start (Home)" aria-label="Start">⏮</button>
        <button id="step-back" type="button" title="Step back ( ← or [ )" aria-label="Step back">◀</button>
        <button id="play" type="button" title="Play / pause (space)" aria-label="Play">▶</button>
        <button id="step-forward" type="button" title="Step forward ( → or ] )" aria-label="Step forward">▶▶</button>
        <button id="to-end" type="button" title="End state (End)" aria-label="End state">⏭</button>
        <label class="sr-only" for="speed">Speed</label>
        <select id="speed" title="Replay speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select>
      </div>
      <div id="step-text" class="step-text"></div>
      <div class="tabs" role="tablist">
        <button id="tab-code" type="button" role="tab" class="active">Code</button>
        <button id="tab-chart" type="button" role="tab">Sequence chart</button>
        <button id="tab-machine" type="button" role="tab" hidden>State machine</button>
        <button id="dock-collapse" type="button" title="Hide or show the code and chart" aria-expanded="true">▾</button>
      </div>
    </div>
    <div id="timeline" class="timeline"></div>
    <div class="dock-body">
      <div id="code" class="code" role="region" aria-label="Source"></div>
      <div id="chart" class="chart" role="region" aria-label="Sequence chart" hidden></div>
      <div id="machine" class="machine" role="region" aria-label="State machine" hidden></div>
    </div>
  </section>
</div>
<script type="application/json" id="payload">${scriptJson(payload)}</script>
<script nonce="${nonce}">"use strict";
const buildExcalidrawScene = ${buildExcalidrawScene.toString()};
${viewerScript()}
</script>
</body>
</html>
`;
}

const MARKERS = '<marker id="pj-arrow" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path class="pj-arrow" d="M0,0.8 L10,5 L0,9.2 Z"/></marker>'
  + '<marker id="pj-arrow-faint" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path class="pj-arrow-faint" d="M0,0.8 L10,5 L0,9.2 Z"/></marker>'
  + '<marker id="pj-arrow-danger" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path class="pj-arrow-danger" d="M0,0.8 L10,5 L0,9.2 Z"/></marker>'
  + '<marker id="pj-arrow-behind" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path class="pj-arrow-behind" d="M0,0.8 L10,5 L0,9.2 Z"/></marker>'
  + machineMarkers();

const LEGEND = `
<h2>Reading the network</h2>
<dl>
  <dt><span class="key key-process"></span></dt><dd>a process (badge: what it is)</dd>
  <dt><span class="key key-own">own code</span></dt><dd>inside a container: the code its process runs itself, before or after its par</dd>
  <dt><span class="key key-par"></span></dt><dd>a par: its branches run in parallel</dd>
  <dt><span class="key key-stack"></span></dt><dd>a par for: one box, ×N processes</dd>
  <dt><span class="key key-arrow"></span></dt><dd>a channel, from its writer to its reader</dd>
  <dt><span class="key key-dashed"></span></dt><dd>conditional: under an if, a loop that may not run, after an early return, an alt</dd>
  <dt><span class="key key-dotted"></span></dt><dd>unknown: through code that cannot be followed</dd>
  <dt><span class="key key-junction"></span></dt><dd>a shared side: several writers or readers</dd>
  <dt><span class="key key-barrier"></span></dt><dd>a barrier and the processes enrolled on it</dd>
  <dt><span class="key key-unenrolled"></span></dt><dd>a sync by a process not enrolled on the barrier</dd>
  <dt><span class="key key-port"></span></dt><dd>a parameter: the caller is on the other side</dd>
  <dt><span class="key key-stub">no writer</span></dt><dd>no partner drawn here (red: the checker proved there is none)</dd>
  <dt><span class="key key-stuck"></span></dt><dd>stuck for good: what it waits for can never come (red); stopped by a runtime error</dd>
  <dt><span class="key key-behind"></span></dt><dd>stuck behind another stuck process, or left waiting by a run that repeats forever (it could go on; this run never lets it)</dd>
  <dt><span class="key key-limit"></span></dt><dd>a value outside the modelled integers: where the model stops following the run, not an error of the program</dd>
  <dt><span class="key key-running"></span></dt><dd>still running when the run ends, or taking part in the steps that repeat</dd>
  <dt><span class="key key-marker"></span></dt><dd>an operation that never completes, and why (click the reason to replay to its partner)</dd>
  <dt><span class="key key-done"></span></dt><dd>finished</dd>
  <dt><span class="key key-cycle"></span></dt><dd>a circular wait</dd>
  <dt><span class="key key-loop"></span></dt><dd>steps that repeat forever (a divergence)</dd>
</dl>
<p>An arrow on the border of a box with several processes inside means every one of them uses that channel.</p>`;

/** Dark values of the network's and the sequence chart's custom properties. */
const DARK_NETWORK: Readonly<Record<string, string>> = Object.freeze({
  bg: '#12161c', text: '#e6e9ef', muted: '#98a2b3', faint: '#5b6573', 'process-fill': '#1a1f27', 'process-stroke': '#4b5563', shadow: 'rgba(0, 0, 0, 0.35)',
  'root-fill': 'rgba(255, 255, 255, 0.02)', 'root-stroke': '#334155', 'par-fill': 'rgba(129, 140, 248, 0.08)', 'par-stroke': '#4f5bd5', 'call-fill': 'rgba(56, 189, 248, 0.07)', 'call-stroke': '#1f6f93',
  'rep-fill': 'rgba(52, 211, 153, 0.07)', 'rep-stroke': '#1f7a5c', count: '#6ee7b7', 'badge-fill': 'rgba(129, 140, 248, 0.18)', 'badge-text': '#b4bfff', 'call-badge-fill': 'rgba(56, 189, 248, 0.16)', 'call-badge-text': '#8bd8ff',
  edge: '#94a3b8', 'label-fill': '#1a1f27', 'label-stroke': '#334155', barrier: '#f59e0b', 'barrier-fill': 'rgba(245, 158, 11, 0.12)', 'port-fill': '#1f2630',
  // Pill and badge fills are opaque: an arrow or a border under a translucent one would cross its text.
  danger: '#f87171', 'danger-strong': '#b91c1c', 'danger-fill': '#322328', 'danger-soft': 'rgba(248, 113, 113, 0.32)', ok: '#4ade80', 'ok-fill': '#192e28', warn: '#fbbf24', 'warn-fill': '#2e2a1d', info: '#7aa7ff',
  loop: '#a78bfa', 'loop-strong': '#6d28d9', 'loop-fill': '#27263b', veil: 'rgba(18, 22, 28, 0.62)',
  'msc-bg': '#12161c', 'msc-text': '#e6e9ef', 'msc-muted': '#98a2b3', 'msc-faint': '#3a4350', 'msc-line': '#4b5563', 'msc-arrow': '#cbd5e1', 'msc-head': '#1b2029', 'msc-barrier': '#f59e0b', 'msc-danger': '#f87171', 'msc-wait': '#fbbf24', 'msc-ok': '#4ade80', 'msc-current': 'rgba(122, 167, 255, 0.14)', 'msc-loop': '#a78bfa',
});

const LIGHT_PAGE = `--bg: #f4f5f7; --surface: #ffffff; --surface-2: #f8fafc; --border: #e2e8f0; --border-strong: #cbd5e1;
  --text: #0f172a; --muted: #64748b; --accent: #2563eb; --accent-soft: rgba(37, 99, 235, 0.1); --accent-strong: #2563eb;
  --danger: #dc2626; --danger-strong: #dc2626; --danger-soft: #fef2f2; --ok: #15803d; --ok-soft: #f0fdf4; --warn: #b45309; --warn-soft: #fffbeb;
  --info: #2563eb; --loop: #7c3aed; --canvas: #ffffff; --code-bg: #ffffff; --code-hl: rgba(37, 99, 235, 0.08);
  --token-fill: #0f172a; --token-text: #ffffff; --token-hidden: #64748b;`;

const DARK_PAGE = `--bg: #0e1116; --surface: #161a21; --surface-2: #1b2029; --border: #262c36; --border-strong: #353d4a;
  --text: #e6e9ef; --muted: #98a2b3; --accent: #7aa7ff; --accent-soft: rgba(122, 167, 255, 0.14); --accent-strong: #2563eb;
  --danger: #f87171; --danger-strong: #b91c1c; --danger-soft: rgba(248, 113, 113, 0.12); --ok: #4ade80; --ok-soft: rgba(74, 222, 128, 0.1); --warn: #fbbf24; --warn-soft: rgba(251, 191, 36, 0.1);
  --info: #7aa7ff; --loop: #a78bfa; --canvas: #12161c; --code-bg: #12161c; --code-hl: rgba(122, 167, 255, 0.1);
  --token-fill: #f8fafc; --token-text: #0f172a; --token-hidden: #475569;`;

/** VS Code's own colours for the page chrome, over either palette. */
const VSCODE_PAGE = `--bg: var(--vscode-sideBar-background, var(--vscode-editor-background)); --surface: var(--vscode-editor-background); --surface-2: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  --border: var(--vscode-panel-border, var(--vscode-widget-border, #8884)); --border-strong: var(--vscode-focusBorder);
  --text: var(--vscode-foreground); --muted: var(--vscode-descriptionForeground); --accent: var(--vscode-focusBorder, #2563eb);
  --canvas: var(--vscode-editor-background); --code-bg: var(--vscode-editor-background);
  --font: var(--vscode-font-family); --mono: var(--vscode-editor-font-family, ui-monospace, Menlo, monospace);`;

const PAGE_CSS = `
:root {
  color-scheme: light dark;
  ${LIGHT_PAGE}
  --font: system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${DARK_PAGE} } }
:root[data-theme="dark"] { ${DARK_PAGE} }
/* Inside VS Code, the editor's theme decides, whatever the system says. */
body.vscode-light, body.vscode-high-contrast-light { ${LIGHT_PAGE} ${VSCODE_PAGE} }
body.vscode-dark, body.vscode-high-contrast { ${DARK_PAGE} ${VSCODE_PAGE} }
/* The network's own colours: light values are the stylesheet's fallbacks. */
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) .pj-net, :root:not([data-theme="light"]) .pj-msc { ${networkColors('dark')} } }
:root[data-theme="dark"] .pj-net, :root[data-theme="dark"] .pj-msc { ${networkColors('dark')} }
:root body.vscode-dark .pj-net, :root body.vscode-dark .pj-msc, :root body.vscode-high-contrast .pj-net, :root body.vscode-high-contrast .pj-msc { ${networkColors('dark')} --pj-bg: var(--vscode-editor-background); --pj-msc-bg: var(--vscode-editor-background); }
:root body.vscode-light .pj-net, :root body.vscode-light .pj-msc, :root body.vscode-high-contrast-light .pj-net, :root body.vscode-high-contrast-light .pj-msc { ${networkColors('light')} --pj-bg: var(--vscode-editor-background); --pj-msc-bg: var(--vscode-editor-background); }

* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); font: 13px/1.45 var(--font); overflow: hidden; }
#app { display: grid; grid-template-rows: auto auto 1fr auto; grid-template-columns: minmax(0, 1fr); height: 100vh; }
button, select, input { font: inherit; color: inherit; }
button { cursor: pointer; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.muted { color: var(--muted); }

.toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 16px; padding: 8px 14px; background: var(--surface); border-bottom: 1px solid var(--border); }
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.brand strong { font-family: var(--mono); font-size: 13.5px; white-space: nowrap; }
.live-state { display: none; width: 8px; height: 8px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); }
[data-mode="live"] .live-state { display: inline-block; }
.live-state.offline { background: var(--muted); box-shadow: none; }
select, input[type="search"] { background: var(--surface-2); border: 1px solid var(--border); border-radius: 7px; padding: 5px 9px; }
#view-select { max-width: 340px; font-family: var(--mono); font-size: 12.5px; }
.search { display: flex; align-items: center; gap: 8px; flex: 1 1 260px; min-width: 200px; }
.search input { width: 100%; max-width: 380px; }
.tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tools button, .transport button, .tabs button { background: var(--surface-2); border: 1px solid var(--border); border-radius: 7px; padding: 4px 10px; }
.tools button:hover, .transport button:hover, .tabs button:hover { border-color: var(--border-strong); }
.zoom { display: inline-flex; }
.zoom button { border-radius: 0; margin-left: -1px; min-width: 32px; }
.zoom button:first-child { border-radius: 7px 0 0 7px; margin-left: 0; }
.zoom button:last-child { border-radius: 0 7px 7px 0; }
#zoom-reset { min-width: 58px; font-variant-numeric: tabular-nums; }
.toggle { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); user-select: none; }
.export { position: relative; }
.menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; display: grid; min-width: 210px; padding: 4px; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 9px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18); }
.menu button { text-align: left; border: 0; background: none; padding: 7px 10px; border-radius: 6px; }
.menu button:hover, .menu button:focus-visible { background: var(--accent-soft); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.verdicts { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; padding: 7px 14px; background: var(--surface); border-bottom: 1px solid var(--border); min-height: 41px; }
.verdict-empty { color: var(--muted); }
.chip { display: inline-flex; align-items: baseline; gap: 7px; padding: 4px 11px 4px 9px; border-radius: 999px; border: 1px solid var(--border-strong); background: var(--surface-2); font-size: 12.5px; max-width: 100%; }
.chip-icon { font-weight: 700; }
.chip-label { font-weight: 600; }
.chip-by { color: var(--muted); font-size: 11.5px; }
.chip.failed.sev-error { border-color: var(--danger); background: var(--danger-soft); }
.chip.failed.sev-error .chip-icon, .chip.failed.sev-error .chip-text { color: var(--danger); }
.chip.failed.sev-warning { border-color: var(--warn); background: var(--warn-soft); }
.chip.failed.sev-warning .chip-icon, .chip.failed.sev-warning .chip-text { color: var(--warn); }
.chip.failed.sev-info { border-color: var(--info); }
.chip.failed.sev-info .chip-icon { color: var(--info); }
.chip.passed { border-color: var(--ok); background: var(--ok-soft); }
.chip.passed .chip-icon, .chip.passed .chip-text { color: var(--ok); }
/* Holds in the model, with what it does not cover: amber. */
.chip.passed.limited { border-color: var(--warn); background: var(--warn-soft); }
.chip.passed.limited .chip-icon, .chip.passed.limited .chip-text { color: var(--warn); }
/* A run that relies on what the model abstracts: a dashed amber ring. */
.chip.caveated { outline: 1.5px dashed var(--warn); outline-offset: 1px; }
.chip.error, .chip.timeout, .chip.cancelled, .chip.skipped { border-style: dashed; }
.chip.stale { opacity: 0.7; }
.chip.active { box-shadow: 0 0 0 2px var(--accent); }
.chip.fresh { animation: pj-chip-pulse 1.2s ease-in-out 3; }
@keyframes pj-chip-pulse { 50% { box-shadow: 0 0 0 5px var(--accent-soft), 0 0 0 2px var(--accent); } }

main { display: grid; grid-template-columns: minmax(0, 1fr) 340px; min-height: 0; }
#stage { position: relative; overflow: hidden; background: var(--canvas); cursor: grab; touch-action: none; outline: none; }
#stage.dragging { cursor: grabbing; }
#canvas { display: block; width: 100%; height: 100%; user-select: none; }
#panel { overflow: auto; background: var(--surface); border-left: 1px solid var(--border); }
#panel-body { padding: 4px 16px 24px; }
.panel-section h2 { margin: 18px 0 8px; font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); font-weight: 650; }
.panel-section p { margin: 6px 0; }
.panel-section ul { margin: 6px 0; padding-left: 18px; }
.panel-section li { margin: 4px 0; }
.facts { display: grid; grid-template-columns: 96px 1fr; gap: 4px 10px; margin: 0; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; overflow-wrap: anywhere; }
.link { background: none; border: 0; padding: 0; color: var(--accent); text-decoration: underline; text-underline-offset: 2px; font-family: var(--mono); font-size: 12.5px; }
.ops { margin-top: 2px; }
.op { font-size: 12px; }
.op-conditional .link { text-decoration-style: dashed; }
.story p { margin: 7px 0; padding-left: 10px; border-left: 3px solid var(--danger); }
.story.sev-warning p { border-left-color: var(--warn); }
.story.sev-info p { border-left-color: var(--info); }
.verdict-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
.verdict-head.failed .verdict-status { color: var(--danger); font-weight: 650; }
.verdict-head.failed.sev-warning .verdict-status { color: var(--warn); }
.verdict-head.failed.sev-info .verdict-status { color: var(--info); }
.verdict-head.passed .verdict-status { color: var(--ok); font-weight: 650; }
.verdict-head.passed.limited .verdict-status { color: var(--warn); }
.panel-section.caveats { margin: 10px -6px 0; padding: 0 6px 6px; border-radius: 8px; background: var(--warn-soft); border: 1px solid var(--warn); }
.panel-section.caveats h2 { color: var(--warn); }
.warn { color: var(--warn); }
details summary { cursor: pointer; color: var(--muted); }
pre.assertion { white-space: pre-wrap; font-family: var(--mono); font-size: 12px; background: var(--surface-2); padding: 8px; border-radius: 6px; }

#minimap { position: absolute; right: 14px; bottom: 14px; width: 190px; height: 128px; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 9px; box-shadow: 0 6px 18px rgba(0, 0, 0, 0.12); overflow: hidden; cursor: pointer; }
#minimap-svg { width: 100%; height: 100%; pointer-events: none; }
#minimap-frame { fill: var(--accent-soft); stroke: var(--accent); stroke-width: 6; vector-effect: non-scaling-stroke; }
#minimap-svg .pj-edge-label-wrap, #minimap-svg .pj-label, #minimap-svg .pj-detail { display: none; }
.legend { position: absolute; left: 14px; bottom: 14px; max-width: 360px; max-height: calc(100% - 28px); overflow: auto; padding: 6px 14px 10px; background: var(--surface); border: 1px solid var(--border-strong); border-radius: 10px; box-shadow: 0 10px 30px rgba(0, 0, 0, 0.16); font-size: 12px; z-index: 6; }
.legend h2 { font-size: 12px; margin: 8px 0; }
.legend dl { display: grid; grid-template-columns: 58px 1fr; gap: 6px 8px; margin: 0; align-items: center; }
.legend dd { margin: 0; }
.legend p { color: var(--muted); margin: 8px 0 0; }
.key { display: inline-block; width: 32px; height: 14px; vertical-align: middle; }
.key-process { border: 1.5px solid var(--muted); border-radius: 4px; }
.key-par { border: 1.5px dashed #a5b4fc; border-radius: 4px; background: rgba(99, 102, 241, 0.06); }
.key-stack { border: 1.5px solid var(--muted); border-radius: 4px; box-shadow: 3px 3px 0 -1px var(--canvas), 3px 3px 0 0 var(--muted); }
.key-arrow { height: 2px; background: var(--muted); position: relative; }
.key-dashed { height: 0; border-top: 2px dashed var(--muted); }
.key-dotted { height: 0; border-top: 2px dotted var(--muted); }
.key-junction { width: 12px; height: 12px; border-radius: 50%; background: var(--muted); }
.key-barrier { border: 1.5px solid #b45309; border-radius: 8px; background: rgba(245, 158, 11, 0.12); }
.key-stuck { border: 2px solid var(--danger); border-radius: 4px; box-shadow: 0 0 0 3px var(--danger-soft); }
.key-marker { width: 14px; height: 14px; border-radius: 50%; background: var(--danger); }
.key-cycle { height: 0; border-top: 3px dashed var(--danger); }
.key-own { width: auto; height: auto; padding: 0 5px; border: 1.2px dashed var(--muted); border-radius: 7px; font-size: 10px; color: var(--muted); white-space: nowrap; }
.key-unenrolled { height: 0; border-top: 2px dotted var(--warn); }
.key-port { width: 26px; border: 1.5px solid var(--muted); border-radius: 4px 0 0 4px; clip-path: polygon(0 0, 78% 0, 100% 50%, 78% 100%, 0 100%); }
.key-stub { width: auto; height: auto; padding: 0 6px; border: 1.2px dashed var(--muted); border-radius: 8px; font-size: 10px; color: var(--muted); white-space: nowrap; }
.key-behind { border: 2px solid var(--warn); border-radius: 4px; }
.key-limit { border: 2px solid var(--warn); border-radius: 4px; background: var(--warn-soft); }
.key-running { border: 2px solid var(--info); border-radius: 4px; }
.key-done { border: 1.5px solid var(--muted); border-radius: 4px; opacity: 0.38; }
.key-loop { height: 0; border-top: 3px dashed var(--loop); }
.key-arrow::after { content: ''; position: absolute; right: -2px; top: -4px; border-left: 7px solid var(--muted); border-top: 5px solid transparent; border-bottom: 5px solid transparent; }
.banners { position: absolute; left: 50%; top: 12px; transform: translateX(-50%); display: grid; gap: 6px; justify-items: center; width: max-content; max-width: min(720px, calc(100% - 32px)); pointer-events: none; z-index: 4; }
/* Over the surface colour, so the network never shows through the (translucent, in the dark) warn colour. */
.banner { padding: 6px 14px; border-radius: 8px; background: linear-gradient(var(--warn-soft), var(--warn-soft)), var(--surface); color: var(--warn); border: 1px solid var(--warn); font-size: 12.5px; font-weight: 600; text-align: center; }
.toast { position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%); padding: 7px 14px; border-radius: 8px; background: var(--text); color: var(--surface); opacity: 0; pointer-events: none; transition: opacity 0.2s; font-size: 12.5px; z-index: 5; }
.toast.visible { opacity: 0.94; }
.stage-message { position: absolute; inset: 40% 15% auto; text-align: center; color: var(--muted); font-size: 14px; }

#dock { position: relative; display: grid; grid-template-rows: auto auto 1fr; height: var(--dock-height, 34vh); min-height: 120px; max-height: 45vh; background: var(--surface); border-top: 1px solid var(--border-strong); }
#dock.collapsed { height: auto; min-height: 0; grid-template-rows: auto auto; }
#dock.collapsed .dock-body { display: none; }
.dock-resize { position: absolute; left: 0; right: 0; top: -4px; height: 8px; cursor: ns-resize; z-index: 5; }
.dock-resize:hover, .dock-resize:focus-visible { background: var(--accent-soft); outline: none; }
#dock-collapse { min-width: 30px; }
#dock.collapsed #dock-collapse { transform: rotate(180deg); }
#details-button { display: none; }
.dock-head { display: flex; align-items: center; gap: 12px; padding: 6px 12px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.transport { display: inline-flex; gap: 4px; align-items: center; }
.transport[hidden] { display: none; }
.transport button { min-width: 34px; padding: 3px 8px; }
#play { min-width: 40px; font-weight: 700; color: var(--accent); }
.step-text { flex: 1 1 300px; min-width: 0; font-size: 12.5px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; cursor: pointer; }
.step-text.expanded { display: block; -webkit-line-clamp: unset; }
.step-text .warn { font-weight: 600; }
.step-text code.event { margin-left: 8px; font-family: var(--mono); font-size: 11.5px; color: var(--muted); }
.tabs { display: inline-flex; gap: 4px; }
.tabs button.active { border-color: var(--accent); color: var(--accent); }
.tabs button[hidden] { display: none; }
.timeline { overflow-x: auto; padding: 6px 12px; border-bottom: 1px solid var(--border); }
.timeline:empty { display: none; }
.ticks { display: flex; gap: 3px; align-items: center; min-height: 28px; }
.tick { flex: 0 0 auto; min-width: 26px; height: 24px; padding: 0 6px; border-radius: 6px; border: 1px solid var(--border-strong); background: var(--surface-2); font-size: 11px; font-variant-numeric: tabular-nums; }
.tick.start { min-width: 14px; width: 14px; padding: 0; border-radius: 50%; height: 14px; }
.tick.hidden { opacity: 0.5; border-style: dashed; }
.tick.barrier { border-color: #b45309; }
.tick.termination { border-color: var(--ok); }
.tick.error { border-color: var(--warn); }
.tick.in-loop { border-color: #7c3aed; background: rgba(124, 58, 237, 0.08); }
.tick.final { border-color: var(--danger); color: var(--danger); font-weight: 650; }
.tick.final.passed { border-color: var(--ok); color: var(--ok); }
.tick.final.kind-divergence { border-color: var(--loop); color: var(--loop); }
.tick.final.kind-divergence.current { background: var(--loop); border-color: var(--loop); color: #fff; }
.tick.current { background: var(--accent-strong); border-color: var(--accent-strong); color: #fff; }
.tick.final.current { background: var(--danger-strong); border-color: var(--danger-strong); color: #fff; }
.tick.final.sev-warning { border-color: var(--warn); color: var(--warn); }
.tick.final.sev-warning.current { background: var(--warn); border-color: var(--warn); color: var(--surface); }
/* A result that only informs (a server that does not terminate, a choice) ends in its own colour, not in red. */
.tick.final.sev-info { border-color: var(--info); color: var(--info); }
.tick.final.sev-info.current { background: var(--info); border-color: var(--info); color: var(--surface); }
.tick.assumed { box-shadow: inset 0 -3px 0 var(--warn); }
/* How it locked: after the trace, in the result's red, dashed until shown. */
.tick-phase { flex: 0 0 auto; margin: 0 4px 0 8px; padding-left: 10px; border-left: 2px solid var(--danger); color: var(--danger); font-size: 11px; font-weight: 650; white-space: nowrap; }
.tick.formation { border-style: dashed; border-color: var(--danger); color: var(--danger); background: var(--danger-soft); font-weight: 600; }
.tick.formation.fm-cycle, .tick.formation.fm-dead-end { border-style: solid; }
.tick.formation.current { background: var(--danger-strong); border-color: var(--danger-strong); color: #fff; }
.step-text .formation-head { color: var(--danger); }
/* Over the surface colour, like the other banners, in the result's red. */
.banner.formation-banner { background: linear-gradient(var(--danger-soft), var(--danger-soft)), var(--surface); color: var(--danger); border-color: var(--danger); }
.dock-body { min-height: 0; overflow: hidden; display: grid; }
.code { overflow: auto; background: var(--code-bg); font: 12.5px/1.6 var(--mono); padding: 4px 0 12px; }
.code-line { display: flex; gap: 0; white-space: pre; cursor: pointer; padding-right: 12px; border-left: 3px solid transparent; }
.code-line:hover { background: var(--code-hl); }
.gutter { flex: 0 0 4.5ch; text-align: right; padding-right: 1.4ch; color: var(--muted); user-select: none; }
.code-text { flex: 0 0 auto; }
.code-line.mark.step { --mark: var(--accent); border-left-color: var(--mark); background: color-mix(in srgb, var(--mark) 12%, transparent); }
.code-line.mark.stuck { border-left-color: var(--danger); background: var(--danger-soft); }
.code-line.mark.warning, .code-line.mark.behind { border-left-color: var(--warn); background: var(--warn-soft); }
.code-line.mark.assumed { border-left-color: var(--warn); border-left-style: dashed; }
.code-line.mark.choice { border-left-color: var(--info); background: var(--accent-soft); }
.code-line.mark.done { border-left-color: var(--ok); }
.code-line.mark.now { border-left-width: 6px; box-shadow: inset 0 0 0 1px var(--danger); }
.code-line.mark.loop { border-left-color: var(--loop); }
.lens.loop { color: var(--loop); font-style: normal; }
.code-line.pulse { animation: pj-line-pulse 0.9s ease-out; }
@keyframes pj-line-pulse { from { background: var(--accent-soft); } to { background: transparent; } }
.lens { margin-left: 3ch; font-family: var(--font); font-size: 12px; font-style: italic; white-space: nowrap; }
.lens.stuck { color: var(--danger); font-weight: 600; font-style: normal; }
.lens.stuck::before { content: '◀ '; }
.lens.warning, .lens.behind { color: var(--warn); font-weight: 600; font-style: normal; }
.lens.warning::before, .lens.behind::before { content: '◀ '; }
.lens.assumed { color: var(--warn); }
.lens.choice { color: var(--info); font-weight: 600; font-style: normal; }
.lens.choice::before { content: '◀ '; }
.lens.done { color: var(--ok); }
.lens.step { color: var(--muted); }
.chart { overflow: auto; padding: 0 12px 8px; background: var(--code-bg); }
.chart-head { position: sticky; top: 0; z-index: 2; }
.chart-head svg { display: block; }
.chart svg { display: block; }
.chart [data-step] { cursor: pointer; }
.chip-target { font-size: 11.5px; padding: 0 6px; border-radius: 6px; background: var(--accent-soft); color: var(--accent); font-weight: 600; }
button.action { margin-top: 4px; background: var(--surface-2); border: 1px solid var(--accent); color: var(--accent); border-radius: 7px; padding: 4px 12px; font-weight: 600; }
button.action:hover { background: var(--accent-soft); }

/* The state machine tab: the diagram, and the run's states beside it. */
.machine { overflow: hidden; display: grid; grid-template-rows: auto 1fr; background: var(--code-bg); min-height: 0; }
.machine-message { padding: 10px 14px; }
.machine-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; padding: 6px 12px; border-bottom: 1px solid var(--border); }
.machine-head strong { font-family: var(--mono); font-size: 12.5px; }
.machine-tools { margin-left: auto; display: inline-flex; gap: 6px; }
.machine-tools button, .machine-tools select { background: var(--surface-2); border: 1px solid var(--border); border-radius: 7px; padding: 2px 9px; font-size: 12px; }
.machine-main { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, 300px); min-height: 0; }
.machine-body { overflow: auto; padding: 8px 12px; min-height: 0; }
.machine-body.fit { display: flex; align-items: flex-start; justify-content: center; }
.machine-body.fit svg { width: 100%; height: 100%; max-height: 100%; }
.machine-body svg { display: block; }
.pj-sm-state[data-state] { cursor: pointer; }
.pj-sm-edge-label.pj-sm-call[role="button"] { cursor: pointer; }
.machine-side { overflow: auto; padding: 8px 12px 12px; border-left: 1px solid var(--border); font-size: 12px; }
.machine-side-head { margin: 2px 0 8px; }
.machine-side-head .caps { font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); font-weight: 650; }
.machine-who { font-family: var(--mono); font-size: 12px; font-weight: 600; margin-top: 2px; overflow-wrap: anywhere; }
/* A state machine needs more height than the code: the dock grows while it is shown (unless resized). */
#dock.machine-open:not(.collapsed) { height: var(--dock-height, 46vh); max-height: 60vh; }
.machine-trail { margin: 0; padding-left: 22px; }
.machine-trail li { margin: 0 0 6px; cursor: pointer; color: var(--muted); }
.machine-trail li.reached { color: var(--text); }
.machine-trail li.current { color: var(--text); font-weight: 600; }
.machine-trail li.current::marker { color: var(--danger); }
.machine-trail li.elsewhere { font-style: italic; }
.machine-trail code { display: block; font-family: var(--mono); font-size: 11px; color: var(--muted); font-weight: 400; overflow-wrap: anywhere; }
.trail-when { font-variant-numeric: tabular-nums; color: var(--muted); }
.machine-key { margin-top: 10px; font-size: 11.5px; }
@media (max-width: 900px) { .machine-main { grid-template-columns: 1fr; } .machine-side { border-left: 0; border-top: 1px solid var(--border); max-height: 40%; } }

/* The network in the page: hover, selection, search, the timeline cursor. */
.pj-node { cursor: pointer; }
.pj-node:focus { outline: none; }
.pj-node:focus-visible .pj-box, .pj-node:focus-visible .pj-group-box { stroke: var(--accent); stroke-width: 2.4; }
.pj-selected .pj-box, .pj-selected .pj-group-box, .pj-selected .pj-port-box, .pj-selected .pj-barrier-box, .pj-selected .pj-stub-box { stroke: var(--accent); stroke-width: 2.6; }
.pj-edge.pj-selected .pj-edge-line { stroke: var(--accent); stroke-width: 2.8; }
.pj-edge { cursor: pointer; }
.pj-edge .pj-edge-line { transition: opacity 0.15s; }
.pj-hovering .pj-edge:not(.pj-hl), .pj-hovering .pj-process:not(.pj-hl), .pj-hovering .pj-junction-node:not(.pj-hl), .pj-hovering .pj-barrier:not(.pj-hl), .pj-hovering .pj-port:not(.pj-hl), .pj-hovering .pj-stub:not(.pj-hl), .pj-hovering .pj-edge-label-wrap:not(.pj-hl) { opacity: 0.22; }
/* The result's marks follow the hover too. */
.pj-hovering .pj-ov-dim { opacity: 0.22; }
/* Selection and search outlines sit above the result. */
.pj-mark-selected { fill: none; stroke: var(--accent); stroke-width: 2.6; pointer-events: none; }
.pj-mark-match { fill: none; stroke: #f59e0b; stroke-width: 2.6; pointer-events: none; }
/* A result about an older version of the buffer: faded, no motion. */
.pj-stale-overlay .pj-overlay-under, .pj-stale-overlay .pj-overlay-over { filter: grayscale(0.7); }
.pj-hovering .pj-edge.pj-hl .pj-edge-line { stroke-width: 2.4; }
.pj-searching .pj-process:not(.pj-match), .pj-searching .pj-junction-node:not(.pj-match), .pj-searching .pj-port:not(.pj-match), .pj-searching .pj-barrier:not(.pj-match) { opacity: 0.35; }
.pj-match .pj-box, .pj-match .pj-group-box { stroke: #f59e0b; stroke-width: 2.6; }
.pj-edge.pj-match .pj-edge-line { stroke: #f59e0b; stroke-width: 2.6; }
.pj-hide-labels .pj-edge-label-wrap { display: none; }
.pj-hide-types .pj-type { display: none; }
.pj-hide-types .pj-port-edge-label { display: none; }
.pj-hide-conditional .pj-edge-conditional, .pj-hide-conditional .pj-edge-unknown { display: none; }
.pj-done { opacity: 0.38; }
.pj-current .pj-box, .pj-current .pj-group-box { stroke: var(--accent); stroke-width: 2.4; }
.pj-edge.pj-current .pj-edge-line { stroke: var(--accent); stroke-width: 2.6; }
.pj-flash .pj-box, .pj-flash .pj-group-box { animation: pj-flash 0.9s ease-out; }
@keyframes pj-flash { 0% { stroke-width: 6; stroke: var(--accent); } 100% { stroke-width: 2.4; } }
.pj-line-chip rect { opacity: 0.95; }
.pj-line-chip text { font: 700 10.5px var(--mono); fill: #fff; }
/* The value a step carries: the inverse of the canvas, readable in either theme. */
.pj-token text { font: 700 10.5px var(--mono); fill: var(--token-text); }
.pj-token rect { fill: var(--token-fill); opacity: 0.95; }
.pj-token-hidden rect { fill: var(--token-hidden); }
.pj-token-hidden text { fill: #fff; }
/* How it locked: the boxes a step is about, the arrows it adds, and whom they wait for. */
.pj-now-ring { fill: none; stroke: var(--pj-danger, #dc2626); stroke-width: 3; pointer-events: none; }
.pj-now-ring.pj-now-animate { animation: pj-now 1s ease-out; }
@keyframes pj-now { from { stroke-width: 12; stroke-opacity: 0.25; } to { stroke-width: 3; stroke-opacity: 1; } }
.pj-partner-ring { fill: none; stroke: var(--pj-danger, #dc2626); stroke-width: 1.8; stroke-dasharray: 6 4; opacity: 0.8; pointer-events: none; }
.pj-now-edge { fill: none; stroke: var(--pj-danger, #dc2626); stroke-width: 5; stroke-linecap: round; stroke-linejoin: round; opacity: 0.75; pointer-events: none; }
.pj-now-edge.pj-now-cycle { stroke-width: 7; opacity: 0.6; }
@media (prefers-reduced-motion: reduce) { .pj-flash .pj-box, .pj-flash .pj-group-box, .code-line.pulse, .pj-now-ring { animation: none; } * { scroll-behavior: auto !important; } }
/* Narrow (a VS Code panel beside the editor, half a screen): the network keeps the room, details open as a drawer. */
@media (max-width: 900px) {
  main { grid-template-columns: minmax(0, 1fr); position: relative; }
  #panel { display: none; position: absolute; top: 0; right: 0; bottom: 0; width: min(340px, 88vw); z-index: 30; border-left: 1px solid var(--border-strong); box-shadow: -12px 0 30px rgba(0, 0, 0, 0.18); }
  body.panel-open #panel { display: block; }
  #details-button { display: inline-block; }
  body.panel-open #details-button { border-color: var(--accent); color: var(--accent); }
  #dock { height: var(--dock-height, 28vh); }
  #minimap { width: 132px; height: 88px; right: 10px; bottom: 10px; }
  .search { flex-basis: 160px; min-width: 140px; }
  /* One row of chips that scrolls, rather than a stack that eats the network's height. */
  .verdicts { flex-wrap: nowrap; overflow-x: auto; }
  .chip { flex: 0 0 auto; }
}
@media (max-height: 640px) { #dock { height: var(--dock-height, 30vh); } }
`;

/** Every network and sequence-chart custom property for one theme. */
function networkColors(theme: 'light' | 'dark'): string {
  const colors: Record<string, string> = theme === 'light'
    ? { ...LIGHT_THEME, ...Object.fromEntries(Object.entries(MSC_COLORS).map(([name, value]) => [`msc-${name}`, value])) }
    : DARK_NETWORK;
  return Object.entries(colors).map(([name, value]) => `--pj-${name}: ${value};`).join(' ');
}

