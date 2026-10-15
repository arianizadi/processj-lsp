/**
 * CSPm documents through the language server: it attaches to them (language
 * id `cspm`, Neovim's `csp`, or a .csp file), runs no ProcessJ analysis on
 * them, publishes its own parse diagnostics, serves the graph, and checks the
 * file's own assertions with FDR (replayed from the recordings).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { replayingRefines } from './fdr-recordings';
import { stopServer } from './server-process';

const ROOT = path.join(__dirname, '..', '..');
const SKIP = process.platform === 'win32' && 'the replayed refines is a shell script';

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

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

  request(method: string, params: unknown, timeoutMs = 15_000): Promise<any> {
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

  async waitFor(predicate: (message: any) => boolean, timeoutMs = 10_000): Promise<any> {
    for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
      const found = this.messages.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('timed out waiting for a message from the server');
  }

  close(): Promise<void> {
    return stopServer(this);
  }

  private send(message: unknown): void {
    const { method } = message as { method?: string };
    if (method === 'shutdown' || method === 'exit') this.sent.add(method);
    const json = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  }
}

async function start(fdrPath?: (dir: string) => string): Promise<{ client: Client; dir: string; close(): Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-cspm-lsp-'));
  const client = new Client();
  await client.request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(dir).toString(),
    capabilities: { window: { showDocument: { support: true } }, workspace: { codeLens: { refreshSupport: true } }, textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
    initializationOptions: { installDir: path.join(dir, 'no-processj'), fdrPath: fdrPath ? fdrPath(dir) : path.join(dir, 'no-fdr', 'refines') },
  });
  client.notify('initialized', {});
  return {
    client,
    dir,
    close: async () => {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function open(client: Client, dir: string, name: string, languageId: string, text = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'cspm', name), 'utf8')): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  const uri = pathToFileURL(file).toString();
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
  return uri;
}

test('a CSPm document gets no ProcessJ analysis: only its own diagnostics, symbols and the graph', async () => {
  const { client, dir, close } = await start();
  try {
    // Neovim's filetype for *.csp is `csp`; VS Code's language is `cspm`; an unknown id with the extension works too.
    const broken = 'channel a, b\nP = a -> b -> P\nQ = a -> \nR = P [| {a} |] P\nassert R :[deadlock free]\n';
    for (const [name, languageId] of [['nvim.csp', 'csp'], ['vscode.csp', 'cspm'], ['plain.csp', 'plaintext']]) {
      const uri = open(client, dir, name, languageId, broken);
      const published = await client.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri);
      // ProcessJ would report a syntax error on line 1; the CSPm parser reports the unfinished prefix on line 3 only.
      assert.deepEqual(published.params.diagnostics.map((d: any) => `${d.range.start.line}:${d.source}:${d.message}`), ['2:processj-lsp (CSPm):this declaration ends too early'], languageId);
      const completion = await client.request('textDocument/completion', { textDocument: { uri }, position: { line: 1, character: 2 } });
      assert.ok(!completion.result || (Array.isArray(completion.result) ? completion.result : completion.result.items).length === 0, 'no ProcessJ completion');
      const formatting = await client.request('textDocument/formatting', { textDocument: { uri }, options: { tabSize: 4, insertSpaces: true } });
      assert.deepEqual(formatting.result ?? [], []);
      const tokens = await client.request('textDocument/semanticTokens/full', { textDocument: { uri } });
      assert.deepEqual(tokens.result?.data ?? [], []);
      const symbols = await client.request('textDocument/documentSymbol', { textDocument: { uri } });
      assert.deepEqual(symbols.result.map((s: any) => s.name), ['a', 'b', 'P', 'R', 'assert R :[deadlock free]']);
    }
    // ProcessJ-only commands say so, and do nothing.
    const uri = pathToFileURL(path.join(dir, 'vscode.csp')).toString();
    await client.request('workspace/executeCommand', { command: 'processj.run', arguments: [uri] });
    await client.waitFor((m) => m.method === 'window/showMessage' && /for ProcessJ files/.test(m.params.message));
    // FDR is not installed: the check says how to get it.
    await client.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [uri] });
    await client.waitFor((m) => m.method === 'window/showMessage' && /refines was not found/.test(m.params.message));
    // The missing ProcessJ install concerns ProcessJ files only: said when the first one opens.
    assert.ok(!client.messages.some((m) => m.method === 'window/showMessage' && /No ProcessJ install/.test(m.params.message)), 'no ProcessJ warning for .csp files');
    // (An install found through ~/processjrc or PROCESSJ_HOME has nothing to warn about.)
    const found = client.messages.some((m) => m.method === 'window/logMessage' && /^ProcessJ install: /.test(m.params.message));
    open(client, dir, 'main.pj', 'processj', 'public void main() {}\n');
    if (!found) await client.waitFor((m) => m.method === 'window/showMessage' && /No ProcessJ install/.test(m.params.message));
    assert.ok(!client.messages.some((m) => m.method === 'window/showMessageRequest'), 'messages are notifications (eglot)');
  } finally {
    await close();
  }
});

test('the graph of a CSPm file: the live page, its payload, and the exports next to the file', async () => {
  const { client, dir, close } = await start();
  try {
    const uri = open(client, dir, 'dining.csp', 'csp');
    await client.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri);
    const shown = await client.request('workspace/executeCommand', { command: 'processj.showConcurrencyReport', arguments: [uri] });
    const url = shown.result as string;
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\//);
    const payload = JSON.parse((await get(`${url}payload`)).body);
    assert.equal(payload.language, 'cspm');
    assert.equal(payload.defaultView, 'view:SYSTEM');
    assert.deepEqual(payload.views.map((view: any) => `${view.label}:${view.section}`), ['SYSTEM:Asserted', 'PHILOSOPHERS:Defined', 'FORKS:Defined']);
    const system = payload.views.find((view: any) => view.id === 'view:SYSTEM');
    assert.equal(system.nodes.filter((node: any) => node.kind === 'process').length, 6);
    assert.ok(system.nodes.every((node: any) => node.machine === undefined), 'no state machines of the translator for a CSPm file');
    assert.deepEqual(payload.chips, []);
    // The VS Code panel's request is answered the same way.
    const panel = await client.request('processj/processNetwork', { textDocument: { uri }, html: false });
    assert.equal(panel.result.payload.language, 'cspm');
    // Exports are named after the .csp file, so a generated model's never replaces its .pj's.
    const exported = await client.request('workspace/executeCommand', { command: 'processj.exportConcurrencyGraph', arguments: [uri, 'svg'] });
    assert.deepEqual(exported.result.written, [path.join(dir, 'dining.csp.graph.svg')]);
    assert.match(fs.readFileSync(path.join(dir, 'dining.csp.graph.svg'), 'utf8'), /PHIL\(0\)/);
    // A model Convert to CSP generated links back to its ProcessJ source.
    fs.writeFileSync(path.join(dir, 'par_deadlock.pj'), fs.readFileSync(path.join(ROOT, 'examples', 'par_deadlock.pj'), 'utf8'));
    const generated = open(client, dir, 'par_deadlock.csp', 'csp');
    const page = await client.request('workspace/executeCommand', { command: 'processj.showConcurrencyReport', arguments: [generated] });
    await client.waitFor((m) => m.method === 'window/showMessage' && /par_deadlock\.csp was generated from par_deadlock\.pj/.test(m.params.message));
    const related = JSON.parse((await get(`${page.result}payload`)).body).related;
    assert.equal(related.label, 'par_deadlock.pj');
    assert.equal(related.uri, pathToFileURL(path.join(dir, 'par_deadlock.pj')).toString());
  } finally {
    await close();
  }
});

test('Check with FDR on a CSPm file: its own assertions, on the graph, as diagnostics and lenses', { skip: SKIP }, async () => {
  const { client, dir, close } = await start(replayingRefines);
  try {
    const uri = open(client, dir, 'dining.csp', 'cspm');
    await client.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri);
    const lenses = await client.request('textDocument/codeLens', { textDocument: { uri } });
    assert.deepEqual(lenses.result.map((lens: any) => `${lens.range.start.line}:${lens.command.title}`), ['20:Process network', '22:FDR: check & show graph']);
    const result = await client.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [uri] });
    assert.equal(result.result.report.producer, 'fdr');
    assert.deepEqual(result.result.report.checks.map((check: any) => `${check.label}:${check.status}`), ['SYSTEM :[deadlock free [F]]:failed']);
    // The failure opens the graph on it.
    const page = await client.waitFor((m) => m.method === 'window/showDocument' && m.params.external === true && /check=line\+23/.test(m.params.uri));
    const payload = JSON.parse((await get(page.params.uri.replace(/\?.*$/, 'payload'))).body);
    assert.equal(payload.chips[0].text, 'deadlock after 6 steps');
    assert.equal(payload.chips[0].targetLabel, undefined);
    assert.equal(payload.overlays[0].cycles.length, 1);
    assert.deepEqual(payload.overlays[0].unplaced, []);
    // Diagnostics: the assertion, and where the processes are stuck.
    const diagnostics = await client.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri && m.params.diagnostics.some((d: any) => d.source === 'FDR' && /does not hold/.test(d.message)));
    assert.deepEqual(diagnostics.params.diagnostics.map((d: any) => `${d.range.start.line}:${d.severity}`), ['22:1', '10:3', '14:3']);
    await client.waitFor((m) => m.method === 'window/showMessage' && /^FDR, dining\.csp: 0 of 1 assertion holds; SYSTEM :\[deadlock free \[F\]\]: deadlock after 6 steps/.test(m.params.message));
    const after = await client.request('textDocument/codeLens', { textDocument: { uri } });
    assert.deepEqual(after.result.map((lens: any) => lens.command.title), ['Process network', 'FDR: deadlock after 6 steps · show graph']);
    // An edit takes the result back.
    client.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: `${fs.readFileSync(path.join(dir, 'dining.csp'), 'utf8')}\n` }] });
    await client.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri && m.params.version === 2 && !m.params.diagnostics.some((d: any) => d.source === 'FDR' && /does not hold/.test(d.message)));
    const stale = JSON.parse((await get(page.params.uri.replace(/\?.*$/, 'payload'))).body);
    assert.deepEqual(stale.chips, []);
  } finally {
    await close();
  }
});
