import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from '../src/checker/checker';
import { DeclIndex } from '../src/checker/index';
import { localRenameConflict, namedTypeSpans, variableAt, variableSpans, visibleVariables } from '../src/navigation';
import { parse } from '../src/parser/parser';

function checked(source: string) {
  const parsed = parse(source);
  const index = new DeclIndex();
  index.addProgram(parsed.program, 'test.pj');
  return { parsed, result: check(parsed.program, { index, text: source }) };
}

test('references use declaration identity and keep shadowed locals separate', () => {
  const source = `public void main(string[] args) {
    int value = 1;
    println(value);
    {
        int value = 2;
        println(value);
    }
    println(value);
}`;
  const { result } = checked(source);
  const outer = variableAt(result, { line: 1, character: 8 });
  const inner = variableAt(result, { line: 4, character: 12 });
  assert.ok(outer && inner);
  assert.notEqual(outer, inner);
  assert.deepEqual(variableSpans(result, outer).map((s) => s.start.line), [1, 2, 7]);
  assert.deepEqual(variableSpans(result, inner).map((s) => s.start.line), [4, 5]);
  assert.equal(variableAt(result, { line: 5, character: 18 }), inner);
  assert.equal(variableAt(result, { line: 7, character: 14 }), outer);
});

test('completion variables respect lexical scope, declaration order and overload', () => {
  const source = `public void work(int first) {
    int before = first;
    {
        int nested = before;
        nested++;
    }
    int after = before;
}

public void work(string second) {
    int other = 1;
    other++;
}`;
  const { parsed, result } = checked(source);
  const namesAt = (line: number) => visibleVariables(parsed.program, result, { line, character: 4 }).map((v) => v.name).sort();
  assert.deepEqual(namesAt(2), ['before', 'first']);
  assert.deepEqual(namesAt(4), ['before', 'first', 'nested']);
  assert.deepEqual(namesAt(6), ['before', 'first']);
  assert.deepEqual(namesAt(11), ['other', 'second']);
  assert.deepEqual(visibleVariables(parsed.program, result, { line: 8, character: 0 }), []);
});

test('qualified type names are not treated as exact short-name references', () => {
  const program = parse('record Thing { int value; }\npublic pkg::Thing[] copy(pkg::Thing[] values) { Thing local; return values; }\n').program;
  assert.deepEqual(namedTypeSpans(program, 'Thing').map((span) => [span.start.line, span.start.col]), [[1, 48]]);
});

test('local rename refuses capture in either direction and duplicate declarations', () => {
  const cases: Array<[string, string, boolean]> = [
    ['int value = 1; { int renamed = 2; return value; }', 'value', true],
    ['int renamed = 1; { int value = 2; return renamed + value; }', 'value', true],
    ['int value = 1; int renamed = 2; return 0;', 'value', true],
    ['int renamed = 1; { int value = 2; return value; }', 'value', false],
    ['{ int renamed = 1; } int value = 2; return value;', 'value', false],
    ['int value = 1; { int renamed = 2; } return value;', 'value', false],
    ['int value = 1; return value;', 'value', false],
  ];
  for (const [body, name, conflict] of cases) {
    const { parsed, result } = checked(`public int demo() { ${body} }`);
    const variable = result.vars.find((v) => v.name === name)!;
    assert.equal(localRenameConflict(parsed.program, result, variable, 'renamed'), conflict, body);
    assert.equal(localRenameConflict(parsed.program, result, variable, name), false, 'same-name rename is harmless');
  }
  const { parsed, result } = checked('const int renamed = 1; public int demo() { int value = 2; return renamed + value; }');
  assert.equal(localRenameConflict(parsed.program, result, result.vars.find((v) => v.name === 'value')!, 'renamed'), true, 'renaming must not capture a constant reference');
  const shadowed = checked('const int renamed = 1; public int demo() { int value = 2; { int value = 3; return renamed + value; } }');
  assert.equal(localRenameConflict(shadowed.parsed.program, shadowed.result, shadowed.result.vars.find((v) => v.name === 'value')!, 'renamed'), true, 'changing a shadowed outer name can capture a constant in the inner scope');
});
