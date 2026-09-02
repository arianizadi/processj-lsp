import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze } from '../src/analysis';
import { extractLocals, extractSymbols } from '../src/symbols';
import { tokenize } from '../src/tokens';

function lint(src: string, libraryNames?: Set<string>) {
  const symbols = extractSymbols(src);
  const locals = extractLocals(src, symbols);
  return analyze(src, symbols, locals, { libraryNames });
}
const codes = (src: string, lib?: Set<string>) => lint(src, lib).map((d) => d.code);

test('tokenizer: strings, numbers, punctuation, keywords', () => {
  const { tokens, issues } = tokenize('chan<int> c; c.write(0x1F); println("a b" + 3.5e2);');
  assert.equal(issues.length, 0);
  assert.deepEqual(tokens.slice(0, 5).map((t) => t.text), ['chan', '<', 'int', '>', 'c']);
  assert.equal(tokens.find((t) => t.kind === 'string')?.text, '"a b"');
  assert.ok(tokens.some((t) => t.kind === 'number' && t.text === '0x1F'));
  assert.ok(tokens.some((t) => t.kind === 'number' && t.text === '3.5e2'));
});

test('lexer limits: escapes in strings, non-ASCII, empty block comment', () => {
  const src = 'public void main(string[] args) {\n    println("a\\nb"); // café\n    /**/\n}\n';
  const c = codes(src);
  assert.ok(c.includes('pj/string-escape'));
  assert.ok(c.includes('pj/non-ascii'));
  assert.ok(c.includes('pj/empty-comment'));
});

test('channel direction: end.end chains and declared end types', () => {
  const src = [
    'public void f(chan<int>.read in, chan<int>.write out) {',
    '    in.write(1);',
    '    int v = out.read();',
    '    in.read.write(2);',
    '}',
  ].join('\n');
  const d = lint(src).filter((x) => x.code === 'pj/channel-direction');
  assert.equal(d.length, 3);
  assert.deepEqual(d.map((x) => x.line), [1, 2, 3]);
});

test('channel write type mismatches on literals', () => {
  const src = 'public void f() {\n    chan<int> c;\n    chan<string> s;\n    c.write("hello");\n    s.write(5);\n    c.write(7);\n    s.write("ok");\n}\n';
  const d = lint(src).filter((x) => x.code === 'pj/channel-write-type');
  assert.deepEqual(d.map((x) => x.line), [3, 4]);
});

test('short-circuit channel read is flagged only on the right side', () => {
  const src = 'public void f(chan<int>.read c) {\n    int n = 0;\n    if (n > 0 && c.read() == 1) { }\n    if (c.read() == 1 && n > 0) { }\n    int x = n > 0 ? c.read() : 0;\n}\n';
  const d = lint(src).filter((x) => x.code === 'pj/short-circuit-read');
  assert.deepEqual(d.map((x) => x.line), [2, 4]);
});

test('parallel usage rule: write in one branch, use in another', () => {
  const src = [
    'public void main(string[] args) {',
    '    int x = 0;',
    '    int y = 0;',
    '    par {',
    '        x = 1;',
    '        y = x + 1;',
    '        { int z = 3; z = z + 1; }',
    '    }',
    '}',
  ].join('\n');
  const d = lint(src).filter((x) => x.code === 'pj/parallel-usage');
  assert.equal(d.length, 1);
  assert.equal(d[0].line, 5);
  assert.match(d[0].message, /'x'/);
});

test('parallel usage rule: no false positive for branch-local declarations or reads only', () => {
  const src = 'public void main(string[] args) {\n    int x = 0;\n    par {\n        println(x);\n        println(x + 1);\n        { int t = x; }\n    }\n}\n';
  assert.deepEqual(lint(src).filter((x) => x.code === 'pj/parallel-usage'), []);
});

test('shared channel end used in two branches gets an error and a make-shared fix', () => {
  const src = [
    'public void main(string[] args) {',
    '    chan<int> c;',
    '    par {',
    '        writer(c.write);',
    '        writer(c.write);',
    '        reader(c.read);',
    '    }',
    '}',
  ].join('\n');
  const d = lint(src).filter((x) => x.code === 'pj/shared-channel-end');
  assert.equal(d.length, 1);
  assert.equal(d[0].line, 4);
  assert.equal(d[0].fix?.kind, 'make-shared');
  assert.equal(d[0].fix?.line, 1);
  assert.equal(d[0].fix?.col, 4);
});

test('shared channels do not trigger the shared-end lint', () => {
  const src = 'public void main(string[] args) {\n    shared chan<int> c;\n    par {\n        writer(c.write);\n        writer(c.write);\n        reader(c.read);\n    }\n}\n';
  assert.deepEqual(lint(src).filter((x) => x.code === 'pj/shared-channel-end'), []);
});

test('unused locals and parameter shadowing', () => {
  const src = 'public void f(int x, int unusedParam) {\n    int x = 3;\n    int dead;\n    println("" + x);\n}\n';
  const d = lint(src);
  assert.ok(d.some((x) => x.code === 'pj/unused' && x.message.includes("'dead'")));
  assert.ok(d.some((x) => x.code === 'pj/unused' && x.message.includes("'unusedParam'") && x.severity === 'info'));
  assert.ok(d.some((x) => x.code === 'pj/shadows-parameter'));
});

test('channel read with no writer in scope', () => {
  const src = 'public void main(string[] args) {\n    chan<int> c;\n    int x = c.read();\n}\n';
  const d = lint(src).filter((x) => x.code === 'pj/channel-no-writer');
  assert.equal(d.length, 1);
  assert.equal(d[0].line, 2);
  const ok = 'public void main(string[] args) {\n    chan<int> c;\n    par { c.write(1); int x = c.read(); }\n}\n';
  assert.deepEqual(lint(ok).filter((x) => x.code === 'pj/channel-no-writer'), []);
  const passed = 'public void main(string[] args) {\n    chan<int> c;\n    par { w(c); int x = c.read(); }\n}\n';
  assert.deepEqual(lint(passed).filter((x) => x.code === 'pj/channel-no-writer'), []);
});

test('alt lints: timeout guard, second alt, reserved names, plain timeout hint', () => {
  const src = [
    'public void f(chan<int>.read c, timer t) {',
    '    int v;',
    '    int index = 0;',
    '    alt {',
    '        v = c.read() : { }',
    '        t.timeout(100) : { }',
    '    }',
    '    alt { v = c.read() : { } }',
    '    t.timeout(5);',
    '}',
  ].join('\n');
  const c = codes(src);
  assert.ok(c.includes('pj/alt-timeout'));
  assert.ok(c.includes('pj/multiple-alts'));
  assert.ok(c.includes('pj/reserved-alt-name'));
  assert.ok(c.includes('pj/timeout-noop'));
  assert.equal(c.filter((x) => x === 'pj/timeout-noop').length, 1);
});

test('missing import std with fix location after the last header line', () => {
  const lib = new Set(['println', 'print']);
  const src = 'package demo;\n\npublic void main(string[] args) {\n    println("hi");\n}\n';
  const d = lint(src, lib).filter((x) => x.code === 'pj/missing-import');
  assert.equal(d.length, 1);
  assert.equal(d[0].fix?.kind, 'add-import');
  assert.equal(d[0].fix?.line, 1);
  assert.deepEqual(lint('import std.*;\n' + src.replace('package demo;\n', ''), lib).filter((x) => x.code === 'pj/missing-import'), []);
});

test('a clean program produces no lints', () => {
  const src = [
    'import std.*;',
    '',
    'public void writer(chan<int>.write out) { out.write(42); }',
    '',
    'public void reader(chan<int>.read in) { int v = in.read(); println("got " + v); }',
    '',
    'public void main(string[] args) {',
    '    chan<int> c;',
    '    par {',
    '        writer(c.write);',
    '        reader(c.read);',
    '    }',
    '}',
  ].join('\n');
  assert.deepEqual(lint(src, new Set(['println'])), []);
});
