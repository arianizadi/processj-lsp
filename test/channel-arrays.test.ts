/**
 * Arrays of channels and recursion through par, elaborated statically: the
 * coursework FIFOs of test/fixtures/fifo/blocks.pj (a par for of stages
 * joined by `chan<int> chans[] = new chan<int>[size - 1]`, and altFIFO
 * calling itself through a par), translated, checked with FDR (recorded,
 * test/fixtures/fdr/blocks*.json) and drawn, with the broken copies next to
 * it. Every element is a channel of its own, every unfolded stage a process
 * of its own, with the same identity in the model and in the graph.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { check } from '../src/checker/checker';
import { DeclIndex } from '../src/checker/index';
import { explain, translateProgram, type CspModel } from '../src/csp/index';
import { processNames } from '../src/csp/explain';
import { loadProgram } from '../src/csp/load';
import { buildOverlays, preferredView } from '../src/graph/overlay';
import { parse } from '../src/parser/parser';
import type { VerificationReport } from '../src/verification';
import { recordedRun } from './fdr-recordings';
import { analyzeFile, analyzeSource, INCLUDE, programView, ROOT } from './graph-helpers';

const FIFO = path.join(ROOT, 'test', 'fixtures', 'fifo');

function translate(file: string, source?: string): CspModel {
  const loaded = loadProgram(file, INCLUDE, source);
  assert.deepEqual(loaded.syntaxErrors, []);
  return translateProgram({ units: loaded.units, index: loaded.index });
}

function fromSource(name: string, source: string): CspModel {
  const dir = path.join(os.tmpdir(), 'processj-channel-arrays-test');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.pj`);
  fs.writeFileSync(file, source);
  return translate(file, source);
}

async function checked(name: string): Promise<{ analyzed: ReturnType<typeof analyzeFile>; model: CspModel; report: VerificationReport }> {
  const file = path.join(FIFO, `${name}.pj`);
  const analyzed = analyzeFile(file);
  const model = translate(file);
  assert.deepEqual(model.unsupported, [], `${name}: the model is complete`);
  const run = await recordedRun(name, model);
  return { analyzed, model, report: explain(model, run, { uri: analyzed.uri, documentVersion: 1 }) };
}

/** Every failed check lands on the drawn network: each process on its own box, each step on its arrow. */
function placeAll(analyzed: ReturnType<typeof analyzeFile>, report: VerificationReport): void {
  const overlays = buildOverlays(analyzed.model, [report], { documentVersion: 1 });
  for (const result of report.checks) {
    const cx = result.counterexample;
    if (!cx) continue;
    const overlay = overlays.find((entry) => entry.view === preferredView(analyzed.model, result, overlays, 0) && entry.check === result.id);
    assert.ok(overlay, `${result.id} is drawn`);
    assert.deepEqual(overlay.unplaced, [], `${result.id}: nothing left out`);
    assert.ok(overlay.processes.every((entry) => entry.exact), `${result.id}: every process on its own box`);
    for (const step of overlay.steps) {
      assert.ok(step.participants.every((part) => part.node), `${result.id} step ${step.index + 1}: every participant drawn`);
      if (step.kind === 'communication') assert.ok(step.channel, `${result.id} step ${step.index + 1}: its channel drawn`);
    }
  }
}

test('blocks.pj: the channel array and the recursion through par are modelled, stage by stage', () => {
  const model = translate(path.join(FIFO, 'blocks.pj'));
  assert.deepEqual(model.unsupported, []);
  // FIFO(6, ...) makes 5 channels; the par for runs 6 iterations, one leaf each, not one per modelled integer.
  const foo = model.sourceMap.processes.filter((p) => p.process?.label.startsWith('foo('));
  assert.deepEqual(foo.map((p) => p.process!.path.at(-1)!.index), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(foo[2].process!.path.map((s) => s.kind), ['branch', 'call', 'par-for']);
  assert.match(model.text, /\nchannel FIFO_chans : \{0\.\.\d+\}\.Int_t\n/);
  // Each element is its own channel, with the array's declarator and FIFO's instance as owner.
  const element = model.sourceMap.channels['FIFO_chans.2'];
  assert.deepEqual([element.ref?.name, element.ref?.index, element.part], ['chans[2]', 2, { channel: 'FIFO_chans', index: 2 }]);
  assert.deepEqual(element.ref?.owner.map((s) => s.kind), ['branch', 'call']);
  // Iteration 2 reads chans[1] and writes chans[2], and nothing else of the array.
  const uses = foo[2].uses.filter((u) => u.channel.startsWith('FIFO_chans')).map((u) => `${u.op} ${u.channel}`);
  assert.deepEqual([...new Set(uses)].sort(), ['read FIFO_chans.1', 'write FIFO_chans.2']);
  // The fork carries only what FIFO(6, ...) sends: no slot is compiled for lengths it never gets.
  assert.match(model.text, /\nchannel pj_fork_FIFO_43 : PJInst_FIFO\.\{ 0 \}\.\{ 5 \}\.\{ 5 \}\.\{ 6 \}\n/);
  // altFIFO(6) unfolds into 6 stages: five id branches, the last altFIFO(1) running id itself.
  const stages = model.sourceMap.processes.filter((p) => p.process?.label === 'id(in, middle.write)');
  assert.equal(stages.length, 5);
  assert.deepEqual(stages.map((p) => p.process!.path.length), [3, 5, 7, 9, 11]);
  // Each stage's middle is its own channel: a recursive procedure's channel carries its instance.
  assert.match(model.text, /\nchannel altFIFO_middle : \{1\.\.\d\}\.Int_t\n/);
  const middles = Object.values(model.sourceMap.channels).filter((c) => c.part?.channel === 'altFIFO_middle');
  assert.equal(middles.length, 5);
  assert.equal(new Set(middles.map((c) => JSON.stringify(c.ref?.owner))).size, 5);
});

test('blocks.pj with FDR: no deadlock, no runtime error, and it terminates (as the real program does)', async () => {
  const { report, analyzed } = await checked('blocks');
  assert.deepEqual(report.checks.map((c) => [c.id, c.status]), [['deadlock-free', 'passed'], ['no-runtime-errors', 'passed'], ['terminates', 'passed']]);
  placeAll(analyzed, report);
});

test('a stage wired past the end of the array: FDR finds the runtime error in that iteration', async () => {
  const { report, analyzed } = await checked('blocks_oob');
  const error = report.checks.find((c) => c.id === 'no-runtime-errors')!;
  assert.equal(error.status, 'failed');
  assert.equal(error.counterexample?.error?.kind, 'array-index');
  assert.equal(error.counterexample?.error?.at?.span.start.line, 33);
  assert.match(error.counterexample!.summary, /^runtime error after \d+ steps: foo \(i = 5\): the index of 'chans' is outside the array \(line 34\)$/);
  placeAll(analyzed, report);
  // The graph knows the index too: iteration 5 says what it cannot draw.
  const view = programView(analyzed.model);
  const last = view.nodes.find((n) => n.name === 'foo(i, chans, size, in, out) [i = 5]')!;
  assert.ok(last.facts.some((f) => /'chans\[…\] \(index 5, outside the 5 channels of 'chans'\)'/.test(f)), last.facts.join('; '));
});

test('a stage left out: FDR finds the deadlock, and the graph shows the stuck stage on its element', async () => {
  const { report, analyzed } = await checked('blocks_skip');
  const deadlock = report.checks.find((c) => c.id === 'deadlock-free')!;
  assert.equal(deadlock.status, 'failed');
  const cx = deadlock.counterexample!;
  const stuck = cx.final.filter((s) => s.status === 'blocked' && s.waits?.some((w) => w.operation === 'write' || w.operation === 'read'));
  const waits = stuck.map((s) => `${s.process.label}: ${s.waits![0].operation} ${s.waits![0].channel?.name}`).sort();
  assert.ok(waits.includes('consumer(d2.read): read d2'), waits.join('; '));
  assert.ok(waits.some((w) => /^foo\(i, chans, size, in, out\) \[i = 4\]: write chans\[4\]$/.test(w)), waits.join('; '));
  placeAll(analyzed, report);
  const overlays = buildOverlays(analyzed.model, [report], { documentVersion: 1 });
  const drawn = overlays.find((o) => o.check === 'deadlock-free' && o.view === programView(analyzed.model).id)!;
  const view = programView(analyzed.model);
  const label = (id: string): string => view.nodes.find((n) => n.id === id)!.name;
  assert.ok(drawn.processes.some((p) => p.status === 'blocked' && label(p.node) === 'foo(i, chans, size, in, out) [i = 4]'));
});

test('the graph draws each element of the array between the iterations that use it, and the unfolded stages nested', () => {
  const { model } = analyzeFile(path.join(FIFO, 'blocks.pj'));
  const view = programView(model);
  const iterations = view.nodes.filter((n) => n.name.startsWith('foo(i, chans, size, in, out) ['));
  assert.equal(iterations.length, 6);
  assert.ok(iterations.every((n) => n.path?.at(-1)?.kind === 'par-for' && n.path.at(-1)!.index !== undefined));
  const name = (id: string): string => view.nodes.find((n) => n.id === id)!.name.replace(/^.*\[(i = \d)\]$/, '$1');
  const elements = view.channels.filter((c) => /^chans\[\d\]$/.test(c.name));
  assert.deepEqual(elements.map((c) => `${c.name}: ${c.writers.map((e) => name(e.node)).join()} -> ${c.readers.map((e) => name(e.node)).join()}`), [
    'chans[0]: i = 0 -> i = 1',
    'chans[1]: i = 1 -> i = 2',
    'chans[2]: i = 2 -> i = 3',
    'chans[3]: i = 3 -> i = 4',
    'chans[4]: i = 4 -> i = 5',
  ]);
  assert.deepEqual(elements[2].ref, { ...elements[2].ref, name: 'chans[2]', index: 2 });
  // altFIFO: five id stages, each inside the stage that started it, and five middles.
  const ids = view.nodes.filter((n) => n.label === 'id(in, middle)');
  assert.equal(ids.length, 5);
  assert.deepEqual(ids.map((n) => n.path!.length), [3, 5, 7, 9, 11]);
  // Each stage's middle is named by the stage's known argument, so the five can be told apart.
  const middles = view.channels.filter((c) => c.ref.name === 'middle');
  assert.deepEqual(middles.map((c) => c.name), [6, 5, 4, 3, 2].map((size) => `middle (size = ${size})`));
  assert.ok(middles.every((c) => c.writers.length === 1 && c.readers.length === 1));
  const stages = view.nodes.filter((n) => n.label === 'altFIFO(size - 1, middle, out)');
  assert.deepEqual(stages.map((n) => n.detail), [5, 4, 3, 2, 1].map((size) => `size = ${size}`));
});

test('elaboration decides conditions on known values: a par for whose iterations either write or read needs no channel server', () => {
  const model = translate(path.join(ROOT, 'test', 'differential', 'par_for_shared_even.pj'));
  assert.deepEqual(model.unsupported, []);
  assert.doesNotMatch(model.text, /PJ_MED\(c/);
  const ops = model.sourceMap.processes.filter((p) => p.kind === 'iteration').map((p) => [...new Set(p.uses.map((u) => u.op))].join());
  assert.deepEqual(ops, ['write', 'read', 'write', 'read']);
});

test('what elaboration cannot settle stays not modelled, with the reason', () => {
  const recursive = (call: string): CspModel => fromSource('rec', [
    'public void stage(chan<int>.read in, chan<int>.write out) { int v = in.read(); out.write(v); }',
    'public void chain(int n, chan<int>.read in, chan<int>.write out) {',
    '    if (n <= 1) stage(in, out);',
    '    else { chan<int> m; par { stage(in, m.write); chain(' + call + ', m.read, out); } }',
    '}',
    'public void main(string[] args) { chan<int> a, b; int k = 3; par { a.write(1); chain(3, a.read, b.write); { int x = b.read(); } } }',
  ].join('\n'));
  // Bounded: chain(3) is three stages.
  const bounded = recursive('n - 1');
  assert.deepEqual(bounded.unsupported, []);
  assert.equal(bounded.sourceMap.processes.filter((p) => p.process?.label === 'stage(in, m.write)').length, 2);
  // The same arguments again: they do not say how deep it goes (it may still stop on data read at run time).
  assert.match(recursive('n').unsupported.map((u) => u.message).join(), /'chain' calls itself on the way to a par with the same arguments again \(n = 3\), so the arguments do not tell how many levels run/);
  assert.doesNotMatch(recursive('n').unsupported.map((u) => u.message).join(), /so it never stops/);
  // Growing arguments: no stop within the process budget.
  assert.match(recursive('n + 1').unsupported.map((u) => u.message).join(), /'chain' calls itself on the way to a par/);
  // An array whose length the run decides.
  const unknownSize = fromSource('size', 'public void main(string[] args) { chan<int> c; int n; par { c.write(2); n = c.read(); } chan<int>[] cs = new chan<int>[n]; }');
  assert.match(unknownSize.unsupported.map((u) => u.message).join(), /the length of the channel array 'cs' is not known before the program runs/);
  // An element chosen at runtime is fine for operations here, but not for a channel handed to a par branch.
  const runtimeIndex = fromSource('index', [
    'public void w(chan<int>.write o) { o.write(1); }',
    'public void main(string[] args) {',
    '    chan<int>[] cs = new chan<int>[2];',
    '    chan<int> c;',
    '    int k;',
    '    par { c.write(1); k = c.read(); }',
    '    par { cs[k].write(5); { int x; x = cs[0].read(); } { int y; y = cs[1].read(); } }',
    '}',
  ].join('\n'));
  assert.deepEqual(runtimeIndex.unsupported, []);
  // The write may be on either element: the iteration is a writer of both.
  const writer = runtimeIndex.sourceMap.processes.find((p) => p.process?.label === 'branch 1' && p.process.path.length === 1 && p.uses.some((u) => u.op === 'write' && u.channel.startsWith('cs.')));
  assert.deepEqual(writer?.uses.filter((u) => u.op === 'write').map((u) => u.channel).sort(), ['cs.0', 'cs.1']);
});

test('the checker warns only about the channel-array forms this ProcessJ build cannot compile', () => {
  const std = new DeclIndex();
  for (const f of fs.readdirSync(path.join(INCLUDE, 'std'))) std.addProgram(parse(fs.readFileSync(path.join(INCLUDE, 'std', f), 'utf8')).program, f);
  const limits = (source: string): number[] => {
    const parsed = parse(source);
    const index = new DeclIndex();
    index.addProgram(parsed.program, 'x.pj');
    index.addIndex(std);
    return check(parsed.program, { index, importsStd: true, text: source }).diagnostics.filter((d) => d.code === 'pj/compiler-limit').map((d) => d.line + 1);
  };
  // test/fixtures/fifo/blocks.pj builds and runs: nothing to warn about.
  assert.deepEqual(limits(fs.readFileSync(path.join(FIFO, 'blocks.pj'), 'utf8')), []);
  assert.deepEqual(limits(fs.readFileSync(path.join(ROOT, 'test', 'differential', 'channel_array_forms.pj'), 'utf8')), []);
  // A read stored by a declaration or used in an expression fails javac; a later assignment leaves the elements null.
  assert.deepEqual(limits([
    'import std.*;',
    'public void main(string[] args) {',
    '    chan<int>[] cs = new chan<int>[1];',
    '    chan<int>[] ds;',
    '    ds = new chan<int>[1];',
    '    int x;',
    '    par { cs[0].write(1); x = cs[0].read(); }',
    '    par { cs[0].write(1); { int y = cs[0].read(); println(y); } }',
    '    par { cs[0].write(1); println(cs[0].read() + 1); }',
    '}',
  ].join('\n')), [5, 8, 9]);
});

test('the example pipeline over a channel array is clean, complete and drawn element by element', () => {
  const file = path.join(ROOT, 'examples', 'channel_array_pipeline.pj');
  const model = translate(file);
  assert.deepEqual(model.unsupported, []);
  const view = programView(analyzeSource(fs.readFileSync(file, 'utf8'), file).model);
  assert.deepEqual(view.channels.filter((c) => c.name.startsWith('links[')).map((c) => c.name), ['links[0]', 'links[1]', 'links[2]', 'links[3]', 'links[4]']);
  assert.ok(view.channels.filter((c) => c.name.startsWith('links[')).every((c) => c.writers.length === 1 && c.readers.length === 1));
});

test('a fork takes only what the parent of its instance sends: several arguments varying across instances still give FDR a model it accepts', async () => {
  const programs: Record<string, string> = {
    // f(1, 2) and f(2, 1): the product of the fork's fields holds (1, 1) and (2, 2), which no parent sends.
    fork_product: `import std.*;
void f(int n, int m) {
    int x = 0;
    par {
        x = 1;
        par for (int i = 0; i < n + m; i++) println(i);
    }
}
public void main(string[] args) {
    par { f(1, 2); f(2, 1); }
    println("done");
}
`,
    // Two arguments changing together through the recursion.
    fork_two_param_rec: `import std.*;
void rec(int a, int b, chan<int>.write out) {
    if (a == 0) out.write(b);
    else {
        chan<int> m;
        int v;
        par { rec(a - 1, b + 1, m.write); { v = m.read(); out.write(v); } }
    }
}
public void main(string[] args) {
    chan<int> r;
    int v;
    par { rec(3, 0, r.write); v = r.read(); }
    println(v);
}
`,
    // Mutual recursion through par: an instance function is defined only for the instances that exist.
    fork_mutual_rec: `import std.*;
void pb(int n, chan<int>.write out) {
    chan<int> m;
    int v;
    par { pa(n - 1, m.write); { v = m.read(); out.write(v + 1); } }
}
void pa(int n, chan<int>.write out) {
    if (n <= 0) out.write(0);
    else pb(n, out);
}
public void main(string[] args) {
    chan<int> r;
    int v;
    par { pa(3, r.write); v = r.read(); }
    println(v);
}
`,
  };
  for (const [name, source] of Object.entries(programs)) {
    const model = fromSource(name, source);
    assert.deepEqual(model.unsupported, [], name);
    assert.match(model.text, /\npj_forkset_\w+\(1\) = /, `${name}: the slots take their fields from a set per instance`);
    const run = await recordedRun(name, model);
    const report = explain(model, run, { uri: 'file:///x.pj', documentVersion: 1 });
    // All of these build and finish with the real compiler.
    assert.deepEqual(report.checks.map((c) => [c.id, c.status]), [['deadlock-free', 'passed'], ['no-runtime-errors', 'passed'], ['terminates', 'passed']], name);
  }
  // Per instance: f's first instance sends (1, 2) only, its second (2, 1) only.
  assert.match(fromSource('fork_product', programs.fork_product).text, /\npj_forkset_f_4\(1\) = \{ 2\.1 \}\npj_forkset_f_4\(2\) = \{ 1\.2 \}\n/);
});

test('a par for that runs no iteration in an instance is named: this ProcessJ build never ends it', () => {
  const model = fromSource('empty_par_for', `import std.*;
void stages(int n) {
    par for (int i = 0; i < n - 1; i++) println(i);
}
public void main(string[] args) {
    stages(1);
    stages(2);
    println("done");
}
`);
  assert.deepEqual(model.unsupported, []);
  const named = model.warnings.filter((w) => w.code === 'compiler/empty-par-for');
  assert.equal(named.length, 1);
  assert.equal(named[0].at?.span.start.line, 2);
  assert.match(named[0].message, /^no iteration of this par for runs in stages \(n = 1\) — the model lets it end at once, as the language says; this ProcessJ build never ends a par for that starts no process/);
  // One iteration or more: nothing to name.
  const fine = fromSource('one_par_for', 'import std.*;\npublic void main(string[] args) {\n    par for (int i = 0; i < 1; i++) println(i);\n}\n');
  assert.deepEqual(fine.warnings.filter((w) => w.code === 'compiler/empty-par-for'), []);
});

test('the stages of an unfolded recursion are named by their known arguments in what FDR says', () => {
  const model = fromSource('alt_fifo_names', `import std.*;
public void id(chan<int>.read in, chan<int>.write out) {
    int v = 0;
    while (v != -1) { v = in.read(); out.write(v); }
}
void sink1(chan<int>.read in) { int v; v = in.read(); }
void producer(chan<int>.write out, int limit) {
    for (int x = 0; x < limit; x++) out.write(x);
    out.write(-1);
}
void consumer(chan<int>.read in) { int x = 0; while (x != -1) { x = in.read(); } }
public void altFIFO(int size, chan<int>.read in, chan<int>.write out) {
    if (size <= 1) sink1(in);
    else {
        chan<int> middle;
        par { id(in, middle.write); altFIFO(size - 1, middle.read, out); }
    }
}
public void main(string[] args) {
    chan<int> d3, d4;
    par { producer(d3.write, 3); consumer(d4.read); altFIFO(4, d3.read, d4.write); }
}
`);
  assert.deepEqual(model.unsupported, []);
  const names = processNames(model, 'file:///x.pj').filter((n): n is string => !!n && /altFIFO|^id/.test(n));
  assert.deepEqual(names.sort(), ['altFIFO (size = 1)', 'altFIFO (size = 2)', 'altFIFO (size = 3)', 'altFIFO (size = 4)', 'id of altFIFO (size = 2)', 'id of altFIFO (size = 3)', 'id of altFIFO (size = 4)']);
});

test('an element picked at run time is drawn as a possible use of every element, and a replicated alt reads them all', () => {
  const runtimeIndex = analyzeSource(`import std.*;
void src(chan<int>[] cs, int n) {
    for (int k = 0; k < n; k++) cs[k].write(k);
}
void sink(chan<int>.read i) { int x; x = i.read(); println(x); }
public void main(string[] args) {
    chan<int>[] cs = new chan<int>[3];
    par { src(cs, 3); sink(cs[0].read); sink(cs[1].read); sink(cs[2].read); }
}
`, path.join(os.tmpdir(), 'runtime_index.pj'));
  const view = programView(runtimeIndex.model);
  const label = (id: string): string => view.nodes.find((n) => n.id === id)!.label;
  const elements = view.channels.filter((c) => /^cs\[\d\]$/.test(c.name));
  assert.deepEqual(elements.map((c) => `${c.name}: ${c.writers.map((e) => `${label(e.node)} ${e.confidence}`).join()} -> ${c.readers.map((e) => label(e.node)).join()}`), [
    'cs[0]: src(cs, 3) conditional -> sink(cs[0])',
    'cs[1]: src(cs, 3) conditional -> sink(cs[1])',
    'cs[2]: src(cs, 3) conditional -> sink(cs[2])',
  ]);
  assert.ok(!view.nodes.some((n) => n.kind === 'stub'), 'no element is left without a writer');

  const alt = analyzeSource(`import std.*;
void w(chan<int>.write o, int v) { o.write(v); }
public void main(string[] args) {
    chan<int>[] cs = new chan<int>[3];
    int x;
    par {
        par for (int i = 0; i < 3; i++) { w(cs[i].write, i); }
        for (int n = 0; n < 3; n++) {
            alt (int j = 0; j < 3; j++) { x = cs[j].read() : println(x); }
        }
    }
}
`, path.join(os.tmpdir(), 'alt_replicated.pj'));
  const altView = programView(alt.model);
  const reader = altView.nodes.find((n) => n.label === 'cs[j].read()')!;
  assert.deepEqual(altView.channels.filter((c) => /^cs\[\d\]$/.test(c.name)).map((c) => c.readers.map((e) => e.node)), [[reader.id], [reader.id], [reader.id]]);
  // The branch that is nothing but the par for is its container: no second box of the same par for inside it.
  assert.equal(altView.nodes.filter((n) => n.label === 'par for i < 3').length, 1);
});

test('a loop counting down over an array keeps its exit value inside the modelled integers', () => {
  const model = fromSource('count_down', `import std.*;
void rd(chan<int>[] cs, int n) {
    int x;
    for (int k = n - 1; k >= 0; k--) { x = cs[k].read(); println(x); }
}
void wr(chan<int>[] cs, int n) { par for (int k = 0; k < n; k++) cs[k].write(k); }
public void main(string[] args) {
    chan<int> cs[] = new chan<int>[3];
    par { wr(cs, 3); rd(cs, 3); }
}
`);
  assert.deepEqual(model.unsupported, []);
  assert.ok(model.intRange.lo <= -1, `${model.intRange.lo}..${model.intRange.hi}`);
});
