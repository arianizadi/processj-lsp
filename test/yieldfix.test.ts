import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withYieldAnnotations } from '../src/yieldfix';

test('withYieldAnnotations marks call-only suspending procedures and keeps line numbers', () => {
  const src = 'import std.*;\n\npublic void wait1() { timer t; t.timeout(1); }\n\npublic void twice() { wait1(); wait1(); }\n\npublic void main(string[] args) { twice(); println("ok"); }\n';
  const out = withYieldAnnotations(src);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.match(out, /public void twice\(\) \[yield=true\] \{ wait1\(\); wait1\(\); \}/);
  assert.match(out, /public void main\(string\[\] args\) \[yield=true\] \{ twice\(\)/);
  assert.match(out, /public void wait1\(\) \{ timer t;/, 'direct communication needs no annotation');
  assert.equal(withYieldAnnotations(out), out, 'idempotent');
  assert.equal(withYieldAnnotations('public void f() { int x = 1 }'), 'public void f() { int x = 1 }', 'left alone on syntax errors');
});
