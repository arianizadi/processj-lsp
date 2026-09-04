import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DeclIndex } from '../src/checker/index';
import { parse } from '../src/parser/parser';

test('declaration index invalidates derived inheritance caches when programs are added', () => {
  const index = new DeclIndex();
  index.addProgram(parse('record Child extends Base { int child; }\nprotocol Combo extends Parent { own : { int x; } }').program);

  assert.deepEqual([...index.recordFields('Child').keys()], ['child']);
  assert.deepEqual([...index.protocolCases('Combo').keys()], ['own']);
  assert.equal(index.extendsName('Base', 'Ancestor'), false);

  index.addProgram(parse('record Ancestor { int root; }\nrecord Base extends Ancestor { int base; }\nprotocol Parent { inherited : { string value; } }').program);

  assert.deepEqual([...index.recordFields('Child').keys()], ['child', 'base', 'root']);
  assert.deepEqual([...index.protocolCases('Combo').keys()], ['own', 'inherited']);
  assert.equal(index.extendsName('Base', 'Ancestor'), true);
});

test('qualified types keep package identity instead of binding to a same-named local type', () => {
  const parsed = parse('record Thing { int value; }\npublic pkg::Thing[] copy(pkg::Thing[] values) { return values; }\n');
  assert.equal(parsed.errors.length, 0);
  const index = new DeclIndex();
  index.addProgram(parsed.program, 'qualified.pj');

  const signature = index.procs.get('copy')?.[0];
  assert.deepEqual(signature?.params[0], { k: 'array', elem: { k: 'unknown', name: 'pkg::Thing' }, dims: 1 });
  assert.deepEqual(signature?.ret, { k: 'array', elem: { k: 'unknown', name: 'pkg::Thing' }, dims: 1 });
});
