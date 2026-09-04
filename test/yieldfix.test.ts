import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withYieldAnnotations } from '../src/yieldfix';

test('withYieldAnnotations marks call-only suspending procedures and keeps line numbers', () => {
  const src = 'import std.*;\n\npublic void wait1() { timer t; t.timeout(1); }\n\npublic void twice() { wait1(); wait1(); }\n\npublic void main(string[] args) { twice(); println("ok"); }\n';
  const out = withYieldAnnotations(src);
  assert.equal(out.split('\n').length, src.split('\n').length);
  assert.match(out, /public void twice\(\) \[yield=true\] \{ wait1\(\); wait1\(\); \}/);
  assert.match(out, /public void main\(string\[\] args\) \{ twice\(\)/, 'the compiler marks main itself');
  assert.match(out, /public void wait1\(\) \{ timer t;/, 'direct communication needs no annotation');
  assert.equal(withYieldAnnotations(out), out, 'idempotent');
  assert.equal(withYieldAnnotations('public void f() { int x = 1 }'), 'public void f() { int x = 1 }', 'left alone on syntax errors');
});

test('withYieldAnnotations keeps the grammar order and merges into an existing annotation list', () => {
  const src = 'void g(chan<int>.read c) { c.read(); }\r\nrecord R { chan<int>.read in; }\r\nvoid f(R r) implements g { g(r.in); }\r\nvoid h(R r) [foo=1] { g(r.in); }\r\n';
  const out = withYieldAnnotations(src);
  assert.equal(out, 'void g(chan<int>.read c) { c.read(); }\r\nrecord R { chan<int>.read in; }\r\nvoid f(R r) [yield=true] implements g { g(r.in); }\r\nvoid h(R r) [yield=true, foo=1] { g(r.in); }\r\n');
  assert.equal(withYieldAnnotations(out), out, 'idempotent');
});
