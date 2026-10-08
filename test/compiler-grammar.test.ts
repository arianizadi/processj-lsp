/**
 * The parser accepts exactly what the compiler's CUP grammar accepts. Every
 * verdict here was checked against the real compiler with
 * `node scripts/parse-diff.js`, which compares the two parsers' trees (via the
 * compiler's -showTree dump) and which side rejects a file; the cases are the
 * disagreements its corpus run and fuzzer found, plus their accepted neighbours.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import type * as A from '../src/parser/ast';
import { format } from '../src/format';
import { parse } from '../src/parser/parser';

const proc = (body: string, params = '') => `void f(${params}) {\n    ${body}\n}\n`;

function problems(src: string): string[] {
  const r = parse(src);
  return [...r.lexIssues.map((i) => i.message), ...r.errors.map((e) => e.message)];
}

function rejects(src: string, expected: RegExp): void {
  const found = problems(src);
  assert.ok(found.some((m) => expected.test(m)), `${src}\n${found.join('\n')}`);
}

function accepts(src: string): void {
  assert.deepEqual(problems(src), [], src);
}

/** The first statement of the first procedure. */
function firstStatement(src: string): A.Stmt {
  const d = parse(src).program.decls.find((x) => x.kind === 'ProcDecl');
  assert.ok(d?.kind === 'ProcDecl' && d.body?.stmts[0], src);
  return d.body.stmts[0];
}

/** The right-hand side of `x = ...;` as the first statement. */
function assigned(src: string): A.Expr {
  const s = firstStatement(src);
  assert.ok(s.kind === 'ExprStmt' && s.expr.kind === 'AssignExpr', src);
  return s.expr.value;
}

test("a nested channel type closed with '>>' is rejected with a fix, as the compiler's lexer reads a shift", () => {
  const r = parse('void f(chan<chan<int>> c) { }');
  assert.deepEqual(r.errors.map((e) => e.message), ["The ProcessJ lexer reads '>>' as a shift operator, so nested channel types must close with '> >'"]);
  assert.deepEqual(r.errors[0].fix, { title: "Change to '> >'", line: 0, col: 20, endCol: 22, text: '> >' });
  // The type is still parsed as meant, and reported once even for three levels.
  const p = r.program.decls[0];
  assert.ok(p.kind === 'ProcDecl' && p.params[0].type.kind === 'ChanType' && p.params[0].type.elem.kind === 'ChanType');
  assert.equal(parse('void f() { chan<chan<chan<int>>> c; }').errors.length, 1);
  accepts('void f(chan<chan<int> > c, shared chan<chan<int> >.write d, chan<chan<int>.read> e) { chan<chan<chan<int> > > g; }');
  // The formatter must not write back what the compiler rejects.
  assert.match(format('void f(chan<chan<int> > c) { }').text ?? '', /chan<chan<int> > c/);
});

test('channel writes, sync and timeout are statements of their own, never values', () => {
  rejects(proc('x = t.timeout(5);', 'timer t'), /'\.timeout\(\.\.\.\)' is a statement of its own/);
  rejects(proc('x = b.sync();', 'barrier b'), /'\.sync\(\)' is a statement of its own/);
  rejects(proc('g(c.write(1));', 'chan<int>.write c'), /'\.write\(\.\.\.\)' is a statement of its own/);
  rejects(proc('c.write(1).x = 2;', 'chan<int>.write c'), /is a statement of its own/);
  rejects(proc('for (c.write(1); ; ) { }', 'chan<int>.write c'), /is a statement of its own/);
  accepts(proc('c.write(1); (c).write(2); d.read().write(3); a[0].sync(); t.timeout(4); x.read({ c.write(5); });', 'chan<int>.write c, timer t'));
  accepts(proc('alt { t.timeout(5) : skip; (x > 0) && t.timeout(6) : skip; }', 'timer t'));
});

test('only a name, literal, parenthesis, field, call or element can be indexed directly', () => {
  rejects(proc('x = c.read()[0];'), /cannot index the result of a channel read directly/);
  rejects(proc('x = c.read[0];'), /cannot index a channel end directly/);
  rejects(proc('x = lib::b[0];'), /cannot index a package-qualified name directly/);
  rejects(proc('x = new int[] { 1 }[0];'), /cannot index a new array directly/);
  rejects(proc('x = new mobile(g)[0];'), /cannot index a 'new mobile' expression directly/);
  accepts(proc('x = (c.read())[0]; x = "abc"[0]; x = g()[0]; x = a.b[0][1]; x = (lib::b)[0]; x = new R { a = 1 }[0];'));
  // Two sizes, not an index of the new array.
  const e = assigned(proc('x = new int[3][0];'));
  assert.equal(e.kind === 'NewArray' && e.dimExprs.length, 2);
});

test("'x++' ends a postfix chain: no member, index or '::' after it", () => {
  rejects(proc('x = y++.z;'), /'\+\+' ends the expression; wrap it in parentheses to apply '\.'/);
  rejects(proc('x = y--[0];'), /'--' ends the expression; wrap it in parentheses to apply '\['/);
  rejects(proc('x = y++::z;'), /'\+\+' ends the expression/);
  accepts(proc('x = (y++).z; x = y++ ++; x = y----;'));
});

test("'fork' needs at least one argument", () => {
  rejects(proc('fork();'), /'fork' needs at least one argument/);
  accepts(proc('fork(g); fork(g, h).x();'));
});

test("an 'is' test binds like '<', so a tighter operator cannot follow it", () => {
  for (const op of ['*', '+', '>>', '%']) rejects(proc(`x = a is T ${op} b;`), new RegExp(`'${op.replace(/[*+]/, '\\$&')}' binds tighter than 'is'`));
  accepts(proc('x = a is T == b; x = a is T && b is U; x = a + b is T; x = a is T < b; x = (a is T) * b; x = a is T ? b : c;'));
  // `a == b is T` is `a == (b is T)`; `a + b is T` is `(a + b) is T`.
  const eq = assigned(proc('x = a == b is T;'));
  assert.ok(eq.kind === 'BinaryExpr' && eq.op === '==' && eq.right.kind === 'IsExpr');
  const sum = assigned(proc('x = a + b is T;'));
  assert.ok(sum.kind === 'IsExpr' && sum.expr.kind === 'BinaryExpr' && sum.expr.op === '+');
});

test("a labeled statement cannot end the branch before 'else', and a label needs a statement", () => {
  rejects(proc('if (c) L: x = 1; else x = 2;'), /labeled statement cannot end the branch before 'else'/);
  rejects(proc('if (c) while (x > 0) L: x = 1; else x = 2;'), /labeled statement cannot end the branch before 'else'/);
  rejects(proc('if (c) if (d) x = 1; else L: x = 2; else x = 3;'), /labeled statement cannot end the branch before 'else'/);
  rejects(proc('L: ;'), /Label 'L' must be followed by a statement/);
  rejects('void f() { L: }', /Label 'L' must be followed by a statement/);
  accepts(proc('if (c) { L: x = 1; } else x = 2; if (c) x = 1; else L: x = 2; while (x) L: x = 1; if (c) do L: x = 1; while (x); else x = 3; L: M: while (true) { break L; }'));
});

test('a package-qualified array type needs a dotted package', () => {
  rejects(proc('lib::T[] x;'), /package-qualified array type only with a dotted package such as 'a\.b::T\[\]'/);
  rejects('void f(lib::T[] x) { }', /only with a dotted package/);
  accepts('void f(a.lib::T[] x) { a.lib::T[] y; }');
});

test('int and long literals must fit, as the compiler decodes them with Integer.decode and Long.decode', () => {
  for (const big of ['2147483648', '0xFFFFFFFF', '037777777777', '0x80000000']) rejects(proc(`int x = ${big};`), /too large for an int: the compiler accepts at most 2147483647/);
  rejects(proc('int x = -2147483648;'), /too large for an int/);
  rejects(proc('long x = 9223372036854775808L;'), /too large for a long/);
  // Without a suffix or a point, a number is an int literal even where a double is wanted.
  rejects(proc('double d = 99999999999;'), /too large for an int/);
  accepts(proc('int x = 2147483647; int h = 0x7fffffff; int o = 017777777777; long l = 9223372036854775807L; long h2 = 0xFFFFFFFFL; double d = 99999999999d;'));
  // Annotation values are kept as text and never decoded.
  accepts('void f() [k=99999999999] { }');
});

test('a claim takes channel names, channel ends, or a declaration of a field, call, element or parenthesised value', () => {
  for (const bad of ['c[0]', 'a.b', '(c)', 'g()', 'lib::c']) rejects(proc(`claim (${bad}) { skip; }`), /A claim takes channel names and channel ends/);
  rejects(proc('claim (chan<int>.write w = c) { }'), /field, call, element or parenthesised value after '=' in a claim declaration; write '\(c\)'/);
  rejects(proc('claim (chan<int>.write w = c.write) { }'), /in a claim declaration/);
  accepts(proc('claim (c, d.write, e.f.read, g().write) { skip; } claim (chan<int>.write w = a.b, shared chan<int>.read r = g(), chan<int>.write v = (c), chan<int>.write u = c[0]) { skip; }'));
});

test('an alt guard may start with a parenthesised timer; only a following && makes it a precondition', () => {
  const s = firstStatement(proc('alt { (t).timeout(5) : skip; (t)[0].timeout(6) : skip; (x > 0) && (t).timeout(7) : skip; }', 'timer t'));
  assert.ok(s.kind === 'AltStmt');
  assert.deepEqual(s.cases.map((c) => [c.guard?.kind, !!c.precondition]), [['TimeoutGuard', false], ['TimeoutGuard', false], ['TimeoutGuard', true]]);
  rejects(proc('alt { (x > 0) v = c.read() : skip; }'), /Expected '&&' between the precondition and the guard/);
});

test('a cast type may sit inside extra parentheses, as CUP casts any parenthesised name', () => {
  for (const src of ['x = ((T)) y;', 'x = (((T))) y;', 'x = ((a.lib::T)) (y);']) {
    const e = assigned(proc(src));
    assert.ok(e.kind === 'CastExpr' && e.type.kind === 'NamedType', src);
  }
  // Not a cast when an operator follows: subtraction of a parenthesised name.
  const minus = assigned(proc('x = ((a)) - y;'));
  assert.ok(minus.kind === 'BinaryExpr' && minus.op === '-');
  rejects(proc('x = ((int)) y;'), /Expected an expression/);
});

test("'par enroll' takes any expression list; only '(a, b)' right before the block is a mistake", () => {
  const field = firstStatement(proc('par enroll (b).x { skip; }'));
  assert.ok(field.kind === 'ParBlock' && field.barriers.length === 1 && field.barriers[0].kind === 'RecordAccess' && !field.barrierParens);
  const two = firstStatement(proc('par enroll (b), c { skip; }'));
  assert.ok(two.kind === 'ParBlock' && two.barriers.length === 2);
  const one = firstStatement(proc('par enroll (b) { skip; }'));
  assert.ok(one.kind === 'ParBlock' && one.barrierParens && one.barriers[0].kind === 'NameExpr');
  rejects(proc('par enroll (b, c) { skip; }'), /accepts one barrier only/);
});

test('pragmas are checked the way the compiler decodes them', () => {
  rejects('#pragma trace;\nvoid f() { }', /Unknown pragma 'trace'; the compiler accepts only LIBRARY, LANGUAGE, NATIVE, NATIVELIB, FILE/);
  rejects('#pragma FILE;\nvoid f() { }', /Pragma 'FILE' needs a string value/);
  rejects('#pragma library "x";\nvoid f() { }', /Pragma 'library' takes no value/);
  rejects('#pragma FILE "a";\n#pragma file "b";\nvoid f() { }', /Pragma 'file' is repeated/);
  accepts('#pragma LIBRARY;\n#pragma NATIVE;\n#pragma FILE "io";\n#pragma LANGUAGE "JVM";\npackage std;\npublic native void println(string s);\n');
});

test("the harness's two renderings agree on a recorded -showTree dump", () => {
  // scripts/parse-diff.js is plain JavaScript; it loads the built parser from dist/.
  const diff = require('../../scripts/parse-diff.js') as {
    oursFor(text: string): { problems: string[]; items: Array<{ tree: unknown }> };
    compilerFor(stdout: string, stderr: string): { rejected?: string; items?: unknown[] };
    sx(node: unknown): string;
  };
  const dir = path.join(__dirname, '..', '..', 'test', 'fixtures', 'showtree');
  const ours = diff.oursFor(fs.readFileSync(path.join(dir, 'shapes.pj'), 'utf8'));
  const theirs = diff.compilerFor(fs.readFileSync(path.join(dir, 'shapes.tree'), 'utf8'), '');
  assert.deepEqual(ours.problems, []);
  assert.equal(theirs.rejected, undefined);
  assert.deepEqual(ours.items.map((i) => diff.sx(i.tree)), (theirs.items ?? []).map((i) => diff.sx(i)));
  assert.equal(ours.items.length, 6);
});
