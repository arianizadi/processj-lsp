import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { format } from '../src/format';
import { parse } from '../src/parser/parser';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'processj');

/** Structural view of a program with positions removed, for before/after comparison. */
function shape(text: string): unknown {
  return JSON.parse(JSON.stringify(parse(text).program, (k, v) => (k === 'span' || k === 'annotationsSpan' || k === 'headerEnd' ? undefined : v)));
}

test('formatting every example program is idempotent and preserves the parse tree', () => {
  const problems: string[] = [];
  for (const f of fs.readdirSync(FIXTURES).filter((x) => x.endsWith('.pj')).sort()) {
    const src = fs.readFileSync(path.join(FIXTURES, f), 'utf8');
    if (parse(src).errors.length) continue; // stale-syntax fixtures are covered by the parser test
    const once = format(src);
    if (!once.text) {
      problems.push(`${f}: refused to format: ${once.errors[0]?.message}`);
      continue;
    }
    const twice = format(once.text);
    if (twice.text !== once.text) problems.push(`${f}: not idempotent`);
    try {
      assert.deepEqual(shape(once.text), shape(src));
    } catch {
      problems.push(`${f}: formatting changed the parse tree`);
    }
    const commentsBefore = (src.match(/\/\/|\/\*/g) ?? []).length;
    const commentsAfter = (once.text.match(/\/\/|\/\*/g) ?? []).length;
    if (commentsAfter < commentsBefore) problems.push(`${f}: lost ${commentsBefore - commentsAfter} comment(s)`);
  }
  assert.deepEqual(problems, []);
});

test('canonical layout of a small program', () => {
  const src = [
    'import std.*;',
    'const int N=3;',
    '// A point.',
    'record Point { int x; int y; }',
    'protocol Msg { move : { int dx; int dy; } quit : { } }',
    'public void writer(chan<int>.write out){out.write(42);}',
    'public void main(string[] args){',
    '  chan<int> c1,c2; timer t; int v;',
    '',
    '',
    '  par { writer(c1.write);',
    '    v=c1.read(); // trailing',
    '  }',
    '  alt{ v=c2.read():{ println("got "+v); }',
    '    t.timeout(100) : {',
    '      println("late"); println("x");',
    '    }',
    '    skip:{}',
    '  }',
    '  for(int i=0;i<N;i++) if(i%2==0) println(i); else { println(-i); }',
    '  while (v > 0) v--;',
    '  int[] xs = new int[]{1,2,3};',
    '  switch(v){ case 1: println("one"); break; default: println("other"); }',
    '}',
  ].join('\n');
  const expected = [
    'import std.*;',
    '',
    'const int N = 3;',
    '',
    '// A point.',
    'record Point {',
    '    int x;',
    '    int y;',
    '}',
    '',
    'protocol Msg {',
    '    move : { int dx; int dy; }',
    '    quit : { }',
    '}',
    '',
    'public void writer(chan<int>.write out) {',
    '    out.write(42);',
    '}',
    '',
    'public void main(string[] args) {',
    '    chan<int> c1, c2;',
    '    timer t;',
    '    int v;',
    '',
    '    par {',
    '        writer(c1.write);',
    '        v = c1.read();  // trailing',
    '    }',
    '    alt {',
    '        v = c2.read() : { println("got " + v); }',
    '        t.timeout(100) : {',
    '            println("late");',
    '            println("x");',
    '        }',
    '        skip : { }',
    '    }',
    '    for (int i = 0; i < N; i++)',
    '        if (i % 2 == 0)',
    '            println(i);',
    '        else {',
    '            println(-i);',
    '        }',
    '    while (v > 0)',
    '        v--;',
    '    int[] xs = new int[] { 1, 2, 3 };',
    '    switch (v) {',
    '        case 1:',
    '            println("one");',
    '            break;',
    '        default:',
    '            println("other");',
    '    }',
    '}',
    '',
  ].join('\n');
  const r = format(src);
  assert.equal(r.text, expected);
  assert.equal(format(expected).text, expected);
});

test('refuses to format a file with syntax errors', () => {
  const r = format('public void main(string[] args) {\n    int x = ;\n}\n');
  assert.equal(r.text, undefined);
  assert.equal(r.errors.length, 1);
});

test('formatting preserves dotted package qualifiers in every supported position', () => {
  const src = [
    'record R extends pkg.base::Base { int value; }',
    'protocol P extends pkg.base::Parent { item: { int value; } }',
    'void run(P p, R r) implements pkg.api::work {',
    'pkg.api::work();',
    'R copy=new pkg.types::R{value=1};',
    'P event=new pkg.types::P{item:value=1};',
    'boolean matches=p is pkg.types::item;',
    'R casted=(pkg.types::R)r;',
    'pkg.types::R[] values;',
    'R process=new mobile(pkg.tasks::worker);',
    '}',
  ].join('\n');
  const result = format(src);
  assert.deepEqual(result.errors, []);
  assert.ok(result.text);
  assert.match(result.text, /extends pkg\.base::Base/);
  assert.match(result.text, /implements pkg\.api::work/);
  assert.match(result.text, /pkg\.api::work\(\)/);
  assert.match(result.text, /new pkg\.types::R/);
  assert.match(result.text, /new pkg\.types::P/);
  assert.match(result.text, /is pkg\.types::item/);
  assert.match(result.text, /\(pkg\.types::R\) r/);
  assert.match(result.text, /pkg\.types::R\[\] values/);
  assert.match(result.text, /new mobile\(pkg\.tasks::worker\)/);
  assert.doesNotMatch(result.text, /pkg::(?:api|base|types|tasks)::/);
  assert.deepEqual(shape(result.text), shape(src));
});

/** Format, failing loudly if the input was refused. */
function fmt(src: string): string {
  const r = format(src);
  assert.ok(r.text, r.errors.map((e) => `${e.line + 1}: ${e.message}`).join('; '));
  return r.text;
}

test('nested prefix operators keep a separating space so they never re-lex as ++ or --', () => {
  const src = 'public void main(string[] args) {\n    int x = 1;\n    int y = - -x;\n    int z = + +x;\n    int w = - --x;\n    int v = !!(x > 0) ? 1 : 2;\n}\n';
  const once = fmt(src);
  assert.match(once, /int y = - -x;/);
  assert.match(once, /int z = \+ \+x;/);
  assert.match(once, /int w = - --x;/);
  assert.match(once, /!!\(x > 0\)/);
  assert.deepEqual(shape(once), shape(src));
  assert.equal(fmt(once), once);
});

test('an inline alt body never hides a multi-line extended rendezvous', () => {
  const src = 'public void f(chan<int>.read c) {\n    int v;\n    alt {\n        v = c.read() : { int x = c.read({ a(); b(); }); }\n    }\n}\n';
  const once = fmt(src);
  assert.deepEqual(shape(once), shape(src));
  assert.equal(fmt(once), once);
  for (const line of once.split('\n')) assert.ok(!/^\S/.test(line) || /^(public|}|$)/.test(line), `statement printed at column 0: ${line}`);
});

test('comments around single-statement branches stay attached to their statement', () => {
  const src = [
    'public void main(string[] args) {',
    '    int a = 1;',
    '    int x = 0;',
    '    int y = 0;',
    '    if (a > 0)',
    '        x = 1; // c1',
    '    else',
    '        y = 2; // c2',
    '    while (a > 9)',
    '        // about y',
    '        y = 3;',
    '    int z = /* hi */ 1;',
    '    z++; /* note */',
    '    y++;',
    '}',
    '',
  ].join('\n');
  const once = fmt(src);
  const lines = once.split('\n');
  assert.ok(lines.includes('        x = 1;  // c1'), once);
  assert.ok(lines.includes('        y = 2;  // c2'), once);
  assert.equal(lines[lines.indexOf('        // about y') + 1], '        y = 3;', once ?? '');
  assert.ok(lines.includes('    int z = 1;  /* hi */'), once);
  assert.ok(lines.includes('    z++;  /* note */'), once);
  assert.ok(!once.includes('\n\n'), `no invented blank lines:\n${once}`);
  assert.equal((once.match(/\/\/|\/\*/g) ?? []).length, 5, 'every comment kept');
  assert.equal(fmt(once), once);
});
