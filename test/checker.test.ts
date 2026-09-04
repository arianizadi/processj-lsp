import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { check } from '../src/checker/checker';
import { DeclIndex } from '../src/checker/index';
import { parse } from '../src/parser/parser';

const FIXTURES = path.join(__dirname, '..', '..', 'test', 'fixtures', 'processj');
const INCLUDE = path.join(__dirname, '..', '..', 'test', 'fixtures', 'include');

function stdIndex(): DeclIndex {
  const idx = new DeclIndex();
  for (const dir of ['std', 'image']) {
    const full = path.join(INCLUDE, dir);
    for (const f of fs.readdirSync(full).filter((x) => x.endsWith('.pj')).sort()) {
      idx.addProgram(parse(fs.readFileSync(path.join(full, f), 'utf8')).program, path.join(full, f));
    }
  }
  return idx;
}
const STD = stdIndex();
const TRUSTED_STD_OUTPUT_DECLARATIONS = new Set(
  ['print', 'println'].flatMap((name) => STD.procs.get(name) ?? []).map((signature) => signature.decl),
);

export function run(src: string, opts: { std?: boolean } = {}) {
  const parsed = parse(src);
  assert.deepEqual(parsed.errors, [], 'test program must parse');
  const index = new DeclIndex();
  index.addProgram(parsed.program, 'test.pj');
  const importsStd = /import\s+std\b/.test(src);
  if (opts.std !== false && importsStd) index.addIndex(STD);
  const result = check(parsed.program, {
    index,
    stdIndex: STD,
    importsStd,
    text: src,
    trustedNonBlockingNativeDeclarations: TRUSTED_STD_OUTPUT_DECLARATIONS,
  });
  return { ...result, codes: result.diagnostics.filter((d) => d.severity !== 'info').map((d) => d.code), notes: result.diagnostics.filter((d) => d.severity === 'info').map((d) => `${d.line + 1}:${d.code}`), messages: result.diagnostics.filter((d) => d.severity !== 'info').map((d) => `${d.line + 1}: ${d.message}`), errors: result.diagnostics.filter((d) => d.severity === 'error') };
}

const MAIN = (body: string, extra = '') => `import std.*;\n${extra}\npublic void main(string[] args) {\n${body}\n}\n`;

// Genuine bugs in the compiler's own examples that the checker is expected to find.
const KNOWN_CORPUS_BUGS: Record<string, string[]> = {
  // muxGate declares out1 as a read end and writes to it; callers then hand the same read end to two processes.
  'fullAdder.pj': ['pj/channel-direction', 'pj/shared-channel-end'],
  // a find/replace of int -> long turned println into prlongln.
  'integrate.pj': ['pj/type/call'],
};

test('the compiler example corpus type-checks; only the known bugs in it are reported', () => {
  const problems: string[] = [];
  for (const f of fs.readdirSync(FIXTURES).filter((x) => x.endsWith('.pj')).sort()) {
    const src = fs.readFileSync(path.join(FIXTURES, f), 'utf8');
    const parsed = parse(src);
    if (parsed.errors.length) continue;
    const index = new DeclIndex();
    index.addProgram(parsed.program, f);
    index.addIndex(STD);
    const r = check(parsed.program, { index, stdIndex: STD, importsStd: true });
    const errors = r.diagnostics.filter((d) => d.severity === 'error');
    const codes = [...new Set(errors.map((d) => d.code))].sort();
    const expected = (KNOWN_CORPUS_BUGS[f] ?? []).sort();
    if (JSON.stringify(codes) !== JSON.stringify(expected)) {
      problems.push(`${f}: expected [${expected.join(', ')}] but got [${codes.join(', ')}]`);
      for (const d of errors.slice(0, 5)) problems.push(`    ${f}:${d.line + 1}: [${d.code}] ${d.message}`);
    }
  }
  assert.deepEqual(problems, []);
});

test('names: undefined with suggestion and fix, proc as value, type as value, duplicates, use in own initialiser', () => {
  const r = run(MAIN('    int count = 1;\n    int x = cuont + 1;\n    int y = main;\n    int z = Point;\n    int x = 2;\n    int w = w + 1;', 'record Point { int a; }'));
  assert.ok(r.messages.some((m) => m.startsWith("5: Cannot find 'cuont'; did you mean 'count'?")), r.messages.join('\n'));
  assert.equal(r.diagnostics.find((d) => /cuont/.test(d.message))?.fix?.text, 'count');
  assert.ok(r.messages.some((m) => /'main' is a procedure; call it/.test(m)));
  assert.ok(r.messages.some((m) => /'Point' is a type, not a value/.test(m)));
  assert.ok(r.messages.some((m) => /'x' is already declared in this scope \(line 5\)/.test(m)), r.messages.join('\n'));
  assert.ok(r.messages.some((m) => m.startsWith("9: Cannot find 'w'")));
});

test('assignments and arithmetic follow Java widening, with constant narrowing for literals', () => {
  const ok = run(MAIN('    byte b = 1;\n    short s = 2;\n    int i = b + s;\n    long l = i;\n    float f = 1.5;\n    double d = l * f;\n    string t = "n=" + i + d;\n    boolean eq = i == l && t != null;\n    char c = 65;\n    i += 2; l <<= 1; t += 1;\n    println(t + eq + c);'));
  assert.deepEqual(ok.errors, [], ok.messages.join('\n'));
  const bad = run(MAIN('    int i = 1;\n    long l = 2;\n    int j = l;\n    int k = "s";\n    string s = 5;\n    boolean b = i + 1;\n    boolean c = i && true;\n    i = i < 2;\n    if (i) { }\n    int m = -true;'));
  assert.deepEqual(
    bad.errors.map((d) => `${d.line + 1}: ${d.message}`),
    [
      "6: Cannot initialise 'j' (int) with a value of type long (long does not fit in int without a cast)",
      "7: Cannot initialise 'k' (int) with a value of type string",
      "8: Cannot initialise 's' (string) with a value of type int",
      "9: Cannot initialise 'b' (boolean) with a value of type int",
      "10: '&&' needs boolean operands; here they are int and boolean",
      "11: Cannot assign boolean to 'i' (int)",
      "12: The condition of 'if' must be boolean, not int",
      "13: Unary '-' needs a number; true is boolean",
    ],
  );
});

test('channels: element types, directions, whole channel vs end, shared requirement', () => {
  const src = MAIN(
    [
      '    chan<int> c;',
      '    chan<string> s;',
      '    par {',
      '        c.write("hello");',
      '        s.write(5);',
      '        reader(c);',
      '        reader(c.write);',
      '        writer(c.read);',
      '        sharedReader(c.read);',
      '        int v = c.write.read();',
      '        c.read.write(1);',
      '        s.write("ok");',
      '        println(s.read());',
      '    }',
    ].join('\n'),
    'public void reader(chan<int>.read in) { println(in.read()); in.write(1); }\npublic void writer(chan<int>.write out) { out.write(1); int x = out.read(); }\npublic void sharedReader(shared chan<int>.read in) { println(in.read()); }',
  );
  const r = run(src);
  const errs = r.errors.map((d) => `${d.line + 1}:${d.code}`);
  assert.ok(errs.includes('2:pj/channel-direction'), `in.write on read end: ${errs.join(' ')}`);
  assert.ok(errs.includes('3:pj/channel-direction'), 'out.read on write end');
  assert.ok(errs.includes('9:pj/channel-write-type'), `string into chan<int>: ${errs.join(' ')}`);
  assert.ok(errs.includes('10:pj/channel-write-type'), 'int into chan<string>');
  assert.ok(r.messages.some((m) => m.startsWith("11: No version of 'reader' accepts (chan<int>)") && /pass an end of the channel: '.read'/.test(m)), r.messages.join('\n'));
  assert.ok(r.messages.some((m) => m.startsWith("12: No version of 'reader' accepts (chan<int>.write)") && /write end was given where a read end/.test(m)));
  assert.ok(r.messages.some((m) => m.startsWith("13: No version of 'writer' accepts (chan<int>.read)")));
  assert.ok(r.messages.some((m) => m.startsWith("14: No version of 'sharedReader' accepts (chan<int>.read)") && /declare the channel 'shared chan<int>'/.test(m)));
  assert.ok(errs.includes('15:pj/channel-direction'), 'c.read.read');
  assert.ok(errs.includes('16:pj/channel-direction'), 'c.read.write');
  assert.ok(!errs.includes('17:pj/channel-write-type') && !errs.includes('18:pj/channel-write-type'));
});

test('records and protocols: fields, literals, switch narrowing, is', () => {
  const decls = 'record Point { int x; int y; }\nrecord Point3 extends Point { int z; }\nprotocol Msg { move : { int dx; int dy; } quit : { string reason; } }';
  const ok = run(MAIN('    Point3 p = new Point3 { x = 1, y = 2, z = 3 };\n    int s = p.x + p.z;\n    Point q = p;\n    Msg m = new Msg { move: dx = 1, dy = 2 };\n    Msg n = new Msg { quit: };\n    switch (m) {\n        case move: s = m.dx; break;\n        case quit: println(m.reason); break;\n    }\n    if (m is move) s = m.dy;\n    println(s + q.y);', decls));
  assert.deepEqual(ok.errors, [], ok.messages.join('\n'));
  const bad = run(MAIN('    Point p = new Point { x = 1, yy = 2 };\n    int a = p.z;\n    Msg m = new Msg { mvoe: dx = 1 };\n    Msg n = new Msg { move: reason = "r" };\n    switch (m) {\n        case move: println(m.reason); break;\n        case halt: break;\n    }\n    boolean b = m is bogus;\n    Point q = new Msg { quit: };', decls));
  assert.deepEqual(
    bad.errors.map((d) => `${d.line + 1}: ${d.message}`),
    [
      "6: Record 'Point' has no field 'yy' (fields: x, y); did you mean 'y'?",
      "7: Record 'Point' has no field 'z' (fields: x, y)",
      "8: 'mvoe' is not a case of protocol Msg (cases: move, quit); did you mean 'move'?",
      "9: Case 'move' of Msg has no field 'reason' (fields: dx, dy)",
      "11: 'reason' belongs to case quit, but here 'm' is case 'move' (fields: dx, dy)",
      "12: 'halt' is not a case of protocol Msg (cases: move, quit)",
      "14: 'bogus' is not a case of protocol Msg (cases: move, quit)",
      "15: Cannot initialise 'q' (Point) with a value of type Msg",
    ],
  );
  const unnarrowed = run(MAIN('    Msg n = new Msg { quit: reason = "done" };\n    println(n.reason);', decls));
  assert.match(unnarrowed.errors.find((d) => d.code === 'pj/type/field')?.message ?? '', /only be inspected after a protocol switch/);
});

test('procedure calls: overload resolution, mismatch explanations, methods, return and break checks', () => {
  const extra = 'public int twice(int v) { return v * 2; }\npublic long twice(long v) { return v * 2; }\npublic void show(string s, int n) { println(s + n); }\npublic int bad() { return; }\npublic void bad2() { return 1; }\npublic int noret(int x) { if (x > 0) return x; else return -x; }';
  const r = run(MAIN('    byte b = 3;\n    int t = twice(b);\n    long u = twice(4L);\n    show("n", "x");\n    show(1);\n    twiceX(1);\n    int q = args.size + "abc".length;\n    break;\n    println(t + u + q);', extra));
  const msgs = r.messages;
  assert.ok(msgs.some((m) => m.startsWith("12: No version of 'show' accepts (string, string): argument 2 ('n') needs int")), msgs.join('\n'));
  assert.ok(msgs.some((m) => m.startsWith("13: No version of 'show' accepts (int). Available: void show(string s, int n)")));
  assert.ok(msgs.some((m) => m.startsWith("14: Cannot find a procedure named 'twiceX'; did you mean 'twice'?")));
  assert.ok(msgs.some((m) => m.startsWith("16: 'break' outside of a loop or switch")));
  assert.ok(msgs.some((m) => /'bad' must return a value of type int/.test(m)));
  assert.ok(msgs.some((m) => /'bad2' returns void; it cannot return a value/.test(m)));
  assert.ok(!msgs.some((m) => /Ambiguous/.test(m)), 'byte argument picks twice(int) as most specific');
  const call = [...r.calls.values()].find((s) => s.name === 'twice' && s.params[0].k === 'prim' && s.params[0].name === 'int');
  assert.ok(call, 'twice(int) chosen for a byte argument');
});

test('concurrency lints from the AST: parallel usage, shared ends with fix, no writer, short circuit', () => {
  const r = run(MAIN('    chan<int> c;\n    chan<int> d;\n    int x = 0;\n    par {\n        w(c.write);\n        w(c.write);\n        x = 1;\n        println(x);\n        { int local = 1; local = local + 1; }\n        println(c.read());\n    }\n    int v = d.read();\n    if (x > 0 && c.read() == 1) { }\n    int z = x > 0 ? c.read() : v;', 'public void w(chan<int>.write o) { o.write(1); }'));
  const byCode = (code: string) => r.diagnostics.filter((d) => d.code === code).map((d) => d.line + 1);
  assert.deepEqual(byCode('pj/parallel-usage'), [11]);
  assert.deepEqual(byCode('pj/shared-channel-end'), [9]);
  assert.equal(r.diagnostics.find((d) => d.code === 'pj/shared-channel-end')?.fix?.kind, 'make-shared');
  assert.deepEqual(byCode('pj/channel-no-writer'), [15]);
});

test('an end handed to a procedure is not an operation: no blocking or self-deadlock claims about it', () => {
  // alttest.pj: c2's read end goes to a procedure that may only use it in an alt.
  const passedEnd = run(MAIN('    chan<int> c1;\n    chan<int> c2;\n    par {\n        c1.write(42);\n        reader(c1.read, c2.read);\n    }', 'public void reader(chan<int>.read a, chan<int>.read b) { println(a.read()); }'));
  assert.deepEqual(passedEnd.codes.filter((c) => (c ?? '').startsWith('pj/channel')), []);
  // fibonacci.pj: both ends of one channel handed to one call that forks internally.
  const bothEnds = run(MAIN('    chan<int> c;\n    fib(c.write, c.read);', 'public void fib(chan<int>.write w, chan<int>.read r) { par { w.write(1); println(r.read()); } }'));
  assert.deepEqual(bothEnds.codes.filter((c) => (c ?? '').startsWith('pj/channel')), []);
});

test('parenthesized and explicitly selected channel operations remain direct, not escaped', () => {
  const result = run(MAIN('    chan<int> c;\n    par {\n        c.write.write(1);\n        println((c).read());\n    }'));
  assert.deepEqual(result.codes.filter((code) => (code ?? '').startsWith('pj/channel')), []);
  const channel = result.channels.find((fact) => fact.variable.name === 'c');
  assert.ok(channel);
  assert.equal(channel.escaped, false);
  assert.deepEqual(channel.operations.map((operation) => [operation.end, operation.direct]), [['write', true], ['read', true]]);
});

test('a read guard in an alt with other guards does not block by itself', () => {
  const alt = run(MAIN('    chan<int> c;\n    timer t;\n    int v;\n    alt {\n        v = c.read() : { println("got " + v); }\n        t.timeout(5000) : { println("timer"); }\n    }'));
  assert.deepEqual(alt.codes.filter((c) => (c ?? '').startsWith('pj/channel')), []);
  // A lone read guard is just a read: with no writer anywhere it blocks.
  const lone = run(MAIN('    chan<int> c;\n    int v;\n    alt {\n        v = c.read() : { println("got " + v); }\n    }'));
  assert.ok(lone.codes.includes('pj/channel-no-writer'));
});

test('an alt read still counts as a possible peer for a writer in another par branch', () => {
  const result = run(MAIN('    chan<int> c;\n    timer t;\n    int v;\n    par {\n        { alt {\n            v = c.read() : { println(v); }\n            t.timeout(50) : { }\n        } }\n        c.write(1);\n    }'));
  assert.deepEqual(result.codes.filter((code) => (code ?? '').startsWith('pj/channel')), []);
  const channel = result.channels.find((fact) => fact.variable.name === 'c');
  assert.deepEqual(channel?.operations.map((operation) => [operation.end, operation.direct]), [['read', true], ['write', true]]);
  assert.equal(channel?.hazard, undefined);
});

test('a par for body is many processes: writes and reads of one channel inside it are not a self-deadlock', () => {
  const r = run(MAIN('    shared chan<int> c;\n    par for (int i = 0; i < 4; i++) {\n        if (i % 2 == 0) c.write(i);\n        else println("odd " + c.read());\n    }'));
  assert.deepEqual(r.codes.filter((c) => (c ?? '').startsWith('pj/channel')), []);
});

test('a channel written and read by the same sequential process is a self-deadlock', () => {
  const bad = run(MAIN('    chan<int> c;\n    c.write(1);\n    int x = c.read();\n    println(x);'));
  assert.deepEqual(bad.codes, ['pj/channel-self-deadlock']);
  assert.equal(bad.diagnostics[0].line, 4);
  assert.match(bad.diagnostics[0].message, /both the writer and the reader of 'c', so this write blocks forever/);
  // Same branch of a par is still one process; different branches are fine.
  const sameBranch = run(MAIN('    chan<int> c;\n    par {\n        { c.write(1); println(c.read()); }\n        println("other");\n    }'));
  assert.deepEqual(sameBranch.codes, ['pj/channel-self-deadlock']);
  const ok = run(MAIN('    chan<int> c;\n    par {\n        c.write(1);\n        println(c.read());\n    }'));
  assert.deepEqual(ok.codes, []);
  const viaProc = run(MAIN('    chan<int> c;\n    par {\n        w(c.write);\n        println(c.read());\n    }', 'public void w(chan<int>.write o) { o.write(1); }'));
  assert.deepEqual(viaProc.codes, []);
});

test('starving loops: infinite loops that never communicate, unless they can exit or call something that does', () => {
  const bad = run(MAIN('    int n = 0;\n    while (true) { n++; }\n    for (;;) { println(n); }\n    do { n--; } while (true);'));
  assert.deepEqual(bad.codes, ['pj/starving-loop', 'pj/starving-loop', 'pj/starving-loop']);
  const ok = run(MAIN('    chan<int> c;\n    int n = 0;\n    par {\n        while (true) c.write(n);\n        while (true) { if (c.read() > 3) break; }\n        while (true) { helper(c.read); }\n        while (n < 10) n++;\n        for (;;) { n++; if (n > 5) return; }\n    }', 'public void helper(chan<int>.read in) { println(in.read()); }'));
  assert.deepEqual(ok.codes.filter((c) => c === 'pj/starving-loop'), []);
});

test('par deadlock simulation: crossed orders, unmatched writes, and correct pairings', () => {
  const crossed = run(MAIN('    chan<int> c;\n    chan<int> d;\n    par {\n        { c.write(1); int x = d.read(); println(x); }\n        { d.write(2); int y = c.read(); println(y); }\n    }'));
  assert.deepEqual(crossed.codes, ['pj/par-deadlock']);
  assert.equal(crossed.deadlocks[0]?.cause, 'circular-wait');
  assert.match(crossed.messages[0], /branch 1 waits to write 'c', branch 2 waits to write 'd'/);
  const unmatched = run(MAIN('    chan<int> c;\n    par {\n        { c.write(1); c.write(2); }\n        println(c.read());\n    }'));
  assert.deepEqual(unmatched.codes, ['pj/par-deadlock']);
  assert.match(unmatched.messages[0], /branch 1 waits to write 'c' but every other branch has finished/);
  const fine = run(MAIN('    chan<int> c;\n    chan<int> d;\n    par {\n        { c.write(1); int x = d.read(); println(x); }\n        { int y = c.read(); d.write(y + 1); }\n    }'));
  assert.deepEqual(fine.codes, []);
  const wrapped = run(MAIN('    timer clock;\n    chan<int> c;\n    chan<int> d;\n    par {\n        { long now = clock.read(); c.write.write(1); int x = d.read.read(); println(now + x); }\n        { d.write.write(2); int y = c.read.read(); println(y); }\n    }'));
  assert.deepEqual(wrapped.codes, ['pj/par-deadlock'], 'timer reads and endpoint selectors do not make an otherwise exact simulation opaque');
  // Opaque branches (a loop, a call that takes a channel) switch the simulation off.
  const opaque = run(MAIN('    chan<int> c;\n    par {\n        while (true) c.write(1);\n        println(c.read());\n    }'));
  assert.deepEqual(opaque.codes, []);
});

test('rendezvous proof explores ambiguous peers instead of depending on branch order', () => {
  const branches = [
    '{ c.write(1); d.write(1); }',
    '{ int fromC = c.read(); int fromE = e.read(); }',
    '{ int otherC = c.read(); int fromD = d.read(); c.write(2); e.write(2); }',
  ];
  const runOrder = (ordered: string[]) => run(MAIN(`    shared chan<int> c;\n    chan<int> d;\n    chan<int> e;\n    par {\n        ${ordered.join('\n        ')}\n    }`));
  const original = runOrder(branches);
  const swapped = runOrder([branches[0], branches[2], branches[1]]);
  assert.equal(original.codes.includes('pj/par-deadlock'), false, original.messages.join('\n'));
  assert.equal(swapped.codes.includes('pj/par-deadlock'), false, swapped.messages.join('\n'));
});

test('multiple independently unmatched waits are missing peers and retain exact no-peer diagnostics', () => {
  const writers = run(MAIN('    shared chan<int> left;\n    shared chan<int> right;\n    par {\n        { left.write(1); right.write(1); }\n        { right.write(2); left.write(2); }\n    }'));
  assert.equal(writers.codes.filter((code) => code === 'pj/par-deadlock').length, 1);
  assert.equal(writers.deadlocks[0]?.cause, 'missing-peer');
  assert.deepEqual(writers.deadlocks[0]?.waits.map((wait) => [wait.branch, wait.operation, wait.channel.name]), [[1, 'write', 'left'], [2, 'write', 'right']]);
  assert.equal(writers.codes.filter((code) => code === 'pj/channel-no-reader').length, 2);
  assert.match(writers.diagnostics.find((diagnostic) => diagnostic.code === 'pj/par-deadlock')?.message ?? '', /matching read on 'left' for branch 1 or a matching read on 'right' for branch 2/);
  assert.equal(writers.channels.find((fact) => fact.variable.name === 'left')?.hazard, 'no-reader');
  assert.equal(writers.channels.find((fact) => fact.variable.name === 'right')?.hazard, 'no-reader');
});

test('par for: outer variables and non-shared ends are shared by every iteration', () => {
  const r = run(MAIN('    chan<int> c;\n    int sum = 0;\n    par for (int i = 0; i < 3; i++) {\n        sum += i;\n        c.write(i);\n    }\n    for (int j = 0; j < 3; j++) println(c.read() + sum);'));
  assert.deepEqual(r.codes.sort(), ['pj/par-for-body', 'pj/parallel-usage', 'pj/shared-channel-end']);
  assert.equal(r.diagnostics.find((d) => d.code === 'pj/shared-channel-end')?.fix?.kind, 'make-shared');
});

test('pri alt with skip before other guards, trivial alt and par, unreachable code, assignment in condition, barrier not enrolled', () => {
  const r = run(MAIN('    int v = 0;\n    boolean b = true;\n    string s = "x";\n    string t = "y";\n    barrier bar;\n    pri alt {\n        skip : { v = 1; }\n        v = c.read() : { }\n    }\n    alt { v = c.read() : { } }\n    par { println(v); }\n    if (b = true) { }\n    if (s == "x") { }\n    if (s == t) { }\n    bar.sync();\n    return;\n    println(v);', 'public void f(chan<int>.read c) { }').replace('public void main(string[] args) {', 'public void main(string[] args) {\n    chan<int>.read c;'));
  const codes = new Set(r.diagnostics.map((d) => d.code));
  for (const c of ['pj/pri-alt-skip', 'pj/trivial-alt', 'pj/trivial-par', 'pj/unreachable', 'pj/assign-in-condition', 'pj/barrier-not-enrolled']) assert.ok(codes.has(c), `${c} in ${[...codes].join(', ')}`);
  assert.ok(!codes.has('pj/string-identity'));
});

test('unreachable code is still type-checked but cannot create execution facts', () => {
  const r = run(MAIN([
    '    chan<int> channel;',
    '    barrier gate;',
    '    return;',
    '    int wrong = "not an int";',
    '    int value = channel.read();',
    '    gate.sync();',
  ].join('\n')));

  assert.ok(r.codes.includes('pj/unreachable'));
  assert.ok(r.codes.includes('pj/type/assign'), 'dead code remains type-checked');
  assert.equal(r.codes.includes('pj/channel-no-writer'), false);
  assert.equal(r.codes.includes('pj/barrier-not-enrolled'), false);
  assert.deepEqual(r.deadlocks, []);
  assert.equal(r.channels.find((fact) => fact.variable.name === 'channel')?.operations.length, 0);
});

test('rendezvous proofs stop at unresolved, diverging and spoofed calls but retain trusted std output leaves', () => {
  const crossedBody = (call: string) => [
    '    chan<int> a;',
    '    chan<int> b;',
    '    par {',
    `        { ${call} a.write(1); int fromB = b.read(); }`,
    '        { b.write(1); int fromA = a.read(); }',
    '    }',
  ].join('\n');

  const unresolvedSource = `import missing.*;\npublic void main(string[] args) {\n${crossedBody('mystery();')}\n}\n`;
  const unresolvedProgram = parse(unresolvedSource).program;
  const unresolvedIndex = new DeclIndex();
  unresolvedIndex.addProgram(unresolvedProgram, 'unresolved.pj');
  const unresolved = check(unresolvedProgram, { index: unresolvedIndex, unresolvedImports: true, text: unresolvedSource });
  assert.equal(unresolved.diagnostics.some((diagnostic) => diagnostic.code === 'pj/par-deadlock'), false);

  const bodyless = run(MAIN(crossedBody('opaque();'), 'private native void opaque();'));
  assert.equal(bodyless.codes.includes('pj/par-deadlock'), false);

  const localPure = run(MAIN(crossedBody('pure();'), 'private void pure() { }'));
  assert.equal(localPure.codes.includes('pj/par-deadlock'), false, 'an unproven body-bearing call is not an exact transparent step');

  const diverging = run(MAIN(crossedBody('spin();'), 'private void spin() { while (true) { } }'));
  assert.equal(diverging.codes.includes('pj/par-deadlock'), false, 'a wait after a nonterminating call is not reported as reachable');

  const stdOutput = run(MAIN(crossedBody('println(1);')));
  assert.equal(stdOutput.codes.includes('pj/par-deadlock'), true, 'the compiler-verified std output leaf remains a narrow exception');

  const spoofSource = MAIN(crossedBody('println(1);'));
  const spoofProgram = parse(spoofSource).program;
  const spoofIndex = new DeclIndex();
  spoofIndex.addProgram(spoofProgram, '/workspace/main.pj');
  spoofIndex.addProgram(parse('public native void println(int value);').program, '/workspace/std/io.pj');
  const spoofed = check(spoofProgram, {
    index: spoofIndex,
    text: spoofSource,
    trustedNonBlockingNativeDeclarations: TRUSTED_STD_OUTPUT_DECLARATIONS,
  });
  assert.equal(spoofed.diagnostics.some((diagnostic) => diagnostic.code === 'pj/par-deadlock'), false, 'a workspace std/io.pj lookalike is not trusted by its path or spelling');
});

test('short-circuit-only channel operations cannot become exact rendezvous heads', () => {
  const source = MAIN([
    '    chan<int> conditional;',
    '    chan<int> live;',
    '    par {',
    '        { boolean skipped = true || conditional.read() > 0; live.write(1); }',
    '        { int value = live.read(); }',
    '    }',
  ].join('\n'));
  const result = run(source);
  assert.equal(result.codes.includes('pj/par-deadlock'), false, 'the skipped conditional read must not fabricate an unmatched branch head');
});

test('a procedure that suspends only through calls gets a [yield=true] quick fix', () => {
  // The compiler marks main itself, so only twice() needs the annotation.
  const r = run('import std.*;\n\npublic void wait1() { timer t; t.timeout(1); }\n\npublic void twice() { wait1(); wait1(); }\n\npublic void marked() [yield=true] { wait1(); }\n\npublic void main(string[] args) { twice(); marked(); println("ok"); }\n');
  const hits = r.diagnostics.filter((d) => d.code === 'pj/needs-yield-annotation');
  assert.deepEqual(hits.map((d) => d.line + 1), [5]);
  // Inserted right after the parameter list, where the grammar puts annotations.
  assert.deepEqual(hits[0].fix, { kind: 'edit', title: 'Add [yield=true]', line: 4, col: 19, endCol: 19, text: ' [yield=true]' });
});

test('the yield annotation respects implements clauses, existing annotations and the compiler\'s own marking rules', () => {
  const src = [
    'void g(chan<int>.read c) { c.read(); }',
    'void f(chan<int>.read c) implements g { g(c); }', // channel-end parameter: the compiler marks it
    'record R { chan<int>.read in; }',
    'void viaRecord(R r) implements g { g(r.in); }', // needs the annotation, before `implements`
    'void annotated(R r) [foo=1] { g(r.in); }', // needs it inside the existing list
    'void initOnly(R r) { int x = r.in.read(); println(x); }', // direct read in an initialiser: marked by the compiler
    'mobile void m(R r) { g(r.in); suspend; }', // suspend: marked by the compiler
    'void b(barrier w) { g2(w); }', // barrier parameter: marked by the compiler
    'void g2(barrier w) { w.sync(); }',
    'void loopInit(R r) { for (int v = r.in.read(); v < 10; v = r.in.read()) { println(v); } }',
    'void viaLoop(R r) { loopInit(r); }', // suspends through a call whose only reads sit in a for header
    'public void main(string[] args) { }',
  ].join('\n') + '\n';
  const r = run('import std.*;\n' + src);
  const hits = r.diagnostics.filter((d) => d.code === 'pj/needs-yield-annotation').map((d) => [d.line, d.fix]);
  assert.deepEqual(hits, [
    [4, { kind: 'edit', title: 'Add [yield=true]', line: 4, col: 19, endCol: 19, text: ' [yield=true]' }],
    [5, { kind: 'edit', title: 'Add [yield=true]', line: 5, col: 21, endCol: 21, text: 'yield=true, ' }],
    [11, { kind: 'edit', title: 'Add [yield=true]', line: 11, col: 17, endCol: 17, text: ' [yield=true]' }],
  ]);
});

test('yield analysis survives call cycles: every member of a cycle that reaches a read yields', () => {
  const r = run('import std.*;\nrecord R { chan<int>.read in; }\nvoid x(R r) { y(r); z(r); }\nvoid y(R r) { x(r); }\nvoid z(R r) { println(r.in.read()); }\npublic void main(string[] args) { }\n');
  const hits = r.diagnostics.filter((d) => d.code === 'pj/needs-yield-annotation').map((d) => d.line);
  assert.deepEqual(hits, [2, 3]);
});

test('yield diagnostics follow the selected overload, mobile construction and yield=false replacement', () => {
  const overload = run([
    'void f(int n) { }',
    'void f(chan<int>.read c) { c.read(); }',
    'void caller() { f(1); }',
  ].join('\n'));
  assert.deepEqual(overload.diagnostics.filter((d) => d.code === 'pj/needs-yield-annotation'), []);

  const mobile = run([
    'record Handle { }',
    'mobile void worker() { }',
    'void make() { Handle process = new mobile(worker); }',
    'void caller() [yield=false] { make(); }',
  ].join('\n'));
  const warning = mobile.diagnostics.find((d) => d.code === 'pj/needs-yield-annotation');
  assert.ok(warning);
  assert.equal(warning.line, 3);
  assert.deepEqual(warning.fix, { kind: 'edit', title: 'Add [yield=true]', line: 3, col: 21, endCol: 26, text: 'true' });
});

test('unused reports are per overload and skip native declarations', () => {
  const r = run('public void foo(int a) { int dead = 1; }\npublic void foo(long b) { int other = 2; }\npublic native void bar(int x);\npublic void main(string[] args) { foo(1); foo(2L); }\n');
  const unused = r.diagnostics.filter((d) => d.code === 'pj/unused').map((d) => `${d.line}:${/'(\w+)'/.exec(d.message)![1]}`);
  assert.deepEqual(unused, ['0:a', '0:dead', '1:b', '1:other']);
});

test('assignment targets are typed, so hover and references see them', () => {
  const r = run('const int N = 4;\npublic void main(string[] args) { int x = 0; x = 1; x++; }\n');
  const targets = [...r.types.entries()].filter(([e]) => e.kind === 'NameExpr' && e.name.name === 'x').map(([e, t]) => `${e.span.start.col}:${t.k === 'prim' ? t.name : t.k}`);
  assert.deepEqual(targets, ['45:int', '52:int']);
  assert.ok(!r.diagnostics.some((d) => d.severity === 'error'), r.diagnostics.map((d) => d.message).join('; '));
});

test('overloads are matched like the compiler: no literal narrowing when choosing a candidate', () => {
  const r = run('public void f(byte b) { }\npublic void f(int i) { }\npublic void g(byte b) { }\npublic void main(string[] args) { f(1); g(1); }\n');
  const chosen = [...r.calls.values()].map((sig) => `${sig.name}(${sig.params.map((p) => (p.k === 'prim' ? p.name : p.k)).join(',')})`);
  assert.deepEqual(chosen, ['f(int)']);
  assert.match(r.diagnostics.find((d) => d.code === 'pj/type/call')!.message, /No version of 'g' accepts \(int\)/);
});

test('a nested alt is one alt to the compiler', () => {
  const r = run('public void f(chan<int>.read a, chan<int>.read b) { int x; alt { x = a.read() : { } alt { x = b.read() : { } } } }\npublic void main(string[] args) { }\n');
  assert.deepEqual(r.diagnostics.filter((d) => d.code === 'pj/multiple-alts'), []);
});

test('reads that must be their own statement: inside ?:, inside a write value; calls as whole conditions', () => {
  const r = run(MAIN('    chan<int> c;\n    chan<int> d;\n    boolean flag = true;\n    par {\n        c.write(1);\n        { int x = flag ? c.read() : 7; println(x); }\n    }\n    par {\n        c.write(2);\n        d.write(c.read() + 1);\n        println(d.read());\n    }\n    if (ready(1)) println("r");\n    while (!ready(2)) { break; }\n    if (ready(3) && flag) println("fine");', 'public boolean ready(int n) { return n > 0; }'));
  const placement = r.diagnostics.filter((d) => d.code === 'pj/read-placement');
  assert.deepEqual(placement.map((d) => d.line + 1), [9, 13]);
  assert.equal(placement[1].fix?.title, "Read into 'read13' first");
  assert.equal(placement[1].fix?.text, 'int read13 = c.read();\n        d.write(read13 + 1)');
  const calls = r.diagnostics.filter((d) => d.code === 'pj/call-as-condition');
  assert.deepEqual(calls.map((d) => d.line + 1), [16, 17]);
  assert.equal(calls[0].fix?.text, ' == true');
  assert.equal(calls[1].fix?.text, 'ready(2) == false');
});

test('every confirmed compiler bug that depends on the code is reported at its point of use', () => {
  const r = run(MAIN(
    [
      '    chan<int> c;',
      '    R rr = null;',
      '    byte b = 1;',
      '    println("a;b");',
      '    suspend;',
      '    par {',
      '        for (int i = 0; i < 3; i++) worker(i, c.write);',
      '        { while (true) { int v = c.read(); if (v > 1) break; } }',
      '    }',
      '    int k = 1;',
      '    switch (k) {',
      '        case 1: while (true) { k++; if (k > 3) break; } break;',
      '    }',
      '    int[] xs = new int[c.read()];',
      '    xs[c.read()] = 1;',
      '    int f = c.read().x;',
      '    par for (int j = 0; j < 2; j++) println(j);',
      '    if (rr == null) println("null");',
      '    rr = new R { x = 1 };',
      '    stop;',
    ].join('\n'),
    'record R { int x; }\nrecord Cyc { Cyc next; }\npublic void worker(int i, chan<int>.write out) { out.write(i); }',
  ));
  const lines = r.diagnostics.map((d) => `${d.line + 1}:${d.code}`);
  // Line numbers: MAIN adds two lines (import + extra decls) before the body.
  const want = ['3:pj/compiler-limit', '7:pj/compiler-limit', '13:pj/compiler-limit', '17:pj/compiler-limit', '19:pj/read-placement', '20:pj/read-placement', '21:pj/read-placement', '24:pj/compiler-limit'];
  for (const w of want) assert.ok(lines.includes(w), `${w} in ${lines.join(' ')}`);
  // Comparing with null is fine and reads inside an index on the right-hand side are fine.
  assert.equal(lines.filter((l) => l.startsWith('23:')).length, 0, lines.join(' '));
  const fine = run(MAIN('    chan<int> c;\n    int[] xs = new int[4];\n    par { c.write(2); { int v = xs[c.read()]; xs[1] = c.read(); println(v); } }\n    while (true) { par { c.write(1); println(c.read()); } break; }\n    int n = 0;\n    for (int i = 0; i < 3; i++) { switch (i) { case 1: n++; break; default: n--; } }\n    switch (n) { case 1: for (int i = 0; i < 3; i++) n++; break; }'));
  assert.deepEqual(fine.codes, [], fine.messages.join('\n'));
});

test('unused and shadowed variables, constants; nothing about compiler internals', () => {
  const r = run(MAIN('    timer t;\n    int index = 0;\n    int dead;\n    int args = 1;\n    const int k = args;\n    alt {\n        v = c.read() : { }\n        t.timeout(100) : { }\n    }\n    alt { v = c.read() : { } }\n    t.timeout(5);\n    println(index + k);', 'public void f(chan<int>.read c, int v) { }').replace('public void main(string[] args) {', 'public void main(string[] args) {\n    chan<int>.read c; int v;'));
  const codes = new Set(r.codes);
  for (const c of ['pj/unused', 'pj/shadows-parameter', 'pj/type/const-init']) assert.ok(codes.has(c), `${c} in ${[...codes].join(', ')}`);
  assert.ok(codes.has('pj/multiple-alts'), 'a second alt in one procedure cannot be built');
  assert.ok(r.messages.some((m) => /'dead' is never used/.test(m)));
});

test("missing 'import std.*' is reported once with a fix, and nothing else is blamed on it", () => {
  const r = run('public void main(string[] args) {\n    println("hi");\n    print("x");\n}\n');
  assert.deepEqual(r.codes, ['pj/missing-import', 'pj/missing-import']);
  assert.equal(r.diagnostics[0].fix?.kind, 'add-import');
});

test('a correct program produces no diagnostics at all', () => {
  const src = [
    'import std.*;',
    '',
    'const int N = 3;',
    'record Pair { int a; int b; }',
    '',
    'public void producer(chan<Pair>.write out) {',
    '    for (int i = 0; i < N; i++) out.write(new Pair { a = i, b = i * i });',
    '}',
    '',
    'public void consumer(chan<Pair>.read in, chan<int>.write done) {',
    '    int sum = 0;',
    '    for (int i = 0; i < N; i++) {',
    '        Pair p = in.read();',
    '        sum += p.a + p.b;',
    '    }',
    '    done.write(sum);',
    '}',
    '',
    'public void main(string[] args) {',
    '    chan<Pair> c;',
    '    chan<int> d;',
    '    par {',
    '        producer(c.write);',
    '        consumer(c.read, d.write);',
    '    }',
    '    println("sum " + d.read());',
    '}',
  ].join('\n');
  const r = run(src);
  assert.deepEqual(r.messages, []);
  assert.ok(r.types.size > 20, 'expression types recorded');
});

test('a constant initialised from a variable is reported, with the reason', () => {
  const r = run(MAIN('    int n = 21;\n    const int m = n * 2;\n    println(m);'));
  assert.ok(r.messages.some((m) => /const-init|literals and other constants/.test(m) && /value would be 0/.test(m)), r.notes.join(' '));
  const ok = run(MAIN('    const int N = 4;\n    const int M = N * 2 + 1;\n    println(M);'));
  assert.ok(!ok.codes.includes('pj/type/const-init'), ok.messages.join('\n'));
});

test('top-level declarations, inheritance, and protocol fields are checked before bodies', () => {
  const r = run([
    'record Base { }',
    'record Child extends Base, Base { }',
    'protocol Parent { tag: { int value; int value; } }',
    'protocol Both extends Parent, Parent;',
    'protocol Left extends Right;',
    'protocol Right extends Left;',
    'int occupied = 1;',
    'record occupied { }',
  ].join('\n'));
  assert.ok(r.messages.some((m) => /'Base' appears more than once.*record 'Child'/.test(m)), r.messages.join('\n'));
  assert.ok(r.messages.some((m) => /Field 'value' is declared twice in case 'tag'/.test(m)), r.messages.join('\n'));
  assert.ok(r.messages.some((m) => /'Parent' appears more than once.*protocol 'Both'/.test(m)), r.messages.join('\n'));
  assert.ok(r.messages.some((m) => /Protocol '(Left|Right)' extends itself/.test(m)), r.messages.join('\n'));
  assert.ok(r.messages.some((m) => /Top-level name 'occupied' is already used by a constant/.test(m)), r.messages.join('\n'));
  const acceptedCompilerQuirks = r.diagnostics.filter((d) => /accepted by this compiler build/.test(d.message));
  assert.equal(acceptedCompilerQuirks.length, 2, r.messages.join('\n'));
  assert.ok(acceptedCompilerQuirks.every((d) => d.severity === 'warning'), r.messages.join('\n'));
});

test('numeric literal types follow the compiler lexer longest-match rules', () => {
  const ok = run('void f() { double fallback = 09; int hexF = 0xff; int hexD = 0xd; int octal = 077; }');
  assert.deepEqual(ok.errors, [], ok.messages.join('\n'));

  const bad = run('void f() { int value = 09; }');
  assert.ok(bad.messages.some((m) => /Cannot initialise 'value'.*type double/.test(m)), bad.messages.join('\n'));
});

test('mobile procedures, suspend, and implements clauses get compiler-aligned diagnostics', () => {
  const r = run([
    'mobile int wrongReturn() { return 1; }',
    'void worker(int n) { }',
    'mobile void worker(long n) { suspend; }',
    'void ordinary() { suspend; }',
    'record Data { }',
    'void missingImpl() implements absent { }',
    'void wrongImpl() implements Data { }',
  ].join('\n'));
  assert.ok(r.messages.some((m) => /Mobile procedure 'wrongReturn' must return void/.test(m)), r.messages.join('\n'));
  assert.ok(r.messages.some((m) => /Mobile procedure 'worker' cannot be overloaded/.test(m)), r.messages.join('\n'));
  assert.ok(r.messages.some((m) => /'suspend' can only appear in a mobile procedure/.test(m)), r.messages.join('\n'));
  assert.ok(r.messages.some((m) => /Cannot find the procedure 'absent'.*implements/.test(m)), r.messages.join('\n'));
  assert.ok(r.messages.some((m) => /'Data' is not a procedure and cannot be implemented/.test(m)), r.messages.join('\n'));

  // Verified against the real compiler: it permits ordinary overloads that
  // follow the first mobile declaration, but rejects a later mobile overload.
  const ordering = run([
    'mobile void first(int n) { }',
    'void first(long n) { }',
    'void second(int n) { }',
    'mobile void second(long n) { }',
  ].join('\n'));
  assert.equal(ordering.diagnostics.filter((d) => d.code === 'pj/type/mobile').length, 1, ordering.messages.join('\n'));
});

test('aggregate defaults, exact built-in fields, and non-assignable whole channels are explained', () => {
  const r = run([
    'record Pair { int left; int right; }',
    'protocol Event { data: { int id; string text; } }',
    'void take(chan<int> c) { }',
    'void f() {',
    '    Pair p = new Pair { left = 1 };',
    '    Event e = new Event { data: id = 2 };',
    '    int[] values = new int[2];',
    '    int badArrayField = values.length;',
    '    int badStringField = "x".size;',
    '    chan<int> first;',
    '    chan<int> second;',
    '    boolean pickFirst = true;',
    '    chan<int> alias = first;',
    '    take(first);',
    '    int v = (pickFirst ? first : second).read();',
    '}',
  ].join('\n'));
  assert.equal(r.diagnostics.filter((d) => d.code === 'pj/missing-field').length, 2, r.messages.join('\n'));
  assert.ok(!r.diagnostics.some((d) => d.code === 'pj/type/ternary'), 'identical channel types are compatible branches');
  assert.ok(r.messages.some((m) => /Arrays have '.size', not '.length'/.test(m)), r.messages.join('\n'));
  assert.ok(r.messages.some((m) => /Strings have '.length', not '.size'/.test(m)), r.messages.join('\n'));
  assert.ok(r.messages.some((m) => /Cannot initialise 'alias'.*whole channels cannot be assigned or passed/.test(m)), r.messages.join('\n'));
  assert.ok(r.messages.some((m) => /No version of 'take' accepts \(chan<int>\).*pass the required .read or .write end/.test(m)), r.messages.join('\n'));
});

test('a call mismatch blames the first argument that actually fails', () => {
  const r = run(['void f(int a, string s) { }', 'void g(int a, int b) { }', 'void main() { f(1, 2); int x = 1; g(x, "s"); }'].join('\n'));
  const calls = r.messages.filter((m) => /No version of/.test(m));
  assert.equal(calls.length, 2, r.messages.join('\n'));
  assert.match(calls[0], /argument 2 \('s'\) needs string/);
  assert.match(calls[1], /argument 2 \('b'\) needs int/);
  assert.ok(!calls.some((m) => /does not fit in int without a cast/.test(m)), calls.join('\n'));
});

test('an unknown lower-case type gets a primitive suggestion from the checker, not the parser', () => {
  const r = run('public void main(string[] args) { itn y = 2; y++; }\n');
  const d = r.diagnostics.find((x) => x.code === 'pj/type/unknown-type');
  assert.match(d?.message ?? '', /Unknown type 'itn'; did you mean 'int'\?/);
  assert.equal(d?.fix?.text, 'int');
});
