import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from '../src/checker/checker';
import { DeclIndex } from '../src/checker/index';
import { parse } from '../src/parser/parser';
import { decodeTokens, semanticTokens } from '../src/semantic';

test('semantic tokens classify declarations, parameters, fields, cases and calls', () => {
  const src = [
    'import std.*;',
    'const int N = 2;',
    'record Point { int x; }',
    'protocol Msg { move : { int dx; } }',
    'public void f(chan<int>.read in, Point p) {',
    '    int v = in.read() + p.x + N;',
    '    Msg m = new Msg { move: dx = v };',
    '    if (m is move) f(in, p);',
    '}',
  ].join('\n');
  const parsed = parse(src);
  assert.deepEqual(parsed.errors, []);
  const index = new DeclIndex();
  index.addProgram(parsed.program, 'a.pj');
  const checked = check(parsed.program, { index, importsStd: true, unresolvedImports: true });
  const toks = decodeTokens(semanticTokens(parsed.program, checked, index));
  const at = (line: number, col: number) => toks.find((t) => t.line === line && t.col === col);
  assert.deepEqual(at(0, 7), { line: 0, col: 7, len: 3, type: 'namespace', mods: [] });
  assert.deepEqual(at(1, 10)?.type, 'variable');
  assert.deepEqual(at(1, 10)?.mods, ['declaration', 'readonly']);
  assert.equal(at(2, 7)?.type, 'struct');
  assert.equal(at(2, 19)?.type, 'property');
  assert.equal(at(3, 9)?.type, 'enum');
  assert.equal(at(3, 15)?.type, 'enumMember');
  assert.equal(at(4, 12)?.type, 'function');
  assert.equal(at(4, 29)?.type, 'parameter');
  assert.equal(at(4, 33)?.type, 'struct');
  assert.equal(at(5, 12)?.type, 'parameter');
  assert.equal(at(5, 24)?.type, 'parameter');
  assert.equal(at(5, 26)?.type, 'property');
  assert.deepEqual(at(5, 30)?.mods, ['readonly']);
  assert.equal(at(6, 4)?.type, 'enum');
  assert.equal(at(6, 22)?.type, 'enumMember');
  assert.equal(at(7, 13)?.type, 'enumMember');
  assert.equal(at(7, 19)?.type, 'function');
  // Relative encoding: deltas never go backwards.
  const data = semanticTokens(parsed.program, checked, index);
  for (let i = 0; i < data.length; i += 5) assert.ok(data[i] >= 0 && data[i + 1] >= 0 && data[i + 2] > 0);
});
