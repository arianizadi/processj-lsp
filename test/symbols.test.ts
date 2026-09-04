import assert from 'node:assert/strict';
import { test } from 'node:test';
import { astSymbols } from '../src/astsymbols';
import { parse } from '../src/parser/parser';
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
  assert.deepEqual(wordAt('    $value++;', 8), { word: '$value', start: 4, end: 10 });
  assert.equal(wordAt('    out.write(42);', 3), undefined);
});

test('tolerant symbol extraction accepts compiler-valid dollar identifiers', () => {
  const source = 'record $Point {\n    int $x;\n}\npublic void $work(int $arg) { int $local = $arg; }\n';
  const symbols = extractSymbols(source);
  assert.deepEqual(symbols.map((symbol) => [symbol.kind, symbol.name]), [['record', '$Point'], ['proc', '$work']]);
  assert.deepEqual(symbols[0].children?.map((field) => field.name), ['$x']);
  assert.deepEqual(extractLocals(source, symbols).map((local) => local.name), ['$arg', '$local']);
});

test('locals survive an unparseable procedure header while record fields stay fields', () => {
  const source = 'const int N\nvoid f(int a,\n       int b) {\n    int x = 1;\n}\nrecord R {\n    int q;\n}\n';
  const locals = extractLocals(source, extractSymbols(source));
  assert.deepEqual(locals.map((local) => [local.name, local.container]), [['a', undefined], ['b', undefined], ['x', undefined]]);
});

test('tolerant extraction reports the exact column of every name', () => {
  const text = ['const int t = 1;', 'record re {', '    int i;', '}', 'protocol pro {', '    r : { int x; }', '}', 'void f(int i, int n) {', '    int t;', '    for (int i = 0; i < n; i++) { }', '    int u = 1, tu = 2;', '}', ''].join('\n');
  const symbols = extractSymbols(text);
  const at = (name: string, kind: string) => {
    const all = [...symbols, ...symbols.flatMap((s) => s.children ?? [])];
    const s = all.find((x) => x.name === name && x.kind === kind);
    return s ? `${s.line}:${s.startCol}-${s.endCol}` : 'missing';
  };
  assert.equal(at('t', 'const'), '0:10-11');
  assert.equal(at('re', 'record'), '1:7-9');
  assert.equal(at('i', 'field'), '2:8-9');
  assert.equal(at('pro', 'protocol'), '4:9-12');
  assert.equal(at('r', 'case'), '5:4-5');
  assert.equal(at('f', 'proc'), '7:5-6');
  const locals = extractLocals(text, symbols).map((l) => `${l.name}@${l.line}:${l.startCol}`);
  assert.deepEqual(locals, ['i@7:11', 'n@7:18', 't@8:8', 'i@9:13', 'u@10:8']);
});

test('a protocol whose first case is called record is still a protocol', () => {
  const [sym] = extractSymbols('protocol Msg {\n    record : { int x; }\n    other : { }\n}\n');
  assert.equal(sym.kind, 'protocol');
  assert.deepEqual(sym.children?.map((c) => c.name), ['record', 'other']);
});

test('AST symbols: a trailing comment on the previous line is not a doc comment, and locals inside nested rendezvous blocks are found', () => {
  const src = 'const int N = 1; // number of workers\npublic void f() { }\n// Documented.\npublic void g(chan<int>.read c, chan<int>.read d) {\n    c.write(d.read({ int t = 1; }));\n    int u = (d.read({ int w = 2; }));\n}\n';
  const { symbols, locals } = astSymbols(parse(src));
  assert.equal(symbols.find((s) => s.name === 'f')?.doc, undefined);
  assert.equal(symbols.find((s) => s.name === 'g')?.doc, 'Documented.');
  assert.deepEqual(locals.map((l) => l.name).sort(), ['c', 'd', 't', 'u', 'w']);
});
