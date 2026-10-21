/**
 * Regression tests for the security review of the analysis paths: inputs
 * that are small to write but large to compute, write paths beside the
 * user's files, and text generated from names the user chose. Each case
 * must end quickly with a clear note, not hang or exhaust memory.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { checkWithFdr } from '../src/csp/check';
import { configureFdrQueue, fdrQueueState, findRefines, OUTPUT_LIMITS, runRefines } from '../src/csp/fdr';
import { includePolicy, prepareIncludes } from '../src/csp/includes';
import { loadProgram } from '../src/csp/load';
import { compile, makeSandbox } from '../src/compiler';
import { typecheckCspm } from '../src/cspm/check';
import { translateProcedure, translateProgram } from '../src/csp/translate';
import { CspmDocument } from '../src/cspm/document';
import { MAX_LAYOUT } from '../src/graph/layout';
import type { NetNode, NetworkView } from '../src/graph/network';
import { layoutOrFallback } from '../src/graph/payload';
import { formatConcurrencyMarkdown } from '../src/graph/render-markdown';
import { setBrowserMode } from '../src/mode';
import { writeGeneratedFile } from '../src/safewrite';
import { analyzeSource, INCLUDE } from './graph-helpers';
import { stopServer } from './server-process';

/** Run `fn` and fail when it takes longer than `ms` (the page's watchdog gives a request 10 s). */
function quick<T>(ms: number, fn: () => T): T {
  const started = Date.now();
  const result = fn();
  const took = Date.now() - started;
  assert.ok(took < ms, `took ${took} ms, more than ${ms} ms`);
  return result;
}

function cspmNotes(text: string): string[] {
  const doc = new CspmDocument('file:///workspace/model.csp', text);
  return doc.model([doc.defaultView()]).views.flatMap((view) => view.notes);
}

/** A language server over stdio, answering its requests to the client the way an editor would. */
class Client {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly waiting = new Map<number, (message: any) => void>();
  readonly messages: any[] = [];
  readonly child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'server.js'), '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
  readonly sent = new Set<string>();

  constructor() {
    this.child.stdout.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const end = this.buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const length = Number(/Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, end).toString())?.[1] ?? 0);
        if (this.buffer.length < end + 4 + length) return;
        const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString());
        this.buffer = this.buffer.subarray(end + 4 + length);
        if (message.id !== undefined && !message.method && this.waiting.has(message.id)) {
          this.waiting.get(message.id)!(message);
          this.waiting.delete(message.id);
        } else if (message.method) {
          this.messages.push(message);
          if (message.id !== undefined) this.send({ jsonrpc: '2.0', id: message.id, result: message.method === 'window/showDocument' ? { success: true } : null });
        }
      }
    });
  }

  request(method: string, params: unknown, timeoutMs = 20_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), timeoutMs);
      this.waiting.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async waitFor(predicate: (message: any) => boolean, timeoutMs = 20_000): Promise<any> {
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('timed out waiting for a message');
  }

  close(): Promise<void> {
    return stopServer(this);
  }

  private send(message: unknown): void {
    const body = JSON.stringify(message);
    this.sent.add((message as { method?: string }).method ?? '');
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }
}

function tempDir(t: { after(fn: () => void): void }, prefix: string): string {
  // The real path: macOS' temporary directory is reached through a link of its own.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function translated(text: string, procedure?: string) {
  const loaded = loadProgram(path.join(os.tmpdir(), 'security.pj'), INCLUDE, text);
  const input = { units: loaded.units, index: loaded.index };
  return procedure ? translateProcedure(input, procedure) : translateProgram(input);
}

// ---------------------------------------------------------------------------
// F-02, F-03: CSPm values the graph evaluates
// ---------------------------------------------------------------------------

test('F-02: a range at 2^53 ends at once, with a note that the integer is too large', () => {
  const notes = quick(2000, () => cspmNotes('MAIN = ||| i : {9007199254740992..9007199254740992} @ STOP\nassert MAIN :[deadlock free]\n'));
  assert.ok(notes.some((note) => /9007199254740992 is too large for the graph to compute with/.test(note)), notes.join('\n'));
});

test('F-02: arithmetic past the integers JavaScript holds exactly is unknown, ordinary ranges are unchanged', () => {
  const notes = quick(2000, () => cspmNotes('N = 9007199254740991 + 1\nMAIN = ||| i : {0..N} @ STOP\n'));
  assert.ok(notes.some((note) => /an integer too large for the graph to compute with/.test(note)), notes.join('\n'));
  const doc = new CspmDocument('file:///workspace/ok.csp', 'channel c : {0..2}\nP(i) = c!i -> STOP\nMAIN = ||| i : {0..2} @ P(i)\n');
  const view = doc.model([doc.defaultView()]).views[0];
  assert.deepEqual(view.nodes.filter((node) => node.label.startsWith('P(')).map((node) => node.label), ['P(0)', 'P(1)', 'P(2)']);
});

test('F-03: a sequence doubled by recursion stops at the size cap with a note', () => {
  const notes = quick(2000, () => cspmNotes('f(0) = <0>\nf(n) = let xs = f(n-1) within xs ^ xs\nchannel c\nMAIN = if length(f(29)) > 0 then STOP else c -> STOP\n'));
  assert.ok(notes.some((note) => /a sequence too long for the graph to compute/.test(note)), notes.join('\n'));
});

test('F-03: deep recursion in a value is cut off instead of overflowing the stack', () => {
  const notes = quick(2000, () => cspmNotes('f(0) = 0\nf(n) = 1 + f(n-1)\nchannel c : {0..1}\nMAIN = if f(100000) > 0 then STOP else c!0 -> STOP\n'));
  assert.ok(notes.some((note) => /recurses deeper than the graph follows/.test(note)), notes.join('\n'));
});

test('F-03: repeated set operations and membership tests are paid for by the evaluation budget', () => {
  // Quadratic before: every member() and inter() compared each pair of values.
  const notes = quick(5000, () => cspmNotes([
    'S = {0..4095}',
    'g(0) = 0',
    'g(n) = card(inter(S, S)) + (if member(n, S) then 1 else 0) + g(n-1)',
    'channel c : {0..1}',
    'MAIN = if g(400) > 0 then STOP else c!0 -> STOP',
    '',
  ].join('\n')));
  assert.ok(notes.some((note) => /evaluation budget ran out|recurses deeper/.test(note)), notes.join('\n'));
});

test('F-03: a CSPm composition of thousands of explicit operands is not drawn (nor walked recursively)', () => {
  const text = `channel c : {0..20000}\nMAIN = ${Array.from({ length: 20000 }, (_, i) => `c!${i} -> STOP`).join(' ||| ')}\n`;
  const doc = quick(5000, () => new CspmDocument('file:///workspace/wide.csp', text));
  const view = quick(5000, () => doc.model([doc.defaultView()]).views[0]);
  assert.equal(view.nodes.length, 1);
  assert.match(view.notes.join('\n'), /more than 1000 operands: it is too large to draw/);
});

// ---------------------------------------------------------------------------
// F-03: ProcessJ graphs and Convert to CSP
// ---------------------------------------------------------------------------

test('F-03: an unknown index into a billion-channel array is one unresolved use, not a billion channels', () => {
  const analyzed = quick(3000, () => analyzeSource('void bomb(int i) {\n    chan<int>[] cs = new chan<int>[1000000000];\n    cs[i].write(1);\n}\n', path.join(os.tmpdir(), 'bomb.pj')));
  const view = analyzed.model.views[0];
  assert.equal(view.channels.length, 0);
  assert.ok(view.nodes.some((node) => node.facts.some((fact) => /one of the 1000000000 channels of 'cs', too many to draw one by one/.test(fact))), JSON.stringify(view.nodes.map((node) => node.facts)));
});

test('F-03: a view with thousands of explicit par branches is not built past the hard limit', () => {
  const text = `void main() {\n    par {\n${'        skip;\n'.repeat(3000)}    }\n}\n`;
  const analyzed = quick(5000, () => analyzeSource(text, path.join(os.tmpdir(), 'many.pj')));
  const view = analyzed.model.views[0];
  assert.equal(view.nodes.length, 1);
  assert.match(view.notes.join('\n'), /more than 1000 processes even with no call expanded: it is too large to draw/);
});

test('F-03: a view too large for the layout engine gets the plain arrangement and a note', async () => {
  const nodes: NetNode[] = [{ id: 'root', kind: 'group', label: 'main', name: 'main', confidence: 'exact', facts: [], operations: [] }];
  for (let i = 0; i <= MAX_LAYOUT.nodes; i++) nodes.push({ id: `p${i}`, parent: 'root', kind: 'process', label: `p${i}`, name: `p${i}`, confidence: 'exact', facts: [], operations: [] });
  const view: NetworkView = { id: 'view:program', kind: 'program', procedure: 'main', label: 'main (whole program)', source: { uri: 'file:///workspace/big.pj', span: { start: { line: 0, col: 0 }, end: { line: 0, col: 4 } } }, nodes, edges: [], channels: [], notes: [], instances: [] };
  const notes: string[] = [];
  const started = Date.now();
  const layout = await layoutOrFallback(view, notes);
  assert.ok(Date.now() - started < 2000);
  assert.ok(layout.nodes.p0, 'every box is placed');
  assert.match(notes.join('\n'), /too large to lay out/);
  assert.match(view.notes.join('\n'), /too large to lay out/);
});

test('F-03: a computed par for bound is checked against the process limit before its iterations are built', () => {
  const model = quick(3000, () => translated('//@csp int 0..1000000000\nvoid worker(int n) {\n    par for (int i = 0; i < n; i++) skip;\n}\nvoid main() { worker(1000000000); }\n'));
  assert.match(model.unsupported.map((u) => u.message).join('\n'), /more than 2000 processes/);
});

test('F-03: a procedure checked on its own does not enumerate a huge integer range for its arguments', () => {
  const model = quick(3000, () => translated('//@csp int 0..1000000000\nvoid worker(int n) {\n    par for (int i = 0; i < n; i++) skip;\n}\n', 'worker'));
  assert.match(model.unsupported.map((u) => u.message).join('\n'), /too many instances to check/);
});

test('F-03: a huge channel array is not modelled, and //@csp int bounds must be exact integers', () => {
  const arrays = quick(3000, () => translated('//@csp int 0..1000000000\nvoid main() {\n    chan<int>[] cs = new chan<int>[100000000];\n    par { cs[0].write(1); int x = cs[0].read(); }\n}\n'));
  assert.match(arrays.unsupported.map((u) => u.message).join('\n'), /'cs' has 100000000 channels, more than the model lays out/);
  const range = translated('//@csp int 0..99999999999999999999\nvoid main() { skip; }\n');
  assert.match(range.warnings.map((w) => w.message).join('\n'), /has a bound too large to model; ignored/);
});

// ---------------------------------------------------------------------------
// F-05: names in generated comments
// ---------------------------------------------------------------------------

test('F-05: a file name with line breaks cannot add statements to the generated model', () => {
  const file = path.join(os.tmpdir(), 'evil\ninclude "secret.csp"\r\n--\u2028x.pj');
  const text = 'void main() {\n    chan<int> c;\n    par { c.write(1); int x = c.read(); }\n}\n/*@csp\nassert MAIN :[deadlock free]\n*/\n';
  const loaded = loadProgram(file, INCLUDE, text);
  const model = translateProgram({ units: loaded.units, index: loaded.index });
  assert.equal(model.unsupported.length, 0, model.unsupported.map((u) => u.message).join('\n'));
  const lines = model.text.split(/\r\n|\r|\n|\u2028|\u2029/);
  assert.ok(lines.some((line) => line.startsWith('-- Generated by processj-lsp from evil include "secret.csp" --')), model.text.slice(0, 300));
  for (const line of lines.filter((entry) => entry.includes('secret.csp'))) assert.match(line, /^\s*--/, `outside a comment: ${line}`);
  assert.ok(!/^\s*include\b/m.test(model.text));
});

// ---------------------------------------------------------------------------
// F-09: Markdown reports
// ---------------------------------------------------------------------------

test('F-09: names and notes in the Markdown report are text, not HTML, links or code fences', () => {
  const analyzed = analyzeSource('void main() {\n    chan<int> c;\n    par { c.write(1); int x = c.read(); }\n}\n', path.join(os.tmpdir(), 'report.pj'));
  const view = analyzed.model.views[0];
  view.notes.push('see [this](javascript:alert(1)) <script>alert(1)</script>');
  const node = view.nodes.find((entry) => entry.kind === 'process' && entry.parent)!;
  node.name = '**bold** `tick`';
  node.label = 'x\n```\n<img src=x onerror=alert(1)>';
  const markdown = formatConcurrencyMarkdown('<img src=x onerror=alert(1)>.pj', analyzed.model);
  assert.match(markdown, /^# Process network — \\<img src=x onerror=alert\(1\)\\>\.pj$/m);
  // Raw `<` only inside the code span of the label, where it is shown as written.
  assert.match(markdown, /`{4} x `{3} <img src=x onerror=alert\(1\)> `{4}/);
  assert.ok(!/<img|<script/.test(markdown.replace(/`{4} .*? `{4}/g, '').replace(/\\</g, '')), markdown);
  assert.match(markdown, /- see \\\[this\\\]\(javascript:alert\(1\)\) \\<script\\>/);
  assert.match(markdown, /\*\*\\\*\\\*bold\\\*\\\* \\`tick\\`\*\*/);
  // The label stays inside its code span and the chart inside its fence: one fence opens it, one closes it.
  assert.equal(markdown.split('\n').filter((line) => line.startsWith('```')).length, 2, markdown);
});

// ---------------------------------------------------------------------------
// F-06: files written beside the source
// ---------------------------------------------------------------------------

const OURS = (head: string): boolean => head.startsWith('-- Generated by processj-lsp from ');

test('F-06: a generated file is never written through a symbolic link, dangling or not', (t) => {
  const dir = tempDir(t, 'pj-safewrite-');
  const outside = path.join(dir, 'outside');
  fs.mkdirSync(outside);
  // Dangling: following it would create a file elsewhere.
  fs.symlinkSync(path.join(outside, 'created'), path.join(dir, 'a.csp'));
  assert.deepEqual(writeGeneratedFile(path.join(dir, 'a.csp'), '-- Generated by processj-lsp from a.pj.\n', OURS), { written: false, reason: 'it is a symbolic link' });
  assert.ok(!fs.existsSync(path.join(outside, 'created')));
  // To a file that even looks generated: left alone too.
  fs.writeFileSync(path.join(outside, 'victim'), '-- Generated by processj-lsp from x.pj.\nsecret\n');
  fs.symlinkSync(path.join(outside, 'victim'), path.join(dir, 'b.csp'));
  assert.equal(writeGeneratedFile(path.join(dir, 'b.csp'), 'replaced', OURS).written, false);
  assert.equal(fs.readFileSync(path.join(outside, 'victim'), 'utf8'), '-- Generated by processj-lsp from x.pj.\nsecret\n');
  // A new name is created, a generated file replaced, a file the user wrote kept.
  assert.deepEqual(writeGeneratedFile(path.join(dir, 'c.csp'), '-- Generated by processj-lsp from c.pj. one\n', OURS), { written: true });
  assert.deepEqual(writeGeneratedFile(path.join(dir, 'c.csp'), '-- Generated by processj-lsp from c.pj. two\n', OURS), { written: true });
  assert.equal(fs.readFileSync(path.join(dir, 'c.csp'), 'utf8'), '-- Generated by processj-lsp from c.pj. two\n');
  fs.writeFileSync(path.join(dir, 'd.csp'), '-- my own model\n');
  assert.deepEqual(writeGeneratedFile(path.join(dir, 'd.csp'), 'replaced', OURS), { written: false, reason: 'it was not written by processj-lsp' });
  assert.equal(fs.readFileSync(path.join(dir, 'd.csp'), 'utf8'), '-- my own model\n');
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left');
});

test('F-06: Convert to CSP and graph exports do not follow links the workspace put in their place', async (t) => {
  const dir = tempDir(t, 'pj-convert-links-');
  const outside = tempDir(t, 'pj-convert-outside-');
  const file = path.join(dir, 'demo.pj');
  fs.writeFileSync(file, 'void main() {\n    chan<int> c;\n    par { c.write(1); int x = c.read(); }\n}\n');
  fs.symlinkSync(path.join(outside, 'newfile'), path.join(dir, 'demo.csp'));
  fs.symlinkSync(path.join(outside, 'graph.svg'), path.join(dir, 'demo.graph.svg'));
  const client = new Client();
  t.after(() => client.close());
  const uri = pathToFileURL(file).toString();
  await client.request('initialize', { processId: process.pid, rootUri: pathToFileURL(dir).toString(), capabilities: { window: { showDocument: { support: true } } }, initializationOptions: { installDir: path.join(dir, 'no-processj'), fdrPath: path.join(dir, 'no-fdr') } });
  client.notify('initialized', {});
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'processj', version: 1, text: fs.readFileSync(file, 'utf8') } });
  const converted = await client.request('workspace/executeCommand', { command: 'processj.convertToCsp', arguments: [uri] });
  assert.equal(converted.error, undefined);
  assert.notEqual(converted.result.cspFile, path.join(dir, 'demo.csp'), 'the model goes to the private report directory');
  assert.ok(client.messages.some((m) => m.method === 'window/showMessage' && /could not write .*demo\.csp \(it is a symbolic link\)/.test(m.params.message)));
  const exported = await client.request('workspace/executeCommand', { command: 'processj.exportConcurrencyGraph', arguments: [uri, 'svg'] });
  assert.equal(exported.error, undefined);
  assert.deepEqual(exported.result.written, []);
  assert.deepEqual(exported.result.refused, [path.join(dir, 'demo.graph.svg')]);
  assert.deepEqual(fs.readdirSync(outside), [], 'nothing was created outside the workspace');
  assert.ok(fs.lstatSync(path.join(dir, 'demo.csp')).isSymbolicLink());
});

// ---------------------------------------------------------------------------
// F-04: what FDR may include
// ---------------------------------------------------------------------------

/** A workspace with a model in `sub/`, files around it, and a private file outside it. */
function includeWorkspace(t: { after(fn: () => void): void }) {
  const root = tempDir(t, 'pj-includes-');
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'private');
  fs.mkdirSync(path.join(workspace, 'sub'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'spec.csp'), 'SECRET = STOP\n');
  fs.writeFileSync(path.join(workspace, 'common.csp'), 'include "sub/leaf.csp"\nCOMMON = STOP\n');
  fs.writeFileSync(path.join(workspace, 'sub', 'leaf.csp'), 'include "../common.csp"\nLEAF = STOP\n');
  return { root, workspace, outside, base: path.join(workspace, 'sub') };
}

test('F-04: includes inside the workspace are followed (cycles once) and made absolute for the copy FDR runs', (t) => {
  const { workspace, base } = includeWorkspace(t);
  const prepared = prepareIncludes('include "../common.csp"\nMAIN = STOP\n', base, includePolicy([workspace], base));
  assert.deepEqual(prepared.problems, []);
  assert.equal(prepared.text, `include "${path.join(workspace, 'common.csp').split(path.sep).join('/')}"\nMAIN = STOP\n`);
  assert.deepEqual(prepared.files.map((file) => file.relative), ['../common.csp', 'leaf.csp']);
});

test('F-04: an include out of the workspace, by .. or through a symbolic link, is refused, also from an included file', (t) => {
  const { workspace, outside, base } = includeWorkspace(t);
  const policy = includePolicy([workspace], base);
  const escaping = prepareIncludes('include "../../private/spec.csp"\n', base, policy);
  assert.match(escaping.problems[0]?.message ?? '', /include "\.\.\/\.\.\/private\/spec\.csp" is refused: it is outside the workspace/);
  assert.deepEqual(escaping.problems[0].span, { start: { line: 0, col: 8 }, end: { line: 0, col: 32 } });
  fs.symlinkSync(path.join(outside, 'spec.csp'), path.join(base, 'spec.csp'));
  assert.match(prepareIncludes('include "spec.csp"\n', base, policy).problems[0]?.message ?? '', /symbolic link to a file outside the workspace/);
  fs.symlinkSync(outside, path.join(workspace, 'linked'));
  assert.match(prepareIncludes(`include "${path.join(workspace, 'linked', 'spec.csp')}"\n`, base, policy).problems[0]?.message ?? '', /symbolic link to a file outside the workspace/);
  fs.writeFileSync(path.join(base, 'nested.csp'), '-- a comment\n  include "../../private/spec.csp"\n');
  const nested = prepareIncludes('MAIN = STOP\ninclude "nested.csp"\n', base, policy);
  assert.match(nested.problems[0]?.message ?? '', /include "\.\.\/\.\.\/private\/spec\.csp" in nested\.csp is refused: it is outside the workspace/);
  assert.equal(nested.problems[0].span.start.line, 1, 'placed on the include that leads there');
  // An include in a comment is not one; one after a comment on its line is.
  assert.deepEqual(prepareIncludes('-- include "../../private/spec.csp"\n', base, policy).problems, []);
  assert.equal(prepareIncludes('{- x -} include "../../private/spec.csp"\n', base, policy).problems.length, 1);
});

test('F-04: an absolute include outside the workspace is kept for a local editor and refused in the browser', (t) => {
  const { workspace, outside, base } = includeWorkspace(t);
  const text = `include "${path.join(outside, 'spec.csp')}"\n`;
  assert.deepEqual(prepareIncludes(text, base, includePolicy([workspace], base)).problems, []);
  setBrowserMode({ remoteFdr: true });
  try {
    const browser = prepareIncludes(text, base, includePolicy([workspace], base));
    assert.match(browser.problems[0]?.message ?? '', /must name a file of the project, relative to the including file/);
    // In the browser the model keeps its relative includes: the runner resolves them among the project's files.
    const relative = prepareIncludes('include "../common.csp"\n', base, includePolicy([workspace], base));
    assert.equal(relative.text, 'include "../common.csp"\n');
    assert.deepEqual(relative.files.map((file) => file.relative), ['../common.csp', 'leaf.csp']);
  } finally {
    setBrowserMode(undefined);
  }
});

test('F-04: Check with FDR is not run on a /*@csp block that includes a file outside the workspace', async (t) => {
  const { workspace } = includeWorkspace(t);
  const file = path.join(workspace, 'prog.pj');
  const text = '/*@csp\ninclude "../private/spec.csp"\n*/\nvoid main() { skip; }\n';
  const loaded = loadProgram(file, INCLUDE, text);
  // refines is never started: the include is refused first.
  const result = await checkWithFdr({ units: loaded.units, index: loaded.index, uri: pathToFileURL(file).toString(), refines: path.join(workspace, 'no-refines'), includeRoots: [workspace] });
  assert.equal(result.rawResults, undefined);
  assert.ok(result.report.checks.length > 0);
  for (const check of result.report.checks) assert.match(check.message ?? '', /FDR was not run: include "\.\.\/private\/spec\.csp" is refused: it is outside the workspace/);
});

test('F-04: FDR\'s type check of a .csp file reports a refused include at the include, without running FDR', async (t) => {
  const { workspace } = includeWorkspace(t);
  const uri = pathToFileURL(path.join(workspace, 'model.csp')).toString();
  const doc = new CspmDocument(uri, 'channel c\ninclude "../private/spec.csp"\nMAIN = c -> STOP\n');
  const errors = await typecheckCspm(doc, path.join(workspace, 'no-refines'), { includeRoots: [workspace] });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /refused: it is outside the workspace/);
  assert.equal(errors[0].span?.start.line, 1);
});

const REFINES = findRefines();

test('F-04: the server shows a refused include of a .csp file as a diagnostic', { skip: !REFINES && 'FDR (refines) is not installed' }, async (t) => {
  const { workspace } = includeWorkspace(t);
  const file = path.join(workspace, 'model.csp');
  const text = 'channel c\ninclude "../private/spec.csp"\nMAIN = c -> STOP\nassert MAIN :[deadlock free]\n';
  fs.writeFileSync(file, text);
  const client = new Client();
  t.after(() => client.close());
  const uri = pathToFileURL(file).toString();
  await client.request('initialize', { processId: process.pid, rootUri: pathToFileURL(workspace).toString(), capabilities: {}, initializationOptions: { installDir: path.join(workspace, 'no-processj'), fdrPath: REFINES } });
  client.notify('initialized', {});
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'csp', version: 1, text } });
  const published = await client.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri && m.params.diagnostics.some((d: any) => /refused/.test(d.message)));
  const refused = published.params.diagnostics.find((d: any) => /refused/.test(d.message));
  assert.equal(refused.range.start.line, 1);
});

// ---------------------------------------------------------------------------
// F-07: FDR runs, together
// ---------------------------------------------------------------------------

/** An executable standing in for refines. */
function fakeRefines(dir: string, script: string): string {
  const file = path.join(dir, 'refines');
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return file;
}

test('F-07: every FDR run of the process waits in one bounded queue, and is turned away past it', { skip: process.platform === 'win32' && 'POSIX shell script' }, async (t) => {
  const dir = tempDir(t, 'pj-fdr-queue-');
  const refines = fakeRefines(dir, 'sleep 0.4\necho \'{"results":[]}\'');
  const model = path.join(dir, 'model.csp');
  fs.writeFileSync(model, 'MAIN = STOP\n');
  configureFdrQueue({ concurrency: 2, waiting: 2 });
  t.after(() => configureFdrQueue({ concurrency: 2, waiting: 16 }));
  const cancelled = new AbortController();
  const runs = [runRefines(refines, model), runRefines(refines, model), runRefines(refines, model), runRefines(refines, model, { signal: cancelled.signal })];
  assert.deepEqual(fdrQueueState(), { running: 2, waiting: 2 });
  const turnedAway = await runRefines(refines, model);
  assert.match(turnedAway.busy ?? '', /^FDR is busy: 2 checks are running and 2 are waiting/);
  // A run cancelled while it waits leaves the queue at once, without starting refines.
  cancelled.abort();
  const stopped = await runs[3];
  assert.equal(stopped.aborted, true);
  assert.equal(stopped.durationMs, 0);
  assert.deepEqual(fdrQueueState(), { running: 2, waiting: 1 });
  const done = await Promise.all(runs.slice(0, 3));
  assert.deepEqual(done.map((run) => [run.exitCode, run.aborted, run.busy]), [[0, false, undefined], [0, false, undefined], [0, false, undefined]]);
  assert.deepEqual(fdrQueueState(), { running: 0, waiting: 0 });
});

test('F-07: refines is stopped when one line of its output passes the limit, before it is held in memory', { skip: process.platform === 'win32' && 'POSIX shell script' }, async (t) => {
  const dir = tempDir(t, 'pj-fdr-frame-');
  // One line, never ended, longer than a line may be; then it would wait for good.
  const refines = fakeRefines(dir, `head -c ${OUTPUT_LIMITS.line + 1_000_000} /dev/zero | tr '\\0' x\nsleep 30`);
  const model = path.join(dir, 'model.csp');
  fs.writeFileSync(model, 'MAIN = STOP\n');
  const started = Date.now();
  const run = await runRefines(refines, model, { timeoutMs: 60_000 });
  assert.ok(Date.now() - started < 15_000, `took ${Date.now() - started} ms`);
  assert.ok((run.outputExceeded ?? 0) > OUTPUT_LIMITS.line, JSON.stringify({ outputExceeded: run.outputExceeded, aborted: run.aborted }));
  assert.equal(run.aborted, false);
  assert.equal(run.timedOut, false);
});

// ---------------------------------------------------------------------------
// F-01: the compiler's working directory
// ---------------------------------------------------------------------------

const NO_INSTALL = { installDir: '/nonexistent', includeDir: '/nonexistent/include', javaBin: '/nonexistent/java', classpath: '' };

/** Every entry under `dir`, relative, with what it is (links are not followed). */
function tree(dir: string, relative = ''): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(path.join(dir, relative)).sort()) {
    const entry = path.join(relative, name);
    const stat = fs.lstatSync(path.join(dir, entry));
    out.push(`${entry.split(path.sep).join('/')}${stat.isSymbolicLink() ? ' -> link' : stat.isDirectory() ? '/' : ''}`);
    if (stat.isDirectory()) out.push(...tree(dir, entry));
  }
  return out;
}

test('F-01: the sandbox holds read-only copies of the imported files, and no link out of it', (t) => {
  const root = tempDir(t, 'pj-sandbox-');
  const project = path.join(root, 'project');
  const outside = path.join(root, 'outside');
  const packages = path.join(root, 'packages');
  for (const dir of [project, outside, path.join(project, 'geom'), path.join(project, 'lib', 'sub'), path.join(project, 'Blah._'), path.join(project, 'unrelated'), path.join(packages, 'pkg')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(outside, 'important.txt'), 'keep me\n');
  // The review's layout: a directory the compiler's library output path goes through, and a link to a user file.
  fs.writeFileSync(path.join(project, 'Blah._', 'keep.txt'), 'x\n');
  fs.symlinkSync(path.join(outside, 'important.txt'), path.join(project, 'victim.h'));
  fs.writeFileSync(path.join(project, 'util.pj'), 'import geom.shapes;\npublic void util() { }\n');
  fs.writeFileSync(path.join(project, 'geom', 'shapes.pj'), 'public void shape() { }\n');
  fs.writeFileSync(path.join(project, 'lib', 'a.pj'), 'public void a() { }\n');
  fs.writeFileSync(path.join(project, 'lib', 'sub', 'b.pj'), 'public void b() { }\n');
  fs.writeFileSync(path.join(project, 'unrelated', 'c.pj'), 'public void c() { }\n');
  fs.writeFileSync(path.join(project, 'other.pj'), 'public void other() { }\n');
  fs.writeFileSync(path.join(packages, 'pkg', 'x.pj'), 'public void x() { }\n');
  const text = 'import util;\nimport lib.*;\nimport pkg.x;\npublic void main(string[] args) { }\n';
  const sandbox = makeSandbox(NO_INSTALL, path.join(project, 'main.pj'), text, undefined, [{ name: 'pkg', target: path.join(packages, 'pkg') }]);
  t.after(() => sandbox.cleanup());
  assert.equal(sandbox.refused, undefined);
  assert.deepEqual(tree(sandbox.root).filter((entry) => !entry.startsWith('.pjlsp-home')), [
    'geom/', 'geom/shapes.pj',
    'lib/', 'lib/a.pj', 'lib/sub/', 'lib/sub/b.pj',
    'main.pj',
    'pkg/', 'pkg/x.pj',
    'util.pj',
  ]);
  assert.equal(fs.readFileSync(path.join(sandbox.root, 'geom', 'shapes.pj'), 'utf8'), 'public void shape() { }\n');
  assert.equal(fs.statSync(path.join(sandbox.root, 'util.pj')).mode & 0o222, 0, 'the copies are read-only');
  assert.equal(fs.readFileSync(path.join(outside, 'important.txt'), 'utf8'), 'keep me\n');
});

test('F-01: a #pragma FILE that is a path, in the file or in an import, keeps the compiler from running', async (t) => {
  const project = tempDir(t, 'pj-pragma-');
  const library = '#pragma LIBRARY;\n#pragma LANGUAGE "C";\n#pragma NATIVELIB "math.h";\n#pragma FILE "/../victim";\npackage p;\n';
  const own = makeSandbox(NO_INSTALL, path.join(project, 'attack.pj'), library);
  t.after(() => own.cleanup());
  assert.match(own.refused?.message ?? '', /#pragma FILE "\/\.\.\/victim" is not a plain file name/);
  assert.equal(own.refused?.line, 3);
  fs.writeFileSync(path.join(project, 'evil.pj'), library);
  const imported = makeSandbox(NO_INSTALL, path.join(project, 'main.pj'), 'import evil;\npublic void main(string[] args) { }\n');
  t.after(() => imported.cleanup());
  assert.equal(imported.refused?.file, path.join(project, 'evil.pj'));
  const plain = makeSandbox(NO_INSTALL, path.join(project, 'io.pj'), '#pragma LIBRARY;\n#pragma NATIVE;\n#pragma FILE "io";\n#pragma LANGUAGE "JVM";\npackage std;\n');
  t.after(() => plain.cleanup());
  assert.equal(plain.refused, undefined);
  // compile() does not start the compiler at all (the java given here does not exist).
  const result = await compile(NO_INSTALL, path.join(project, 'attack.pj'), library);
  assert.equal(result.refused?.line, 3);
  assert.equal(result.stderr, '');
});

test('F-01: the server runs the compiler unasked only on files inside the workspace', { skip: process.platform === 'win32' && 'POSIX shell script' }, async (t) => {
  const root = tempDir(t, 'pj-compile-roots-');
  const workspace = path.join(root, 'workspace');
  const elsewhere = path.join(root, 'downloads');
  const install = path.join(root, 'processj');
  for (const dir of [workspace, elsewhere, path.join(install, 'bin'), path.join(install, 'resources', 'jars')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(install, 'bin', 'ProcessJc.class'), '');
  for (const jar of ['java_cup_runtime.jar', 'ST-4.0.7.jar', 'asm-all-5.2.jar']) fs.writeFileSync(path.join(install, 'resources', 'jars', jar), '');
  // A java that only says which file it was asked to compile.
  const log = path.join(root, 'java.log');
  const java = path.join(root, 'java');
  fs.writeFileSync(java, `#!/bin/sh\nfor last; do :; done\necho "$last" >> ${JSON.stringify(log)}\n`, { mode: 0o755 });
  const client = new Client();
  t.after(() => client.close());
  await client.request('initialize', { processId: process.pid, rootUri: pathToFileURL(workspace).toString(), capabilities: {}, initializationOptions: { installDir: install, javaBin: java } });
  client.notify('initialized', {});
  const source = 'public void main(string[] args) { }\n';
  const open = (file: string): string => {
    fs.writeFileSync(file, source);
    const uri = pathToFileURL(file).toString();
    client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'processj', version: 1, text: source } });
    return uri;
  };
  const outsideUri = open(path.join(elsewhere, 'downloaded.pj'));
  const insideUri = open(path.join(workspace, 'mine.pj'));
  await client.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === outsideUri);
  for (const deadline = Date.now() + 10_000; !fs.existsSync(log) && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 20));
  await client.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === insideUri);
  // The outside file was opened first; give a compiler run for it every chance to show up.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(fs.readFileSync(log, 'utf8').trim().split('\n'), ['mine.pj']);
});
