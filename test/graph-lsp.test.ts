import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { stopServer } from './server-process';

interface Message {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

/** A minimal LSP client that answers the server's own requests from `answers`. */
class Client {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly waiting = new Map<number, (message: Message) => void>();
  readonly received: Message[] = [];
  readonly child: ChildProcessWithoutNullStreams;
  readonly sent = new Set<string>();

  constructor(server: string, private readonly answers: Record<string, (params: any) => unknown>) {
    this.child = spawn(process.execPath, [server, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
  }

  request(method: string, params: unknown): Promise<Message> {
    const id = this.nextId++;
    const done = new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 15_000);
      this.waiting.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    this.send({ jsonrpc: '2.0', id, method, params });
    return done;
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async waitFor(method: string, predicate: (message: Message) => boolean = () => true): Promise<Message> {
    for (const deadline = Date.now() + 10_000; Date.now() < deadline;) {
      const index = this.received.findIndex((message) => message.method === method && predicate(message));
      if (index >= 0) return this.received.splice(index, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${method}`);
  }

  /** Shut the server down and wait for it to exit, as an editor does (it removes its reports and sandboxes on the way out). */
  close(): Promise<void> {
    return stopServer(this);
  }

  private send(message: unknown): void {
    const { method } = message as Message;
    if (method === 'shutdown' || method === 'exit') this.sent.add(method);
    const json = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const length = Number(/Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, end).toString())?.[1] ?? 0);
      if (this.buffer.length < end + 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString()) as Message;
      this.buffer = this.buffer.subarray(end + 4 + length);
      if (message.id !== undefined && !message.method) {
        this.waiting.get(message.id)?.(message);
        this.waiting.delete(message.id);
      } else if (message.id !== undefined && message.method) {
        this.received.push(message);
        const answer = this.answers[message.method];
        this.send({ jsonrpc: '2.0', id: message.id, result: answer ? answer(message.params) : null });
      } else this.received.push(message);
    }
  }
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http.get(url, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

const CROSSED = [
  'public void main(string[] args) {',
  '    chan<int> c;',
  '    chan<int> d;',
  '    par {',
  '        { c.write(1); int x = d.read(); }',
  '        { d.write(2); int y = c.read(); }',
  '    }',
  '}',
  '',
].join('\n');

test('the graph commands open the live viewer, write reports and exports, and serve VS Code', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'processj-lsp-graph-'));
  const file = path.join(root, 'crossed.pj');
  fs.writeFileSync(file, CROSSED);
  const uri = pathToFileURL(file).toString();
  const shown: Array<{ uri: string; external?: boolean }> = [];
  const client = new Client(path.join(__dirname, '..', 'src', 'server.js'), {
    'window/showDocument': (params) => {
      shown.push(params);
      return { success: true };
    },
  });
  t.after(async () => {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const initialized = await client.request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(root).toString(),
    capabilities: { window: { showDocument: { support: true } } },
    initializationOptions: { installDir: path.join(root, 'missing-processj') },
  });
  assert.ok(initialized.result.capabilities.executeCommandProvider.commands.includes('processj.exportConcurrencyGraph'));
  client.notify('initialized', {});
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'processj', version: 1, text: CROSSED } });
  await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === uri);

  // Default: the live page, opened in the browser.
  const opened = await client.request('workspace/executeCommand', { command: 'processj.showConcurrencyReport', arguments: [uri] });
  const url = opened.result as string;
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[\w-]{32,}\/d\/[\w-]+\/$/);
  assert.deepEqual(shown.pop(), { uri: url, external: true });
  const page = await get(url);
  assert.equal(page.status, 200);
  assert.match(page.body, /data-mode="live"/);
  const payload = JSON.parse((await get(`${url}payload`)).body);
  assert.deepEqual(payload.chips.map((chip: any) => `${chip.producer}:${chip.label}:${chip.text}`), ['checker:Deadlock freedom:deadlock']);
  assert.equal(payload.overlays[0].processes.length, 2);
  assert.equal(payload.source.text, CROSSED);

  // An edit reaches the open page as an update event.
  const update = new Promise<string>((resolve, reject) => {
    const req = http.get(`${url}events`, (response) => {
      response.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('event: update')) {
          req.destroy();
          resolve('update');
        }
      });
    });
    req.on('error', (error) => {
      if (!String(error).includes('socket hang up')) reject(error);
    });
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  client.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: CROSSED.replace('c.write(1)', 'c.write(3)') }] });
  assert.equal(await update, 'update');
  assert.match((await get(`${url}payload`)).body, /"documentVersion":2/);

  // The other modes.
  const markdown = await client.request('workspace/executeCommand', { command: 'processj.showConcurrencyReport', arguments: [uri, 'markdown'] });
  assert.match(fs.readFileSync(markdown.result, 'utf8'), /# Process network — crossed\.pj[\s\S]*Deadlock freedom/);
  assert.deepEqual(shown.pop(), { uri: pathToFileURL(markdown.result).toString(), external: false, takeFocus: true });
  const svg = await client.request('workspace/executeCommand', { command: 'processj.showConcurrencyReport', arguments: [uri, 'svg'] });
  assert.match(fs.readFileSync(svg.result, 'utf8'), /class="pj-ov-blocked"/);
  assert.equal(shown.pop()?.external, true);
  const scene = await client.request('workspace/executeCommand', { command: 'processj.showConcurrencyReport', arguments: [uri, 'excalidraw'] });
  assert.equal(JSON.parse(fs.readFileSync(scene.result, 'utf8')).source, 'processj-lsp');
  // A scene is for editing: it is kept next to the source, not in the report directory removed at shutdown.
  assert.equal(scene.result, path.join(root, 'crossed.graph.excalidraw'));
  const unknown = await client.request('workspace/executeCommand', { command: 'processj.showConcurrencyReport', arguments: [uri, 'pdf'] });
  assert.match(unknown.error?.message ?? '', /Unknown graph mode 'pdf'/);

  // Exports land next to the source and never replace a file someone else wrote.
  const exported = await client.request('workspace/executeCommand', { command: 'processj.exportConcurrencyGraph', arguments: [uri] });
  // `all` is the pictures and the page; JSON is written when asked for by name.
  assert.deepEqual(exported.result.written.map((entry: string) => path.basename(entry)), ['crossed.graph.svg', 'crossed.graph.excalidraw', 'crossed.graph.html']);
  assert.deepEqual(exported.result.refused, []);
  const again = await client.request('workspace/executeCommand', { command: 'processj.exportConcurrencyGraph', arguments: [uri, 'svg'] });
  assert.deepEqual(again.result.written, [path.join(root, 'crossed.graph.svg')], 'its own export is replaced');
  fs.writeFileSync(path.join(root, 'crossed.graph.json'), '{"mine": true}\n');
  const refused = await client.request('workspace/executeCommand', { command: 'processj.exportConcurrencyGraph', arguments: [uri, 'json'] });
  assert.deepEqual(refused.result, { written: [], refused: [path.join(root, 'crossed.graph.json')], skipped: [] });
  assert.equal(fs.readFileSync(path.join(root, 'crossed.graph.json'), 'utf8'), '{"mine": true}\n');
  const warning = await client.waitFor('window/showMessage', (message) => /did not overwrite/.test(message.params?.message ?? ''));
  // Messages are notifications: a request needs an answer, and Emacs 31.1's eglot fails to
  // send one for a request without actions, which wedges its later synchronous requests.
  assert.equal(warning.id, undefined);
  assert.ok(!client.received.some((message) => message.method === 'window/showMessageRequest'), 'no message waits for an answer, not even the missing-install warning');
  const elsewhere = await client.request('workspace/executeCommand', { command: 'processj.exportConcurrencyGraph', arguments: [uri, 'html', 'out'] });
  assert.deepEqual(elsewhere.result.written, [path.join(root, 'out', 'crossed.graph.html')]);
  // Format names are the formats' own keys, not anything an object inherits.
  for (const format of ['toString', '__proto__', 'constructor', 'hasOwnProperty']) {
    const strange = await client.request('workspace/executeCommand', { command: 'processj.exportConcurrencyGraph', arguments: [uri, format] });
    assert.match(strange.error?.message ?? '', /Unknown export format/, format);
  }
  assert.deepEqual(fs.readdirSync(root).filter((entry) => entry.startsWith('crossed') && !/\.(pj|svg|excalidraw|html|json)$/.test(entry)), [], 'no stray files');
  // A file with nothing to draw yet: the page is still written, the pictures are skipped with a message.
  const empty = path.join(root, 'empty.pj');
  fs.writeFileSync(empty, 'import std.io;\n');
  const emptyUri = pathToFileURL(empty).toString();
  client.notify('textDocument/didOpen', { textDocument: { uri: emptyUri, languageId: 'processj', version: 1, text: 'import std.io;\n' } });
  const nothing = await client.request('workspace/executeCommand', { command: 'processj.exportConcurrencyGraph', arguments: [emptyUri] });
  assert.deepEqual([nothing.result.written.map((entry: string) => path.basename(entry)), nothing.result.skipped], [['empty.graph.html'], ['svg', 'excalidraw']]);
  const emptyPage = await client.request('workspace/executeCommand', { command: 'processj.showConcurrencyReport', arguments: [emptyUri, 'svg'] });
  assert.equal(emptyPage.result, null);
  assert.equal(emptyPage.error, undefined);

  // VS Code's panel: the page with its nonce, then data only, then one view.
  // The value VS Code really sends as webview.cspSource.
  const network = await client.request('processj/processNetwork', { textDocument: { uri }, nonce: 'abcdefghijklmnop0123', cspSource: "'self' https://*.vscode-cdn.net" });
  assert.match(network.result.html, /script-src &#39;nonce-abcdefghijklmnop0123&#39;/);
  assert.match(network.result.html, /style-src &#39;self&#39; https:\/\/\*\.vscode-cdn\.net &#39;unsafe-inline&#39;/);
  assert.match(network.result.html, /data-mode="webview"/);
  const injected = await client.request('processj/processNetwork', { textDocument: { uri }, nonce: "x' 'unsafe-eval", cspSource: "'self' 'unsafe-eval'" });
  assert.doesNotMatch(injected.result.html, /unsafe-eval/, 'a nonce or source that is not a plain token is ignored');
  const data = await client.request('processj/processNetwork', { textDocument: { uri }, html: false });
  assert.equal(data.result.html, undefined);
  const one = await client.request('processj/processNetwork', { textDocument: { uri }, view: data.result.payload.defaultView });
  assert.equal(one.result.view.id, data.result.payload.defaultView);

  // With the live viewer off, the page is a file opened in the browser.
  client.notify('workspace/didChangeConfiguration', { settings: { processj: { liveViewer: false } } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Off means no listener at all, not only none for the next graph.
  await assert.rejects(get(url), /ECONNREFUSED/);
  const offline = await client.request('workspace/executeCommand', { command: 'processj.showConcurrencyReport', arguments: [uri] });
  assert.match(offline.result, /crossed\.graph\.html$/);
  assert.match(fs.readFileSync(offline.result, 'utf8'), /data-mode="file"/);
  const last = shown.pop();
  assert.equal(last?.external, true);
  assert.equal(fileURLToPath(last!.uri), offline.result);

  await client.request('shutdown', null);
});

test('no VS Code client command reuses an id the server advertises (the client could not start)', async (t) => {
  // vscode-languageclient registers every advertised server command under its own id; VS Code
  // refuses a second registration of an id, and the client's start fails on it.
  const root = path.join(__dirname, '..', '..');
  const source = fs.readFileSync(path.join(root, 'vscode', 'src', 'extension.ts'), 'utf8');
  const registered = [...source.matchAll(/registerCommand\('([\w.]+)'/g)].map((match) => match[1]);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'vscode', 'package.json'), 'utf8')) as { contributes: { commands: Array<{ command: string }> }; activationEvents: string[] };
  const contributed = manifest.contributes.commands.map((entry) => entry.command);
  assert.ok(registered.includes('processj.exportConcurrencyGraphFiles'));
  assert.deepEqual([...contributed].sort(), [...new Set(registered)].filter((id) => contributed.includes(id)).sort(), 'every contributed command is registered');
  const advertised = new Set<string>();
  for (const literals of [true, false]) {
    const client = new Client(path.join(__dirname, '..', 'src', 'server.js'), {});
    t.after(() => client.close());
    const reply = await client.request('initialize', {
      processId: process.pid,
      rootUri: null,
      capabilities: { workspace: { applyEdit: true }, textDocument: { codeAction: literals ? { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix'] } } } : {} } },
    });
    for (const command of reply.result.capabilities.executeCommandProvider.commands as string[]) advertised.add(command);
    await client.close();
  }
  assert.ok(advertised.has('processj.exportConcurrencyGraph'));
  assert.deepEqual(registered.filter((id) => advertised.has(id)), [], 'client commands that collide with server commands');
  for (const event of manifest.activationEvents.filter((entry) => entry.startsWith('onCommand:'))) assert.ok(!advertised.has(event.slice('onCommand:'.length)), `${event} names a server command`);
});
