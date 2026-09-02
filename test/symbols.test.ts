import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractLocals, extractSymbols, maskCommentsAndStrings, wordAt } from '../src/symbols';

const SAMPLE = `import std.*;

const int NUMBER = 9;

// A point in the plane.
record Point {
    int x;
    int y;
}

protocol Msg {
    move : { int dx; int dy; }
    quit : { }
}

/* Writes one value.
 * Blocks until read. */
public void writer1(chan<int>.write out) {
    out.write(42); // "not a { brace"
}

public void reader(chan<int>.read in1, chan<int>.read in2) {
    int v;
    alt {
        v = in1.read() : { println("Got " + v); }
        skip : { println("in skip"); }
    }
}

public void main(string[] args) {
    chan<int> c1, c2;
    timer t;
    long a = t.read();
    for (int i = 0; i < NUMBER; i++) {
        par {
            writer1(c1.write);
            reader(c1.read, c2.read);
        }
    }
}
`;

test('masking removes comment and string bodies but keeps line structure', () => {
  const masked = maskCommentsAndStrings('int x; // hi {\nstring s = "a}b";\n/* multi\nline */ int y;');
  assert.equal(masked.split('\n').length, 4);
  assert.ok(!masked.includes('hi {'));
  assert.ok(!masked.includes('a}b'));
  assert.ok(masked.includes('int y;'));
});

test('top-level symbols: const, record with fields, protocol with cases, procs', () => {
  const syms = extractSymbols(SAMPLE);
  const names = syms.map((s) => `${s.kind}:${s.name}`);
  assert.deepEqual(names, ['const:NUMBER', 'record:Point', 'protocol:Msg', 'proc:writer1', 'proc:reader', 'proc:main']);

  const point = syms[1];
  assert.deepEqual(point.children?.map((c) => c.name), ['x', 'y']);
  assert.equal(point.doc, 'A point in the plane.');

  const msg = syms[2];
  assert.deepEqual(msg.children?.map((c) => c.name), ['move', 'quit']);
  assert.equal(msg.children?.[0].detail, 'move : { int dx; int dy; }');

  const writer = syms[3];
  assert.equal(writer.detail, 'public void writer1(chan<int>.write out)');
  assert.deepEqual(writer.params, ['chan<int>.write out']);
  assert.equal(writer.doc, 'Writes one value.\nBlocks until read.');
  assert.equal(writer.line, 17);
  assert.equal(writer.endLine, 19);

  const main = syms[5];
  assert.equal(main.endLine, SAMPLE.split('\n').length - 2);
});

test('locals and parameters are attributed to their enclosing proc', () => {
  const syms = extractSymbols(SAMPLE);
  const locals = extractLocals(SAMPLE, syms);
  const inMain = locals.filter((l) => l.container === 'main').map((l) => l.name);
  assert.deepEqual(inMain, ['args', 'c1', 'c2', 't', 'a', 'i']);
  const inReader = locals.filter((l) => l.container === 'reader').map((l) => l.name);
  assert.deepEqual(inReader, ['in1', 'in2', 'v']);
  const out = locals.find((l) => l.name === 'out');
  assert.equal(out?.container, 'writer1');
  assert.match(out?.detail ?? '', /parameter/);
});

test('control-flow keywords are never mistaken for declarations', () => {
  const src = 'public void f() {\n    if (x) { g(); }\n    else if (y) { h(); }\n    while (z) { }\n    return foo(1);\n}\n';
  const syms = extractSymbols(src);
  assert.deepEqual(syms.map((s) => s.name), ['f']);
  assert.deepEqual(extractLocals(src, syms), []);
});

test('native library declarations without bodies end on their own line', () => {
  const src = 'package std;\n\npublic native void println(string s);\npublic native void println(int i);\npublic native const double PI;\n';
  const syms = extractSymbols(src);
  assert.deepEqual(syms.map((s) => [s.kind, s.name, s.line, s.endLine]), [
    ['proc', 'println', 2, 2],
    ['proc', 'println', 3, 3],
    ['const', 'PI', 4, 4],
  ]);
});

test('wordAt finds identifier boundaries', () => {
  assert.deepEqual(wordAt('    out.write(42);', 6), { word: 'out', start: 4, end: 7 });
  assert.deepEqual(wordAt('    out.write(42);', 9), { word: 'write', start: 8, end: 13 });
  assert.equal(wordAt('    out.write(42);', 3), undefined);
});
