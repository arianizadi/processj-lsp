import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { format } from '../src/format';
import { parse } from '../src/parser/parser';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'processj');

/** Structural view of a program with positions removed, for before/after comparison. */
function shape(text: string): unknown {
  return JSON.parse(JSON.stringify(parse(text).program, (k, v) => (k === 'span' ? undefined : v)));
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
