import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from '../src/checker/checker';
import { DeclIndex } from '../src/checker/index';
import { namedTypeSpans, variableAt, variableSpans, visibleVariables } from '../src/navigation';
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
