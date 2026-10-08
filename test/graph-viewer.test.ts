import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { explain, stateMachines, translateProgram } from '../src/csp/index';
import { loadProgram } from '../src/csp/load';
import { pathKey } from '../src/graph/overlay';
import { buildViewerPayload } from '../src/graph/payload';
import { renderViewerHtml } from '../src/graph/render-html';
import { buildViewerMachine, layoutMachine, machineRequestKey, refOfMachine } from '../src/graph/render-machine';
import type { VerificationReport } from '../src/verification';
import { recordedRun } from './fdr-recordings';
import { analyzeFile, analyzeSource, FIXTURES, ROOT } from './graph-helpers';

/** A headless Chrome or Chromium on this machine (CHROME_PATH first); the page tests are skipped without one. */
function findChrome(): string | undefined {
  const candidates = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((candidate) => !!candidate && fs.existsSync(candidate));
}

const CHROME = findChrome();
const SKIP = CHROME ? false : 'no Chrome or Chromium on this machine (set CHROME_PATH)';
const NONCE = 'viewerTestNonce0123456789';
const VERIFICATION = path.join(ROOT, 'test', 'fixtures', 'verification');
const FIXTURE_URI = 'file:///fixtures/verification/commstime_bounded.pj';

/**
 * Load a viewer page in headless Chrome with a harness script after the
 * viewer's own (it carries the page's nonce, so the page's CSP lets it run), and
 * return the `data-*` attributes it leaves on <html>.
 */
async function load(html: string, harness: string): Promise<Record<string, string>> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'processj-viewer-'));
  try {
    const page = path.join(dir, 'page.html');
    const script = `<script nonce="${NONCE}">"use strict";try{const r={};${harness};document.documentElement.dataset.result=JSON.stringify(r);}catch(e){document.documentElement.dataset.harnessError=String(e&&e.stack||e);}</script>`;
    fs.writeFileSync(page, html.replace('</body>', `${script}</body>`));
    // Incognito: the page remembers its tab and toggles in localStorage, and a headless
    // Chrome flushing that to a fresh profile does not exit after --dump-dom.
    const chrome = spawn(CHROME!, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--incognito', `--user-data-dir=${path.join(dir, 'profile')}`, '--window-size=1400,900', '--dump-dom', pathToFileURL(page).toString()], { stdio: ['ignore', 'pipe', 'ignore'] });
    const dom = await new Promise<string>((resolve) => {
      let text = '';
      const timer = setTimeout(() => chrome.kill('SIGKILL'), 60_000);
      chrome.stdout.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8');
        if (text.includes('</html>')) chrome.kill('SIGKILL');
      });
      chrome.on('close', () => {
        clearTimeout(timer);
        resolve(text);
      });
    });
    const tag = /<html([^>]*)>/.exec(dom)?.[1] ?? '';
    const decode = (value: string): string => value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    return Object.fromEntries([...tag.matchAll(/data-([\w-]+)="([^"]*)"/g)].map((match) => [match[1], decode(match[2])]));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the viewer replays every step, then the end state, and exports what is on screen', { skip: SKIP }, async () => {
  const analyzed = analyzeFile(path.join(VERIFICATION, 'commstime_bounded.pj'), FIXTURE_URI);
  const report = JSON.parse(fs.readFileSync(path.join(VERIFICATION, 'commstime_bounded.fdr.json'), 'utf8')) as VerificationReport;
  const payload = await buildViewerPayload({ model: analyzed.model, reports: [report], source: { uri: FIXTURE_URI, text: analyzed.text }, documentVersion: 1 });
  const page = await load(renderViewerHtml(payload, { mode: 'file', nonce: NONCE }), `
    r.ready = document.documentElement.dataset.ready;
    r.opened = document.querySelector('.tick.current').textContent;
    document.querySelector('.tick[data-position="18"]').click();
    r.last = document.getElementById('step-text').textContent;
    r.lastRoute = document.querySelectorAll('#graph .pj-edge.pj-current').length;
    r.lastToken = document.querySelectorAll('#dynamic .pj-token').length;
    r.lastOverlay = document.querySelectorAll('.pj-overlay-over > *').length;
    document.getElementById('step-forward').click();
    r.end = document.querySelector('.tick.current').textContent;
    r.endOverlay = document.querySelectorAll('.pj-overlay-over .pj-ov-blocked').length;
    let saved = '';
    save = (name, data) => { saved = name + '\\n' + data; };
    document.getElementById('tab-chart').click();
    exportAs('chart');
    r.chartName = saved.split('\\n')[0];
    r.chartRows = (saved.match(/data-step="\\d+"/g) || []).length;
    r.chartNamespace = saved.includes('xmlns="http://www.w3.org/2000/svg"');
    r.chartSticky = saved.includes('pj-msc-sticky');
    exportAs('svg');
    r.svgVerdict = saved.includes('deadlock after 18 steps');
    r.svgStory = saved.includes('consume read its three values and finished');
    r.svgLegend = saved.includes('stuck behind another process');
  `);
  assert.equal(page['harness-error'], undefined);
  assert.equal(page.error, undefined, 'the page script threw');
  const result = JSON.parse(page.result) as Record<string, unknown>;
  assert.equal(result.ready, 'true');
  assert.equal(result.opened, 'stuck', 'a failure opens on its end state');
  // The last step is a position of its own: its arrow and value, without the end state drawn over them.
  assert.match(String(result.last), /^Step 18 of 18: /);
  assert.equal(result.lastRoute, 1);
  assert.equal(result.lastToken, 1);
  assert.equal(result.lastOverlay, 0);
  assert.equal(result.end, 'stuck');
  assert.ok(Number(result.endOverlay) > 0);
  // The sequence chart export is the chart (18 rows), not the copy of its lane heads.
  assert.equal(result.chartName, 'commstime_bounded.sequence.svg');
  assert.equal(result.chartRows, 18);
  assert.equal(result.chartNamespace, true);
  assert.equal(result.chartSticky, false);
  // The page's SVG carries the verdict, the account and a legend, like the server's.
  assert.deepEqual([result.svgVerdict, result.svgStory, result.svgLegend], [true, true, true]);
});

test('the viewer runs on a file with nothing to draw, and on views a saved file does not carry', { skip: SKIP }, async () => {
  const empty = analyzeSource('import std.io;\n', '/virtual/empty.pj');
  const emptyPage = await load(renderViewerHtml(await buildViewerPayload({ model: empty.model, source: { uri: empty.uri, text: empty.text } }), { mode: 'file', nonce: NONCE }), `
    r.ready = document.documentElement.dataset.ready;
    r.message = document.getElementById('stage-message').hidden ? '' : document.getElementById('stage-message').textContent;
    r.select = document.getElementById('view-select').disabled;
    exportAs('svg');
  `);
  assert.equal(emptyPage.error, undefined, 'the page script threw');
  assert.equal(emptyPage['harness-error'], undefined);
  const result = JSON.parse(emptyPage.result) as Record<string, unknown>;
  assert.equal(result.ready, 'true');
  assert.match(String(result.message), /no procedure with a body yet/);
  assert.equal(result.select, true);
  // One view laid out; the others are listed and say why they are not shown.
  const commstime = analyzeFile(path.join(FIXTURES, 'commstime.pj'));
  const payload = await buildViewerPayload({ model: commstime.model, source: { uri: commstime.uri, text: commstime.text }, budget: { views: 1, nodes: 1000 } });
  assert.ok(payload.views.filter((view) => view.pending).length >= 3);
  const pending = payload.views.find((view) => view.pending)!;
  const pendingPage = await load(renderViewerHtml(payload, { mode: 'file', nonce: NONCE }), `
    r.note = document.getElementById('panel-body').textContent;
    showView(${JSON.stringify(pending.id)});
    r.panel = document.getElementById('panel-body').textContent;
    r.zoom = document.getElementById('zoom-reset').textContent;
    r.dock = document.getElementById('dock').hidden;
  `);
  assert.equal(pendingPage.error, undefined, 'the page script threw');
  const shown = JSON.parse(pendingPage.result) as Record<string, unknown>;
  assert.match(String(shown.note), /procedure views are not included in this file/);
  assert.match(String(shown.panel), /not included in this file/);
  assert.equal(shown.zoom, '—');
  assert.equal(shown.dock, true);
});

test('the viewer opens on an editor\'s focus: the check, the stuck process selected, its state machine with FDR\'s states in order', { skip: SKIP }, async () => {
  const file = path.join(ROOT, 'examples', 'dining_philosophers.pj');
  const analyzed = analyzeFile(file);
  const loaded = loadProgram(file, path.join(ROOT, 'test', 'fixtures', 'include'));
  const model = translateProgram({ units: loaded.units, index: loaded.index });
  const report = explain(model, await recordedRun('dining_philosophers', model), { uri: analyzed.uri, documentVersion: 1 });
  const stuck = report.checks[0].counterexample!.final.find((snap) => snap.process.label.startsWith('philosopher(0'))!;
  const focus = { check: 'deadlock-free', process: pathKey(stuck.process.path) };
  const payload = await buildViewerPayload({ model: analyzed.model, reports: [report], source: { uri: analyzed.uri, text: analyzed.text }, documentVersion: 1, focus });
  // A file carries the state machines it may show: here the one the focus opens.
  const view = payload.views.find((entry) => entry.kind === 'program')!;
  const overlay = payload.overlays.find((entry) => entry.check === 'deadlock-free' && entry.view === view.id)!;
  const node = view.nodes.find((entry) => entry.id === overlay.processes.find((process) => process.key === focus.process)!.node)!;
  const machines = stateMachines(model);
  const machine = machines.find((entry) => refOfMachine(entry) === node.machine)!;
  const request = { target: 'program', ref: node.machine!, ...focus };
  payload.machines = { [machineRequestKey(request)]: buildViewerMachine({ request, machine, machines, layout: await layoutMachine(machine), model: 'the model FDR checked (the whole program)', trail: stuck.trail, process: { label: stuck.process.label, status: stuck.status, description: stuck.description, waits: (stuck.waits ?? []).map((wait) => wait.detail) } }) };
  const page = await load(renderViewerHtml(payload, { mode: 'file', nonce: NONCE }), `
    r.ready = document.documentElement.dataset.ready;
    r.chip = document.querySelector('.chip.active .chip-label').textContent;
    r.selected = selection && selection.id;
    r.tab = dockTab;
    r.orders = [...document.querySelectorAll('#machine .pj-sm-order text')].map((t) => t.textContent);
    r.stuck = [...document.querySelectorAll('#machine .pj-sm-stuck')].map((g) => g.dataset.state);
    r.callout = document.querySelector('#machine .pj-sm-callout text').textContent;
    r.taken = document.querySelectorAll('#machine .pj-sm-taken').length;
    r.trail = [...document.querySelectorAll('#machine .machine-trail li')].map((li) => li.className);
    setCursor(2, false);
    r.middle = [...document.querySelectorAll('#machine .pj-sm-current')].map((g) => g.dataset.state);
    r.middleStuck = document.querySelectorAll('#machine .pj-sm-stuck').length;
    setCursor(endPosition(), false);
    let saved = '';
    save = (name, data) => { saved = name + '\\n' + data; };
    exportAs('machine');
    r.exportName = saved.split('\\n')[0];
    r.exportHasState = saved.includes('philosopher__28') && saved.includes('state machine');
    r.exportOrders = (saved.match(/class="pj-sm-order/g) || []).length;
  `);
  assert.equal(page['harness-error'], undefined);
  assert.equal(page.error, undefined, 'the page script threw');
  const result = JSON.parse(page.result) as Record<string, unknown>;
  assert.equal(result.ready, 'true');
  assert.equal(result.chip, 'Deadlock freedom');
  assert.equal(result.selected, node.id, 'the stuck process is selected');
  assert.equal(result.tab, 'machine', 'its state machine is open');
  assert.deepEqual(result.orders, ['2', '3'], 'the states FDR names in its machine, numbered in the run\'s order');
  assert.deepEqual(result.stuck, ['philosopher__28']);
  assert.match(String(result.callout), /^waits to write true on right/);
  assert.ok(Number(result.taken) >= 3, 'the way it came is marked');
  assert.deepEqual(result.trail, ['elsewhere reached', 'reached', 'reached current']);
  // After step 2 it is at its first write, not stuck yet.
  assert.deepEqual(result.middle, ['philosopher__27']);
  assert.equal(result.middleStuck, 0);
  assert.equal(result.exportName, 'dining_philosophers.philosopher.machine.svg');
  assert.equal(result.exportHasState, true);
  assert.equal(result.exportOrders, 2);
});
