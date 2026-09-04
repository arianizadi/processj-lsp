import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from '../src/checker/checker';
import { DeclIndex } from '../src/checker/index';
import { analyzeProtocols, effectiveProtocolCases, type ProtocolAnalysis } from '../src/checker/protocols';
import { parse } from '../src/parser/parser';

function analyze(source: string, file = 'protocols.pj', reuseTokens = true): ProtocolAnalysis {
  const parsed = parse(source);
  assert.deepEqual(parsed.errors, [], 'test program must parse');
  const index = new DeclIndex();
  index.addProgram(parsed.program, file);
  const checked = check(parsed.program, { index, text: source });
  return analyzeProtocols(parsed.program, index, checked, {
    file,
    sourceText: source,
    tokens: reuseTokens ? parsed.tokens : undefined,
  });
}

test('protocol structures store declarations once and report genuine case collisions', () => {
  const source = [
    'protocol A {',
    '    same: { int fromA; }',
    '    aOnly: { string text; }',
    '}',
    'protocol B {',
    '    same: { long fromB; }',
    '    bOnly: { boolean ok; }',
    '}',
    'protocol Combined extends A, B { own: { int value; } }',
    'protocol Override extends A { same: { double local; } }',
    'protocol Descendant extends Combined { later: { } }',
    'protocol Left extends A { left: { } }',
    'protocol Right extends A { right: { } }',
    'protocol Diamond extends Left, Right { diamond: { } }',
  ].join('\n');
  const result = analyze(source);

  const combined = result.protocols.find((protocol) => protocol.name === 'Combined');
  assert.ok(combined);
  assert.equal(combined.caseSetComplete, true);
  assert.deepEqual(combined.parents.map((parent) => [parent.name, parent.resolved]), [['A', true], ['B', true]]);
  assert.deepEqual(
    effectiveProtocolCases(result.protocols, combined).map((protocolCase) => protocolCase.name),
    ['own', 'same', 'aOnly', 'bOnly'],
  );
  assert.deepEqual(combined.cases.map((protocolCase) => protocolCase.name), ['own']);
  const shadowedSame = combined.collisions[0].origins.find((protocolCase) => protocolCase.declaringProtocolName === 'B');
  assert.equal(shadowedSame?.effective, false);
  assert.equal(shadowedSame?.inheritanceDepth, 1);
  assert.equal(shadowedSame?.inheritedVia, 'B');
  assert.deepEqual(shadowedSame?.fields.map((field) => [field.name, field.typeLabel]), [['fromB', 'long']]);

  assert.equal(combined.collisions.length, 1);
  assert.equal(combined.collisions[0].caseName, 'same');
  assert.equal(combined.collisions[0].kind, 'multiple-inheritance');
  assert.equal(combined.collisions[0].introduced, true);
  assert.deepEqual(combined.collisions[0].origins.map((origin) => origin.declaringProtocolName), ['A', 'B']);

  const override = result.protocols.find((protocol) => protocol.name === 'Override');
  assert.equal(override?.collisions[0]?.kind, 'own-and-inherited');
  assert.equal(override?.collisions[0]?.span.start.line, 9);

  const descendant = result.protocols.find((protocol) => protocol.name === 'Descendant');
  assert.deepEqual(descendant?.collisions, [], 'inherited conflicts are represented at their source, not copied');

  // The shared A declaration arrives through two diamond paths, but is one
  // origin and therefore not an ambiguity.
  const diamond = result.protocols.find((protocol) => protocol.name === 'Diamond');
  assert.deepEqual(diamond?.collisions, []);
  assert.equal(effectiveProtocolCases(result.protocols, diamond!).filter((protocolCase) => protocolCase.name === 'same').length, 1);

  const collisions = result.issues.filter((issue) => issue.kind === 'inherited-case-collision');
  assert.deepEqual(collisions.map((issue) => issue.caseName), ['same', 'same']);
  assert.ok(collisions.every((issue) => issue.span.start.line >= 8));
});

test('nested ambiguous parents emit only newly introduced collisions', () => {
  const source = [
    'protocol A { x: { int fromA; } }',
    'protocol B { x: { int fromB; } }',
    'protocol C extends A, B { c: { } }',
    'protocol D extends C { d: { } }',
    'protocol E extends C, B { e: { } }',
    'protocol F extends C, A { f: { } }',
    'protocol Left extends A { left: { } }',
    'protocol Right extends A { right: { } }',
    'protocol Diamond extends Left, Right { diamond: { } }',
  ].join('\n');
  const result = analyze(source, 'nested-collisions.pj');
  const collisions = new Map(result.protocols.map((protocol) => [protocol.name, protocol.collisions]));

  assert.deepEqual(collisions.get('C')?.map((collision) => collision.origins.map((origin) => origin.declaringProtocolName)), [['A', 'B']]);
  assert.deepEqual(collisions.get('E')?.map((collision) => collision.origins.map((origin) => origin.declaringProtocolName)), [['A', 'B']]);
  assert.deepEqual(collisions.get('D'), [], 'a single parent does not reintroduce its collision');
  assert.deepEqual(collisions.get('F'), [], 'two paths selecting the same A declaration are not ambiguous');
  assert.deepEqual(collisions.get('Diamond'), [], 'a diamond sharing one declaration is not ambiguous');
  assert.deepEqual(
    result.issues.filter((issue) => issue.kind === 'inherited-case-collision').map((issue) => issue.protocolId),
    [result.protocols.find((protocol) => protocol.name === 'C')?.id, result.protocols.find((protocol) => protocol.name === 'E')?.id],
  );
});

test('protocol switches expose explicit coverage, missing cases and duplicate defaults', () => {
  const source = [
    'protocol Base { inherited: { } }',
    'protocol Message extends Base { ping: { } pong: { } }',
    'void handle(Message message) {',
    '    switch (message) {',
    '    case inherited:',
    '        break;',
    '    case ping:',
    '        break;',
    '    }',
    '    switch (message) {',
    '    case ping:',
    '        break;',
    '    case ping: /* the default below is intentional */ default:',
    '        break;',
    '    default:',
    '        break;',
    '    }',
    '}',
  ].join('\n');
  const result = analyze(source, 'switches.pj', false);

  assert.equal(result.switches.length, 2);
  const [partial, withDefaults] = result.switches;
  assert.equal(partial.coverage, 'non-exhaustive');
  assert.equal(partial.exhaustive, false);
  assert.deepEqual(partial.missingCases.map((protocolCase) => protocolCase.name), ['pong']);
  assert.deepEqual(
    partial.labels.filter((label) => label.kind === 'case').map((label) => [label.name, label.valid, label.duplicate]),
    [['inherited', true, false], ['ping', true, false]],
  );
  assert.equal(source.split('\n')[partial.insertAt.line][partial.insertAt.col], '}');

  assert.equal(withDefaults.coverage, 'exhaustive');
  assert.equal(withDefaults.exhaustive, true);
  assert.deepEqual(withDefaults.missingCases.map((protocolCase) => protocolCase.name), ['pong', 'inherited']);
  assert.equal(withDefaults.defaultLabels.length, 2);
  assert.equal(withDefaults.duplicateDefaults.length, 1);
  const duplicate = withDefaults.duplicateDefaults[0];
  assert.equal(source.split('\n')[duplicate.span.start.line].slice(duplicate.span.start.col, duplicate.span.end.col), 'default');

  const missingIssues = result.issues.filter((issue) => issue.kind === 'missing-cases');
  assert.equal(missingIssues.length, 1);
  assert.deepEqual(missingIssues[0].missingCases.map((protocolCase) => protocolCase.name), ['pong']);
  const defaultIssues = result.issues.filter((issue) => issue.kind === 'duplicate-default');
  assert.equal(defaultIssues.length, 1);
  assert.equal(defaultIssues[0].span.start.line, 14);
});

test('incomplete visible declarations produce unknown coverage instead of false warnings', () => {
  const source = [
    'protocol Opaque;',
    'protocol Child extends Missing { own: { } }',
    'protocol CycleA extends CycleB { a: { } }',
    'protocol CycleB extends CycleA { b: { } }',
    'void inspect(Opaque opaque, Child child) {',
    '    switch (opaque) { }',
    '    switch (child) { case own: break; }',
    '}',
  ].join('\n');
  const result = analyze(source);

  const opaque = result.protocols.find((protocol) => protocol.name === 'Opaque');
  const child = result.protocols.find((protocol) => protocol.name === 'Child');
  assert.equal(opaque?.forward, true);
  assert.equal(opaque?.caseSetComplete, false);
  assert.equal(child?.parents[0].resolved, false);
  assert.equal(child?.caseSetComplete, false);
  assert.equal(result.protocols.find((protocol) => protocol.name === 'CycleA')?.caseSetComplete, false);
  assert.deepEqual(result.switches.map((protocolSwitch) => protocolSwitch.coverage), ['unknown', 'unknown']);
  assert.ok(result.switches.every((protocolSwitch) => protocolSwitch.exhaustive === undefined));
  assert.equal(result.issues.filter((issue) => issue.kind === 'missing-cases').length, 0);
});

test('protocol diagnostics do not cascade from invalid cases or broken inheritance', () => {
  const source = [
    'protocol Message { ping: { } pong: { } }',
    'protocol CycleA extends CycleB { same: { } }',
    'protocol CycleB extends CycleA { same: { } }',
    'void inspect(Message message) {',
    '    switch (message) { case pnig: break; }',
    '}',
  ].join('\n');
  const result = analyze(source);
  const protocolSwitch = result.switches[0];
  assert.equal(protocolSwitch.coverage, 'non-exhaustive');
  assert.equal(protocolSwitch.labels[0].valid, false);
  assert.equal(result.issues.some((issue) => issue.kind === 'missing-cases'), false);
  assert.ok(result.collisions.length > 0, 'collision facts remain available to graphs and inspections');
  assert.equal(result.issues.some((issue) => issue.kind === 'inherited-case-collision'), false);
});

test('flow facts connect construction, channel traffic and case inspection to procedures', () => {
  const source = [
    'protocol Message { ping: { int value; } pong: { } }',
    'void produce(chan<Message>.write out) {',
    '    out.write(new Message { ping: value = 1 });',
    '}',
    'void consume(chan<Message>.read in) {',
    '    Message message = in.read();',
    '    switch (message) {',
    '    case ping:',
    '        break;',
    '    default:',
    '        break;',
    '    }',
    '    if (message is pong) { }',
    '}',
  ].join('\n');
  const first = analyze(source, 'flow.pj');
  const second = analyze(source, 'flow.pj');

  assert.deepEqual(first.flows.map((flow) => flow.kind), ['send', 'construct', 'receive', 'match', 'test']);
  const send = first.flows.find((flow) => flow.kind === 'send');
  const construct = first.flows.find((flow) => flow.kind === 'construct');
  const receive = first.flows.find((flow) => flow.kind === 'receive');
  const match = first.flows.find((flow) => flow.kind === 'match');
  const protocolTest = first.flows.find((flow) => flow.kind === 'test');
  assert.deepEqual([send?.protocolName, send?.caseName, send?.procedureName, send?.subject?.variableName], ['Message', 'ping', 'produce', 'out']);
  assert.deepEqual([construct?.caseName, construct?.procedureName], ['ping', 'produce']);
  assert.deepEqual([receive?.protocolName, receive?.procedureName, receive?.subject?.variableName], ['Message', 'consume', 'in']);
  assert.deepEqual([match?.caseName, match?.procedureName, match?.subject?.variableName], ['ping', 'consume', 'message']);
  assert.deepEqual([protocolTest?.caseName, protocolTest?.procedureName, protocolTest?.subject?.variableName], ['pong', 'consume', 'message']);
  assert.ok(send?.subject?.variableId?.includes('parameter'));
  assert.equal(send?.caseId, construct?.caseId);

  // Fact identity is content-derived, not tied to an analysis instance.
  assert.deepEqual(first.flows.map((flow) => flow.id), second.flows.map((flow) => flow.id));
  assert.deepEqual(first.protocols.map((protocol) => protocol.id), second.protocols.map((protocol) => protocol.id));
  assert.ok(first.flows.every((flow) => flow.id.includes('flow-')));
});
