import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeclIndex } from '../src/checker/index';
import type { Span } from '../src/parser/ast';
import { parse } from '../src/parser/parser';
import {
  applyRefactorEdits,
  planChannelDiagnostic,
  planCorrectChannelDirection,
  planExtractProcedure,
  planIntroduceChannel,
  planMakeChannelShared,
  planRunInPar,
  type RefactorResult,
} from '../src/refactors';

function positionAt(source: string, offset: number): { line: number; col: number } {
  let line = 0;
  let col = 0;
  for (let index = 0; index < offset; index++) {
    if (source[index] === '\r') {
      if (source[index + 1] === '\n') index++;
      line++;
      col = 0;
    } else if (source[index] === '\n') {
      line++;
      col = 0;
    } else {
      col++;
    }
  }
  return { line, col };
}

function rangeFrom(source: string, first: string, last = first, occurrence = 0): Span {
  let start = -1;
  let from = 0;
  for (let index = 0; index <= occurrence; index++) {
    start = source.indexOf(first, from);
    assert.notEqual(start, -1, `missing '${first}' occurrence ${occurrence}`);
    from = start + first.length;
  }
  const endStart = source.indexOf(last, start);
  assert.notEqual(endStart, -1, `missing '${last}' after '${first}'`);
  return { start: positionAt(source, start), end: positionAt(source, endStart + last.length) };
}

function succeed(result: RefactorResult): Exclude<RefactorResult, { ok: false }> {
  if (!result.ok) assert.fail(result.reasons.join('\n'));
  return result;
}

function fail(result: RefactorResult): Extract<RefactorResult, { ok: false }> {
  if (result.ok) assert.fail(`expected refusal, got ${result.plan.title}`);
  return result;
}

const stdOutputIndex = new DeclIndex();
stdOutputIndex.addProgram(parse('public native void println(int value);').program, '/processj/include/std/io.pj');
const trustedStdOutputDeclarations = new Set((stdOutputIndex.procs.get('println') ?? []).map((signature) => signature.decl));

function introduceChannel(source: string, range: Span): RefactorResult {
  return planIntroduceChannel(source, range, {
    index: stdOutputIndex,
    trustedNonBlockingNativeDeclarations: trustedStdOutputDeclarations,
  });
}

test('extract procedure captures read-only inputs, chooses a unique name, and preserves source text', () => {
  const source = [
    'private void extracted() { }',
    'public void main(string[] args) {',
    '    int value = 4;',
    '    int offset = 2;',
    '    int temp = value + offset;',
    '    // the comment belongs to the extracted computation',
    '    temp++;',
    '}',
    '',
  ].join('\n');
  const result = succeed(planExtractProcedure(source, rangeFrom(source, 'int temp = value + offset;', 'temp++;')));
  assert.equal(result.plan.kind, 'extract-procedure');
  assert.equal(result.plan.edits.length, 2);
  const rewritten = applyRefactorEdits(source, result.plan.edits);
  assert.match(rewritten, /    extracted2\(value, offset\);/);
  assert.match(rewritten, /private void extracted2\(int value, int offset\) \{\n    int temp = value \+ offset;\n    \/\/ the comment belongs to the extracted computation\n    temp\+\+;\n\}/);
});

test('extract procedure passes one exact channel end and marks a yielding procedure', () => {
  const source = [
    'public void main(string[] args) {',
    '    chan<int> c;',
    '    int value = 7;',
    '    c.write(value);',
    '}',
    '',
  ].join('\n');
  const result = succeed(planExtractProcedure(source, rangeFrom(source, 'c.write(value);')));
  const rewritten = applyRefactorEdits(source, result.plan.edits);
  assert.match(rewritten, /    extracted\(c\.write, value\);/);
  assert.match(rewritten, /private void extracted\(chan<int>\.write c, int value\) \[yield=true\]/);
});

test('extract procedure refuses changed captures, escaping declarations, control flow, and partial statements', () => {
  const changed = [
    'public void main(string[] args) {',
    '    int outer = 0;',
    '    outer = 2;',
    '}',
  ].join('\n');
  assert.match(fail(planExtractProcedure(changed, rangeFrom(changed, 'outer = 2;'))).reasons.join(' '), /modified/);

  const escaping = [
    'public void main(string[] args) {',
    '    int base = 1;',
    '    int local = base + 1;',
    '    int answer = local;',
    '}',
  ].join('\n');
  assert.match(fail(planExtractProcedure(escaping, rangeFrom(escaping, 'int local = base + 1;'))).reasons.join(' '), /used afterward/);

  const returning = 'public int choose(int n) {\n    return n;\n}\n';
  assert.match(fail(planExtractProcedure(returning, rangeFrom(returning, 'return n;'))).reasons.join(' '), /return/);

  const partial = 'public void main(string[] args) {\n    int value = 1;\n}\n';
  const statement = rangeFrom(partial, 'int value = 1;');
  const cut: Span = { start: { ...statement.start, col: statement.start.col + 4 }, end: statement.end };
  assert.match(fail(planExtractProcedure(partial, cut)).reasons.join(' '), /cuts through a statement/);
});

test('extract procedure preserves CRLF line endings', () => {
  const source = 'public void main(string[] args) {\r\n\tint input = 2;\r\n\tint local = input + 1;\r\n\tlocal++;\r\n}\r\n';
  const result = succeed(planExtractProcedure(source, rangeFrom(source, 'int local = input + 1;', 'local++;')));
  const rewritten = applyRefactorEdits(source, result.plan.edits);
  assert.equal(rewritten.replace(/\r\n/g, '').includes('\n'), false);
  assert.match(rewritten, /private void extracted\(int input\) \{\r\n\tint local/);

  const crSource = 'public void main(string[] args) {\r\tint input = 2;\r\tint local = input + 1;\r\tlocal++;\r}\r';
  const crResult = succeed(planExtractProcedure(crSource, rangeFrom(crSource, 'int local = input + 1;', 'local++;')));
  const crRewritten = applyRefactorEdits(crSource, crResult.plan.edits);
  assert.equal(crRewritten.includes('\n'), false);
  assert.match(crRewritten, /private void extracted\(int input\) \{\r\tint local/);
});

test('extract procedure appends after trailing source trivia', () => {
  const source = [
    'public void main(string[] args) {',
    '    int input = 2;',
    '    int local = input + 1;',
    '    local++;',
    '}',
    '// keep this trailing note with the original source',
  ].join('\n');
  const result = succeed(planExtractProcedure(source, rangeFrom(source, 'int local = input + 1;', 'local++;')));
  const rewritten = applyRefactorEdits(source, result.plan.edits);
  assert.ok(rewritten.indexOf('// keep this trailing note') < rewritten.indexOf('private void extracted'));
});

test('run in par proves independent writes and retains comments and indentation', () => {
  const source = [
    'public void main(string[] args) {',
    '    int left;',
    '    int right;',
    '    left = 1;',
    '    // independent result',
    '    right = 2;',
    '}',
    '',
  ].join('\n');
  const result = succeed(planRunInPar(source, rangeFrom(source, 'left = 1;', 'right = 2;')));
  const rewritten = applyRefactorEdits(source, result.plan.edits);
  assert.match(rewritten, /    par \{\n        left = 1;\n        \/\/ independent result\n        right = 2;\n    \}/);
});

test('run in par accepts a locally matched rendezvous', () => {
  const source = [
    'public void main(string[] args) {',
    '    int value;',
    '    chan<int> c;',
    '    c.write(1);',
    '    value = c.read();',
    '}',
    '',
  ].join('\n');
  const result = succeed(planRunInPar(source, rangeFrom(source, 'c.write(1);', 'value = c.read();')));
  assert.match(applyRefactorEdits(source, result.plan.edits), /par \{\n        c\.write\(1\);\n        value = c\.read\(\);/);
});

test('run in par refuses when one legal peer choice completes but another deadlocks', () => {
  const first = '{ c.write(1); d.write(1); }';
  const last = '{ int otherC = c.read(); int fromD = d.read(); c.write(2); e.write(2); }';
  const source = [
    'public void main(string[] args) {',
    '    shared chan<int> c;',
    '    chan<int> d;',
    '    chan<int> e;',
    `    ${first}`,
    '    { int fromC = c.read(); int fromE = e.read(); }',
    `    ${last}`,
    '}',
    '',
  ].join('\n');
  assert.match(fail(planRunInPar(source, rangeFrom(source, first, last))).reasons.join(' '), /legal rendezvous schedule can deadlock/);
});

test('run in par still refuses an unavoidable crossed rendezvous deadlock', () => {
  const first = '{ a.write(1); int fromB = b.read(); }';
  const last = '{ b.write(1); int fromA = a.read(); }';
  const source = [
    'public void main(string[] args) {',
    '    chan<int> a;',
    '    chan<int> b;',
    `    ${first}`,
    `    ${last}`,
    '}',
    '',
  ].join('\n');
  assert.match(fail(planRunInPar(source, rangeFrom(source, first, last))).reasons.join(' '), /legal rendezvous schedule can deadlock/);
});

test('run in par explains dependencies, opaque calls, unmatched channels, and branch-local declarations', () => {
  const dependency = [
    'public void main(string[] args) {',
    '    int a;',
    '    int b;',
    '    a = 1;',
    '    b = a;',
    '}',
  ].join('\n');
  assert.match(fail(planRunInPar(dependency, rangeFrom(dependency, 'a = 1;', 'b = a;'))).reasons.join(' '), /depend on 'a'/);

  const call = [
    'private int value() { return 1; }',
    'public void main(string[] args) {',
    '    int a;',
    '    int b;',
    '    a = value();',
    '    b = 2;',
    '}',
  ].join('\n');
  assert.match(fail(planRunInPar(call, rangeFrom(call, 'a = value();', 'b = 2;'))).reasons.join(' '), /hidden state or I\/O/);

  const unmatched = [
    'public void main(string[] args) {',
    '    int a;',
    '    chan<int> c;',
    '    a = c.read();',
    '    a = 2;',
    '}',
  ].join('\n');
  assert.match(fail(planRunInPar(unmatched, rangeFrom(unmatched, 'a = c.read();', 'a = 2;'))).reasons.join(' '), /rendezvous schedule/);

  const declaration = 'public void main(string[] args) {\n    int a = 1;\n    int b = 2;\n}\n';
  assert.match(fail(planRunInPar(declaration, rangeFrom(declaration, 'int a = 1;', 'int b = 2;'))).reasons.join(' '), /declaration would become local/);
});

test('run in par refuses opaque synchronization and reference mutations without alias proof', () => {
  const synchronization = [
    'public void main(string[] args) {',
    '    barrier gate;',
    '    int done;',
    '    gate.sync();',
    '    done = 1;',
    '}',
  ].join('\n');
  assert.match(fail(planRunInPar(synchronization, rangeFrom(synchronization, 'gate.sync();', 'done = 1;'))).reasons.join(' '), /cannot be proven independent/);

  const mutation = [
    'record Box { int value; }',
    'public void main(string[] args) {',
    '    Box box = new Box { value = 0 };',
    '    int done;',
    '    box.value++;',
    '    done = 1;',
    '}',
  ].join('\n');
  assert.match(fail(planRunInPar(mutation, rangeFrom(mutation, 'box.value++;', 'done = 1;'))).reasons.join(' '), /may alias state/);
});

test('channel-direction repair changes a private parameter and all exact in-file callers', () => {
  const source = [
    'private void writer(chan<int>.read out) { int payload = 1; out.write(payload); }',
    'public void main(string[] args) {',
    '    chan<int> c;',
    '    par {',
    '        writer(c.read);',
    '        int value = c.read();',
    '    }',
    '}',
    '',
  ].join('\n');
  const result = succeed(planChannelDiagnostic(source, { code: 'pj/channel-direction', range: rangeFrom(source, 'out.write(payload)') }));
  assert.equal(result.plan.kind, 'channel-direction');
  const rewritten = applyRefactorEdits(source, result.plan.edits);
  assert.match(rewritten, /writer\(chan<int>\.write out\)/);
  assert.match(rewritten, /writer\(c\.write\)/);
  assert.doesNotMatch(rewritten, /writer\(c\.read\)/);
});

test('channel-direction repair refuses public API changes and mixed-direction uses', () => {
  const publicSource = 'public void writer(chan<int>.read out) { out.write(1); }\n';
  assert.match(fail(planCorrectChannelDirection(publicSource, rangeFrom(publicSource, 'out.write(1)'))).reasons.join(' '), /public\/protected signature/);
  assert.match(fail(planCorrectChannelDirection(publicSource, rangeFrom(publicSource, 'out.write(1)'), { allowExternalCallers: true })).reasons.join(' '), /No in-file callers demonstrate/);

  const mixed = [
    'private void broken(chan<int>.read end) {',
    '    end.write(1);',
    '    int value = end.read();',
    '}',
    '',
  ].join('\n');
  assert.match(fail(planCorrectChannelDirection(mixed, rangeFrom(mixed, 'end.write(1)'))).reasons.join(' '), /both directions/);
});

test('make shared chooses one side for direct operations', () => {
  const source = [
    'public void main(string[] args) {',
    '    chan<int> c;',
    '    par {',
    '        { int first = c.read(); }',
    '        { int second = c.read(); }',
    '        { c.write(1); c.write(2); }',
    '    }',
    '}',
    '',
  ].join('\n');
  const result = succeed(planMakeChannelShared(source, rangeFrom(source, 'c.read()', 'c.read()', 1)));
  assert.equal(result.plan.kind, 'channel-sharing');
  const rewritten = applyRefactorEdits(source, result.plan.edits);
  assert.match(rewritten, /shared read chan<int> c;/);
  assert.doesNotMatch(rewritten, /shared write chan/);
});

test('make shared works for a par for, where one use already means repeated ownership', () => {
  const inline = [
    'public void main(string[] args) {',
    '    chan<int> c;',
    '    par for (int i = 0; i < 3; i++) { c.write(i); }',
    '    for (int j = 0; j < 3; j++) { int v = c.read(); }',
    '}',
    '',
  ].join('\n');
  // The server passes the diagnostic's own range, which is the channel name.
  const direct = succeed(planMakeChannelShared(inline, rangeFrom(inline, 'c.write(i)', 'c')));
  assert.match(applyRefactorEdits(inline, direct.plan.edits), /shared write chan<int> c;/);

  // The endpoint the replicated body hands on must become shared as well, or the
  // generated code still takes no lock inside the callee.
  const viaCallee = [
    'private void put(chan<int>.write out) { out.write(1); }',
    'public void main(string[] args) {',
    '    chan<int> c;',
    '    par for (int i = 0; i < 3; i++) { put(c.write); }',
    '    for (int j = 0; j < 3; j++) { int v = c.read(); }',
    '}',
    '',
  ].join('\n');
  const propagated = succeed(planMakeChannelShared(viaCallee, rangeFrom(viaCallee, 'c.write)', 'c')));
  const rewritten = applyRefactorEdits(viaCallee, propagated.plan.edits);
  assert.match(rewritten, /shared write chan<int> c;/);
  assert.match(rewritten, /private void put\(shared chan<int>\.write out\)/);
});

test('make shared propagates endpoint ownership to a private callee exactly once', () => {
  const source = [
    'private void consume(chan<int>.read in) { int value = in.read(); }',
    'public void main(string[] args) {',
    '    chan<int> c;',
    '    par {',
    '        consume(c.read);',
    '        consume(c.read);',
    '        { c.write(1); c.write(2); }',
    '    }',
    '}',
    '',
  ].join('\n');
  const result = succeed(planMakeChannelShared(source, rangeFrom(source, 'c.read', 'c.read', 1)));
  const rewritten = applyRefactorEdits(source, result.plan.edits);
  assert.match(rewritten, /private void consume\(shared chan<int>\.read in\)/);
  assert.equal((rewritten.match(/shared chan<int>\.read in/g) ?? []).length, 1);
  assert.match(rewritten, /shared read chan<int> c;/);
});

test('make shared follows an endpoint through every private in-file forwarding parameter', () => {
  const source = [
    'private void leaf(chan<int>.read in) { int value = in.read(); }',
    'private void mid(chan<int>.read in) { leaf(in); }',
    'public void main(string[] args) {',
    '    chan<int> c;',
    '    par {',
    '        mid(c.read);',
    '        mid(c.read);',
    '        { c.write(1); c.write(2); }',
    '    }',
    '}',
    '',
  ].join('\n');
  const result = succeed(planMakeChannelShared(source, rangeFrom(source, 'c.read', 'c.read', 1)));
  const rewritten = applyRefactorEdits(source, result.plan.edits);
  assert.match(rewritten, /private void leaf\(shared chan<int>\.read in\)/);
  assert.match(rewritten, /private void mid\(shared chan<int>\.read in\)/);
  assert.equal((rewritten.match(/shared chan<int>\.read in/g) ?? []).length, 2);
  assert.match(rewritten, /shared read chan<int> c;/);
});

test('make shared propagates the selected root side through calls outside the triggering par', () => {
  const source = [
    'private void chosen(chan<int>.read in) { int value = in.read(); }',
    'private void elsewhere(chan<int>.read in) { int value = in.read(); }',
    'public void main(string[] args) {',
    '    chan<int> c;',
    '    par {',
    '        chosen(c.read);',
    '        chosen(c.read);',
    '        { c.write(1); c.write(2); }',
    '    }',
    '    elsewhere(c.read);',
    '}',
    '',
  ].join('\n');
  const result = succeed(planMakeChannelShared(source, rangeFrom(source, 'c.read', 'c.read', 1)));
  const rewritten = applyRefactorEdits(source, result.plan.edits);
  assert.match(rewritten, /private void chosen\(shared chan<int>\.read in\)/);
  assert.match(rewritten, /private void elsewhere\(shared chan<int>\.read in\)/);
  assert.equal((rewritten.match(/shared chan<int>\.read in/g) ?? []).length, 2);
  assert.match(rewritten, /shared read chan<int> c;/);
});

test('make shared ignores endpoint forwarding after an unconditional return', () => {
  const source = [
    'private void chosen(chan<int>.read in) { int value = in.read(); }',
    'private void unreachable(chan<int>.read in) { int value = in.read(); }',
    'public void main(string[] args) {',
    '    chan<int> c;',
    '    par {',
    '        chosen(c.read);',
    '        chosen(c.read);',
    '        { c.write(1); c.write(2); }',
    '    }',
    '    return;',
    '    unreachable(c.read);',
    '}',
    '',
  ].join('\n');
  const result = succeed(planMakeChannelShared(source, rangeFrom(source, 'c.read', 'c.read', 1)));
  const rewritten = applyRefactorEdits(source, result.plan.edits);

  assert.match(rewritten, /private void chosen\(shared chan<int>\.read in\)/);
  assert.match(rewritten, /private void unreachable\(chan<int>\.read in\)/);
  assert.match(rewritten, /shared read chan<int> c;/);
});

test('make shared refuses recursive, bodyless, and independently unshared forwarding paths', () => {
  const recursive = [
    'private void first(chan<int>.read in) { second(in); }',
    'private void second(chan<int>.read in) { first(in); }',
    'public void main(string[] args) {',
    '    chan<int> c;',
    '    par { first(c.read); first(c.read); { c.write(1); c.write(2); } }',
    '}',
    '',
  ].join('\n');
  assert.match(fail(planMakeChannelShared(recursive, rangeFrom(recursive, 'c.read', 'c.read', 1))).reasons.join(' '), /recursive cycle/);

  const bodyless = [
    'private native void opaque(chan<int>.read in);',
    'private void mid(chan<int>.read in) { opaque(in); }',
    'public void main(string[] args) {',
    '    chan<int> c;',
    '    par { mid(c.read); mid(c.read); { c.write(1); c.write(2); } }',
    '}',
    '',
  ].join('\n');
  assert.match(fail(planMakeChannelShared(bodyless, rangeFrom(bodyless, 'c.read', 'c.read', 1))).reasons.join(' '), /bodyless procedure/);

  const publicCallee = [
    'public void consume(chan<int>.read in) { int value = in.read(); }',
    'public void main(string[] args) {',
    '    chan<int> c;',
    '    par { consume(c.read); consume(c.read); { c.write(1); c.write(2); } }',
    '}',
    '',
  ].join('\n');
  assert.match(fail(planMakeChannelShared(publicCallee, rangeFrom(publicCallee, 'c.read', 'c.read', 1))).reasons.join(' '), /public or protected signature/);

  const otherCaller = [
    'private void leaf(chan<int>.read in) { int value = in.read(); }',
    'private void mid(chan<int>.read in) { leaf(in); }',
    'public void main(string[] args) {',
    '    chan<int> c;',
    '    chan<int> other;',
    '    par { mid(c.read); mid(c.read); { c.write(1); c.write(2); } }',
    '    leaf(other.read);',
    '}',
    '',
  ].join('\n');
  assert.match(fail(planMakeChannelShared(otherCaller, rangeFrom(otherCaller, 'c.read', 'c.read', 1))).reasons.join(' '), /unshared or opaque read endpoint/);
});

test('make shared refuses a multi-declarator and an unproven non-par use', () => {
  const multi = [
    'public void main(string[] args) {',
    '    chan<int> a, b;',
    '    par {',
    '        { int x = a.read(); }',
    '        { int y = a.read(); }',
    '    }',
    '}',
  ].join('\n');
  assert.match(fail(planMakeChannelShared(multi, rangeFrom(multi, 'a.read()'))).reasons.join(' '), /multi-variable/);

  const sequential = 'public void main(string[] args) {\n    chan<int> c;\n    int x = c.read();\n}\n';
  assert.match(fail(planMakeChannelShared(sequential, rangeFrom(sequential, 'c.read()'))).reasons.join(' '), /not inside a par/);
});

test('introduce channel replaces one simple producer-consumer race with a rendezvous', () => {
  const source = [
    'public void main(string[] args) {',
    '    int value = 0;',
    '    par {',
    '        value = 42;',
    '        println(value);',
    '    }',
    '    println(value);',
    '}',
    '',
  ].join('\n');
  const result = succeed(introduceChannel(source, rangeFrom(source, 'value', 'value', 2)));
  const rewritten = applyRefactorEdits(source, result.plan.edits);
  assert.match(rewritten, /chan<int> valueChannel;\n    par/);
  assert.match(rewritten, /valueChannel\.write\(42\);/);
  assert.match(rewritten, /\{\n            value = valueChannel\.read\(\);\n            println\(value\);\n        \}/);
});

test('introduce channel refuses multiple producers and producer feedback', () => {
  const multiple = [
    'public void main(string[] args) {',
    '    int value = 0;',
    '    par {',
    '        value = 1;',
    '        value = 2;',
    '        println(value);',
    '    }',
    '}',
  ].join('\n');
  assert.match(fail(introduceChannel(multiple, rangeFrom(multiple, 'value', 'value', 3))).reasons.join(' '), /Exactly one par branch/);

  const feedback = [
    'public void main(string[] args) {',
    '    int value = 1;',
    '    par {',
    '        value = value + 1;',
    '        println(value);',
    '    }',
    '}',
  ].join('\n');
  assert.match(fail(introduceChannel(feedback, rangeFrom(feedback, 'value', 'value', 2))).reasons.join(' '), /also reads/);
});

test('introduce channel refuses conditional receives and newly proven rendezvous deadlocks', () => {
  const conditional = [
    'public void main(string[] args) {',
    '    int value = 0;',
    '    boolean enabled = false;',
    '    par {',
    '        value = 42;',
    '        if (enabled) println(value);',
    '    }',
    '}',
  ].join('\n');
  assert.match(fail(introduceChannel(conditional, rangeFrom(conditional, 'value', 'value', 2))).reasons.join(' '), /unconditional channel receive could deadlock/);

  const cyclic = [
    'public void main(string[] args) {',
    '    int value = 0;',
    '    chan<int> existing;',
    '    par {',
    '        { value = 42; existing.write(1); }',
    '        { int token = existing.read(); println(value); }',
    '    }',
    '}',
  ].join('\n');
  assert.match(fail(introduceChannel(cyclic, rangeFrom(cyclic, 'value', 'value', 2))).reasons.join(' '), /confirmed blocking hazard.*pj\/par-deadlock/);
});

test('introduce channel refuses calls and opaque synchronization that can conceal a circular wait', () => {
  const unresolvedOutput = [
    'public void main(string[] args) {',
    '    int value = 0;',
    '    par {',
    '        value = 42;',
    '        println(value);',
    '    }',
    '}',
  ].join('\n');
  assert.match(
    fail(planIntroduceChannel(unresolvedOutput, rangeFrom(unresolvedOutput, 'value', 'value', 2))).reasons.join(' '),
    /calls 'println'.*not proven safe/,
  );

  const spoofOutputIndex = new DeclIndex();
  spoofOutputIndex.addProgram(parse('public native void println(int value);').program, '/workspace/std/io.pj');
  assert.match(
    fail(planIntroduceChannel(unresolvedOutput, rangeFrom(unresolvedOutput, 'value', 'value', 2), {
      index: spoofOutputIndex,
      trustedNonBlockingNativeDeclarations: trustedStdOutputDeclarations,
    })).reasons.join(' '),
    /calls 'println'.*not proven safe/,
    'a path-and-spelling lookalike is not a trusted non-blocking leaf',
  );

  const throughCall = [
    'private void recv(chan<int>.read in) { int token = in.read(); }',
    'public void main(string[] args) {',
    '    int value = 0;',
    '    chan<int> c;',
    '    par {',
    '        { value = 42; recv(c.read); }',
    '        { c.write(1); println(value); }',
    '    }',
    '}',
  ].join('\n');
  assert.match(
    fail(introduceChannel(throughCall, rangeFrom(throughCall, 'value', 'value', 2))).reasons.join(' '),
    /calls 'recv'.*may block or synchronize.*circular wait/,
  );

  const opaqueSync = [
    'public void main(string[] args) {',
    '    int value = 0;',
    '    barrier gate;',
    '    par {',
    '        { value = 42; gate.sync(); }',
    '        println(value);',
    '    }',
    '}',
  ].join('\n');
  assert.match(
    fail(introduceChannel(opaqueSync, rangeFrom(opaqueSync, 'value', 'value', 2))).reasons.join(' '),
    /barrier, timeout, claim, or extended rendezvous.*circular wait/,
  );

  const earlyReturn = [
    'public void main(string[] args) {',
    '    int value = 0;',
    '    int seen = 0;',
    '    par {',
    '        { return; value = 42; }',
    '        seen = value;',
    '    }',
    '}',
  ].join('\n');
  assert.match(
    fail(planIntroduceChannel(earlyReturn, rangeFrom(earlyReturn, 'value', 'value', 2))).reasons.join(' '),
    /control transfers first|contains return/,
  );

  const nestedPar = [
    'public void main(string[] args) {',
    '    int value = 0;',
    '    int seen = 0;',
    '    chan<int> c;',
    '    par {',
    '        { par { int token = c.read(); } value = 42; }',
    '        { seen = value; c.write(1); }',
    '    }',
    '}',
  ].join('\n');
  assert.match(
    fail(planIntroduceChannel(nestedPar, rangeFrom(nestedPar, 'value', 'value', 2))).reasons.join(' '),
    /nested par, par-for, or alt.*circular wait/,
  );
});

test('introduce channel refuses unsafe insertion context and producer trivia loss', () => {
  const nested = [
    'public void main(string[] args) {',
    '    int value = 0;',
    '    boolean enabled = true;',
    '    if (enabled) par {',
    '        value = 42;',
    '        println(value);',
    '    }',
    '}',
  ].join('\n');
  assert.match(fail(introduceChannel(nested, rangeFrom(nested, 'value', 'value', 2))).reasons.join(' '), /direct statement of a block/);

  const trivia = [
    'public void main(string[] args) {',
    '    int value = 0;',
    '    par {',
    '        value /* chosen result */ = 42;',
    '        println(value);',
    '    }',
    '}',
  ].join('\n');
  assert.match(fail(introduceChannel(trivia, rangeFrom(trivia, 'value', 'value', 2))).reasons.join(' '), /without losing it/);
});

test('applyRefactorEdits applies original-coordinate edits from the end and rejects overlap', () => {
  const source = 'one two three';
  const first: Span = { start: { line: 0, col: 0 }, end: { line: 0, col: 3 } };
  const last: Span = { start: { line: 0, col: 8 }, end: { line: 0, col: 13 } };
  assert.equal(applyRefactorEdits(source, [{ range: first, newText: '1' }, { range: last, newText: '3' }]), '1 two 3');
  assert.throws(() => applyRefactorEdits(source, [{ range: first, newText: 'x' }, { range: { start: { line: 0, col: 2 }, end: { line: 0, col: 4 } }, newText: 'y' }]), /overlap/);
});
