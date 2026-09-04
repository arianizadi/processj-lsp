import assert from 'node:assert/strict';
import { test } from 'node:test';
import { check } from '../src/checker/checker';
import { DeclIndex } from '../src/checker/index';
import { parse } from '../src/parser/parser';
import { decodeTokens, semanticTokens } from '../src/semantic';

test('semantic tokens classify declarations, parameters, fields, cases and calls', () => {
  const src = [
    'import std.*;',
    'const int N = 2;',
    'record Point { int x; }',
    'protocol Msg { move : { int dx; } }',
    'public void f(chan<int>.read in, Point p) {',
    '    int v = in.read() + p.x + N;',
    '    Msg m = new Msg { move: dx = v };',
    '    if (m is move) f(in, p);',
    '}',
  ].join('\n');
  const parsed = parse(src);
  assert.deepEqual(parsed.errors, []);
  const index = new DeclIndex();
  index.addProgram(parsed.program, 'a.pj');
  const checked = check(parsed.program, { index, importsStd: true, unresolvedImports: true });
  const toks = decodeTokens(semanticTokens(parsed.program, checked, index));
  const at = (line: number, col: number) => toks.find((t) => t.line === line && t.col === col);
  assert.deepEqual(at(0, 7), { line: 0, col: 7, len: 3, type: 'namespace', mods: [] });
  assert.deepEqual(at(1, 10)?.type, 'variable');
  assert.deepEqual(at(1, 10)?.mods, ['declaration', 'readonly']);
  assert.equal(at(2, 7)?.type, 'struct');
  assert.equal(at(2, 19)?.type, 'property');
  assert.equal(at(3, 9)?.type, 'enum');
  assert.equal(at(3, 15)?.type, 'enumMember');
  assert.equal(at(4, 12)?.type, 'function');
  assert.equal(at(4, 29)?.type, 'parameter');
  assert.equal(at(4, 33)?.type, 'struct');
  assert.equal(at(5, 12)?.type, 'parameter');
  assert.equal(at(5, 24)?.type, 'parameter');
  assert.equal(at(5, 26)?.type, 'property');
  assert.deepEqual(at(5, 30)?.mods, ['readonly']);
  assert.equal(at(6, 4)?.type, 'enum');
  assert.equal(at(6, 22)?.type, 'enumMember');
  assert.equal(at(7, 13)?.type, 'enumMember');
  assert.equal(at(7, 19)?.type, 'function');
  // Relative encoding: deltas never go backwards.
  const data = semanticTokens(parsed.program, checked, index);
  for (let i = 0; i < data.length; i += 5) assert.ok(data[i] >= 0 && data[i + 1] >= 0 && data[i + 2] > 0);
});

test('qualified-name package segments are semantic namespaces', () => {
  const src = [
    'void f() implements acme.api::work {',
    '    acme.api::work();',
    '    acme.model::Thing[] values;',
    '}',
  ].join('\n');
  const parsed = parse(src);
  assert.deepEqual(parsed.errors, []);
  const index = new DeclIndex();
  index.addProgram(parsed.program, 'qualified.pj');
  const checked = check(parsed.program, { index, unresolvedImports: true });
  const toks = decodeTokens(semanticTokens(parsed.program, checked, index));
  const spelling = (token: (typeof toks)[number]) => src.split('\n')[token.line].slice(token.col, token.col + token.len);
  const packages = toks.filter((token) => spelling(token) === 'acme' || spelling(token) === 'api' || spelling(token) === 'model');
  assert.equal(packages.length, 6);
  assert.ok(packages.every((token) => token.type === 'namespace'));
  assert.equal(toks.find((token) => spelling(token) === 'Thing')?.type, 'struct');
});

test('channel operations carry direction, sharing, blocking and escape modifiers', () => {
  const src = [
    'void use(shared chan<int>.read input) { int value = input.read(); }',
    'void main() { shared read chan<int> c; use(c.read); }',
  ].join('\n');
  const parsed = parse(src);
  assert.deepEqual(parsed.errors, []);
  const index = new DeclIndex();
  index.addProgram(parsed.program, 'channels.pj');
  const checked = check(parsed.program, { index });
  const tokens = decodeTokens(semanticTokens(parsed.program, checked, index));
  const spelling = (token: (typeof tokens)[number]) => src.split('\n')[token.line].slice(token.col, token.col + token.len);
  const operatedInput = tokens.find((token) => token.line === 0 && spelling(token) === 'input' && token.mods.includes('channelRead'));
  assert.deepEqual(operatedInput?.mods, ['channelRead', 'channelShared', 'blocking']);
  const passedChannel = tokens.find((token) => token.line === 1 && spelling(token) === 'c' && token.mods.includes('escaped'));
  assert.ok(passedChannel?.mods.includes('channelRead'));
  assert.ok(passedChannel?.mods.includes('channelShared'));
});

test('wrapped channel operations keep direct modifiers while timer reads remain non-blocking', () => {
  const src = [
    'void inspect(timer clock) { long now = clock.read(); }',
    'void main() {',
    '    chan<int> c;',
    '    par {',
    '        c.write.write(1);',
    '        println((c).read());',
    '    }',
    '}',
  ].join('\n');
  const parsed = parse(src);
  assert.deepEqual(parsed.errors, []);
  const index = new DeclIndex();
  index.addProgram(parsed.program, 'wrapped-channels.pj');
  const checked = check(parsed.program, { index, unresolvedImports: true });
  const tokens = decodeTokens(semanticTokens(parsed.program, checked, index));
  const at = (line: number, spelling: string) => tokens.filter((token) => token.line === line && src.split('\n')[line].slice(token.col, token.col + token.len) === spelling).at(-1);

  assert.deepEqual(at(0, 'clock')?.mods, [], 'reading a timer is an ordinary non-blocking value operation');
  assert.deepEqual(at(4, 'c')?.mods, ['channelWrite', 'blocking']);
  assert.deepEqual(at(5, 'c')?.mods, ['channelRead', 'blocking']);
  assert.equal(new Set(tokens.map((token) => `${token.line}:${token.col}:${token.len}`)).size, tokens.length, 'semantic token ranges never overlap exactly');
});

test('a read offered among alt choices is directional but not labelled as an unconditional blocking operation', () => {
  const src = [
    'void choose(chan<int>.read input, timer clock) {',
    '    int value;',
    '    alt {',
    '        value = input.read() : { println(value); }',
    '        clock.timeout(10) : { }',
    '    }',
    '}',
  ].join('\n');
  const parsed = parse(src);
  assert.deepEqual(parsed.errors, []);
  const index = new DeclIndex();
  index.addProgram(parsed.program, 'alt-tokens.pj');
  const checked = check(parsed.program, { index, unresolvedImports: true });
  const token = decodeTokens(semanticTokens(parsed.program, checked, index)).find((entry) => entry.line === 3 && src.split('\n')[3].slice(entry.col, entry.col + entry.len) === 'input');
  assert.ok(token?.mods.includes('channelRead'));
  assert.equal(token?.mods.includes('blocking'), false);
});

test('already-separated endpoint arguments inherit the selected formal role without duplicating explicit selectors', () => {
  const src = [
    'record Routes { chan<int>.read input; shared chan<int>.write output; }',
    'void pass(chan<int>.read endpoint) { }',
    'void pass(shared chan<int>.write endpoint) { }',
    'void route(chan<int>.read input, shared chan<int>.write output, Routes routes) {',
    '    pass(input);',
    '    pass(output);',
    '    pass(routes.input);',
    '    pass(routes.output);',
    '    chan<int> local;',
    '    pass(local.read);',
    '}',
  ].join('\n');
  const parsed = parse(src);
  assert.deepEqual(parsed.errors, []);
  const index = new DeclIndex();
  index.addProgram(parsed.program, 'endpoint-arguments.pj');
  const checked = check(parsed.program, { index });
  assert.equal(checked.diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length, 0);
  const tokens = decodeTokens(semanticTokens(parsed.program, checked, index));
  const spelling = (token: (typeof tokens)[number]) => src.split('\n')[token.line].slice(token.col, token.col + token.len);
  const at = (line: number, text: string) => tokens.find((token) => token.line === line && spelling(token) === text);

  assert.deepEqual(at(4, 'input')?.mods, ['channelRead', 'escaped']);
  assert.deepEqual(at(5, 'output')?.mods, ['channelWrite', 'channelShared', 'escaped']);
  assert.deepEqual(at(6, 'input'), { line: 6, col: 16, len: 5, type: 'property', mods: ['channelRead', 'escaped'] });
  assert.deepEqual(at(7, 'output'), { line: 7, col: 16, len: 6, type: 'property', mods: ['channelWrite', 'channelShared', 'escaped'] });
  assert.deepEqual(at(6, 'routes')?.mods, [], 'the endpoint field, not its record container, carries the role');
  assert.deepEqual(at(9, 'local')?.mods, ['channelRead', 'escaped']);
  assert.equal(at(9, 'local')?.mods.includes('channelWrite'), false);
  assert.equal(tokens.filter((token) => token.line === 9 && spelling(token) === 'local').length, 1, 'an explicit selector emits one carrier token');
});
