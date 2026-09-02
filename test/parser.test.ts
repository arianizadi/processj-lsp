import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { parse, suggest } from '../src/parser/parser';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'processj');

function fixtures(): Array<{ name: string; text: string }> {
  return fs
    .readdirSync(FIXTURES)
    .filter((f) => f.endsWith('.pj'))
    .sort()
    .map((f) => ({ name: f, text: fs.readFileSync(path.join(FIXTURES, f), 'utf8') }));
}

test('every ProcessJ example program parses without errors (except the stale "proc" keyword)', () => {
  const problems: string[] = [];
  for (const { name, text } of fixtures()) {
    const { errors } = parse(text);
    const usesProc = /(^|\s)proc\s+\w/.test(text.replace(/\/\/.*$/gm, ''));
    const unexpected = errors.filter((e) => !(usesProc && /'proc'/.test(e.message)));
    for (const e of unexpected) problems.push(`${name}:${e.line + 1}:${e.col + 1}: ${e.message}`);
  }
  assert.deepEqual(problems, []);
});

test('misspelled statement keyword gets a suggestion and the body is still parsed', () => {
  const src = 'public void main(string[] args) {\n    pa {\n        println("a");\n        int x = ;\n    }\n}\n';
  const { errors, program } = parse(src);
  assert.equal(errors[0].line, 1);
  assert.match(errors[0].message, /Unknown statement 'pa'; did you mean 'par'\?/);
  assert.deepEqual(errors[0].fix, { title: "Change to 'par'", line: 1, col: 4, endCol: 6, text: 'par' });
  assert.ok(errors.some((e) => e.line === 3 && /Expected an expression but found ';'/.test(e.message)));
  const main = program.decls[0];
  assert.equal(main.kind, 'ProcDecl');
  assert.equal(main.kind === 'ProcDecl' && main.body?.stmts[0].kind, 'ParBlock');
});

test('missing semicolon is reported right after the statement, once', () => {
  const src = 'public void main(string[] args) {\n    int x = 1\n    println("a");\n}\n';
  const { errors } = parse(src);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].line, 1);
  assert.equal(errors[0].col, 13);
  assert.match(errors[0].message, /Missing ';' after the variable declaration/);
  assert.deepEqual(errors[0].fix, { title: "Insert ';'", line: 1, col: 13, endCol: 13, text: ';' });
});

test('unclosed block names the line where it was opened', () => {
  const src = 'public void main(string[] args) {\n    while (true) {\n        println("a");\n\n';
  const { errors } = parse(src);
  assert.ok(errors.some((e) => /Missing '\}' to close the block opened at line 2/.test(e.message)), JSON.stringify(errors));
});

test('else without if, unknown type with suggestion, not-a-statement', () => {
  const src = [
    'public void main(string[] args) {',
    '    else { }',
    '    itn y = 2;',
    '    y + 1;',
    '    c.read;',
    '}',
  ].join('\n');
  const msgs = parse(src).errors.map((e) => `${e.line}:${e.message}`);
  assert.ok(msgs.some((m) => m.startsWith("1:'else' without a matching 'if'")), msgs.join('\n'));
  assert.ok(msgs.some((m) => m.startsWith("2:Unknown type 'itn'; did you mean 'int'?")), msgs.join('\n'));
  assert.ok(msgs.some((m) => m.startsWith("3:Not a statement: the '+' expression")), msgs.join('\n'));
  assert.ok(msgs.some((m) => m.startsWith("4:'c.read' names a channel end")), msgs.join('\n'));
});

test('alt guard errors are specific', () => {
  const src = 'public void f(chan<int>.read c) {\n    int v;\n    alt {\n        c.read() : { }\n        v = c.read() { }\n    }\n}\n';
  const msgs = parse(src).errors.map((e) => e.message);
  assert.ok(msgs.some((m) => /An alt guard must store the value: write 'v = c\.read\(\)'/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some((m) => /Expected ':' after the alt guard/.test(m)), msgs.join('\n'));
});

test('top-level typos and stale proc keyword', () => {
  const msgs = parse('pubic void f() { }\nproc void g() { }\n').errors.map((e) => e.message);
  assert.ok(msgs.some((m) => /Unknown declaration 'pubic'; did you mean 'public'\?/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some((m) => /'proc' is not part of the syntax/.test(m)), msgs.join('\n'));
});

test('AST shapes: channel types, nested generics, casts, literals, extended rendezvous', () => {
  const src = [
    'record R { int a; }',
    'protocol P { tag : { int x; } none : { } }',
    'public void f(shared chan<chan<int>>.read in, chan<int>.write out) {',
    '    int v = (int) 3.5;',
    '    long w = (long) v;',
    '    R r = new R { a = 1 };',
    '    P p = new P { none: };',
    '    int[] xs = new int[] { 1, 2 };',
    '    int[][] m = new int[2][];',
    '    v = in.read({ out.write(1); }).read();',
    '    if (p is tag) out.write(v);',
    '    par enroll b { skip; }',
    '}',
  ].join('\n');
  const { errors, program } = parse(src);
  assert.deepEqual(errors, []);
  const f = program.decls[2];
  assert.equal(f.kind, 'ProcDecl');
  if (f.kind !== 'ProcDecl') return;
  const p0 = f.params[0].type;
  assert.equal(p0.kind, 'ChanType');
  assert.equal(p0.kind === 'ChanType' && p0.shared && p0.end === 'read' && p0.elem.kind === 'ChanType', true);
  const body = f.body!.stmts;
  assert.equal(body[0].kind === 'LocalDecl' && body[0].declarators[0].init?.kind, 'CastExpr');
  assert.equal(body[2].kind === 'LocalDecl' && body[2].declarators[0].init?.kind, 'RecordLiteral');
  assert.equal(body[3].kind === 'LocalDecl' && body[3].declarators[0].init?.kind, 'ProtocolLiteral');
  assert.equal(body[4].kind === 'LocalDecl' && body[4].declarators[0].init?.kind === 'NewArray' && body[4].declarators[0].init.init?.elements.length, 2);
  assert.equal(body[5].kind === 'LocalDecl' && body[5].declarators[0].init?.kind === 'NewArray' && body[5].declarators[0].init.extraDims, 1);
  const rd = body[6].kind === 'ExprStmt' && body[6].expr.kind === 'AssignExpr' ? body[6].expr.value : undefined;
  assert.equal(rd?.kind, 'ChanRead');
  assert.equal(rd?.kind === 'ChanRead' && rd.target.kind === 'ChanRead' && !!rd.target.extended, true);
  assert.equal(body[7].kind === 'IfStmt' && body[7].cond.kind, 'IsExpr');
  assert.equal(body[8].kind === 'ParBlock' && body[8].barriers.length, 1);
});

test('suggest picks close keywords only', () => {
  assert.equal(suggest('pa', ['par', 'pri', 'if']), 'par');
  assert.equal(suggest('whlie', ['while', 'for']), 'while');
  assert.equal(suggest('fooo', ['while', 'for']), undefined);
  assert.equal(suggest('x', ['if']), undefined);
});
