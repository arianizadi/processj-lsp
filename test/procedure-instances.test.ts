/**
 * A procedure checked on its own whose data parameters decide its network
 * (recursion depth, channel-array lengths, par for counts): checked with the
 * arguments its calls from the program give, one instance per distinct tuple,
 * a channel-array parameter given fresh channels of the length the calls give;
 * with no call, every modelled value that elaborates; with neither, not
 * modelled with a reason that says what to do. The coursework FIFOs of
 * test/fixtures/fifo/blocks.pj (and their broken copies) are checked with FDR
 * (recorded, test/fixtures/fdr/proc_*.json) and drawn on each procedure's own
 * view, drawn with the same arguments.
 */
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { drawnArguments, explain, lensVerdict, translateProcedure, translateProgram, type CspModel } from '../src/csp/index';
import { loadProgram } from '../src/csp/load';
import { buildNetwork } from '../src/graph/network';
import { buildOverlays, preferredView } from '../src/graph/overlay';
import type { VerificationReport } from '../src/verification';
import { recordedRun } from './fdr-recordings';
import { analyzeFile, INCLUDE, ROOT } from './graph-helpers';

const FIFO = path.join(ROOT, 'test', 'fixtures', 'fifo');

function load(name: string): ReturnType<typeof loadProgram> {
  const loaded = loadProgram(path.join(FIFO, `${name}.pj`), INCLUDE);
  assert.deepEqual(loaded.syntaxErrors, []);
  return loaded;
}

function procedure(name: string, proc: string): CspModel {
  const loaded = load(name);
  return translateProcedure({ units: loaded.units, index: loaded.index }, proc);
}

/** Check a procedure of a fixture with FDR (recorded) and place every counterexample on its own view, drawn as it is checked. */
async function checkAndPlace(name: string, proc: string): Promise<{ model: CspModel; report: VerificationReport }> {
  const file = path.join(FIFO, `${name}.pj`);
  const loaded = load(name);
  const input = { units: loaded.units, index: loaded.index };
  const model = translateProcedure(input, proc);
  assert.deepEqual(model.unsupported, [], `${name} ${proc}: the model is complete`);
  const analyzed = analyzeFile(file);
  const report = explain(model, await recordedRun(`proc_${name}_${proc}`, model), { uri: analyzed.uri, documentVersion: 1 });
  const graph = buildNetwork(analyzed.program, analyzed.checked, {
    uri: analyzed.uri,
    text: analyzed.text,
    effects: analyzed.effects.summaries,
    index: analyzed.index,
    procedureArguments: (decl) => drawnArguments(translateProcedure(input, decl.name.name, decl.name.span.start)),
  });
  const overlays = buildOverlays(graph, [report], { documentVersion: 1 });
  for (const check of report.checks) {
    if (!check.counterexample) continue;
    const view = preferredView(graph, check, overlays, 0);
    assert.equal(graph.views.find((v) => v.id === view)?.procedure, proc, `${proc} ${check.id}: shown on its own view`);
    const overlay = overlays.find((entry) => entry.view === view && entry.check === check.id);
    assert.ok(overlay, `${proc} ${check.id} is drawn`);
    assert.deepEqual(overlay.unplaced, [], `${proc} ${check.id}: nothing left out`);
    assert.ok(overlay.processes.length && overlay.processes.every((entry) => entry.exact), `${proc} ${check.id}: every process on its own box`);
  }
  return { model, report };
}

const statuses = (report: VerificationReport): string[] => report.checks.map((c) => `${c.id} ${c.status}`);
const ALL_PASS = ['deadlock-free passed', 'divergence-free passed', 'no-runtime-errors passed', 'deterministic passed'];

test('blocks.pj: every procedure checks on its own, a structural parameter with the arguments of its call', async () => {
  // id, producer and consumer have no parameter that decides their network: every value, as before.
  for (const proc of ['id', 'producer', 'consumer']) {
    const { model, report } = await checkAndPlace('blocks', proc);
    assert.equal(model.checkedWith, undefined);
    assert.deepEqual(statuses(report), ALL_PASS, proc);
  }
  // altFIFO(6, ...) at line 75: six stages, unfolded through the recursion; a 6-place buffer.
  const alt = await checkAndPlace('blocks', 'altFIFO');
  assert.equal(alt.model.checkedWith?.text, 'altFIFO checked with size = 6 (the call at line 75)');
  // Five levels of a par of two branches (the last altFIFO(1) runs id in its own branch).
  assert.equal(alt.model.sourceMap.processes.filter((p) => p.kind === 'branch').length, 10);
  assert.match(alt.model.text, /^altFIFO = pj_call\.6 -> PJ_RUN$/m);
  assert.deepEqual(statuses(alt.report), ALL_PASS);
  assert.equal(alt.report.checks[0].target.arguments, 'size = 6');
  assert.match(lensVerdict(alt.report), /^FDR: no deadlock, [\d,]+ states · size = 6$/);
  assert.ok(alt.report.assumptions.some((a) => a.startsWith('altFIFO checked with size = 6 (the call at line 75)')));
  // FIFO(6, ...) at line 69: a par for of six foo stages joined by five channels.
  const fifo = await checkAndPlace('blocks', 'FIFO');
  assert.equal(fifo.model.checkedWith?.text, 'FIFO checked with size = 6 (the call at line 69)');
  assert.equal(fifo.model.sourceMap.processes.filter((p) => p.kind === 'iteration').length, 6);
  assert.deepEqual(statuses(fifo.report), ALL_PASS);
  // foo, called in FIFO's par for: one instance per iteration, chans fresh channels of length 5.
  const foo = await checkAndPlace('blocks', 'foo');
  assert.equal(foo.model.checkedWith?.text, 'foo checked with i = 0..5, chans of length 5, size = 6 (6 instances, each checked; the call at line 44)');
  assert.deepEqual(foo.model.checkedWith?.instances.map((i) => i.label), [0, 1, 2, 3, 4, 5].map((i) => `i = ${i}, chans of length 5, size = 6`));
  assert.match(foo.model.text, /^channel chans : \{0\.\.\d+\}\.Int_t$/m);
  assert.match(foo.model.text, /^foo = \(pj_call\.0\.6 -> PJ_RUN_1\) \[\] \(pj_call\.1\.6 -> PJ_RUN_2\) \[\]/m);
  assert.equal(foo.model.sourceMap.instances?.length, 6);
  assert.deepEqual(statuses(foo.report), ALL_PASS);
  // The graph draws foo as checked: the five channels of chans are ports of their own.
  const blocks = analyzeFile(path.join(FIFO, 'blocks.pj'));
  const graph = buildNetwork(blocks.program, blocks.checked, {
    uri: blocks.uri,
    procedureArguments: (decl) => drawnArguments(procedure('blocks', decl.name.name)),
    only: ['foo'],
  });
  const view = graph.views[0];
  assert.deepEqual(view.nodes.filter((n) => n.kind === 'port').map((n) => n.label), ['chans[0]', 'chans[1]', 'chans[2]', 'chans[3]', 'chans[4]', 'in', 'out']);
  assert.match(view.notes.join(), /Drawn with chans of length 5 and size = 6 \(i differs between the instances checked/);
});

test('the program check of blocks.pj is what it was', () => {
  const loaded = load('blocks');
  const model = translateProgram({ units: loaded.units, index: loaded.index });
  assert.equal(model.checkedWith, undefined);
  assert.deepEqual(model.unsupported, []);
  assert.match(model.text, /^-- Target: the whole program, from main \(MAIN\)\.$/m);
});

test('a broken stage shows on the procedure checked on its own, in the instance that has it', async () => {
  // FIFO runs one stage too few: the fifth stage waits for good to hand on its value.
  const skip = await checkAndPlace('blocks_skip', 'FIFO');
  assert.equal(skip.report.checks[0].status, 'failed');
  assert.match(skip.report.checks[0].message ?? '', /foo \(i = 4\) waits to write -1 on out \(chans\[4\]\)/);
  // The last stage reads one channel past the end of chans: only foo with i = 5 (the sixth instance) fails.
  const oob = await checkAndPlace('blocks_oob', 'foo');
  const errors = oob.report.checks.find((c) => c.id === 'no-runtime-errors')!;
  assert.equal(errors.status, 'failed');
  assert.equal(errors.counterexample?.steps[0].description, 'foo is called with i = 5, size = 6');
  assert.equal(errors.counterexample?.error?.at?.span.start.line, 33);
  // altFIFO's last stage reads and never writes: the stage before it is stuck, deep in the recursion.
  const alt = await checkAndPlace('blocks_alt', 'altFIFO');
  const deadlock = alt.report.checks.find((c) => c.id === 'deadlock-free')!;
  assert.equal(deadlock.status, 'failed');
  assert.ok(deadlock.counterexample!.final.some((s) => s.process.path.length === 9), 'a process of the fifth level of the recursion');
});

test('with no call that fixes them, every modelled value that elaborates; with none, why not and what to do', () => {
  const chain = procedure('unbound', 'chain');
  assert.deepEqual(chain.unsupported, []);
  assert.equal(chain.checkedWith?.source, 'range');
  assert.equal(chain.checkedWith?.text, 'chain checked with size = 0..2 (3 instances, each checked; no call in the program fixes size: every modelled value (0..2) for which the network is finite)');
  // The recursion never stops: not modelled, with what to do about it.
  const grow = procedure('unbound', 'grow');
  assert.equal(grow.unsupported.length, 1);
  assert.match(grow.unsupported[0].message, /^'grow' on its own: n decides its network, no call in the program fixes it, and for no modelled value \(0\.\.2\) does elaboration end \('grow' calls itself on the way to a par/);
  assert.match(grow.unsupported[0].message, /If it ends for some argument, call grow from main with it, or name it above the procedure with \/\/@csp check grow\(<n>\)$/);
  // An array of channels no call gives: fresh channels of every length that elaborates.
  const stages = procedure('unbound', 'stages');
  assert.deepEqual(stages.unsupported, []);
  assert.equal(stages.checkedWith?.instances[0].label, 'cs of length 1');
  // A //@csp check directive names the arguments.
  const named = procedure('unbound', 'named');
  assert.equal(named.checkedWith?.text, 'named checked with size = 3 (from //@csp check at line 42)');
  assert.deepEqual(named.warnings, []);
});

test('//@csp check: named arguments, several instances, and a wrong argument is a warning', () => {
  const source = (directives: string): string => [
    'public void id(chan<int>.read in, chan<int>.write out) { int v = in.read(); out.write(v); }',
    'public void chain(int size, chan<int>.read in, chan<int>.write out) {',
    '    if (size <= 1) id(in, out);',
    '    else { chan<int> m; par { id(in, m.write); chain(size - 1, m.read, out); } }',
    '}',
    directives,
    'public void top(int size, boolean loud, chan<int>.read in, chan<int>.write out) { chain(size, in, out); if (loud) out.write(1); }',
    'public void main(string[] args) { }',
  ].join('\n');
  const fs = require('node:fs') as typeof import('node:fs');
  const os = require('node:os') as typeof import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-check-directive-'));
  try {
    const translate = (directives: string): CspModel => {
      const file = path.join(dir, 'top.pj');
      fs.writeFileSync(file, source(directives));
      const loaded = loadProgram(file, INCLUDE);
      return translateProcedure({ units: loaded.units, index: loaded.index }, 'top');
    };
    const two = translate('//@csp check top(size = 2)\n//@csp check top(3, true)');
    assert.equal(two.checkedWith?.text, 'top checked with size = 2, 3 (2 instances, each checked; from //@csp check at lines 6 and 7)');
    // loud does not decide the network: any value, as for every procedure check.
    assert.match(two.text, /^top = \(pj_call\.2\?loud -> PJ_RUN_1\(loud\)\) \[\] \(pj_call\.3\?loud -> PJ_RUN_2\(loud\)\)$/m);
    const wrong = translate('//@csp check top(size = x)');
    assert.match(wrong.warnings.map((w) => w.message).join(), /\/\/@csp check: 'size = x' is not an argument of \/\/@csp check top\(size, loud\)/);
    // Ignored: checked with every value that elaborates, as with no directive.
    assert.equal(wrong.checkedWith?.source, 'range');
    // A range set by hand that does not hold the argument: not checked, and why.
    const narrow = translate('//@csp int 0..2\n//@csp check top(6, false)');
    assert.match(narrow.unsupported.map((u) => u.message).join(), /^'top' on its own: \/\/@csp check gives size = 6, outside the modelled integers 0\.\.2\. Widen the range with \/\/@csp int/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
