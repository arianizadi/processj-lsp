/**
 * Regression tests for the security review of the analysis paths: inputs
 * that are small to write but large to compute, write paths beside the
 * user's files, and text generated from names the user chose. Each case
 * must end quickly with a clear note, not hang or exhaust memory.
 */
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { loadProgram } from '../src/csp/load';
import { translateProcedure, translateProgram } from '../src/csp/translate';
import { CspmDocument } from '../src/cspm/document';
import { MAX_LAYOUT } from '../src/graph/layout';
import type { NetNode, NetworkView } from '../src/graph/network';
import { layoutOrFallback } from '../src/graph/payload';
import { analyzeSource, INCLUDE } from './graph-helpers';

/** Run `fn` and fail when it takes longer than `ms` (the page's watchdog gives a request 10 s). */
function quick<T>(ms: number, fn: () => T): T {
  const started = Date.now();
  const result = fn();
  const took = Date.now() - started;
  assert.ok(took < ms, `took ${took} ms, more than ${ms} ms`);
  return result;
}

function cspmNotes(text: string): string[] {
  const doc = new CspmDocument('file:///workspace/model.csp', text);
  return doc.model([doc.defaultView()]).views.flatMap((view) => view.notes);
}

function translated(text: string, procedure?: string) {
  const loaded = loadProgram(path.join(os.tmpdir(), 'security.pj'), INCLUDE, text);
  const input = { units: loaded.units, index: loaded.index };
  return procedure ? translateProcedure(input, procedure) : translateProgram(input);
}

// ---------------------------------------------------------------------------
// F-02, F-03: CSPm values the graph evaluates
// ---------------------------------------------------------------------------

test('F-02: a range at 2^53 ends at once, with a note that the integer is too large', () => {
  const notes = quick(2000, () => cspmNotes('MAIN = ||| i : {9007199254740992..9007199254740992} @ STOP\nassert MAIN :[deadlock free]\n'));
  assert.ok(notes.some((note) => /9007199254740992 is too large for the graph to compute with/.test(note)), notes.join('\n'));
});

test('F-02: arithmetic past the integers JavaScript holds exactly is unknown, ordinary ranges are unchanged', () => {
  const notes = quick(2000, () => cspmNotes('N = 9007199254740991 + 1\nMAIN = ||| i : {0..N} @ STOP\n'));
  assert.ok(notes.some((note) => /an integer too large for the graph to compute with/.test(note)), notes.join('\n'));
  const doc = new CspmDocument('file:///workspace/ok.csp', 'channel c : {0..2}\nP(i) = c!i -> STOP\nMAIN = ||| i : {0..2} @ P(i)\n');
  const view = doc.model([doc.defaultView()]).views[0];
  assert.deepEqual(view.nodes.filter((node) => node.label.startsWith('P(')).map((node) => node.label), ['P(0)', 'P(1)', 'P(2)']);
});

test('F-03: a sequence doubled by recursion stops at the size cap with a note', () => {
  const notes = quick(2000, () => cspmNotes('f(0) = <0>\nf(n) = let xs = f(n-1) within xs ^ xs\nchannel c\nMAIN = if length(f(29)) > 0 then STOP else c -> STOP\n'));
  assert.ok(notes.some((note) => /a sequence too long for the graph to compute/.test(note)), notes.join('\n'));
});

test('F-03: deep recursion in a value is cut off instead of overflowing the stack', () => {
  const notes = quick(2000, () => cspmNotes('f(0) = 0\nf(n) = 1 + f(n-1)\nchannel c : {0..1}\nMAIN = if f(100000) > 0 then STOP else c!0 -> STOP\n'));
  assert.ok(notes.some((note) => /recurses deeper than the graph follows/.test(note)), notes.join('\n'));
});

test('F-03: repeated set operations and membership tests are paid for by the evaluation budget', () => {
  // Quadratic before: every member() and inter() compared each pair of values.
  const notes = quick(5000, () => cspmNotes([
    'S = {0..4095}',
    'g(0) = 0',
    'g(n) = card(inter(S, S)) + (if member(n, S) then 1 else 0) + g(n-1)',
    'channel c : {0..1}',
    'MAIN = if g(400) > 0 then STOP else c!0 -> STOP',
    '',
  ].join('\n')));
  assert.ok(notes.some((note) => /evaluation budget ran out|recurses deeper/.test(note)), notes.join('\n'));
});

// ---------------------------------------------------------------------------
// F-03: ProcessJ graphs and Convert to CSP
// ---------------------------------------------------------------------------

test('F-03: an unknown index into a billion-channel array is one unresolved use, not a billion channels', () => {
  const analyzed = quick(3000, () => analyzeSource('void bomb(int i) {\n    chan<int>[] cs = new chan<int>[1000000000];\n    cs[i].write(1);\n}\n', path.join(os.tmpdir(), 'bomb.pj')));
  const view = analyzed.model.views[0];
  assert.equal(view.channels.length, 0);
  assert.ok(view.nodes.some((node) => node.facts.some((fact) => /one of the 1000000000 channels of 'cs', too many to draw one by one/.test(fact))), JSON.stringify(view.nodes.map((node) => node.facts)));
});

test('F-03: a view with thousands of explicit par branches is not built past the hard limit', () => {
  const text = `void main() {\n    par {\n${'        skip;\n'.repeat(3000)}    }\n}\n`;
  const analyzed = quick(5000, () => analyzeSource(text, path.join(os.tmpdir(), 'many.pj')));
  const view = analyzed.model.views[0];
  assert.equal(view.nodes.length, 1);
  assert.match(view.notes.join('\n'), /more than 1000 processes even with no call expanded: it is too large to draw/);
});

test('F-03: a view too large for the layout engine gets the plain arrangement and a note', async () => {
  const nodes: NetNode[] = [{ id: 'root', kind: 'group', label: 'main', name: 'main', confidence: 'exact', facts: [], operations: [] }];
  for (let i = 0; i <= MAX_LAYOUT.nodes; i++) nodes.push({ id: `p${i}`, parent: 'root', kind: 'process', label: `p${i}`, name: `p${i}`, confidence: 'exact', facts: [], operations: [] });
  const view: NetworkView = { id: 'view:program', kind: 'program', procedure: 'main', label: 'main (whole program)', source: { uri: 'file:///workspace/big.pj', span: { start: { line: 0, col: 0 }, end: { line: 0, col: 4 } } }, nodes, edges: [], channels: [], notes: [], instances: [] };
  const notes: string[] = [];
  const started = Date.now();
  const layout = await layoutOrFallback(view, notes);
  assert.ok(Date.now() - started < 2000);
  assert.ok(layout.nodes.p0, 'every box is placed');
  assert.match(notes.join('\n'), /too large to lay out/);
  assert.match(view.notes.join('\n'), /too large to lay out/);
});

test('F-03: a computed par for bound is checked against the process limit before its iterations are built', () => {
  const model = quick(3000, () => translated('//@csp int 0..1000000000\nvoid worker(int n) {\n    par for (int i = 0; i < n; i++) skip;\n}\nvoid main() { worker(1000000000); }\n'));
  assert.match(model.unsupported.map((u) => u.message).join('\n'), /more than 2000 processes/);
});

test('F-03: a procedure checked on its own does not enumerate a huge integer range for its arguments', () => {
  const model = quick(3000, () => translated('//@csp int 0..1000000000\nvoid worker(int n) {\n    par for (int i = 0; i < n; i++) skip;\n}\n', 'worker'));
  assert.match(model.unsupported.map((u) => u.message).join('\n'), /too many instances to check/);
});

test('F-03: a huge channel array is not modelled, and //@csp int bounds must be exact integers', () => {
  const arrays = quick(3000, () => translated('//@csp int 0..1000000000\nvoid main() {\n    chan<int>[] cs = new chan<int>[100000000];\n    par { cs[0].write(1); int x = cs[0].read(); }\n}\n'));
  assert.match(arrays.unsupported.map((u) => u.message).join('\n'), /'cs' has 100000000 channels, more than the model lays out/);
  const range = translated('//@csp int 0..99999999999999999999\nvoid main() { skip; }\n');
  assert.match(range.warnings.map((w) => w.message).join('\n'), /has a bound too large to model; ignored/);
});
