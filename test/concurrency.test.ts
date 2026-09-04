import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeProcedureEffects } from '../src/checker/effects';
import { check } from '../src/checker/checker';
import { DeclIndex } from '../src/checker/index';
import { buildConcurrencyGraph, formatConcurrencyMarkdown } from '../src/concurrency';
import { channelInlays } from '../src/inlays';
import { parse } from '../src/parser/parser';

function analyze(source: string) {
  const parsed = parse(source);
  assert.deepEqual(parsed.errors, []);
  const index = new DeclIndex();
  index.addProgram(parsed.program, 'graph.pj');
  const checked = check(parsed.program, { index, text: source, unresolvedImports: true });
  const effects = analyzeProcedureEffects([{ program: parsed.program, checked, file: 'graph.pj' }]);
  return { parsed, index, checked, effects };
}

test('the concurrency graph connects procedures, branches, calls and channels with source locations', () => {
  const source = [
    'void produce(chan<int>.write output) { output.write(42); }',
    'public void main(string[] args) {',
    '    chan<int> values;',
    '    par {',
    '        produce(values.write);',
    '        println(values.read());',
    '    }',
    '}',
  ].join('\n');
  const { parsed, index, checked, effects } = analyze(source);
  const graph = buildConcurrencyGraph(parsed.program, checked, index, { uri: 'file:///graph.pj', effects: effects.summaries });

  assert.ok(graph.nodes.some((node) => node.kind === 'procedure' && node.label === 'produce'));
  assert.equal(graph.nodes.filter((node) => node.kind === 'parallel').length, 1);
  assert.equal(graph.nodes.filter((node) => node.kind === 'branch').length, 2);
  const values = graph.nodes.find((node) => node.kind === 'channel' && node.label === 'values');
  assert.ok(values);
  assert.ok(graph.edges.some((edge) => edge.kind === 'call'));
  assert.ok(graph.edges.some((edge) => edge.kind === 'pass-write' && edge.to === values.id));
  assert.ok(graph.edges.some((edge) => edge.kind === 'read' && edge.to === values.id));
  assert.ok(Object.values(graph.procedureEffects).flat().some((effect) => effect.label === 'writes channel #1'));
  assert.doesNotThrow(() => JSON.stringify(graph));

  const report = formatConcurrencyMarkdown('graph.pj', graph);
  assert.match(report, /flowchart LR/);
  assert.match(report, /Procedure effects/);
  assert.match(report, /produce/);
  assert.match(report, /-->\|"produce\(chan‹int›\.write\)"\|/, 'Mermaid-sensitive call punctuation is contained in a quoted edge label');
  assert.doesNotMatch(report, /-->\|produce\(/);
});

test('unreachable operations are absent from the exact execution graph', () => {
  const source = [
    'void ignored() {',
    '    chan<int> channel;',
    '    return;',
    '    int value = channel.read();',
    '}',
  ].join('\n');
  const { parsed, index, checked, effects } = analyze(source);
  const graph = buildConcurrencyGraph(parsed.program, checked, index, { uri: 'file:///graph.pj', effects: effects.summaries });

  assert.equal(graph.edges.some((edge) => edge.kind === 'read' || edge.kind === 'write'), false);
  assert.equal(graph.procedureEffects[graph.nodes.find((node) => node.kind === 'procedure')!.id]?.some((effect) => effect.label === 'reads channels'), false);
});

test('deadlock diagnostics and graph facts retain every causal wait location', () => {
  const source = [
    'public void main(string[] args) {',
    '    chan<int> left;',
    '    chan<int> right;',
    '    par {',
    '        { left.write(1); int x = right.read(); }',
    '        { right.write(1); int y = left.read(); }',
    '    }',
    '}',
  ].join('\n');
  const { parsed, index, checked, effects } = analyze(source);
  const diagnostic = checked.diagnostics.find((entry) => entry.code === 'pj/par-deadlock');
  assert.ok(diagnostic);
  assert.equal(diagnostic.related?.length, 2);
  assert.match(diagnostic.message, /Each listed branch is blocked/);
  assert.equal(checked.deadlocks.length, 1);
  assert.equal(checked.deadlocks[0].cause, 'circular-wait');
  assert.deepEqual(checked.deadlocks[0].waits.map((wait) => [wait.branch, wait.operation, wait.channel.name]), [[1, 'write', 'left'], [2, 'write', 'right']]);

  const graph = buildConcurrencyGraph(parsed.program, checked, index, { uri: 'file:///deadlock.pj', effects: effects.summaries });
  assert.equal(graph.deadlocks.length, 1);
  assert.equal(graph.deadlocks[0].waits.length, 2);
  assert.match(formatConcurrencyMarkdown('deadlock.pj', graph), /Circular wait/);
});

test('concurrency graph distinguishes multiple missing peers from a circular wait', () => {
  const source = [
    'public void main(string[] args) {',
    '    shared chan<int> left;',
    '    shared chan<int> right;',
    '    par {',
    '        { left.write(1); right.write(1); }',
    '        { right.write(2); left.write(2); }',
    '    }',
    '}',
  ].join('\n');
  const { parsed, index, checked, effects } = analyze(source);
  assert.equal(checked.deadlocks.length, 1);
  assert.equal(checked.deadlocks[0].cause, 'missing-peer');
  assert.equal(checked.diagnostics.filter((entry) => entry.code === 'pj/channel-no-reader').length, 2);

  const graph = buildConcurrencyGraph(parsed.program, checked, index, { uri: 'file:///missing-peers.pj', effects: effects.summaries });
  assert.equal(graph.deadlocks[0]?.cause, 'missing-peer');
  const report = formatConcurrencyMarkdown('missing-peers.pj', graph);
  assert.match(report, /Missing peer/);
  assert.doesNotMatch(report, /Circular wait/);
});

test('channel inlays summarize direction, topology, transitive use and hazards once per declaration', () => {
  const source = [
    'void consume(chan<int>.read input) { int value = input.read(); }',
    'public void main(string[] args) {',
    '    chan<int> jobs;',
    '    consume(jobs.read);',
    '}',
  ].join('\n');
  const { parsed, checked, effects } = analyze(source);
  const hints = channelInlays(parsed.program, checked, effects);
  const input = hints.find((hint) => hint.variable.name === 'input');
  const jobs = hints.find((hint) => hint.variable.name === 'jobs');
  assert.match(input?.label ?? '', /read endpoint.*read directly/);
  assert.ok(!/^\s/.test(input?.label ?? ''), 'padding is provided by the LSP field, not duplicated in the label');
  assert.match(jobs?.label ?? '', /exclusive.*escapes/);
  assert.equal(hints.filter((hint) => hint.variable.name === 'jobs').length, 1);

  const self = analyze('public void main(string[] args) { chan<int> c; c.write(1); int value = c.read(); }');
  const selfHint = channelInlays(self.parsed.program, self.checked, self.effects).find((hint) => hint.variable.name === 'c');
  assert.match(selfHint?.label ?? '', /self deadlock/);
  const selfDiagnostic = self.checked.diagnostics.find((entry) => entry.code === 'pj/channel-self-deadlock');
  assert.equal(selfDiagnostic?.related?.length, 2);
});

test('channel inlay ranges are end-exclusive and contain every returned hint position', () => {
  const source = 'void consume(chan<int>.read input) { int value = input.read(); }';
  const { parsed, checked, effects } = analyze(source);
  const input = channelInlays(parsed.program, checked, effects).find((hint) => hint.variable.name === 'input');
  assert.ok(input);

  const before = channelInlays(parsed.program, checked, effects, {
    start: { line: input.position.line, col: 0 },
    end: input.position,
  });
  assert.equal(before.some((hint) => hint.variable === input.variable), false);

  const containing = channelInlays(parsed.program, checked, effects, {
    start: input.position,
    end: { line: input.position.line, col: input.position.col + 1 },
  });
  assert.equal(containing.some((hint) => hint.variable === input.variable), true);
});

test('graph traffic distinguishes operated endpoints and non-blocking timer reads', () => {
  const source = [
    'public void main(string[] args) {',
    '    chan<int> c;',
    '    timer clock;',
    '    long now = clock.read();',
    '    par {',
    '        c.write.write(1);',
    '        println(c.read.read());',
    '    }',
    '}',
  ].join('\n');
  const { parsed, index, checked, effects } = analyze(source);
  const graph = buildConcurrencyGraph(parsed.program, checked, index, { uri: 'C:\\workspace\\graph.pj', effects: effects.summaries });
  const channel = graph.nodes.find((node) => node.kind === 'channel' && node.label === 'c');
  const timer = graph.nodes.find((node) => node.kind === 'timer' && node.label === 'clock');
  assert.ok(channel && timer);
  assert.equal(graph.edges.filter((edge) => edge.kind === 'read' && edge.to === channel.id).length, 1);
  assert.equal(graph.edges.filter((edge) => edge.kind === 'write' && edge.to === channel.id).length, 1);
  assert.equal(graph.edges.some((edge) => (edge.kind === 'pass-read' || edge.kind === 'pass-write') && edge.to === channel.id), false);
  assert.equal(graph.edges.some((edge) => edge.kind === 'read' && edge.to === timer.id), false);
  assert.match(graph.uri ?? '', /^file:/);
});

test('record-held concurrency resources are synthetic field nodes, not fake channels named after the record', () => {
  const source = [
    'record Bundle { chan<int>.read input; timer clock; }',
    'void inspect(Bundle bundle) {',
    '    int value = bundle.input.read();',
    '    bundle.clock.timeout(10);',
    '    println(value);',
    '}',
  ].join('\n');
  const { parsed, index, checked, effects } = analyze(source);
  const graph = buildConcurrencyGraph(parsed.program, checked, index, { uri: 'file:///resources.pj', effects: effects.summaries });
  assert.ok(graph.nodes.some((node) => node.kind === 'channel' && node.label === 'bundle.input'));
  assert.ok(graph.nodes.some((node) => node.kind === 'timer' && node.label === 'bundle.clock'));
  assert.equal(graph.nodes.some((node) => node.kind === 'channel' && node.label === 'bundle'), false);
});

test('repeated exact aggregate resource paths share a node while array paths stay per-use', () => {
  const source = [
    'record Bundle { chan<int>.read input; chan<int>.read[] inputs; }',
    'void inspect(Bundle bundle) {',
    '    int first = bundle.input.read();',
    '    int second = bundle.input.read();',
    '    int third = bundle.inputs[0].read();',
    '    int fourth = bundle.inputs[0].read();',
    '}',
  ].join('\n');
  const { parsed, index, checked, effects } = analyze(source);
  const graph = buildConcurrencyGraph(parsed.program, checked, index, { uri: 'file:///stable-resources.pj', effects: effects.summaries });
  const exact = graph.nodes.filter((node) => node.kind === 'channel' && node.label === 'bundle.input');
  const indexed = graph.nodes.filter((node) => node.kind === 'channel' && node.label === 'bundle.inputs[…]');
  assert.equal(exact.length, 1);
  assert.equal(indexed.length, 2);
  const exactReads = graph.edges.filter((edge) => edge.kind === 'read' && edge.to === exact[0].id);
  assert.deepEqual(exactReads.map((edge) => edge.source.span.start.line), [2, 3], 'shared node retains each operation edge source');
});

test('calls expose already-separated parameter and record-field endpoints without duplicating explicit selectors', () => {
  const source = [
    'record Bundle { chan<int>.read input; chan<int>.write output; }',
    'void consume(chan<int>.read source) { }',
    'void produce(chan<int>.write destination) { }',
    'void route(chan<int>.read input, chan<int>.write output, Bundle bundle) {',
    '    consume(input);',
    '    produce(output);',
    '    consume(bundle.input);',
    '    produce(bundle.output);',
    '    chan<int> local;',
    '    consume(local.read);',
    '    produce(local.write);',
    '}',
  ].join('\n');
  const { parsed, index, checked, effects } = analyze(source);
  const graph = buildConcurrencyGraph(parsed.program, checked, index, { uri: 'file:///endpoint-passes.pj', effects: effects.summaries });
  const route = graph.nodes.find((node) => node.kind === 'procedure' && node.label === 'route');
  assert.ok(route);
  const reads = graph.edges.filter((edge) => edge.from === route.id && edge.kind === 'pass-read');
  const writes = graph.edges.filter((edge) => edge.from === route.id && edge.kind === 'pass-write');
  assert.equal(reads.length, 3);
  assert.equal(writes.length, 3);
  assert.deepEqual(reads.map((edge) => graph.nodes.find((node) => node.id === edge.to)?.label), ['input', 'bundle.input', 'local']);
  assert.deepEqual(writes.map((edge) => graph.nodes.find((node) => node.id === edge.to)?.label), ['output', 'bundle.output', 'local']);
});

test('graph confidence follows execution paths and preserves unknown over conditional', () => {
  const source = [
    'boolean probe() { return true; }',
    'void flow(boolean enabled, int mode, chan<int>.write output) {',
    '    if (enabled) output.write(1);',
    '    boolean both = enabled && probe();',
    '    boolean chosen = enabled ? probe() : false;',
    '    while (enabled) { output.write(2); break; }',
    '    switch (mode) { case 1: probe(); break; default: break; }',
    '    alt { skip : { probe(); } }',
    '    if (enabled) missing();',
    '    output.write(3);',
    '    probe();',
    '}',
  ].join('\n');
  const { parsed, index, checked, effects } = analyze(source);
  const graph = buildConcurrencyGraph(parsed.program, checked, index, { uri: 'file:///confidence.pj', effects: effects.summaries });
  const flow = graph.nodes.find((node) => node.kind === 'procedure' && node.label === 'flow');
  assert.ok(flow);

  const writes = graph.edges.filter((edge) => edge.from === flow.id && edge.kind === 'write');
  assert.deepEqual(writes.map((edge) => edge.confidence), ['conditional', 'conditional', 'exact']);
  const probeCalls = graph.edges.filter((edge) => edge.kind === 'call' && graph.nodes.find((node) => node.id === edge.to)?.label === 'probe');
  assert.deepEqual(probeCalls.map((edge) => edge.confidence), ['conditional', 'conditional', 'conditional', 'conditional', 'exact']);
  const unresolved = graph.edges.find((edge) => edge.from === flow.id && edge.kind === 'call' && graph.nodes.find((node) => node.id === edge.to)?.label === 'missing');
  assert.equal(unresolved?.confidence, 'unknown');
  assert.ok(graph.nodes.filter((node) => node.kind === 'branch' && /^choice /.test(node.label)).every((node) => node.confidence === 'conditional'));
});
