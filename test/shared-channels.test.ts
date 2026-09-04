import assert from 'node:assert/strict';
import { test } from 'node:test';
import { run } from './checker.test';

const MAIN = (body: string, extra = '') => `import std.*;\n${extra}\npublic void main(string[] args) {\n${body}\n}\n`;

function codes(src: string, code: string): Array<[number, string]> {
  return run(src).diagnostics.filter((d) => d.code === code).map((d) => [d.line, d.message]);
}

test('two branches operating a shared channel end inline are warned: the compiler emits no lock for them', () => {
  const writers = codes(MAIN('    shared chan<int> c;\n    par {\n        seq {\n            c.write(5);\n        }\n        c.write(5);\n        println(c.read());\n        println(c.read());\n    }'), 'pj/shared-unlocked-end');
  assert.equal(writers.length, 2, JSON.stringify(writers));
  assert.deepEqual(writers.map(([line]) => line), [8, 10]);
  assert.match(writers[0][1], /'c\.write' .*without the runtime's write lock/);
  assert.match(writers[0][1], /shared chan<int>\.write/);
  assert.match(writers[1][1], /'c\.read' .*without the runtime's read lock/);
  assert.match(writers[1][1], /Keep all reads in one sequential process/);
  assert.doesNotMatch(writers[1][1], /Pass 'c\.read' to a procedure/);
});

test('a replicated par for body with an inline shared operation is warned', () => {
  const hits = codes(MAIN('    shared chan<int> c;\n    par for (int i = 0; i < 4; i++) {\n        if (i < 2) c.write(i);\n        else println("read " + c.read());\n    }'), 'pj/shared-unlocked-end');
  assert.deepEqual(hits.map(([line]) => line), [5, 6]);
});

test('an end handed to a non-shared parameter is unlocked, one handed to a shared parameter is locked', () => {
  const unlocked = codes(MAIN('    shared write chan<int> c;\n    par {\n        w(c.write, 5);\n        w(c.write, 6);\n        {\n            println(c.read());\n            println(c.read());\n        }\n    }', 'public void w(chan<int>.write o, int v) { o.write(v); }'), 'pj/shared-unlocked-end');
  assert.deepEqual(unlocked.map(([line]) => line), [6]);
  assert.match(unlocked[0][1], /passed to 'w', which declares it as 'chan<int>\.write'/);

  const locked = run(MAIN('    shared write chan<int> c;\n    par {\n        put(c.write, 5);\n        put(c.write, 6);\n        {\n            println(c.read());\n            println(c.read());\n        }\n    }', 'public void put(shared chan<int>.write out, int v) { out.write(v); }'));
  assert.deepEqual(locked.diagnostics.filter((d) => d.code === 'pj/shared-unlocked-end' || d.code === 'pj/shared-channel-end'), []);
});

test('one process per side needs no lock, and only the side actually shared is exempt from the shared-end error', () => {
  const single = run(MAIN('    shared chan<int> c;\n    par {\n        {\n            c.write(5);\n            c.write(6);\n        }\n        println(c.read());\n    }'));
  assert.deepEqual(single.diagnostics.filter((d) => d.code === 'pj/shared-unlocked-end'), []);

  // `shared read` leaves the write side unshared, so two writer branches still
  // get the existing "declare it shared" error even though the channel says shared.
  const writeSide = run(MAIN('    shared read chan<int> c;\n    par {\n        c.write(5);\n        c.write(6);\n        {\n            println(c.read());\n            println(c.read());\n        }\n    }'));
  assert.deepEqual(writeSide.diagnostics.filter((d) => d.code === 'pj/shared-channel-end').map((d) => d.line), [6]);
});

test('any read through a shared read parameter is a compiler limit', () => {
  const crash = run('import std.*;\npublic void take(shared chan<int>.read in) { int v; v = in.read(); println(v); }\npublic void inLoop(shared chan<int>.read in) { int v; while (true) { v = in.read(); println(v); } }\npublic void justPasses(shared chan<int>.read in) { take(in); }\npublic void plainEnd(chan<int>.read in) { int v; v = in.read(); println(v); }\npublic void main(string[] args) { }\n');
  const limits = crash.diagnostics.filter((d) => d.code === 'pj/compiler-limit' && /shared chan<int>\.read/.test(d.message));
  assert.deepEqual(limits.map((d) => d.line), [1, 2]);
  assert.match(limits[0].message, /code generator/);
});

test('two branches with their own same-named shared channel are two channels, not a hazard', () => {
  const separate = run(MAIN('    par {\n        { shared chan<int> c; par { c.write(1); println(c.read()); } }\n        { shared chan<int> c; par { c.write(2); println(c.read()); } }\n    }'));
  assert.deepEqual(separate.diagnostics.filter((d) => d.code === 'pj/shared-unlocked-end'), []);
});
