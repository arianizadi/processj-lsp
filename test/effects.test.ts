import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from '../src/checker/checker';
import { analyzeProcedureEffects, type EffectUnit, type ProcedureEffectSummary } from '../src/checker/effects';
import { DeclIndex } from '../src/checker/index';
import type * as A from '../src/parser/ast';
import { parse } from '../src/parser/parser';

function checkedUnits(sources: Array<{ source: string; file: string }>): { units: EffectUnit[]; declarations: Map<string, A.ProcDecl> } {
  const parsed = sources.map(({ source, file }) => ({ source, file, parsed: parse(source) }));
  for (const unit of parsed) assert.deepEqual(unit.parsed.errors, [], `${unit.file} must parse`);
  const index = new DeclIndex();
  for (const unit of parsed) index.addProgram(unit.parsed.program, unit.file);
  const units = parsed.map(({ source, file, parsed: result }): EffectUnit => ({
    program: result.program,
    checked: check(result.program, { index, text: source }),
    file,
  }));
  const declarations = new Map<string, A.ProcDecl>();
  for (const unit of units) {
    for (const decl of unit.program.decls) if (decl.kind === 'ProcDecl') declarations.set(decl.name.name, decl);
  }
  return { units, declarations };
}

function summary(source: string, name: string): ProcedureEffectSummary {
  const { units, declarations } = checkedUnits([{ source, file: 'effects.pj' }]);
  const decl = declarations.get(name);
  assert.ok(decl, `missing ${name}`);
  const result = analyzeProcedureEffects(units).get(decl);
  assert.ok(result, `missing summary for ${name}`);
  return result;
}

function sorted(values: ReadonlySet<number>): number[] {
  return [...values].sort((a, b) => a - b);
}

test('direct effects distinguish channel parameter traffic, timer reads, waits and mobile suspension', () => {
  const result = summary(
    [
      'mobile void worker(chan<int>.read input, chan<int>.write output, barrier gate, timer clock) {',
      '    long now = clock.read();',
      '    int value = input.read();',
      '    output.write(value);',
      '    gate.sync();',
      '    clock.timeout(5);',
      '    suspend;',
      '}',
    ].join('\n'),
    'worker',
  );

  assert.equal(result.direct.channelRead, true);
  assert.equal(result.direct.channelWrite, true);
  assert.deepEqual(sorted(result.direct.channelReads), [0]);
  assert.deepEqual(sorted(result.direct.channelWrites), [1]);
  assert.equal(result.direct.blocking, true);
  assert.equal(result.direct.barrier, true);
  assert.equal(result.direct.timer, true);
  assert.equal(result.direct.mobile, true);
  assert.equal(result.direct.unknown, false);
  assert.equal(result.direct.confidence, 'exact');
  assert.equal(result.sites.filter((site) => site.kind === 'channel-read').length, 1, 'timer.read() is not channel traffic');
});

test('new mobile is a direct scheduler suspension, matching compiler yield semantics', () => {
  const result = summary(
    [
      'record Handle { }',
      'mobile void worker() { }',
      'void launch() { Handle process = new mobile(worker); }',
    ].join('\n'),
    'launch',
  );

  assert.equal(result.direct.mobile, true);
  assert.equal(result.direct.blocking, true);
  assert.deepEqual(result.sites.filter((site) => site.kind === 'mobile' || site.kind === 'blocking').map((site) => site.kind), ['mobile', 'blocking']);
});

test('unreachable statements do not become conservative may-effects', () => {
  const result = summary(
    [
      'void ignored(chan<int>.read input) {',
      '    return;',
      '    int value = input.read();',
      '}',
    ].join('\n'),
    'ignored',
  );

  assert.equal(result.direct.channelRead, false);
  assert.equal(result.direct.blocking, false);
  assert.deepEqual(result.sites, []);
});

test('one terminating par branch does not hide effects in another branch', () => {
  const result = summary(
    [
      'void parallel(chan<int>.read input) {',
      '    par {',
      '        return;',
      '        int value = input.read();',
      '    }',
      '}',
    ].join('\n'),
    'parallel',
  );

  assert.equal(result.direct.par, true);
  assert.equal(result.direct.channelRead, true);
  assert.deepEqual(sorted(result.direct.channelReads), [0]);
});

test('exact overload calls propagate effects and substitute formal parameter positions', () => {
  const source = [
    'void leaf(chan<int>.read input, chan<int>.write output) {',
    '    int value = input.read();',
    '    output.write(value);',
    '}',
    'void bridge(chan<int>.write destination, chan<int>.read source) [yield=true] {',
    '    leaf(source, destination);',
    '}',
  ].join('\n');
  const result = summary(source, 'bridge');

  assert.equal(result.direct.channelRead, false);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].resolution, 'exact');
  assert.deepEqual(result.calls[0].arguments, [{ kind: 'parameter', index: 1 }, { kind: 'parameter', index: 0 }]);
  assert.equal(result.transitive.channelRead, true);
  assert.equal(result.transitive.channelWrite, true);
  assert.deepEqual(sorted(result.transitive.channelReads), [1]);
  assert.deepEqual(sorted(result.transitive.channelWrites), [0]);
  assert.equal(result.transitive.blocking, true);
  assert.equal(result.transitive.confidence, 'exact');
});

test('ambiguous and unknown-argument overloads never become exact effect or yield edges', () => {
  const source = [
    'record A { }',
    'record B { }',
    'record C extends A, B { }',
    'void choose(A value) { }',
    'void choose(B value) { timer clock; clock.timeout(1); }',
    'void ambiguous(C value) { choose(value); }',
    'void numeric(int value) { }',
    'void numeric(long value) { timer clock; clock.timeout(1); }',
    'void unknown(Missing value) { numeric(value); }',
  ].join('\n');
  const parsed = parse(source);
  assert.deepEqual(parsed.errors, []);
  const index = new DeclIndex();
  index.addProgram(parsed.program, 'ambiguous-effects.pj');
  const checked = check(parsed.program, { index, text: source, unresolvedImports: true });

  assert.equal(checked.calls.size, 0, 'neither syntactic call has a proven overload identity');
  assert.ok(checked.diagnostics.some((diagnostic) => diagnostic.code === 'pj/type/call' && /Ambiguous call/.test(diagnostic.message)));
  assert.deepEqual(
    checked.diagnostics.filter((diagnostic) => diagnostic.code === 'pj/needs-yield-annotation'),
    [],
    'invalid calls are not evidence for a user-facing missing-yield diagnostic',
  );

  const effects = analyzeProcedureEffects([{ program: parsed.program, checked, file: 'ambiguous-effects.pj' }]);
  for (const name of ['ambiguous', 'unknown']) {
    const declaration = parsed.program.decls.find((decl): decl is A.ProcDecl => decl.kind === 'ProcDecl' && decl.name.name === name)!;
    const result = effects.get(declaration)!;
    assert.equal(result.calls[0]?.resolution, 'unresolved');
    assert.equal(result.transitive.unknown, true);
    assert.equal(result.transitive.blocking, true);
    assert.equal(result.transitive.confidence, 'unknown');
  }
});

test('multi-file exact calls use supplied units and retain target source files', () => {
  const { units, declarations } = checkedUnits([
    { source: 'void relay(chan<int>.read input) [yield=true] { int value = input.read(); }', file: 'relay.pj' },
    { source: 'void entry(chan<int>.read source) [yield=true] { relay(source); }', file: 'entry.pj' },
  ]);
  const entry = declarations.get('entry')!;
  const result = analyzeProcedureEffects(units).get(entry)!;

  assert.equal(result.calls[0].resolution, 'exact');
  assert.equal(result.calls[0].targetFile, 'relay.pj');
  assert.deepEqual(sorted(result.transitive.channelReads), [0]);
  assert.equal(result.transitive.unknown, false);
});

test('mutually recursive SCCs reach a parameter-substituting fixed point', () => {
  const source = [
    'void even(chan<int>.read first, chan<int>.read second) [yield=true] { odd(second, first); }',
    'void odd(chan<int>.read first, chan<int>.read second) [yield=true] {',
    '    if (true) even(second, first);',
    '    else { int value = first.read(); }',
    '}',
  ].join('\n');
  const { units, declarations } = checkedUnits([{ source, file: 'recursive.pj' }]);
  const effects = analyzeProcedureEffects(units);
  const even = effects.get(declarations.get('even')!)!;
  const odd = effects.get(declarations.get('odd')!)!;

  assert.equal(even.recursive, true);
  assert.equal(odd.recursive, true);
  assert.equal(even.scc, odd.scc);
  assert.deepEqual(sorted(odd.direct.channelReads), [0]);
  assert.deepEqual(sorted(even.transitive.channelReads), [1]);
  assert.deepEqual(sorted(odd.transitive.channelReads), [0]);
});

test('a recursive component receives effects from an already-solved callee component', () => {
  const source = [
    'void sink(chan<int>.write output) { output.write(1); }',
    'void left(chan<int>.write output) [yield=true] { right(output); }',
    'void right(chan<int>.write output) [yield=true] {',
    '    if (true) left(output);',
    '    else sink(output);',
    '}',
  ].join('\n');
  const { units, declarations } = checkedUnits([{ source, file: 'components.pj' }]);
  const effects = analyzeProcedureEffects(units);
  const left = effects.get(declarations.get('left')!)!;
  const right = effects.get(declarations.get('right')!)!;

  assert.equal(left.recursive, true);
  assert.equal(right.recursive, true);
  assert.equal(left.scc, right.scc);
  assert.deepEqual(sorted(left.transitive.channelWrites), [0]);
  assert.deepEqual(sorted(right.transitive.channelWrites), [0]);
});

test('local channel actuals do not escape into caller parameter sets', () => {
  const source = [
    'void consume(chan<int>.read input) { int value = input.read(); }',
    'void owner() [yield=true] { chan<int> local; consume(local.read); }',
  ].join('\n');
  const result = summary(source, 'owner');

  assert.deepEqual(result.calls[0].arguments, [{ kind: 'local' }]);
  assert.equal(result.transitive.channelRead, true);
  assert.deepEqual(sorted(result.transitive.channelReads), []);
  assert.equal(result.transitive.unknown, false);
});

test('channel resources rooted in aggregate parameters and simple aliases retain their origin', () => {
  const source = [
    'record Bundle { chan<int>.read input; }',
    'void consume(chan<int>.read input) { int value = input.read(); }',
    'void routed(Bundle bundle, chan<int>.read[] inputs) [yield=true] {',
    '    int direct = bundle.input.read();',
    '    chan<int>.read alias = inputs[0];',
    '    consume(alias);',
    '}',
  ].join('\n');
  const result = summary(source, 'routed');

  assert.deepEqual(sorted(result.direct.channelReads), [0]);
  assert.deepEqual(result.calls[0].arguments, [{ kind: 'parameter', index: 1 }]);
  assert.deepEqual(sorted(result.transitive.channelReads), [0, 1]);
  assert.equal(result.transitive.unknown, false);
  assert.equal(result.transitive.confidence, 'exact');
});

test('mutable record and protocol aliases replace stale aggregate parameter origins conservatively', () => {
  const record = summary(
    [
      'record Box { chan<int>.read input; }',
      'void route(Box first, Box second) {',
      '    Box selected = first;',
      '    selected = second;',
      '    int value = selected.input.read();',
      '}',
    ].join('\n'),
    'route',
  );
  assert.deepEqual(sorted(record.direct.channelReads), [1]);
  assert.equal(record.direct.unknown, true);
  assert.equal(record.direct.confidence, 'conservative');

  const protocol = summary(
    [
      'protocol Packet { data: { chan<int>.read input; } }',
      'void route(Packet first, Packet second) {',
      '    Packet selected = first;',
      '    selected = second;',
      '    switch (selected) {',
      '        case data: int value = selected.input.read(); break;',
      '    }',
      '}',
    ].join('\n'),
    'route',
  );
  assert.deepEqual(sorted(protocol.direct.channelReads), [1]);
  assert.equal(protocol.direct.unknown, true);
  assert.equal(protocol.direct.confidence, 'conservative');
});

test('field writes update static origins and indexed writes invalidate aggregate aliases', () => {
  const field = summary(
    [
      'record Box { chan<int>.read input; }',
      'void route(Box first, Box second) {',
      '    Box selected = first;',
      '    selected.input = second.input;',
      '    int value = selected.input.read();',
      '}',
    ].join('\n'),
    'route',
  );
  assert.deepEqual(sorted(field.direct.channelReads), [1]);
  assert.equal(field.direct.unknown, true);
  assert.equal(field.direct.confidence, 'conservative');

  const indexed = summary(
    [
      'void route(chan<int>.read[] first, chan<int>.read[] second) {',
      '    chan<int>.read[] selected = first;',
      '    selected[0] = second[0];',
      '    int value = selected[0].read();',
      '}',
    ].join('\n'),
    'route',
  );
  assert.deepEqual(sorted(indexed.direct.channelReads), []);
  assert.equal(indexed.direct.unknown, true);
  assert.equal(indexed.direct.confidence, 'conservative');
});

test('unresolved and unavailable calls remain conservative instead of claiming purity', () => {
  const unresolved = summary('void caller(chan<int>.read input) { missing(input); }', 'caller');
  assert.equal(unresolved.calls[0].resolution, 'unresolved');
  assert.equal(unresolved.direct.unknown, true);
  assert.equal(unresolved.direct.blocking, true);
  assert.equal(unresolved.direct.confidence, 'unknown');

  const externalSource = 'void external(chan<int>.read input);\nvoid caller(chan<int>.read input) { external(input); }';
  const external = summary(externalSource, 'caller');
  assert.equal(external.calls[0].resolution, 'exact');
  assert.equal(external.transitive.unknown, true);
  assert.equal(external.transitive.blocking, true);
});

test('par, alt and barrier enrollment are surfaced as composable direct facts', () => {
  const source = [
    'void orchestrate(chan<int>.read input, barrier gate) {',
    '    par enroll (gate) {',
    '        { int value = input.read(); }',
    '        alt { skip : { } }',
    '    }',
    '}',
  ].join('\n');
  const result = summary(source, 'orchestrate');

  assert.equal(result.direct.par, true);
  assert.equal(result.direct.alt, true);
  assert.equal(result.direct.barrier, true);
  assert.equal(result.direct.blocking, true);
  assert.deepEqual(sorted(result.direct.channelReads), [0]);
});
