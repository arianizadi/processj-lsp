import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { translateProgram, type CspModel } from '../src/csp/index';
import { loadProgram } from '../src/csp/load';
import { checkCspmWithFdr, fdrErrors, typecheckCspm } from '../src/cspm/check';
import { CspmDocument } from '../src/cspm/document';
import { covers, evaluate, Globals, toEvents } from '../src/cspm/eval';
import { explainCspm, matchCspmResults } from '../src/cspm/explain';
import type { Assertion, Decl, Definition, Ex } from '../src/cspm/ast';
import { parseCspm } from '../src/cspm/parser';
import { cspmFdrDiagnostics, formatCspmReport } from '../src/cspm/report';
import { buildOverlays } from '../src/graph/overlay';
import type { NetworkView } from '../src/graph/network';
import { pathMatches, type VerificationReport } from '../src/verification';
import { recordedRun, refines } from './fdr-recordings';

const ROOT = path.join(__dirname, '..', '..');
const CSPM = path.join(ROOT, 'test', 'fixtures', 'cspm');
const INCLUDE = path.join(ROOT, 'test', 'fixtures', 'include');

function fixture(name: string): CspmDocument {
  const file = path.join(CSPM, name);
  return new CspmDocument(pathToFileURL(file).toString(), fs.readFileSync(file, 'utf8'), 1);
}

function only<T extends Decl['kind']>(decls: Decl[], kind: T): Array<Extract<Decl, { kind: T }>> {
  return decls.filter((decl): decl is Extract<Decl, { kind: T }> => decl.kind === kind);
}

function body(text: string, name = 'P'): Ex {
  const file = parseCspm(text);
  assert.deepEqual(file.diagnostics.filter((d) => d.severity === 'error'), [], text);
  const def = only(file.decls, 'def').find((decl) => decl.name.name === name);
  assert.ok(def, `${name} is defined`);
  return def.body;
}

/** An expression as a bracketed tree: operators and their operands. */
function tree(e: Ex): string {
  switch (e.k) {
    case 'name': return e.name;
    case 'num': return String(e.value);
    case 'bool': return String(e.value);
    case 'app': return `${tree(e.fn)}(${e.args.map(tree).join(', ')})`;
    case 'dot': return e.parts.map(tree).join('.');
    case 'bin': return `(${tree(e.left)} ${e.op} ${tree(e.right)})`;
    case 'un': return `(${e.op} ${tree(e.arg)})`;
    case 'prefix': return `(${tree(e.head)}${e.fields.map((f) => `${f.kind}${tree(f.expr)}${f.restrict ? `:${tree(f.restrict)}` : ''}`).join('')} -> ${tree(e.body)})`;
    case 'guard': return `(${tree(e.cond)} & ${tree(e.body)})`;
    case 'op': return `(${tree(e.left)} ${e.op} ${tree(e.right)})`;
    case 'hide': return `(${tree(e.proc)} \\ ${tree(e.set)})`;
    case 'par': return `(${tree(e.left)} [|${tree(e.sync)}|] ${tree(e.right)})`;
    case 'apar': return `(${tree(e.left)} [${tree(e.alphaLeft)} || ${tree(e.alphaRight)}] ${tree(e.right)})`;
    case 'exception': return `(${tree(e.left)} [|${tree(e.set)}|> ${tree(e.right)})`;
    case 'rename': return `${tree(e.proc)}[[${e.pairs.map(([a, b]) => `${tree(a)} <- ${tree(b)}`).join(', ')}]]`;
    case 'repl': return `(${e.op}${e.sync ? `${tree(e.sync)}|]` : ''} ${e.stmts.map((s) => (s.kind === 'gen' ? `${tree(s.pattern)}:${tree(s.source)}` : tree(s.expr))).join(', ')} @ ${e.alpha ? `[${tree(e.alpha)}] ` : ''}${tree(e.body)})`;
    case 'set': return `{${e.items.map(tree).join(', ')}}`;
    case 'enum': return `{|${e.items.map(tree).join(', ')}${e.stmts ? ` | ${e.stmts.map((s) => (s.kind === 'gen' ? `${tree(s.pattern)} <- ${tree(s.source)}` : tree(s.expr))).join(', ')}` : ''}|}`;
    case 'range': return `${e.seq ? '<' : '{'}${tree(e.from)}..${e.to ? tree(e.to) : ''}${e.seq ? '>' : '}'}`;
    case 'comp': return `${e.seq ? '<' : '{'}${e.items.map(tree).join(', ')} | ${e.stmts.map((s) => (s.kind === 'gen' ? `${tree(s.pattern)} <- ${tree(s.source)}` : tree(s.expr))).join(', ')}${e.seq ? '>' : '}'}`;
    case 'seq': return `<${e.items.map(tree).join(', ')}>`;
    case 'tuple': return `(${e.items.map(tree).join(', ')})`;
    case 'if': return `(if ${tree(e.cond)} then ${tree(e.then)} else ${tree(e.else)})`;
    case 'let': return `(let ${e.decls.map((d) => (d.kind === 'def' ? `${d.name.name} = ${tree(d.body)}` : d.kind)).join('; ')} within ${tree(e.body)})`;
    case 'lambda': return `(\\${e.params.map(tree).join(', ')} @ ${tree(e.body)})`;
    default: return e.k;
  }
}

/** The drawn operands of a view and who they share events with: `PHIL(0) -- FORK(1): pickup.0.1, putdown.0.1`. */
function links(view: NetworkView): string[] {
  const name = (id: string): string => view.nodes.find((node) => node.id === id)?.name ?? id;
  const out: string[] = [];
  for (const channel of view.channels) {
    if (channel.port) {
      const node = view.nodes.find((entry) => entry.id === channel.port)!;
      for (const writer of channel.writers) out.push(`${name(writer.node)} -> [${node.label}]`);
      for (const reader of channel.readers) out.push(`[${node.label}] -> ${name(reader.node)}`);
      for (const member of channel.members) out.push(`${name(member.node)} -- [${node.label}]`);
      continue;
    }
    const hidden = view.edges.some((edge) => edge.channel === channel.id && edge.tags.includes('hidden')) ? ' (hidden)' : '';
    if (channel.kind === 'barrier') out.push(`{${channel.members.map((member) => name(member.node)).join(', ')}}: ${channel.name}${hidden}`);
    else if (channel.writers.length) out.push(`${channel.writers.map((w) => name(w.node)).join(', ')} -> ${channel.readers.map((r) => name(r.node)).join(', ')}: ${channel.name}${hidden}`);
    else out.push(`${channel.members.map((member) => name(member.node)).join(' -- ')}: ${channel.name}${hidden}`);
  }
  return out;
}

function processes(view: NetworkView): string[] {
  return view.nodes.filter((node) => node.kind === 'process').map((node) => `${node.label}${node.replicated ? ` ${node.replicated.text}` : ''}`);
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('every hand-written model parses without errors, with its declarations and assertions', () => {
  const expected: Record<string, { defs: string[]; asserts: string[] }> = {
    'dining.csp': { defs: ['N', 'PHILS', 'PHIL', 'FORK', 'PHILOSOPHERS', 'FORKS', 'SYSTEM'], asserts: ['SYSTEM :[deadlock free [F]]'] },
    'copy.csp': { defs: ['COPY', 'SYSTEM', 'BUFF2', "BUFF2'"], asserts: ['BUFF2 [FD= SYSTEM', 'SYSTEM [FD= BUFF2', 'SYSTEM :[deadlock free]', 'SYSTEM :[divergence free]', 'COPY(left, right) [T= SYSTEM'] },
    'ring.csp': { defs: ['N', 'NODES', 'NODE', 'START', 'A', 'RING'], asserts: ['RING :[deadlock free [F]]', 'RING :[divergence free]'] },
    'interleave.csp': { defs: ['CLIENTS', 'CLIENT', 'SERVER', 'SYSTEM'], asserts: ['SYSTEM :[deadlock free]', 'SYSTEM :[divergence free]', 'SYSTEM \\ {| request, reply |} :[deterministic [F]]'] },
    'vending.csp': { defs: ['SPEC', 'VM', 'CUSTOMER', 'SYSTEM'], asserts: ['SPEC [F= VM', 'SPEC [T= VM', 'VM :[deterministic [F]]', 'SYSTEM :[deadlock free [F]]'] },
  };
  for (const [name, want] of Object.entries(expected)) {
    const file = parseCspm(fs.readFileSync(path.join(CSPM, name), 'utf8'));
    assert.deepEqual(file.diagnostics, [], name);
    assert.deepEqual(only(file.decls, 'def').map((decl) => decl.name.name), want.defs, name);
    assert.deepEqual(only(file.decls, 'assert').map((decl) => decl.text), want.asserts, name);
  }
});

test('process operators bind as FDR documents them', () => {
  assert.equal(tree(body('P = a -> P [] b -> STOP')), '((a -> P) [] (b -> STOP))');
  assert.equal(tree(body('P = a -> b -> STOP |~| c -> STOP')), '((a -> (b -> STOP)) |~| (c -> STOP))');
  assert.equal(tree(body('P = x > 0 & a -> P')), '((x > 0) & (a -> P))');
  assert.equal(tree(body('P = a -> STOP ; Q')), '((a -> STOP) ; Q)');
  assert.equal(tree(body('P = A [| {| c |} |] B \\ {| c |}')), '((A [|{|c|}|] B) \\ {|c|})');
  assert.equal(tree(body('P = A ||| B [] C')), '(A ||| (B [] C))');
  assert.equal(tree(body('P = A [ {a} || {a, b} ] B')), '(A [{a} || {a, b}] B)');
  assert.equal(tree(body('P = (A [| {e} |> SKIP) \\ H')), '((A [|{e}|> SKIP) \\ H)');
  assert.equal(tree(body('P = A [| {e} |> SKIP [] B')), '((A [|{e}|> SKIP) [] B)');
  assert.equal(tree(body('P = COPY [[ right <- mid ]]')), 'COPY[[right <- mid]]');
  assert.equal(tree(body('P = c?x:{0..2}!x+1.y -> P')), '(c?x:{0..2}!(x + 1).y -> P)');
  assert.equal(tree(body('P = pickup.i.((i+1)%N) -> P')), '(pickup.i.((i + 1) % N) -> P)');
  assert.equal(tree(body('P = if n == 0 then STOP else a -> P')), '(if (n == 0) then STOP else (a -> P))');
  assert.equal(tree(body('P = let\n  Q = a -> Q\n  R(x) = b.x -> R(x)\nwithin Q ||| R(1)')), '(let Q = (a -> Q); R = (b.x -> R(x)) within (Q ||| R(1)))');
  assert.equal(tree(body('P = \\ x @ x + 1')), '(\\x @ (x + 1))');
});

test('replicated operators, sets, sequences and comprehensions', () => {
  assert.equal(tree(body('P = ||| i : {0..2} @ W(i)')), '(||| i:{0..2} @ W(i))');
  assert.equal(tree(body('P = [| {| sync |} |] i : S @ W(i)')), '([|{|sync|}|] i:S @ W(i))');
  assert.equal(tree(body('P = || i : S @ [A(i)] NODE(i)')), '(|| i:S @ [A(i)] NODE(i))');
  assert.equal(tree(body('P = [] x : S, x > 1 @ c.x -> STOP')), '([] x:S, (x > 1) @ (c.x -> STOP))');
  assert.equal(tree(body('X = {| c.i | i <- S |}', 'X')), '{|c.i | i <- S|}');
  assert.equal(tree(body('X = { (x, y) | x <- A, y <- B, x != y }', 'X')), '{(x, y) | x <- A, y <- B, (x != y)}');
  assert.equal(tree(body('X = <x | x <- s, x > 1>', 'X')), '<x | x <- s, (x > 1)>');
  assert.equal(tree(body('X = <1..3> ^ <> ^ <a, b>', 'X')), '((<1..3> ^ <>) ^ <a, b>)');
  assert.equal(tree(body('X = #s < 3 and not member(x, S)', 'X')), '(((# s) < 3) and (not member(x, S)))');
});

test('declarations: channels, datatypes, nametypes, includes, comments, assertions of every kind', () => {
  const file = parseCspm([
    '{- a {- nested -} comment -}',
    'include "lib.csp"',
    'datatype Msg = req.{0..1} | ack | data.Bool.Msg',
    'subtype Small = req.{0}',
    'nametype Pair = {0..1}.{0..1}',
    'channel a, b : Pair',
    'channel done',
    'external normal',
    'transparent diamond, sbisim',
    '-- the process',
    'P = a?x.y -> done -> P',
    'f(0) = 1',
    'f(n) = n * f(n - 1)',
    'g :: (Int) -> Int',
    'assert P :[deadlock free]',
    'assert not P :[divergence free [FD]]',
    'assert P :[has trace [T]]: <done>',
    'assert STOP [T= P :[tau priority]: {done}',
    'assert P :[deterministic]',
  ].join('\n'));
  assert.deepEqual(file.diagnostics, []);
  assert.deepEqual(file.decls.map((decl) => decl.kind), ['include', 'datatype', 'datatype', 'nametype', 'channel', 'channel', 'external', 'transparent', 'def', 'def', 'def', 'signature', 'assert', 'assert', 'assert', 'assert', 'assert']);
  const datatype = only(file.decls, 'datatype')[0];
  assert.deepEqual(datatype.constructors.map((ctor) => `${ctor.name.name}/${ctor.fields.length}`), ['req/1', 'ack/0', 'data/2']);
  assert.equal((file.decls[8] as Definition).comment, 'the process');
  const asserts = only(file.decls, 'assert');
  assert.deepEqual(asserts.map((a) => [a.negated, a.property?.name ?? a.refinement?.model, a.property?.model ?? '']), [[false, 'deadlock free', ''], [true, 'divergence free', 'FD'], [false, 'has trace', 'T'], [false, 'T', ''], [false, 'deterministic', '']]);
  assert.equal(asserts[3].options, ':[tau priority]: {done}');
});

test('never crashes: what it cannot read is reported, kept opaque, and the rest is still read', () => {
  const file = parseCspm([
    'channel a',
    'P = a -> ',
    'Q = a -> Q',
    'R = a -> @@@ Q',
    'Timed(et) {',
    '  T = a -> T',
    '}',
    'S = Q ||| Q',
    "assert S :[deadlock free]",
  ].join('\n'));
  assert.deepEqual(file.decls.map((decl) => decl.kind === 'def' ? decl.name.name : decl.kind), ['channel', 'opaque', 'Q', 'opaque', 'skipped', 'S', 'assert']);
  assert.deepEqual(file.diagnostics.map((d) => `${d.span.start.line + 1}:${d.severity}`), ['2:error', '4:error', '5:info']);
  // Random input never throws.
  for (let seed = 1; seed < 200; seed++) {
    let text = '';
    let x = seed;
    for (let i = 0; i < 80; i++) {
      x = (x * 1103515245 + 12345) % 2147483648;
      text += 'P=a->[]|~|{}()<>[|]|||\\@:;.,?!&x1 \n'[x % 38];
    }
    assert.doesNotThrow(() => new CspmDocument('file:///x.csp', text, 1).model(['view:P']));
  }
});

test('every model the translator generates from the examples parses, and its network unfolds to the processes of the program', () => {
  const files = fs.readdirSync(path.join(ROOT, 'examples')).filter((name) => name.endsWith('.pj'));
  let drawn = 0;
  for (const name of files) {
    const file = path.join(ROOT, 'examples', name);
    const loaded = loadProgram(file, INCLUDE);
    if (loaded.syntaxErrors.length) continue;
    let model: CspModel;
    try {
      model = translateProgram({ units: loaded.units, index: loaded.index });
    } catch {
      continue;
    }
    if (model.unsupported.length) continue;
    const doc = new CspmDocument(pathToFileURL(file.replace(/\.pj$/, '.csp')).toString(), model.text, 1);
    assert.deepEqual(doc.diagnostics.filter((d) => d.severity === 'error'), [], `${name}: the generated model parses`);
    assert.equal(doc.file.generatedFrom, name, `${name}: the header names its source`);
    const view = doc.view(doc.defaultView());
    assert.ok(view, `${name}: a default view`);
    if (view.tree.kind === 'comp') drawn++;
  }
  assert.ok(drawn >= 10, `most examples are networks (${drawn})`);
});

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

test('the evaluator computes what the drawing needs, and says unknown rather than guess', () => {
  const globals = new Globals(parseCspm('N = 3\nchannel c : {0..N-1}.{0..1}\nchannel d\ndatatype T = x | y.{0..1}\nf(0) = 1\nf(n) = n * f(n-1)\n').decls);
  const value = (text: string): string => {
    const v = evaluate(body(`V = ${text}`, 'V'), globals.env);
    return v.t === 'unknown' ? `unknown: ${v.why}` : JSON.stringify(v, (key, val) => (key === 'env' ? undefined : val));
  };
  assert.equal(value('(N + 1) % N'), '{"t":"int","v":1}');
  assert.equal(value('f(4)'), '{"t":"int","v":24}');
  assert.equal(value('card({0..N-1})'), '{"t":"int","v":3}');
  assert.equal(value('card(T)'), '{"t":"int","v":3}');
  assert.match(value('{0..}'), /^unknown: the infinite range/);
  assert.match(value('undefined_name + 1'), /^unknown: undefined_name is not defined/);
  const events = toEvents(evaluate(body('V = union({| c.1 |}, {d})', 'V'), globals.env), globals)!;
  assert.equal(covers(events, { channel: 'c', fields: [{ t: 'int', v: 1 }, { t: 'int', v: 0 }], open: false }), 'yes');
  assert.equal(covers(events, { channel: 'c', fields: [{ t: 'int', v: 2 }, { t: 'int', v: 0 }], open: false }), 'no');
  assert.equal(covers(events, { channel: 'c', fields: [undefined, { t: 'int', v: 0 }], open: false }), 'maybe');
  assert.equal(covers(events, { channel: 'd', fields: [], open: false }), 'yes');
  const all = toEvents(evaluate(body('V = diff(Events, {| c |})', 'V'), globals.env), globals)!;
  assert.equal(covers(all, { channel: 'd', fields: [], open: false }), 'yes');
  assert.equal(covers(all, { channel: 'c', fields: [], open: true }), 'no');
});

// ---------------------------------------------------------------------------
// Networks
// ---------------------------------------------------------------------------

test('dining philosophers: each philosopher shares its forks\' events with exactly its two forks', () => {
  const doc = fixture('dining.csp');
  assert.deepEqual(doc.roots.map((root) => `${root.name}:${root.section}`), ['SYSTEM:asserted', 'PHILOSOPHERS:definition', 'FORKS:definition']);
  assert.equal(doc.defaultView(), 'view:SYSTEM');
  const { view } = doc.view('view:SYSTEM')!;
  assert.deepEqual(processes(view), ['PHIL(0)', 'PHIL(1)', 'PHIL(2)', 'FORK(0)', 'FORK(1)', 'FORK(2)']);
  assert.deepEqual(view.nodes.filter((node) => node.kind === 'group').map((node) => `${node.label} [${node.badge}] ${node.detail ?? ''}`), ['SYSTEM [[| |]] [| {| pickup, putdown |} |]', 'PHILOSOPHERS [|||] ||| i : PHILS', 'FORKS [|||] ||| j : PHILS']);
  assert.deepEqual(links(view).sort(), [
    'PHIL(0) -- FORK(0): pickup.0.0, putdown.0.0',
    'PHIL(0) -- FORK(1): pickup.0.1, putdown.0.1',
    'PHIL(1) -- FORK(1): pickup.1.1, putdown.1.1',
    'PHIL(1) -- FORK(2): pickup.1.2, putdown.1.2',
    'PHIL(2) -- FORK(0): pickup.2.0, putdown.2.0',
    'PHIL(2) -- FORK(2): pickup.2.2, putdown.2.2',
  ]);
  // No direction: these are synchronisations, not data.
  assert.ok(view.edges.every((edge) => edge.tags.includes('undirected')));
  // What a philosopher does on its own is listed on its box.
  assert.equal(view.nodes.find((node) => node.label === 'PHIL(1)')!.detail, 'also eats.1, thinks.1');
  // Identity per src/verification.ts: branch of SYSTEM's parallel, the reference unfolded, the member of the replicated interleave.
  const phil = view.nodes.find((node) => node.label === 'PHIL(2)')!;
  assert.deepEqual(phil.path!.map((step) => `${step.kind}@${step.site.span.start.line + 1}:${step.site.span.start.col}${step.index === undefined ? '' : `#${step.index}`}`), ['branch@21:9#1', 'call@21:9', 'par-for@18:15#3']);
  // Every box knows where it is written and what it does there.
  assert.deepEqual(phil.operations.map((op) => `${op.kind}@${op.at.span.start.line + 1}`).sort(), ['sync@11', 'sync@11', 'sync@12', 'sync@12']);
});

test('the COPY pipeline: data flows left to right, the middle channel is hidden, the environment is a port', () => {
  const doc = fixture('copy.csp');
  const { view } = doc.view('view:SYSTEM')!;
  assert.deepEqual(processes(view), ['COPY(left, mid)', 'COPY(mid, right)']);
  assert.deepEqual(links(view), ['[left] -> COPY(left, mid)', 'COPY(left, mid) -> COPY(mid, right): mid (hidden)', 'COPY(mid, right) -> [right]']);
  assert.deepEqual(view.nodes.filter((node) => node.kind === 'port').map((node) => `${node.label}:${node.port!.direction}`), ['left:in', 'right:out']);
  assert.deepEqual(view.nodes.find((node) => node.id === 'n:root')!.facts, ['unfolds SYSTEM', 'hides {| mid |}']);
  // The processes the assertions are about (the implementation of a refinement) are the views; BUFF2' has parameters.
  assert.deepEqual(doc.roots.map((root) => `${root.name}:${root.section}`), ['SYSTEM:asserted', 'BUFF2:asserted']);
});

test('an alphabetized ring links each node to its two neighbours', () => {
  const { view } = fixture('ring.csp').view('view:RING')!;
  assert.deepEqual(processes(view), ['pass.1 -> NODE(0)', 'NODE(1)', 'NODE(2)', 'NODE(3)']);
  assert.equal(view.nodes.find((node) => node.label.startsWith('pass'))!.detail, 'i = 0');
  assert.deepEqual(links(view), ['pass.1 -> NODE(0) -- NODE(3): pass.0', 'pass.1 -> NODE(0) -- NODE(1): pass.1', 'NODE(1) -- NODE(2): pass.2', 'NODE(2) -- NODE(3): pass.3']);
});

test('a replicated interleave of clients: each client shares only its own events with the server', () => {
  const doc = fixture('interleave.csp');
  const { view } = doc.view('view:SYSTEM')!;
  assert.deepEqual(processes(view), ['CLIENT(0)', 'CLIENT(1)', 'CLIENT(2)', 'SERVER']);
  assert.deepEqual(links(view), ['CLIENT(0) -- SERVER: request.0, reply.0', 'CLIENT(1) -- SERVER: request.1, reply.1', 'CLIENT(2) -- SERVER: request.2, reply.2']);
  // The assertion about the hidden system has a view of its own, with the same links hidden.
  const hidden = doc.view(doc.roots.find((root) => root.name === 'SYSTEM \\ {| request, reply |}')!.id)!.view;
  assert.ok(hidden.edges.every((edge) => edge.tags.includes('hidden')));
});

test('three processes on one event are a hub; a large replicated set is one box xN; the walk says what it could not follow', () => {
  const hub = new CspmDocument('file:///hub.csp', 'channel b, x\nA = b -> A\nB = b -> x -> B\nC = b -> C\nSYS = (A [| {b} |] B) [| {b} |] C\nassert SYS :[deadlock free]\n', 1);
  const view = hub.view('view:SYS')!.view;
  assert.deepEqual(links(view), ['{A, B, C}: b']);
  assert.equal(view.nodes.filter((node) => node.kind === 'barrier').length, 1);
  const big = new CspmDocument('file:///big.csp', 'channel c : {0..99}\nW(i) = c.i -> W(i)\nSYS = ||| i : {0..99} @ W(i)\n', 1);
  const many = big.view('view:SYS')!.view;
  assert.deepEqual(processes(many), ['W(i) ×100']);
  assert.match(many.notes.join(' '), /drawn as one box standing for its 100 members/);
  const opaque = new CspmDocument('file:///opaque.csp', 'channel a\nP = a -> mystery(3)\nQ = a -> Q\nSYS = P [| {a} |] Q\n', 1);
  const leaf = opaque.view('view:SYS')!.leaves;
  assert.match([...leaf.values()].find((entry) => entry.label === 'P')!.partial.join(' '), /mystery\(3\): mystery is not defined/);
});

// ---------------------------------------------------------------------------
// FDR
// ---------------------------------------------------------------------------

async function checked(name: string): Promise<{ doc: CspmDocument; report: VerificationReport }> {
  const doc = fixture(name);
  const run = await recordedRun(`cspm_${name.replace(/\.csp$/, '')}`, { text: doc.text } as CspModel);
  const report = explainCspm({ uri: doc.uri, documentVersion: 1, text: doc.text, file: doc.file, globals: doc.globals, viewFor: (a: Assertion) => doc.viewForAssertion(a), run });
  return { doc, report };
}

test('FDR on the dining philosophers: the deadlock is a circle of waits, placed on the drawn boxes', async () => {
  const { doc, report } = await checked('dining.csp');
  assert.deepEqual(report.checks.map((check) => `${check.id} ${check.label}: ${check.status}`), ['line 23 SYSTEM :[deadlock free [F]]: failed']);
  const cx = report.checks[0].counterexample!;
  assert.equal(cx.kind, 'deadlock');
  assert.equal(cx.steps.length, 6);
  assert.ok(cx.final.every((snapshot) => snapshot.status === 'blocked' && snapshot.waits?.length === 1));
  // Every philosopher holds its left fork and waits for its right one.
  for (const snapshot of cx.final.filter((entry) => entry.process.label.startsWith('PHIL'))) {
    const i = Number(/\d/.exec(snapshot.process.label)![0]);
    assert.equal(snapshot.waits![0].detail, `waits to sync on pickup.${i}.${(i + 1) % 3}`);
    assert.equal(snapshot.waits![0].partner?.process?.label, `FORK(${(i + 1) % 3})`);
    assert.equal(snapshot.waits![0].at?.span.start.line, 10);
  }
  assert.equal(cx.cycles?.length, 1);
  assert.deepEqual(cx.cycles![0].map((entry) => entry.process.label), ['PHIL(0)', 'FORK(1)', 'PHIL(1)', 'FORK(2)', 'PHIL(2)', 'FORK(0)']);
  // The overlay finds every process and every wait on the drawing.
  const model = doc.model(['view:SYSTEM']);
  const overlays = buildOverlays(model, [report]);
  assert.equal(overlays.length, 1);
  assert.deepEqual(overlays[0].unplaced, []);
  assert.equal(overlays[0].processes.length, 6);
  assert.ok(overlays[0].waits.every((wait) => wait.edge), 'each wait is on its arrow');
  assert.equal(overlays[0].cycles[0].nodes.length, 6);
  // Each step names who took part.
  assert.deepEqual(cx.steps.map((step) => step.participants.map((p) => p.process.label).join('+')), ['PHIL(0)', 'PHIL(1)', 'PHIL(1)+FORK(1)', 'PHIL(2)', 'PHIL(0)+FORK(0)', 'PHIL(2)+FORK(2)']);
  // Paths match the drawn boxes.
  const view = model.views[0];
  for (const snapshot of cx.final) assert.ok(view.nodes.some((node) => node.path && pathMatches(node.path, snapshot.process.path)), snapshot.process.label);
});

test('FDR on the COPY pipeline: the failing refinement shows the hidden step and who would do the refused event', async () => {
  const { report } = await checked('copy.csp');
  assert.deepEqual(report.checks.map((check) => `${check.label}: ${check.status}`), ['BUFF2 [FD= SYSTEM: passed', 'SYSTEM [FD= BUFF2: passed', 'SYSTEM :[deadlock free]: passed', 'SYSTEM :[divergence free]: passed', 'COPY(left, right) [T= SYSTEM: failed']);
  const failed = report.checks[4];
  assert.equal(failed.target.name, 'SYSTEM');
  const cx = failed.counterexample!;
  assert.equal(cx.kind, 'refinement');
  assert.match(cx.summary, /^SYSTEM can perform left\.\d after ⟨left\.\d⟩ \(COPY\(left, mid\)\), which COPY\(left, right\) does not allow$/);
  assert.deepEqual(cx.steps.map((step) => `${step.event}${step.visible ? '' : ' (hidden)'}`).map((text) => text.replace(/\d/, 'v')), ['left.v', 'mid.v (hidden)']);
  assert.match(cx.steps[1].description, /^COPY\(left, mid\) outputs \d on mid; COPY\(mid, right\) inputs it \(hidden\)$/);
  assert.deepEqual(cx.steps[1].participants.map((p) => p.role), ['writer', 'reader']);
});

test('FDR on a vending machine: a failures refinement, nondeterminism and a deadlock with its environment', async () => {
  const { report } = await checked('vending.csp');
  assert.deepEqual(report.checks.map((check) => `${check.label}: ${check.status}`), ['SPEC [F= VM: failed', 'SPEC [T= VM: passed', 'VM :[deterministic [F]]: failed', 'SYSTEM :[deadlock free [F]]: failed']);
  assert.match(report.checks[0].message!, /^after ⟨coin⟩, VM can refuse every event but \{(tea|coffee)\}, while SPEC must then offer \{tea, coffee\}/);
  assert.equal(report.checks[2].counterexample!.kind, 'nondeterminism');
  assert.match(report.checks[2].message!, /^VM is nondeterministic after ⟨coin⟩: it can perform (tea|coffee) and can also refuse it/);
  const deadlock = report.checks[3].counterexample!;
  const vm = deadlock.final.find((snapshot) => snapshot.process.label === 'VM')!;
  assert.equal(vm.waits?.[0].detail, 'waits to sync on coffee');
  // CUSTOMER never offers coffee, and the parallel synchronises on it: nobody can ever answer.
  assert.deepEqual(vm.waits?.[0].partner, { process: deadlock.final.find((snapshot) => snapshot.process.label === 'CUSTOMER')!.process, state: 'missing', detail: 'CUSTOMER never performs coffee, and [| {| coin, tea, coffee |} |] synchronises on it' });
});

test('FDR on a model the translator generated: its plumbing is drawn, and the crossed writes are the circle', async () => {
  const { doc, report } = await checked('par_deadlock.csp');
  const deadlock = report.checks.find((check) => check.property === 'deadlock-free')!;
  assert.equal(deadlock.target.name, 'PJ_NOERR(MAIN)');
  assert.deepEqual(deadlock.counterexample!.cycles?.[0].map((entry) => entry.process.label), ['main__par10_1(1)', 'main__par10_2(1)']);
  const branch = deadlock.counterexample!.final.find((snapshot) => snapshot.process.label === 'main__par10_1(1)')!;
  assert.equal(branch.waits?.[0].detail, 'waits to output c.1');
  const overlays = buildOverlays(doc.model([doc.viewForAssertion(doc.file.decls.find((decl): decl is Assertion => decl.kind === 'assert')!)!.root.id]), [report]);
  assert.deepEqual(overlays.find((overlay) => overlay.check === deadlock.id)?.unplaced, []);
  assert.equal(doc.generatedFrom(), path.join(CSPM, 'par_deadlock.pj'));
});

test('results are matched to assertions by their text, an included file\'s assertions skipped; FDR errors keep their place', () => {
  const doc = new CspmDocument('file:///m.csp', 'channel a\nP = a -> P\nassert P :[deadlock free]\nassert P [T= P\n', 1);
  const asserts = doc.file.decls.filter((decl): decl is Assertion => decl.kind === 'assert');
  const r = (assertion: string) => ({ assertion, passed: true, errors: [], counterexamples: [] });
  assert.deepEqual(matchCspmResults(asserts, [r('Q :[deadlock free]'), r('P :[deadlock free]'), r('P [T= P')]).map((x) => x?.assertion), ['P :[deadlock free]', 'P [T= P']);
  assert.deepEqual(fdrErrors(['m.csp:3:5-6: b is not in scope', 'lib.csp:1:1-2:3: oops', '<unknown location>: Unexpected token EOF'], 'm.csp'), [
    { message: 'b is not in scope', span: { start: { line: 2, col: 4 }, end: { line: 2, col: 5 } } },
    { message: 'oops', file: 'lib.csp', span: { start: { line: 0, col: 0 }, end: { line: 1, col: 2 } } },
    { message: 'Unexpected token EOF' },
  ]);
  const notRun = explainCspm({ uri: doc.uri, text: doc.text, file: doc.file, globals: doc.globals, viewFor: (a) => doc.viewForAssertion(a), notRun: 'FDR is not installed' });
  assert.deepEqual(notRun.checks.map((check) => `${check.status}: ${check.message}`), ['skipped: FDR is not installed', 'skipped: FDR is not installed']);
});

test('the text report and the diagnostics of a result: the failed assertion, and where the processes are stuck', async () => {
  const { doc, report } = await checked('dining.csp');
  const text = formatCspmReport(report, { fileName: 'dining.csp' });
  assert.match(text, /SYSTEM :\[deadlock free \[F\]\]\s+FAILS/);
  assert.match(text, /Circular wait: PHIL\(0\) -> FORK\(1\) -> PHIL\(1\) -> FORK\(2\) -> PHIL\(2\) -> FORK\(0\) -> PHIL\(0\)/);
  const spans = new Map(doc.file.decls.filter((decl): decl is Assertion => decl.kind === 'assert').map((a) => [`line ${a.span.start.line + 1}`, a.span] as const));
  const diagnostics = cspmFdrDiagnostics(report, spans);
  // The three philosophers are stuck at one prefix, the three forks at another.
  assert.deepEqual(diagnostics.map((d) => `${d.span.start.line + 1}:${d.severity}`), ['23:error', '11:info', '15:info']);
  assert.equal(diagnostics[1].message, 'PHIL(0), PHIL(1) and PHIL(2) are stuck here, waiting to sync on pickup.0.1, sync on pickup.1.2, sync on pickup.2.0 (SYSTEM :[deadlock free [F]], line 23)');
  assert.match(diagnostics[0].message, /^SYSTEM :\[deadlock free \[F\]\] does not hold: deadlock after 6 steps/);
});

test('a chain drawn as one composition is matched to FDR\'s binary tree by how it was written: every process gets its own state', async () => {
  const { report } = await checked('nested.csp');
  const check = report.checks[0];
  assert.equal(check.status, 'failed');
  assert.doesNotMatch(check.message!, /does not have the shape|matched by position/);
  const cx = check.counterexample!;
  const offers = Object.fromEntries(cx.final.map((snapshot) => [snapshot.process.label, snapshot.waits?.map((wait) => wait.detail).join('; ') ?? snapshot.description]));
  // What FDR gave each process (acceptances P(0) {go}, Q(0) {c.0}, ..., P(2) {c.2}, STOP {}), on that process.
  assert.deepEqual(offers, {
    'P(0)': 'waits to sync on go',
    'Q(0)': 'waits to sync on c.0',
    'P(1)': 'waits to sync on go',
    'Q(1)': 'waits to sync on c.1',
    'P(2)': 'waits to sync on c.2',
    STOP: '',
  });
  const p2 = cx.final.find((snapshot) => snapshot.process.label === 'P(2)')!;
  assert.equal(p2.waits![0].partner?.state, 'missing');
  // Each step is its own pair's.
  assert.ok(cx.steps.every((step) => step.participants.length > 0));
});

test('assertions FDR prints differently are still matched; a negation keeps its "not"; a failures-model trace is refused, not missing', async () => {
  const { report } = await checked('forms.csp');
  assert.deepEqual(report.checks.map((check) => `${check.label}: ${check.status}`), [
    'P :[livelock free]: passed',
    'P :[divergence-free]: passed',
    'P :[has trace [T]]: <a,b>: passed',
    'STOP [T= ||| i : {0..1} @ R(i): failed',
    'P {- a comment -} [F= P: passed',
    'not P [T= STOP: failed',
    'not STOP [T= P: passed',
    'T :[has trace [T]]: <a, c>: passed',
    'T :[has trace]: <a, c>: failed',
  ]);
  assert.equal(report.checks[1].property, 'divergence-free');
  assert.equal(report.checks[5].message, 'P [T= STOP holds (1 state), so its negation does not');
  assert.match(report.checks[6].message!, /^holds: STOP \[T= P does not/);
  const trace = report.checks[8].message!;
  assert.match(trace, /^T can refuse \{c\} after ⟨a⟩ \(it may offer only \{b\}\): in the F model/);
  assert.doesNotMatch(trace, /does not have the trace/);
  const doc = fixture('forms.csp');
  const spans = new Map(doc.file.decls.filter((decl): decl is Assertion => decl.kind === 'assert').map((a) => [`line ${a.span.start.line + 1}`, a.span] as const));
  const negation = cspmFdrDiagnostics(report, spans).find((d) => d.check === report.checks[5].id)!;
  assert.equal(negation.message, 'not P [T= STOP does not hold: P [T= STOP holds (1 state), so its negation does not');
});

test('who takes part follows each event: an input facing alphabets, one-to-many and unfollowed renamings, events cut off', () => {
  // `c?x` meets the alphabets {c.0} and {c.1}: each c.i is a pair, never a three-way event.
  for (const sys of ['(|| i : {0,1} @ [{c.i}] P(i)) [| {|c|} |] S', '(P(0) [ {c.0} || {c.1} ] P(1)) [| {|c|} |] S']) {
    const doc = new CspmDocument('file:///hub.csp', `channel c : {0..1}\nP(i) = c.i -> P(i)\nS = c?x -> S\nSYS = ${sys}\n`, 1);
    const view = doc.view('view:SYS')!.view;
    assert.deepEqual(links(view), ['P(0) -- S: c.0', 'P(1) -- S: c.1'], sys);
    assert.equal(view.nodes.filter((node) => node.kind === 'barrier').length, 0, sys);
  }
  // `[[ a <- b, a <- c ]]`: P does both b and c; neither is an event that can never happen.
  const renamed = new CspmDocument('file:///r.csp', 'channel a, b, c, x\nchannel d : {0..1}\nP = a -> P\nQ = b -> Q\nR = c -> R\nSYS = (P [[ a <- b, a <- c ]]) [| {b, c} |] (Q ||| R)\nT = d.0 -> d.1 -> T\nU = x -> U\nSYS2 = (T [[ d.0 <- x ]]) [| {x} |] U\n', 1);
  const one = renamed.view('view:SYS')!;
  assert.deepEqual(links(one.view), ['P [[ a <- b, a <- c ]] -- Q: b', 'P [[ a <- b, a <- c ]] -- R: c']);
  assert.deepEqual(one.blocked, []);
  // A renaming the graph does not follow: its partner shares x with it, conditionally, and is not said to do x alone.
  const two = renamed.view('view:SYS2')!.view;
  assert.deepEqual(links(two), ['T [[ d.0 <- x ]] -- U: x']);
  assert.ok(two.edges.every((edge) => edge.confidence === 'conditional'));
  assert.ok(two.nodes.every((node) => !/also/.test(node.detail ?? '')), 'nothing is claimed to be done alone');
  // A renaming around a part of the network: outside it, its a is b, shared with C.
  const around = new CspmDocument('file:///rw.csp', 'channel a, b\nA = a -> A\nB = a -> B\nC = b -> C\nSYS = ((A [| {a} |] B) [[ a <- b ]]) [| {b} |] C\n', 1).view('view:SYS')!;
  assert.deepEqual(links(around.view), ['{A, B, C}: b']);
  assert.deepEqual(around.blocked, []);
});

test('views say where they stop: a recursive composition cut at the depth limit; one stub per event an operand can never share', () => {
  const rec = new CspmDocument('file:///rec.csp', 'channel a\nQ(n) = Q(n+1) ||| Q(n+2)\nSYSTEM = a -> SKIP ||| Q(0)\n', 1);
  const view = rec.view('view:SYSTEM')!.view;
  assert.match(view.notes.join(' '), /Compositions more than 8 references deep are not unfolded/);
  assert.ok(view.nodes.some((node) => node.kind === 'process' && node.facts.some((fact) => /is a composition, not unfolded/.test(fact))));
  // c and each c.i are one never-shared end per operand, not two.
  const stubs = new CspmDocument('file:///s.csp', 'channel c : {0..1}\nW(i) = c!i -> W(i) [] c?x -> W(i)\nSYSTEM = (W(0) [| {| c |} |] STOP) ||| (W(1) [| {| c |} |] STOP)\n', 1);
  const drawn = stubs.view('view:SYSTEM')!.view.nodes.filter((node) => node.kind === 'stub').map((node) => node.label);
  assert.deepEqual(drawn, ['never shared: c', 'never shared: c']);
});

test('the parser reads what FDR reads: module-qualified names, and nesting too deep is a warning, never a failure', () => {
  const mod = parseCspm('channel a\nmodule M\n  X = a -> X\nexports\n  Y = X\nendmodule\nSYSTEM = a -> SYSTEM [| {a} |] M::Y\n');
  assert.deepEqual(mod.diagnostics.map((d) => d.severity), ['info']);
  const deep = new CspmDocument('file:///par.csp', `channel a\nQ = ${'('.repeat(250)}a -> Q${')'.repeat(250)}\nP = a -> P\n`, 1);
  assert.deepEqual(deep.diagnostics.map((d) => d.severity), ['warning']);
  assert.ok(deep.symbols().some((symbol) => symbol.name === 'P'));
  const chain = new CspmDocument('file:///chain.csp', `channel a\nQ = ${'a -> '.repeat(20000)}Q\n`, 1);
  assert.ok(chain.diagnostics.every((d) => d.severity !== 'error'));
  // Several of FDR's type errors in one string: one diagnostic each, at its own line.
  assert.deepEqual(fdrErrors(['m.csp:2:10-15: bogus is not in scope\nm.csp:4:6-20: undefinedthing is not in scope'], 'm.csp').map((e) => [e.span?.start.line, e.message]), [[1, 'bogus is not in scope'], [3, 'undefinedthing is not in scope']]);
});

test('linking stays fast when many definitions reach the same events', () => {
  const n = 300;
  const text = ['channel c : {0..3}', ...Array.from({ length: n }, (_, i) => `P${i} = c!${i % 4} -> c?x -> P${(i + 1) % n}`), `SYSTEM = ${Array.from({ length: 60 }, (_, i) => `P${i}`).join(' ||| ')}`].join('\n');
  const started = Date.now();
  const doc = new CspmDocument('file:///big.csp', text, 1);
  assert.ok(doc.view(doc.defaultView()));
  assert.ok(Date.now() - started < 3000, `built in ${Date.now() - started} ms`);
});

test('a live run of FDR gives what the recordings hold', { skip: !refines && 'FDR is not installed' }, async () => {
  for (const name of ['dining.csp', 'copy.csp']) {
    const doc = fixture(name);
    const live = await checkCspmWithFdr({ document: doc, refines, workers: 1, timeoutMs: 60_000 });
    const { report } = await checked(name);
    assert.deepEqual(live.report.checks.map((check) => `${check.id}:${check.status}`), report.checks.map((check) => `${check.id}:${check.status}`), name);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cspm-tc-'));
  try {
    const broken = new CspmDocument(pathToFileURL(path.join(dir, 'broken.csp')).toString(), 'channel a : {0..1}\nP = a!1 -> P\nQ = b -> Q\n', 1);
    assert.deepEqual(await typecheckCspm(broken, refines!), [{ message: 'b is not in scope', span: { start: { line: 2, col: 4 }, end: { line: 2, col: 5 } } }]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
