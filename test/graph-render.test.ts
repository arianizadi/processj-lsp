import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { layoutView, type Box, type ViewLayout } from '../src/graph/layout';
import type { NetworkView } from '../src/graph/network';
import { buildOverlays } from '../src/graph/overlay';
import { buildViewerPayload } from '../src/graph/payload';
import { buildExcalidrawScene, excalidrawInput, renderExcalidraw } from '../src/graph/render-excalidraw';
import { contentSecurityPolicy, renderViewerHtml } from '../src/graph/render-html';
import { formatConcurrencyMarkdown } from '../src/graph/render-markdown';
import { renderSequenceChart } from '../src/graph/render-msc';
import { renderNetworkSvg } from '../src/graph/render-svg';
import { staticVerificationReport } from '../src/graph/static-verification';
import { parse } from '../src/parser/parser';
import type { VerificationReport } from '../src/verification';
import { analyzeFile, analyzeSource, FIXTURES, programView, ROOT } from './graph-helpers';

const VERIFICATION = path.join(ROOT, 'test', 'fixtures', 'verification');
const FIXTURE_URI = 'file:///fixtures/verification/commstime_bounded.pj';
/** Every example program of the compiler that parses, plus the repository's own examples. */
const CORPUS = [
  ...fs.readdirSync(FIXTURES).filter((file) => file.endsWith('.pj')).map((file) => path.join(FIXTURES, file)),
  ...fs.readdirSync(path.join(ROOT, 'examples')).filter((file) => file.endsWith('.pj')).map((file) => path.join(ROOT, 'examples', file)),
].filter((file) => parse(fs.readFileSync(file, 'utf8')).errors.length === 0).sort();

/** A small XML well-formedness check: balanced tags, quoted attributes, escaped text. */
function assertWellFormedXml(text: string, what: string): void {
  const body = text.replace(/^<\?xml[^>]*\?>/, '').replace(/<!--[\s\S]*?-->/g, '');
  const stack: string[] = [];
  const tag = /<(\/?)([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>/g;
  const badEntity = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/;
  let last = 0;
  for (let match = tag.exec(body); match; match = tag.exec(body)) {
    const between = body.slice(last, match.index);
    assert.ok(!between.includes('<'), `${what}: stray '<' before ${match[0].slice(0, 40)}`);
    assert.ok(!badEntity.test(between), `${what}: unescaped '&' in text: ${between.slice(0, 60)}`);
    assert.ok(!badEntity.test(match[3]), `${what}: unescaped '&' in attributes of <${match[2]}>`);
    if (match[1]) assert.equal(stack.pop(), match[2], `${what}: </${match[2]}> closes the wrong element`);
    else if (!match[4]) stack.push(match[2]);
    last = tag.lastIndex;
  }
  assert.ok(!body.slice(last).includes('<'), `${what}: unparsed markup at the end`);
  assert.deepEqual(stack, [], `${what}: unclosed elements`);
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.width - 0.5 && b.x < a.x + a.width - 0.5 && a.y < b.y + b.height - 0.5 && b.y < a.y + a.height - 0.5;
}

function assertLayoutInvariants(view: NetworkView, layout: ViewLayout): void {
  const what = view.label;
  for (const node of view.nodes) assert.ok(layout.nodes[node.id], `${what}: ${node.name} is laid out`);
  // Siblings never overlap; children stay inside their container.
  const byParent = new Map<string, string[]>();
  for (const node of view.nodes) {
    const list = byParent.get(node.parent ?? '');
    if (list) list.push(node.id);
    else byParent.set(node.parent ?? '', [node.id]);
    if (node.parent) {
      const box = layout.nodes[node.id];
      const parent = layout.nodes[node.parent];
      assert.ok(box.x >= parent.x - 0.5 && box.y >= parent.y - 0.5 && box.x + box.width <= parent.x + parent.width + 0.5 && box.y + box.height <= parent.y + parent.height + 0.5, `${what}: ${node.name} is inside its container`);
    }
  }
  for (const [parent, ids] of byParent) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) assert.ok(!overlaps(layout.nodes[ids[i]], layout.nodes[ids[j]]), `${what}: ${ids[i]} and ${ids[j]} overlap in ${parent || 'the root'}`);
    }
  }
  // Every edge is routed; every label is on the canvas and clear of the boxes.
  const leaves = view.nodes.filter((node) => node.kind !== 'group').map((node) => layout.nodes[node.id]);
  for (const edge of view.edges) {
    const laid = layout.edges[edge.id];
    assert.ok(laid && laid.points.length >= 2, `${what}: ${edge.id} is routed`);
    if (!laid.label) continue;
    const label = laid.label;
    assert.ok(label.x >= 0 && label.y >= 0 && label.x + label.width <= layout.width && label.y + label.height <= layout.height, `${what}: the label of ${edge.label} is on the canvas`);
    for (const box of leaves) assert.ok(!overlaps(label, box), `${what}: the label of ${edge.label} covers a box`);
  }
}

test('layouts keep boxes apart, route every arrow, keep labels on the canvas, and are deterministic', async () => {
  assert.ok(CORPUS.length > 30);
  for (const file of CORPUS) {
    const { model } = analyzeFile(file);
    for (const view of model.views.slice(0, 6)) {
      const layout = await layoutView(view);
      assertLayoutInvariants(view, layout);
      assert.deepEqual(await layoutView(view), layout, `${path.basename(file)} ${view.label} lays out the same way twice`);
    }
  }
});

test('an edit that leaves a drawing as it was does not lay it out again, wherever it moves the source', async () => {
  // layout.ts makes its one ELK from this module: count the layouts it is asked for.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ELK = require('elkjs/lib/elk.bundled.js') as { prototype: { layout(...args: unknown[]): Promise<unknown> } };
  const own = Object.getOwnPropertyDescriptor(ELK.prototype, 'layout');
  const layout = ELK.prototype.layout;
  let layouts = 0;
  ELK.prototype.layout = function (this: unknown, ...args: unknown[]) {
    layouts++;
    return layout.apply(this, args);
  };
  try {
    const file = path.join(ROOT, 'examples', 'dining_philosophers.pj');
    const source = fs.readFileSync(file, 'utf8');
    const boxes = (view: NetworkView, laid: ViewLayout): Box[] => view.nodes.map((node) => laid.nodes[node.id]);
    const before = programView(analyzeSource(source, file).model);
    const first = await layoutView(before);
    // Two lines above everything: every box gets a new id (ids name source lines), none moves.
    const after = programView(analyzeSource(`// moved\n\n${source}`, file).model);
    assert.notDeepEqual(after.nodes.map((node) => node.id), before.nodes.map((node) => node.id));
    const counted = layouts;
    const second = await layoutView(after);
    assert.equal(layouts, counted, 'ELK was not asked again');
    assert.deepEqual(boxes(after, second), boxes(before, first));
    assert.deepEqual(Object.keys(second.nodes).sort(), after.nodes.map((node) => node.id).sort(), 'under the new ids');
    // A drawing that does change is laid out.
    await layoutView(programView(analyzeSource(source.replace(/philosopher/g, 'thinker'), file).model));
    assert.equal(layouts, counted + 1);
  } finally {
    if (own) Object.defineProperty(ELK.prototype, 'layout', own);
    else delete (ELK.prototype as { layout?: unknown }).layout;
  }
});

test('the SVG is standalone, well-formed, light by default, and escapes every label', async () => {
  const source = [
    'void show(string text, chan<int>.write out) { out.write(1); }',
    'public void main(string[] args) {',
    '    chan<int> c;',
    '    par { show("a<b&\\"c", c.write); int v = c.read(); }',
    '}',
  ].join('\n');
  const { model, program, checked, uri } = analyzeSource(source, '/virtual/escape&<>.pj');
  const view = programView(model);
  const svg = renderNetworkSvg(view, await layoutView(view), { title: 'escape&<>.pj' });
  assertWellFormedXml(svg, 'network svg');
  assert.match(svg, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<!-- generated by processj-lsp/);
  assert.match(svg, /escape&amp;&lt;&gt;\.pj/);
  assert.match(svg, /show\(&quot;a&lt;b&amp;/);
  assert.match(svg, /viewBox="-?[\d.]+ 0 [\d.]+ [\d.]+"/);
  assert.match(svg, /\.pj-bg \{ fill: #ffffff; \}/, 'files use plain light colours');
  assert.doesNotMatch(svg, /var\(--/, 'no custom properties in a file other tools will read');
  // With a result, the end state and the plain-words account are drawn in.
  const deadlock = analyzeFile(path.join(ROOT, 'examples', 'par_deadlock.pj'));
  const report = staticVerificationReport(deadlock.program, deadlock.checked, { uri: deadlock.uri, model: deadlock.model });
  const [overlay] = buildOverlays(deadlock.model, [report]);
  const stuck = renderNetworkSvg(programView(deadlock.model), await layoutView(programView(deadlock.model)), { title: 'par_deadlock.pj', overlay });
  assertWellFormedXml(stuck, 'overlay svg');
  assert.equal((stuck.match(/class="pj-ov-blocked"/g) ?? []).length, 2);
  assert.equal((stuck.match(/class="pj-ov-stuck[ "]/g) ?? []).length, 2);
  // The crossed pair's circle runs along the two arrows that join them (a red band under each, no loop
  // of its own), with red arrowheads on the stuck arrows.
  assert.equal((stuck.match(/class="pj-ov-cycle-route" data-edge/g) ?? []).length, 2);
  assert.equal((stuck.match(/class="pj-ov-cycle-edge"/g) ?? []).length, 0);
  assert.match(stuck, /circular wait along the arrows/, 'the legend says what the band is');
  assert.match(stuck, /class="pj-ov-stuck-edge pj-ov-root"[^>]*marker-end="url\(#pj-arrow-danger\)"/);
  assert.match(stuck, /circular wait: branch 1 → branch 2 → branch 1/);
  assert.match(stuck, /class="pj-caption-text"[^>]*>branch 1 is stuck at line 12 writing c/);
  void program;
  void checked;
  void uri;
});

test('the Excalidraw scene is valid and every binding is recorded on both sides', async () => {
  const analyzed = analyzeFile(path.join(VERIFICATION, 'commstime_bounded.pj'), FIXTURE_URI);
  const report = JSON.parse(fs.readFileSync(path.join(VERIFICATION, 'commstime_bounded.fdr.json'), 'utf8')) as VerificationReport;
  const view = programView(analyzed.model);
  const layout = await layoutView(view);
  const [overlay] = buildOverlays(analyzed.model, [report]);
  const text = renderExcalidraw(view, layout, { title: 'commstime_bounded.pj', overlay });
  assert.equal(renderExcalidraw(view, layout, { title: 'commstime_bounded.pj', overlay }), text, 'deterministic');
  const scene = JSON.parse(text) as { type: string; version: number; source: string; elements: Array<Record<string, any>>; appState: Record<string, unknown>; files: Record<string, unknown> };
  assert.equal(scene.type, 'excalidraw');
  assert.equal(scene.version, 2);
  assert.equal(scene.source, 'processj-lsp');
  assert.deepEqual(scene.appState, { viewBackgroundColor: '#ffffff', gridSize: null });
  assert.deepEqual(scene.files, {});
  const common = ['id', 'type', 'x', 'y', 'width', 'height', 'angle', 'strokeColor', 'backgroundColor', 'fillStyle', 'strokeWidth', 'strokeStyle', 'roughness', 'opacity', 'groupIds', 'frameId', 'index', 'roundness', 'seed', 'version', 'versionNonce', 'isDeleted', 'boundElements', 'updated', 'link', 'locked'];
  const byId = new Map(scene.elements.map((element) => [element.id as string, element]));
  assert.equal(byId.size, scene.elements.length, 'ids are unique');
  let previousIndex = '';
  for (const element of scene.elements) {
    for (const key of common) assert.ok(key in element, `${element.type} ${element.id} has ${key}`);
    assert.ok(element.index > previousIndex, 'fractional indices increase');
    previousIndex = element.index;
    assert.ok(Number.isInteger(element.seed) && element.seed > 0);
    if (element.type === 'text') {
      for (const key of ['text', 'originalText', 'fontSize', 'fontFamily', 'textAlign', 'verticalAlign', 'containerId', 'lineHeight', 'autoResize']) assert.ok(key in element, `text has ${key}`);
      if (element.containerId) {
        const container = byId.get(element.containerId);
        assert.ok(container?.boundElements.some((bound: { id: string; type: string }) => bound.id === element.id && bound.type === 'text'), 'the container lists its text');
      }
    }
    if (element.type === 'arrow') {
      assert.deepEqual(element.points[0], [0, 0]);
      for (const key of ['lastCommittedPoint', 'startBinding', 'endBinding', 'startArrowhead', 'endArrowhead']) assert.ok(key in element, `arrow has ${key}`);
      // The result's own links (a circular wait, `waits for`) join no shapes.
      if (element.customData?.processj) continue;
      for (const binding of [element.startBinding, element.endBinding]) {
        assert.ok(binding, 'arrows are bound at both ends');
        const shape = byId.get(binding.elementId);
        assert.ok(shape?.boundElements.some((bound: { id: string; type: string }) => bound.id === element.id && bound.type === 'arrow'), 'the shape lists the arrow');
      }
    }
    for (const bound of element.boundElements ?? []) {
      const other = byId.get(bound.id);
      assert.ok(other, `bound element ${bound.id} exists`);
      if (bound.type === 'arrow') assert.ok(other.startBinding?.elementId === element.id || other.endBinding?.elementId === element.id, 'the arrow binds back');
      if (bound.type === 'text') assert.equal(other.containerId, element.id, 'the text points back');
    }
  }
  // The end state is in the scene: stuck boxes in red, finished ones faded.
  assert.ok(scene.elements.some((element) => element.type === 'rectangle' && element.strokeColor === '#e03131'));
  assert.ok(scene.elements.some((element) => element.type === 'rectangle' && element.opacity === 40));
  // The title carries the whole verdict, wrapped rather than cut, above everything else drawn.
  const title = scene.elements.find((element) => element.type === 'text' && String(element.text).startsWith('commstime_bounded.pj · '))!;
  assert.ok(String(title.text).replace(/\n/g, ' ').includes(`FDR · ${report.checks[0].counterexample!.summary}`), String(title.text));
  const topOf = (element: Record<string, any>): number => element.y + Math.min(0, ...((element.points as Array<[number, number]> | undefined) ?? []).map((point) => point[1]));
  assert.ok(title.y + title.height <= Math.min(...scene.elements.filter((element) => element !== title).map(topOf)), 'the title sits above the drawing');
  // The page embeds the same builder: its source refers to nothing outside itself.
  const source = buildExcalidrawScene.toString();
  assert.doesNotMatch(source, /require\(|exports\.|_\d+\./);
  const rebuilt = new Function(`return (${source})`)() as typeof buildExcalidrawScene;
  assert.deepEqual(rebuilt(excalidrawInput(view, layout, { title: 'x' })), buildExcalidrawScene(excalidrawInput(view, layout, { title: 'x' })));
});

test('the viewer page is self-contained and runs only with its nonce', async () => {
  const analyzed = analyzeFile(path.join(VERIFICATION, 'commstime_bounded.pj'), FIXTURE_URI);
  const report = JSON.parse(fs.readFileSync(path.join(VERIFICATION, 'commstime_bounded.fdr.json'), 'utf8')) as VerificationReport;
  const hostile = `${analyzed.text}\n// </script><script>alert(1)</script>\n`;
  const payload = await buildViewerPayload({ model: analyzed.model, reports: [report], source: { uri: FIXTURE_URI, text: hostile } });
  for (const mode of ['file', 'live', 'webview'] as const) {
    const nonce = 'TESTNONCE0123456789abcdef';
    const html = renderViewerHtml(payload, { mode, nonce, cspSource: mode === 'webview' ? 'https://*.vscode-cdn.net' : undefined, liveBase: '/token/d/id/' });
    const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html)?.[1].replace(/&#39;/g, "'");
    assert.equal(csp, contentSecurityPolicy({ mode, cspSource: mode === 'webview' ? 'https://*.vscode-cdn.net' : undefined }, nonce));
    assert.match(csp!, new RegExp(`script-src 'nonce-${nonce}'`));
    assert.match(csp!, mode === 'live' ? /connect-src 'self'/ : /connect-src 'none'/);
    if (mode === 'webview') assert.match(csp!, /style-src https:\/\/\*\.vscode-cdn\.net 'unsafe-inline'/);
    // Every script is either the page's own (with the nonce) or inert data.
    const scripts = [...html.matchAll(/<script([^>]*)>/g)].map((match) => match[1]);
    assert.deepEqual(scripts, [' type="application/json" id="payload"', ` nonce="${nonce}"`]);
    // Nothing is fetched from the network: only the SVG namespace mentions http.
    const urls = [...html.matchAll(/(?:https?:)?\/\/[\w.-]+\.[a-z]{2,}[^\s"'<>)]*/gi)].map((match) => match[0]).filter((url) => !url.startsWith('http://www.w3.org/') && !url.includes('vscode-cdn.net'));
    assert.deepEqual([...new Set(urls)], [], `${mode}: no external URLs`);
    assert.doesNotMatch(html, /\b(?:src|href)=["']?(?:https?:)?\/\//i);
    assert.doesNotMatch(html, /@import|url\(\s*["']?https?:/i);
    // The source text cannot end the data block.
    assert.equal(html.split('</script>').length - 1, 2, 'only the two real script elements close');
    assert.match(html, /\\u003c\/script>\\u003cscript>alert\(1\)/);
  }
});

test('the sequence chart has a row per step, lifelines, and the stuck end', () => {
  const report = JSON.parse(fs.readFileSync(path.join(VERIFICATION, 'commstime_bounded.fdr.json'), 'utf8')) as VerificationReport;
  const counterexample = report.checks[0].counterexample!;
  const chart = renderSequenceChart(counterexample, { title: 'Deadlock freedom' });
  assertWellFormedXml(chart, 'sequence chart');
  assert.equal((chart.match(/<g class="pj-msc-row[^"]*" data-step="\d+"/g) ?? []).length, counterexample.steps.length);
  assert.equal((chart.match(/class="pj-msc-lane"/g) ?? []).length, 6);
  assert.equal((chart.match(/class="pj-msc-blocked"/g) ?? []).length, 4);
  assert.match(chart, />d\.0</);
  assert.match(chart, /class="pj-msc-row pj-msc-hidden" data-step="4"/);
  assert.doesNotMatch(chart, /var\(--/, 'a standalone chart uses plain colours');
  assert.match(renderSequenceChart(counterexample, { themed: true }), /var\(--pj-msc-bg, #ffffff\)/);
});

test('the Markdown report describes the network and the results in words, with a Mermaid diagram', () => {
  const analyzed = analyzeFile(path.join(VERIFICATION, 'commstime_bounded.pj'), FIXTURE_URI);
  const report = JSON.parse(fs.readFileSync(path.join(VERIFICATION, 'commstime_bounded.fdr.json'), 'utf8')) as VerificationReport;
  const markdown = formatConcurrencyMarkdown('commstime_bounded.pj', analyzed.model, [report]);
  assert.match(markdown, /^# Process network — commstime_bounded\.pj/);
  assert.match(markdown, /\*\*main \(whole program\)\*\* runs 6 processes connected by 4 channels\./);
  assert.match(markdown, /\| `a` \| long \| branch 1 of delta \| consume\(a\) \|/);
  assert.match(markdown, /✕ \*\*Deadlock freedom\*\* \(FDR 4\.2\.7, 28 states, 190 ms\): deadlock after 18 steps/);
  assert.match(markdown, /  - branch 1 of delta is stuck at line 29 writing a: consume read its three values and finished\./);
  assert.match(markdown, /✓ \*\*Divergence freedom\*\* \(FDR 4\.2\.7, 28 states, 120 ms\): passed/);
  assert.match(markdown, /```mermaid\nflowchart LR\n/);
  assert.match(markdown, /subgraph n\d+\["call · delta\(d, a, b\)"\]/);
  assert.match(markdown, /-->\|"a : long"\|/);
});
