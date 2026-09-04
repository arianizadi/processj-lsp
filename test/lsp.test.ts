import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

interface Message {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

class LspClient {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly waiting = new Map<number, { resolve: (message: Message) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private readonly notifications: Message[] = [];
  readonly child: ChildProcessWithoutNullStreams;

  constructor(server: string) {
    this.child = spawn(process.execPath, [server, '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
    this.child.on('exit', (code, signal) => {
      const detail = this.child.stderr.read()?.toString().trim();
      const error = new Error(`language server exited (${signal ?? code ?? 'unknown'})${detail ? `: ${detail}` : ''}`);
      for (const pending of this.waiting.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.waiting.clear();
    });
  }

  request(method: string, params: unknown): Promise<Message> {
    const id = this.nextId++;
    const result = new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`timed out waiting for ${method}; stderr: ${this.child.stderr.read()?.toString() ?? ''}`));
      }, 10_000);
      this.waiting.set(id, { resolve, reject, timer });
    });
    this.send({ jsonrpc: '2.0', id, method, params });
    return result;
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  async waitFor(method: string, predicate: (message: Message) => boolean = () => true): Promise<Message> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const index = this.notifications.findIndex((message) => message.method === method && predicate(message));
      if (index >= 0) return this.notifications.splice(index, 1)[0];
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${method}; stderr: ${this.child.stderr.read()?.toString() ?? ''}`);
  }

  private send(message: unknown): void {
    const json = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString();
      const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1] ?? 0);
      if (this.buffer.length < headerEnd + 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString()) as Message;
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      if (message.id !== undefined && this.waiting.has(message.id)) {
        const pending = this.waiting.get(message.id)!;
        clearTimeout(pending.timer);
        pending.resolve(message);
        this.waiting.delete(message.id);
      } else if (message.id !== undefined && message.method) {
        // A server-to-client request (for example dynamic registration).
        this.send({ jsonrpc: '2.0', id: message.id, result: null });
      } else if (message.method) this.notifications.push(message);
    }
  }
}

test('server publishes lexer diagnostics and keeps completion/rename binding-aware', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'processj-lsp-test-'));
  const addedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'processj-lsp-added-root-'));
  fs.mkdirSync(path.join(root, 'lib'));
  fs.mkdirSync(path.join(root, 'a'));
  fs.mkdirSync(path.join(root, 'b'));
  fs.mkdirSync(path.join(root, 'wild'));
  fs.writeFileSync(path.join(root, 'lib', 'tools.pj'), 'package lib;\npublic int helper(int value) { return value; }\n');
  fs.writeFileSync(path.join(root, 'a', 'tools.pj'), 'package a;\n/** Integer overload docs. */\npublic int sharedName(int value) { return value; }\npublic string sharedName(string value) { return value; }\npublic int pair(string text, int value) { return value; }\nrecord Foo { int value; }\n');
  fs.writeFileSync(path.join(root, 'b', 'tools.pj'), 'package b;\npublic int sharedName(int value) { return value + 1; }\n');
  fs.writeFileSync(path.join(root, 'b_user.pj'), 'import b.tools;\npublic int useB() { return sharedName(1); }\n');
  fs.writeFileSync(path.join(root, 'a_string_user.pj'), 'import a.tools;\npublic string useString() { return sharedName("x"); }\n');
  fs.writeFileSync(path.join(root, 'wild', 'seed.pj'), 'package wild;\npublic void seed() { }\n');
  fs.writeFileSync(path.join(addedRoot, 'extra.pj'), 'public void fromAddedRoot() { }\n');
  const server = path.join(__dirname, '..', 'src', 'server.js');
  const client = new LspClient(server);
  t.after(() => {
    client.child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(addedRoot, { recursive: true, force: true });
  });

  const initialized = await client.request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(root).toString(),
    // Real editors advertise workspace folders, which makes vscode-languageserver
    // install its own handler for the change notification.
    capabilities: { workspace: { workspaceFolders: true } },
    initializationOptions: { installDir: path.join(root, 'missing-processj') },
  });
  assert.equal(initialized.error, undefined);
  const packageVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version;
  assert.equal(typeof packageVersion, 'string');
  assert.equal(initialized.result.serverInfo.version, packageVersion);
  assert.equal(initialized.result.capabilities.workspace.workspaceFolders.supported, true);
  client.notify('initialized', {});

  const uri = pathToFileURL(path.join(root, 'bindings.pj')).toString();
  const source = `public void main(string[] args) {
    int value = 1;
    {
        int value = 2;
        value++;
    }
    value++;
    // value in a comment; completion before the declaration below
    int later = value;
}

public void other() {
    int privateToOther = 1;
}`;
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'processj', version: 1, text: source } });
  await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === uri);

  const innerRefs = await client.request('textDocument/references', {
    textDocument: { uri },
    position: { line: 4, character: 10 },
    context: { includeDeclaration: true },
  });
  assert.deepEqual(innerRefs.result.map((location: any) => location.range.start.line), [3, 4]);

  const outerRefs = await client.request('textDocument/references', {
    textDocument: { uri },
    position: { line: 6, character: 6 },
    context: { includeDeclaration: false },
  });
  assert.deepEqual(outerRefs.result.map((location: any) => location.range.start.line), [6, 8]);

  const rename = await client.request('textDocument/rename', {
    textDocument: { uri },
    position: { line: 4, character: 10 },
    newName: 'innerValue',
  });
  assert.deepEqual(rename.result.changes[uri].map((edit: any) => edit.range.start.line), [3, 4]);

  const invalidRename = await client.request('textDocument/rename', {
    textDocument: { uri },
    position: { line: 4, character: 10 },
    newName: 'while',
  });
  assert.equal(invalidRename.result, undefined);
  assert.match(invalidRename.error?.message ?? '', /'while' is a reserved word/, 'a refused rename explains itself');
  const malformedRename = await client.request('textDocument/rename', {
    textDocument: { uri },
    position: { line: 4, character: 10 },
    newName: '1bad',
  });
  assert.match(malformedRename.error?.message ?? '', /not a valid ProcessJ identifier/);

  const dollarRename = await client.request('textDocument/rename', {
    textDocument: { uri },
    position: { line: 4, character: 10 },
    newName: '$innerValue',
  });
  assert.equal(dollarRename.result.changes[uri][0].newText, '$innerValue');

  const commentRename = await client.request('textDocument/prepareRename', {
    textDocument: { uri },
    position: { line: 7, character: 8 },
  });
  assert.equal(commentRename.result, null, 'comment text is not a renameable symbol');

  const keywordRename = await client.request('textDocument/prepareRename', {
    textDocument: { uri },
    position: { line: 0, character: 2 },
  });
  assert.equal(keywordRename.result, null, 'keywords are not renameable symbols');

  const completion = await client.request('textDocument/completion', {
    textDocument: { uri },
    position: { line: 7, character: 4 },
  });
  const completionItems = Array.isArray(completion.result) ? completion.result : completion.result.items;
  const labels = new Set(completionItems.map((item: any) => item.label));
  assert.ok(labels.has('args') && labels.has('value'));
  assert.ok(!labels.has('later'), 'a declaration below the cursor is not in scope');
  assert.ok(!labels.has('privateToOther'), 'locals from another procedure stay private');
  const helper = completionItems.find((item: any) => item.label === 'helper');
  assert.equal(helper?.additionalTextEdits?.[0]?.newText, 'import lib.tools;\n\n');
  const duplicateImports = completionItems
    .filter((item: any) => item.label === 'sharedName')
    .map((item: any) => item.additionalTextEdits?.[0]?.newText)
    .sort();
  assert.deepEqual(duplicateImports, ['import a.tools;\n\n', 'import a.tools;\n\n', 'import b.tools;\n\n']);

  // A file created beneath an existing wildcard import was not part of the old
  // dependency set. The watcher must invalidate that analysis so the new
  // declaration becomes imported, not an explicit-import suggestion.
  const wildcardUri = pathToFileURL(path.join(root, 'wild_user.pj')).toString();
  const wildcardSource = 'import wild.*;\npublic int useWild() { return newlyAvailable(); }\n';
  client.notify('textDocument/didOpen', { textDocument: { uri: wildcardUri, languageId: 'processj', version: 1, text: wildcardSource } });
  await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === wildcardUri);
  const createdPath = path.join(root, 'wild', 'new.pj');
  fs.writeFileSync(createdPath, 'package wild;\npublic int newlyAvailable() { return 1; }\n');
  client.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: pathToFileURL(createdPath).toString(), type: 1 }] });
  await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === wildcardUri);
  const wildcardCompletion = await client.request('textDocument/completion', {
    textDocument: { uri: wildcardUri },
    position: { line: 1, character: 40 },
    context: { triggerKind: 1 },
  });
  const wildcardItems = Array.isArray(wildcardCompletion.result) ? wildcardCompletion.result : wildcardCompletion.result.items;
  const newlyAvailable = wildcardItems.find((item: any) => item.label === 'newlyAvailable');
  assert.ok(newlyAvailable);
  assert.equal(newlyAvailable.additionalTextEdits, undefined, 'wildcard-imported declarations need no redundant import');

  const highlights = await client.request('textDocument/documentHighlight', {
    textDocument: { uri },
    position: { line: 4, character: 10 },
  });
  assert.deepEqual(highlights.result.map((highlight: any) => highlight.range.start.line), [3, 4]);

  const workspaceSymbols = await client.request('workspace/symbol', { query: 'helper' });
  assert.equal(workspaceSymbols.result[0]?.name, 'helper');
  assert.match(workspaceSymbols.result[0]?.location?.uri ?? '', /lib\/tools\.pj$/);

  client.notify('workspace/didChangeWorkspaceFolders', {
    event: { added: [{ uri: pathToFileURL(addedRoot).toString(), name: 'added' }], removed: [] },
  });
  const addedSymbols = await client.request('workspace/symbol', { query: 'fromAddedRoot' });
  assert.equal(addedSymbols.result[0]?.name, 'fromAddedRoot', 'new workspace folders are indexed without restarting');

  // Opening a same-named declaration elsewhere must not hijack an imported
  // call. Definition, references, and rename follow the overload/file selected
  // by the checker and leave the other module and its caller untouched.
  const unrelatedUri = pathToFileURL(path.join(root, 'b', 'tools.pj')).toString();
  client.notify('textDocument/didOpen', {
    textDocument: {
      uri: unrelatedUri,
      languageId: 'processj',
      version: 1,
      text: fs.readFileSync(path.join(root, 'b', 'tools.pj'), 'utf8'),
    },
  });
  await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === unrelatedUri);

  const packageRename = await client.request('textDocument/prepareRename', {
    textDocument: { uri: unrelatedUri },
    position: { line: 0, character: 8 },
  });
  assert.equal(packageRename.result, null, 'package path segments are not renameable declarations');

  const callerUri = pathToFileURL(path.join(root, 'a_user.pj')).toString();
  const callerSource = 'import a.tools;\npublic int useA() { return sharedName(1); }\npublic string useAString() { return sharedName("x"); }\n';
  client.notify('textDocument/didOpen', { textDocument: { uri: callerUri, languageId: 'processj', version: 1, text: callerSource } });
  await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === callerUri);
  const callPosition = { line: 1, character: 29 };

  const definition = await client.request('textDocument/definition', { textDocument: { uri: callerUri }, position: callPosition });
  assert.equal(definition.result.length, 1);
  assert.match(definition.result[0].uri, /\/a\/tools\.pj$/);
  const importedHover = await client.request('textDocument/hover', { textDocument: { uri: callerUri }, position: callPosition });
  assert.match(importedHover.result.contents.value, /Integer overload docs/);

  const importedRefs = await client.request('textDocument/references', {
    textDocument: { uri: callerUri },
    position: callPosition,
    context: { includeDeclaration: true },
  });
  assert.deepEqual(importedRefs.result.map((location: any) => [location.uri, location.range.start.line]), [
    [pathToFileURL(path.join(root, 'a', 'tools.pj')).toString(), 2],
    [callerUri, 1],
  ]);

  const importedUses = await client.request('textDocument/references', {
    textDocument: { uri: callerUri },
    position: callPosition,
    context: { includeDeclaration: false },
  });
  assert.deepEqual(importedUses.result.map((location: any) => location.uri), [callerUri]);

  const overloadHighlights = await client.request('textDocument/documentHighlight', {
    textDocument: { uri: callerUri },
    position: callPosition,
  });
  assert.deepEqual(overloadHighlights.result.map((highlight: any) => highlight.range.start.line), [1], 'highlights follow the selected overload');

  const signatureUri = pathToFileURL(path.join(root, 'signature.pj')).toString();
  const signatureSource = [
    'import a.tools;',
    'public int commas() { return pair("a,b", /* x,y */ 1); }',
    'public int longCall() {',
    '    return pair(',
    '        "x",',
    ...Array.from({ length: 22 }, () => ''),
    '        1',
    '    );',
    '}',
  ].join('\n');
  client.notify('textDocument/didOpen', { textDocument: { uri: signatureUri, languageId: 'processj', version: 1, text: signatureSource } });
  await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === signatureUri);
  const commaSignature = await client.request('textDocument/signatureHelp', {
    textDocument: { uri: signatureUri },
    position: { line: 1, character: signatureSource.split('\n')[1].lastIndexOf('1') },
  });
  assert.equal(commaSignature.result.activeParameter, 1, 'commas in strings and comments do not advance signature help');
  const longSignature = await client.request('textDocument/signatureHelp', {
    textDocument: { uri: signatureUri },
    position: { line: 27, character: 8 },
  });
  assert.equal(longSignature.result.activeParameter, 1, 'signature help survives calls spanning more than twenty lines');
  const strayUri = pathToFileURL(path.join(root, 'stray.pj')).toString();
  const straySource = 'import a.tools;\npublic int stray() {\n    pair(\n    int v = 1;\n    int a, b = 1;\n}\n';
  client.notify('textDocument/didOpen', { textDocument: { uri: strayUri, languageId: 'processj', version: 1, text: straySource } });
  await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === strayUri);
  const straySignature = await client.request('textDocument/signatureHelp', {
    textDocument: { uri: strayUri },
    position: { line: 4, character: 15 },
  });
  assert.equal(straySignature.result, null, 'an unclosed call in an earlier statement is not the signature context');

  const importedRename = await client.request('textDocument/rename', {
    textDocument: { uri: callerUri },
    position: callPosition,
    newName: 'renamedA',
  });
  assert.deepEqual(Object.keys(importedRename.result.changes).sort(), [
    pathToFileURL(path.join(root, 'a', 'tools.pj')).toString(),
    callerUri,
  ].sort());
  assert.deepEqual(importedRename.result.changes[pathToFileURL(path.join(root, 'a', 'tools.pj')).toString()].map((edit: any) => edit.range.start.line), [2]);

  const typeUri = pathToFileURL(path.join(root, 'type_user.pj')).toString();
  const typeSource = `import a.tools;
record Holder {
    int Foo;
}
public Foo identity(Foo value) { return value; }
public a::Foo[] qualified(a::Foo[] values) { return values; }`;
  client.notify('textDocument/didOpen', { textDocument: { uri: typeUri, languageId: 'processj', version: 1, text: typeSource } });
  await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === typeUri);
  const typeRename = await client.request('textDocument/rename', {
    textDocument: { uri: typeUri },
    position: { line: 4, character: 8 },
    newName: 'RenamedFoo',
  });
  assert.deepEqual(typeRename.result.changes[typeUri].map((edit: any) => [edit.range.start.line, edit.range.start.character]), [
    [4, 7],
    [4, 20],
  ]);
  assert.ok(!typeRename.result.changes[typeUri].some((edit: any) => edit.range.start.line === 2), 'same-named record field is a different symbol');
  const typeHighlights = await client.request('textDocument/documentHighlight', {
    textDocument: { uri: typeUri },
    position: { line: 4, character: 8 },
  });
  assert.deepEqual(typeHighlights.result.map((highlight: any) => [highlight.range.start.line, highlight.range.start.character]), [
    [4, 7],
    [4, 20],
  ]);
  const qualifiedTypeRename = await client.request('textDocument/prepareRename', {
    textDocument: { uri: typeUri },
    position: { line: 5, character: 11 },
  });
  assert.equal(qualifiedTypeRename.result, null, 'a package-qualified type never binds to an unrelated short name');

  const memberUri = pathToFileURL(path.join(root, 'member.pj')).toString();
  const memberSource = 'public void main(string[] args) {\n    int number = 1;\n    number.\n}\n';
  client.notify('textDocument/didOpen', { textDocument: { uri: memberUri, languageId: 'processj', version: 1, text: memberSource } });
  await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === memberUri);
  const primitiveMembers = await client.request('textDocument/completion', {
    textDocument: { uri: memberUri },
    position: { line: 2, character: 11 },
  });
  assert.deepEqual(primitiveMembers.result, []);

  const chainUri = pathToFileURL(path.join(root, 'chain.pj')).toString();
  const chainSource = 'record Box { chan<int>.write out; }\npublic void main(Box box) {\n    box.out.\n}\n';
  client.notify('textDocument/didOpen', { textDocument: { uri: chainUri, languageId: 'processj', version: 1, text: chainSource } });
  await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === chainUri);
  const chainMembers = await client.request('textDocument/completion', {
    textDocument: { uri: chainUri },
    position: { line: 2, character: 12 },
  });
  assert.deepEqual(chainMembers.result.map((item: any) => item.label), ['write(...)'], 'member completion follows record fields');

  // Any typed receiver expression completes: an array element, a call result, a nested field.
  const exprUri = pathToFileURL(path.join(root, 'exprmember.pj')).toString();
  const exprSource = 'record P { int x; }\nrecord Q { P p; }\npublic Q make() { return new Q { p = new P { x = 1 } }; }\npublic void main(string[] args) {\n    Q[] qs = new Q[2];\n    qs[0].\n    int a = 1;\n    make().p.\n    int b = 2;\n    (qs[1]).\n}\n';
  client.notify('textDocument/didOpen', { textDocument: { uri: exprUri, languageId: 'processj', version: 1, text: exprSource } });
  await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === exprUri);
  for (const [line, character, expected] of [[5, 10, ['p']], [7, 13, ['x']], [9, 12, ['p']]] as const) {
    const members = await client.request('textDocument/completion', { textDocument: { uri: exprUri }, position: { line, character } });
    assert.deepEqual(members.result.map((item: any) => item.label), expected, `member completion at ${line}:${character}`);
  }

  const badCallUri = pathToFileURL(path.join(root, 'badcall.pj')).toString();
  const badCallSource = 'public int twice(int n) { return n * 2; }\npublic void main() {\n    int a = twice(1);\n    int b = twice("x");\n}\n';
  client.notify('textDocument/didOpen', { textDocument: { uri: badCallUri, languageId: 'processj', version: 1, text: badCallSource } });
  await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === badCallUri);
  const badCallRename = await client.request('textDocument/rename', {
    textDocument: { uri: badCallUri },
    position: { line: 0, character: 12 },
    newName: 'dbl',
  });
  assert.deepEqual(badCallRename.result.changes[badCallUri].map((edit: any) => edit.range.start.line), [0, 2, 3], 'a mistyped call is renamed along with the declaration');

  const timerUri = pathToFileURL(path.join(root, 'timer.pj')).toString();
  const timerSource = 'public void main(string[] args) {\n    timer clock;\n    clock.\n}\n';
  client.notify('textDocument/didOpen', { textDocument: { uri: timerUri, languageId: 'processj', version: 1, text: timerSource } });
  await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === timerUri);
  const timerMembers = await client.request('textDocument/completion', {
    textDocument: { uri: timerUri },
    position: { line: 2, character: 10 },
  });
  assert.deepEqual(timerMembers.result.map((item: any) => item.label), ['read()', 'timeout(ms)']);
  assert.match(timerMembers.result[0].detail, /^long:/);

  const lexUri = pathToFileURL(path.join(root, 'lexer.pj')).toString();
  const lexSource = 'public void main(string[] args) {\n    string escaped = "bad\\n"; // café\n}\n';
  client.notify('textDocument/didOpen', { textDocument: { uri: lexUri, languageId: 'processj', version: 1, text: lexSource } });
  const published = await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === lexUri);
  const codes = new Set(published.params.diagnostics.map((diagnostic: any) => diagnostic.code));
  assert.ok(codes.has('pj/string-escape'));
  assert.ok(codes.has('pj/non-ascii'));
  assert.equal(published.params.version, 1);

  const stringRename = await client.request('textDocument/prepareRename', {
    textDocument: { uri: lexUri },
    position: { line: 1, character: 22 },
  });
  assert.equal(stringRename.result, null, 'string contents are not renameable symbols');

  await client.request('shutdown', null);
  client.notify('exit', null);
});
