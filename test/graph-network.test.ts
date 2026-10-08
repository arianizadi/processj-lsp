import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { countText, findChannel, findOperations, findProcess, locate, viewProcesses, type NetworkView } from '../src/graph/network';
import type { ProcessPath } from '../src/verification';
import { analyzeFile, analyzeSource, at, channelEdges, FIXTURES, nodeNamed, programView, ROOT, viewOf } from './graph-helpers';

const brief = (path: ProcessPath | undefined): string => (path ?? []).map((step) => `${step.kind}@${at(step.site.span)}${step.index === undefined ? '' : `#${step.index}`}`).join(' / ');

test('commstime is the hand-drawn ring: delta -a-> consume, delta -b-> succ -c-> prefix -d-> delta', () => {
  const { model } = analyzeFile(path.join(FIXTURES, 'commstime.pj'));
  const view = programView(model);
  const processes = view.nodes.filter((node) => node.path?.length === 1 && !node.own).map((node) => node.name);
  assert.deepEqual(processes, ['delta(d, a, b)', 'succ(b, c)', 'prefix(0, c, d)', 'consume(a)']);
  // delta runs a par of its own: drawn inside it, writing the outer channels a and b.
  const delta = nodeNamed(view, 'delta(d, a, b)');
  assert.equal(delta.kind, 'group');
  const inside = view.nodes.filter((node) => node.parent === delta.id).map((node) => `${node.label}${node.own ? ' (own)' : ''}`);
  assert.deepEqual(inside, ['own code (own)', 'out1.write(l)', 'out2.write(l)']);
  // delta's own read of d is drawn from its own-code box, so the arrow on delta's border is never needed for it.
  const d = view.channels.find((channel) => channel.name === 'd')!;
  const own = view.nodes.find((node) => node.own)!;
  assert.deepEqual(view.edges.filter((edge) => edge.channel === d.id).map((edge) => edge.to), [own.id]);
  assert.deepEqual(own.path, delta.path, 'the same process as its container');
  assert.deepEqual(channelEdges(view, 'a'), ['branch 1 of delta -> consume(a)']);
  assert.deepEqual(channelEdges(view, 'b'), ['branch 2 of delta -> succ(b, c)']);
  assert.deepEqual(channelEdges(view, 'c'), ['succ(b, c) -> prefix(0, c, d)']);
  assert.deepEqual(channelEdges(view, 'd'), ['prefix(0, c, d) -> delta(d, a, b)']);
  // `out2.write(l)` is guarded by an if; every other operation runs whenever its loop's first test does.
  const edge = (name: string) => view.edges.find((entry) => entry.channel === view.channels.find((channel) => channel.name === name)!.id)!;
  assert.equal(edge('b').confidence, 'conditional');
  for (const name of ['a', 'c', 'd']) assert.equal(edge(name).confidence, 'exact', name);
  assert.equal(edge('a').label, 'a : long');
  // Parameters are bound to the real channels: no channel named in, out1 or out2 in the program view.
  assert.deepEqual(view.channels.map((channel) => channel.name).sort(), ['a', 'b', 'c', 'd']);
});

test('process paths follow the spawn-site rule of src/verification.ts exactly', () => {
  const { model, program } = analyzeFile(path.join(FIXTURES, 'commstime.pj'));
  const view = programView(model);
  const main = program.decls.find((decl) => decl.kind === 'ProcDecl' && decl.name.name === 'main');
  assert.ok(main?.kind === 'ProcDecl' && main.body);
  const par = main.body.stmts[1];
  assert.equal(par.kind, 'ParBlock');
  assert.deepEqual(nodeNamed(view, 'delta(d, a, b)').path, [{ kind: 'branch', site: { uri: model.uri, span: par.body.stmts[0].span }, index: 1 }]);
  assert.deepEqual(nodeNamed(view, 'consume(a)').path, [{ kind: 'branch', site: { uri: model.uri, span: par.body.stmts[3].span }, index: 4 }]);
  // A call passed through on the way to a par adds the Invocation (not the statement).
  const deltaCall = par.body.stmts[0];
  assert.equal(deltaCall.kind, 'ExprStmt');
  assert.equal(brief(nodeNamed(view, 'branch 1 of delta').path), 'branch@43:5#1 / call@43:5 / branch@25:7#1');
  assert.deepEqual(nodeNamed(view, 'branch 1 of delta').path?.[1], { kind: 'call', site: { uri: model.uri, span: deltaCall.expr.span } });
  // The root is [] in its own view; delta's own view starts again from [].
  assert.deepEqual(view.nodes.find((node) => !node.parent && node.kind === 'group')?.path, []);
  assert.equal(brief(nodeNamed(viewOf(model, 'delta'), 'branch 1').path), 'branch@25:7#1');
});

test('santa: nested par enroll branches, shared channels drawn from the boxes that use them', () => {
  const { model } = analyzeFile(path.join(FIXTURES, 'santa.pj'));
  const view = programView(model);
  assert.equal(brief(nodeNamed(view, 'reindeer(1, seed + 1, …)').path), 'branch@302:9#1 / branch@308:13#2 / branch@311:17#2');
  assert.equal(brief(nodeNamed(view, 'santa(…, knock, …)').path), 'branch@302:9#1 / branch@303:13#1');
  assert.equal(brief(nodeNamed(view, 'elf(2, …, elves_a, elves_b, …)').path), 'branch@330:9#2 / branch@335:13#3');
  assert.equal(brief(nodeNamed(view, 'display(report)').path), 'branch@353:9#3');
  // Every elf writes elf_santa: one arrow from their par box to santa.
  assert.deepEqual(channelEdges(view, 'elf_santa'), ['branch 2 -> santa(…, knock, …)']);
  // santa and every reindeer write report: their box and the elves' box meet in a junction before display.
  assert.deepEqual(channelEdges(view, 'report'), ['branch 1 -> *', 'branch 2 -> *', '* -> display(report)']);
  // The barriers link to the par boxes that enroll on them.
  assert.deepEqual(channelEdges(view, 'santa_reindeer').map((edge) => edge.split(' -> ')[1]), ['branch 1']);
  assert.deepEqual(channelEdges(view, 'just_reindeer').map((edge) => edge.split(' -> ')[1]), ['branch 2 of branch 1']);
  // The real writers are still known per process.
  const report = view.channels.find((channel) => channel.name === 'report')!;
  assert.equal(report.writers.length, 8);
  assert.equal(report.readers.length, 1);
});

test('shared channels meet in a junction: N writers -> junction -> M readers', () => {
  const shared = programView(analyzeFile(path.join(FIXTURES, 'sharedchan.pj')).model);
  assert.deepEqual(channelEdges(shared, 'c'), ['writer(c) -> *', 'writer(c) -> *', '* -> reader(1, c)', '* -> reader(2, c)', '* -> reader(3, c)']);
  assert.deepEqual(shared.channels[0].shared, { read: true, write: true });
  const writers = programView(analyzeFile(path.join(FIXTURES, 'sharedwrite.pj')).model);
  assert.deepEqual(channelEdges(writers, 'c'), ['writer(1, c) -> *', 'writer(2, c) -> *', 'writer(3, c) -> *', '* -> reader(c)']);
  assert.deepEqual(writers.channels[0].shared, { read: false, write: true });
});

test('a barrier is a node joined to the processes enrolled on it', () => {
  const { model } = analyzeFile(path.join(ROOT, 'test', 'differential', 'barrier_enroll.pj'));
  const view = programView(model);
  const barrier = view.nodes.find((node) => node.kind === 'barrier');
  assert.equal(barrier?.label, 'b');
  assert.deepEqual(channelEdges(view, 'b'), ['barrier b -> worker(b, 1)', 'barrier b -> worker(b, 2)']);
  assert.ok(view.edges.filter((edge) => edge.kind === 'barrier').every((edge) => edge.tags.includes('enrolled') && edge.tags.includes('sync')));
});

test('par for is one replicated box with its count; a multi-statement body is one process per statement', () => {
  const source = [
    'const int N = 4;',
    'void worker(int id, chan<int>.write out) { out.write(id); }',
    'void sink(int n, chan<int>.read in) { for (int i = 0; i < n; i++) { int v = in.read(); } }',
    'public void main(string[] args) {',
    '    shared write chan<int> c;',
    '    int limit = 7;',
    '    par {',
    '        par for (int i = 0; i < N; i++) worker(i, c.write);',
    '        sink(N, c.read);',
    '    }',
    '    par for (int j = 0; j < limit; j++) {',
    '        int x = j;',
    '        println(x);',
    '    }',
    '    int k = args.size;',
    '    par for (int j = 0; j < k; j++) { worker(j, c.write); }',
    '}',
  ].join('\n');
  const view = programView(analyzeSource(source, '/virtual/replicated.pj').model);
  const workers = view.nodes.filter((node) => node.label.startsWith('worker'));
  assert.deepEqual(workers.map((node) => node.replicated?.text), ['×4', '×N']);
  assert.equal(brief(workers[0].path), 'branch@8:9#1 / par-for@8:9');
  assert.equal(workers[0].path?.[1].index, undefined, 'drawn once for every iteration');
  // `j < limit` with `int limit = 7;` straight before: a known count.
  const body = view.nodes.find((node) => node.group === 'par-for');
  assert.equal(body?.replicated?.text, '×7');
  const statements = view.nodes.filter((node) => node.parent === body?.id);
  assert.deepEqual(statements.map((node) => node.badge), ['stmt 1', 'stmt 2']);
  assert.equal(brief(statements[1].path), 'par-for@11:5 / branch@13:9#2');
});

test('alt guards are conditional reads; constants decide loops and ifs', () => {
  const view = programView(analyzeFile(path.join(FIXTURES, 'alttest.pj')).model);
  const edge = view.edges.find((entry) => entry.label?.startsWith('c1'));
  assert.equal(edge?.confidence, 'conditional');
  assert.ok(edge?.tags.includes('alt'));
  assert.ok(view.notes.some((note) => note.includes("'c2'")) || !view.channels.some((channel) => channel.name === 'c2' && channel.edges.length), 'c2 is passed but never used');
  const constant = analyzeSource([
    'void producer(chan<int>.write out) { if (true) out.write(1); while (false) out.write(2); }',
    'public void main(string[] args) { chan<int> c; par { producer(c.write); int v = c.read(); } }',
  ].join('\n'), '/virtual/constant.pj').model;
  const operations = programView(constant).nodes.find((node) => node.label === 'producer(c)')!.operations;
  assert.deepEqual(operations.map((operation) => operation.confidence), ['exact'], 'the dead while body is not an operation; if (true) is certain');
});

test('recursion is drawn once; an unresolved call is unknown', () => {
  const source = [
    'void ping(int n, chan<int>.write out) {',
    '    chan<int> inner;',
    '    par {',
    '        out.write(n);',
    '        ping(n - 1, inner.write);',
    '        { int v = inner.read(); }',
    '    }',
    '}',
    'public void main(string[] args) {',
    '    chan<int> c;',
    '    par { ping(3, c.write); mystery(c.read); }',
    '}',
  ].join('\n');
  const view = programView(analyzeSource(source, '/virtual/recursive.pj').model);
  const outer = nodeNamed(view, 'ping(3, c)');
  assert.equal(outer.kind, 'group', 'the first call is expanded');
  const recursive = view.nodes.find((node) => node.call?.collapsed === 'recursion');
  assert.equal(recursive?.label, 'ping(n - 1, inner)');
  const mystery = nodeNamed(view, 'mystery(c)');
  assert.equal(mystery.confidence, 'unknown');
  assert.equal(view.edges.find((edge) => edge.to === mystery.id)?.confidence, 'unknown');
});

test('a procedure view has its channel and barrier parameters as boundary ports', () => {
  const { model } = analyzeFile(path.join(FIXTURES, 'commstime.pj'));
  const delta = viewOf(model, 'delta');
  assert.deepEqual(delta.nodes.filter((node) => node.kind === 'port').map((node) => `${node.label}:${node.port?.direction}`), ['in:in', 'out1:out', 'out2:out']);
  assert.deepEqual(channelEdges(delta, 'in'), ['port in -> delta']);
  assert.deepEqual(channelEdges(delta, 'out1'), ['branch 1 -> port out1']);
  const bar = viewOf(analyzeFile(path.join(FIXTURES, 'bartest.pj')).model, 'bar');
  assert.deepEqual(bar.nodes.filter((node) => node.kind === 'port').map((node) => `${node.label}:${node.port?.direction}`), ['b:sync', 'w:out']);
});

test('placement helpers find boxes, arrows and statements for verification results', () => {
  const { model } = analyzeFile(path.join(FIXTURES, 'commstime.pj'));
  const view: NetworkView = programView(model);
  const branch = nodeNamed(view, 'branch 1 of delta');
  assert.equal(findProcess(view, branch.path!)?.node.id, branch.id);
  // A path below what is drawn lands on the nearest drawn ancestor, marked approximate.
  const deeper = [...branch.path!, { kind: 'call' as const, site: { uri: model.uri, span: { start: { line: 99, col: 0 }, end: { line: 99, col: 1 } } } }, { kind: 'branch' as const, site: { uri: model.uri, span: { start: { line: 99, col: 2 }, end: { line: 99, col: 3 } } }, index: 1 }];
  assert.deepEqual(findProcess(view, deeper), { node: branch, exact: false });
  const a = view.channels.find((channel) => channel.name === 'a')!;
  assert.equal(findChannel(view, a.ref)?.channel.id, a.id);
  // Owner written with the call steps left out still finds the channel.
  assert.equal(findChannel(view, { ...a.ref, owner: [] })?.channel.id, a.id);
  const write = branch.operations[0];
  assert.deepEqual(findOperations(view, write.at).map((entry) => entry.node.id), [branch.id]);
  // One entry point for a process, a channel or a statement, in that order of preference.
  assert.equal(locate(view, { process: branch.path })?.node?.id, branch.id);
  assert.equal(locate(view, { channel: a.ref })?.channel?.id, a.id);
  assert.deepEqual(locate(view, { at: write.at }), { node: branch, channel: a, exact: false });
  // A par for iteration with a concrete index matches the replicated box.
  const replicated = programView(analyzeSource('void w() { }\npublic void main(string[] args) { par for (int i = 0; i < 3; i++) w(); }', '/virtual/each.pj').model);
  const box = replicated.nodes.find((node) => node.replicated)!;
  assert.equal(findProcess(replicated, [{ ...box.path![0], index: 2 }])?.node.id, box.id);
});

test('every node and edge has a stable id and the same input gives the same model', () => {
  const first = analyzeFile(path.join(FIXTURES, 'santa.pj')).model;
  const second = analyzeFile(path.join(FIXTURES, 'santa.pj')).model;
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  for (const view of first.views) {
    const ids = [...view.nodes.map((node) => node.id), ...view.edges.map((edge) => edge.id)];
    assert.equal(new Set(ids).size, ids.length, `duplicate ids in ${view.label}`);
    for (const node of view.nodes) if (node.kind === 'process') assert.ok(node.source, `${node.name} has a source`);
  }
});

/** Confidence of the drawn arrows of each named channel. */
function arrowConfidence(view: NetworkView): Record<string, string> {
  return Object.fromEntries(view.channels.filter((channel) => channel.kind === 'channel').map((channel) => [channel.name, [...new Set(channel.edges.map((id) => view.edges.find((edge) => edge.id === id)!.confidence))].join('/')]));
}

test('an operation after a conditional return, break or continue, or after a loop only a break ends, is conditional', () => {
  const source = [
    'void early(int k, chan<int>.write out) { if (k > 3) return; out.write(k); }',
    'void looper(chan<int>.read in, chan<int>.write done) { while (true) { int x = in.read(); if (x > 5) break; } done.write(1); }',
    'void forever(chan<int>.read in, chan<int>.write done) { while (true) { int x = in.read(); } done.write(2); }',
    'void skipper(chan<int>.read in, chan<int>.write out) { for (int i = 0; i < 3; i++) { int x = in.read(); if (x < 0) continue; out.write(x); } }',
    'void labelled(chan<int>.read in, chan<int>.write out) { outer: while (true) { int x = in.read(); if (x > 1) break outer; } out.write(3); }',
    'void plain(chan<int>.write out) { if (true) { out.write(4); } out.write(5); }',
    'public void main(string[] args) {',
    '    chan<int> a, b, c, d, e, f, g, h, i, j;',
    '    par {',
    '        early(7, a.write);',
    '        { int v = a.read(); }',
    '        looper(b.read, c.write);',
    '        { b.write(9); int w = c.read(); }',
    '        forever(d.read, e.write);',
    '        { d.write(1); int z = e.read(); }',
    '        skipper(f.read, g.write);',
    '        { f.write(1); int y = g.read(); }',
    '        labelled(h.read, i.write);',
    '        { h.write(2); int u = i.read(); }',
    '        plain(j.write);',
    '        { int s = j.read(); int t = j.read(); }',
    '    }',
    '}',
  ].join('\n');
  const view = programView(analyzeSource(source, '/virtual/exits.pj').model);
  const confidence = arrowConfidence(view);
  // `if (k > 3) return;` may leave before the write; the guarded `if (k <= 3) out.write(k)` would say the same.
  assert.equal(confidence.a, 'conditional');
  // done.write runs only when the break is taken; after an endless loop with no break it never runs.
  assert.equal(confidence.c, 'conditional');
  assert.equal(confidence.e, 'conditional');
  // A `continue` under an if skips the rest of the iteration.
  assert.equal(confidence.g, 'conditional');
  assert.equal(confidence.i, 'conditional');
  // A break or loop that cannot leave the block changes nothing: `if (true)` always runs, nothing exits.
  assert.equal(confidence.j, 'exact');
  // The reads before the exits stay as certain as they were.
  assert.equal(confidence.b, 'exact');
  assert.equal(confidence.d, 'exact');
});

test('a call under a condition makes everything inside the expanded callee conditional', () => {
  const source = [
    'void tee(chan<int>.read in, chan<int>.write a, chan<int>.write b) { int x = in.read(); par { a.write(x); b.write(x); } }',
    'public void main(string[] args) {',
    '    chan<int> s, p, q;',
    '    boolean go = args.size > 5;',
    '    par {',
    '        { if (go) tee(s.read, p.write, q.write); }',
    '        s.write(1);',
    '        { int u = p.read(); int v = q.read(); }',
    '    }',
    '}',
  ].join('\n');
  const view = programView(analyzeSource(source, '/virtual/conditional-call.pj').model);
  assert.deepEqual(arrowConfidence(view), { s: 'conditional', p: 'conditional', q: 'conditional' });
  for (const name of ['branch 1 of tee', 'branch 2 of tee']) assert.equal(nodeNamed(view, name).confidence, 'conditional', name);
  // The branch that holds the call keeps the style of a branch, not of a procedure.
  assert.equal(nodeNamed(view, 'branch 1').group, 'branch');
  // Called unconditionally, the same callee's network is exact.
  const plain = programView(analyzeSource(source.replace('if (go) tee', 'tee'), '/virtual/plain-call.pj').model);
  assert.deepEqual(arrowConfidence(plain), { s: 'exact', p: 'exact', q: 'exact' });
});

test('a par for body is exact only when the par for has an iteration', () => {
  const source = [
    'const int NONE = 0;',
    'const int SOME = 3;',
    'void fan(int n, shared chan<int>.write out) { par for (int i = 0; i < n; i++) out.write(i); }',
    'public void main(string[] args) {',
    '    shared write chan<int> a, b, c;',
    '    par {',
    '        par for (int i = 0; i < NONE; i++) { a.write(i); }',
    '        par for (int i = 0; i < SOME; i++) { b.write(i); }',
    '        fan(2, c.write);',
    '        { int x = a.read(); int y = b.read(); int z = c.read(); }',
    '    }',
    '}',
  ].join('\n');
  const { model } = analyzeSource(source, '/virtual/par-for-count.pj');
  const view = programView(model);
  assert.deepEqual(view.nodes.filter((node) => node.replicated).map((node) => `${node.label} ${node.replicated!.text} ${node.confidence}`), ['a.write(i) ×0 conditional', 'b.write(i) ×3 exact', 'out.write(i) ×N conditional']);
  assert.deepEqual(arrowConfidence(view), { a: 'conditional', b: 'exact', c: 'conditional' });
  // The parameter is a shared writing end: only its writing side is shared.
  assert.deepEqual(viewOf(model, 'fan').channels[0].shared, { read: false, write: true });
});

test('branches of nested pars and of several pars are named after their owner', () => {
  const source = [
    'public void main(string[] args) {',
    '    chan<int> a, b, c;',
    '    par {',
    '        par { a.write(1); b.write(2); }',
    '        { int x = a.read(); int y = b.read(); c.write(x + y); }',
    '    }',
    '    par { int z = c.read(); println("z"); }',
    '}',
  ].join('\n');
  const view = programView(analyzeSource(source, '/virtual/nested-names.pj').model);
  const names = view.nodes.filter((node) => node.path && node.path.length > 0).map((node) => node.name);
  assert.deepEqual(names, ['branch 1 of par at line 3', 'branch 1 of branch 1 of par at line 3', 'branch 2 of branch 1 of par at line 3', 'branch 2 of par at line 3', 'branch 1 of par at line 7', 'println("z")']);
  assert.equal(new Set(names).size, names.length, 'every process has its own name');
});

test('barrier links say which processes are enrolled; a sync nothing enrolled is marked', () => {
  const nested = [
    'void worker(int id, barrier b) { b.sync(); }',
    'public void main(string[] args) {',
    '    barrier b;',
    '    par enroll (b) {',
    '        worker(1, b);',
    '        { par { worker(2, b); worker(3, b); } }',
    '    }',
    '}',
  ].join('\n');
  const view = programView(analyzeSource(nested, '/virtual/nested-enroll.pj').model);
  const edges = view.edges.filter((edge) => edge.kind === 'barrier').map((edge) => `${view.nodes.find((node) => node.id === edge.to)!.name}${edge.tags.includes('not enrolled') ? ' (not enrolled)' : ''}`);
  // The barrier counts worker 1 and the branch running the inner par; workers 2 and 3 sync without being counted.
  assert.deepEqual(edges, ['worker(1, b)', 'branch 2', 'worker(2, b) (not enrolled)', 'worker(3, b) (not enrolled)']);
  assert.equal(view.edges.find((edge) => edge.tags.includes('not enrolled'))?.label, 'not enrolled');
  const barrier = view.nodes.find((node) => node.kind === 'barrier')!;
  assert.deepEqual(barrier.facts, ['2 processes enrolled', 'worker(2, b), worker(3, b) sync on it without being enrolled: the barrier counts only enrolled processes']);
  // No enroll at all: every sync is marked; enrolled processes elsewhere (santa) are drawn as before.
  const bare = programView(analyzeSource('public void main(string[] args) { barrier b; par { b.sync(); b.sync(); } }', '/virtual/bare-sync.pj').model);
  assert.ok(bare.edges.filter((edge) => edge.kind === 'barrier').every((edge) => edge.tags.includes('not enrolled')));
  const santa = programView(analyzeFile(path.join(FIXTURES, 'santa.pj')).model);
  assert.ok(santa.edges.filter((edge) => edge.kind === 'barrier').every((edge) => edge.tags.includes('enrolled') && !edge.tags.includes('not enrolled')));
  assert.deepEqual(santa.nodes.filter((node) => node.kind === 'barrier').map((node) => `${node.label}: ${node.facts[0]}`), ['santa_reindeer: 4 processes enrolled', 'just_reindeer: 3 processes enrolled']);
  // A barrier parameter is enrolled by the caller: no mark in the procedure's own view.
  const bar = viewOf(analyzeFile(path.join(FIXTURES, 'bartest.pj')).model, 'bar');
  assert.ok(bar.edges.every((edge) => !edge.tags.includes('not enrolled')));
});

test('an end kept in a local is that channel\'s end', () => {
  const view = programView(analyzeFile(path.join(ROOT, 'test', 'differential', 'end_in_variable.pj')).model);
  assert.deepEqual(view.channels.map((channel) => channel.name), ['c']);
  assert.deepEqual(channelEdges(view, 'c'), ['branch 1 -> println(…)']);
  assert.deepEqual(view.notes, []);
});

test('process counts count processes, a par for box once per iteration', () => {
  const source = [
    'void w(chan<int>.write out) { out.write(1); }',
    'public void main(string[] args) {',
    '    shared write chan<int> c;',
    '    par {',
    '        par for (int i = 0; i < 4; i++) w(c.write);',
    '        { for (int i = 0; i < 4; i++) { int x = c.read(); } }',
    '    }',
    '}',
  ].join('\n');
  const view = programView(analyzeSource(source, '/virtual/count.pj').model);
  // The par for itself, its four iterations, and the reader.
  assert.deepEqual(viewProcesses(view), { count: 6, unsized: 0 });
  assert.equal(countText(viewProcesses(view)), '6 processes');
  assert.equal(countText({ count: 2, unsized: 1 }), '2 processes and a par for of unknown size');
  assert.deepEqual(viewProcesses(programView(analyzeFile(path.join(FIXTURES, 'commstime.pj')).model)), { count: 6, unsized: 0 });
});
