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
        this.notifications.push(message);
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
    capabilities: { workspace: { workspaceFolders: true, applyEdit: true } },
    initializationOptions: { installDir: path.join(root, 'missing-processj') },
  });
  assert.equal(initialized.error, undefined);
  const packageVersion = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8')).version;
  assert.equal(typeof packageVersion, 'string');
  assert.equal(initialized.result.serverInfo.version, packageVersion);
  assert.equal(initialized.result.capabilities.workspace.workspaceFolders.supported, true);
  assert.equal(initialized.result.capabilities.codeActionProvider, true, 'legacy clients get the pre-literal CodeAction capability');
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
    chan<int> stranded;
    int blocked = stranded.read();
}

public void other() {
    int privateToOther = 1;
}`;
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'processj', version: 1, text: source } });
  const initialDiagnostics = await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === uri);
  const stranded = initialDiagnostics.params.diagnostics.find((diagnostic: any) => diagnostic.code === 'pj/channel-no-writer');
  assert.ok(stranded);
  assert.equal(stranded.relatedInformation, undefined, 'related diagnostic locations are omitted unless the client advertises support');

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
  assert.deepEqual(timerMembers.result.map((item: any) => item.label), ['read()', 'timeout(when)']);
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

  // LSP clients that do not advertise versioned documentChanges still receive
  // the original `changes` form instead of an edit they are allowed to ignore.
  const legacyEditUri = pathToFileURL(path.join(root, 'legacy-edit.pj')).toString();
  const legacyEditSource = 'public void main(string[] args) {\n    pa { skip; }\n}\n';
  client.notify('textDocument/didOpen', { textDocument: { uri: legacyEditUri, languageId: 'processj', version: 1, text: legacyEditSource } });
  const legacyPublished = await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === legacyEditUri);
  const typo = legacyPublished.params.diagnostics.find((diagnostic: any) => diagnostic.code === 'pj/syntax' && /did you mean 'par'/.test(diagnostic.message));
  assert.ok(typo);
  const legacyActions = await client.request('textDocument/codeAction', { textDocument: { uri: legacyEditUri }, range: typo.range, context: { diagnostics: [typo] } });
  const legacyFix = legacyActions.result.find((action: any) => action.title === "Change to 'par'");
  assert.equal(legacyFix.command, 'processj.applyWorkspaceEdit');
  assert.equal(legacyFix.arguments[0].documentChanges, undefined);
  assert.equal(legacyFix.arguments[0].changes[legacyEditUri][0].newText, 'par');

  const unknownCommand = await client.request('workspace/executeCommand', { command: 'processj.typo', arguments: [legacyEditUri] });
  assert.match(unknownCommand.error?.message ?? '', /Unknown ProcessJ command/, 'unknown commands never fall through to build or run');

  await client.request('shutdown', null);
  client.notify('exit', null);
});

test('legacy clients without workspace/applyEdit are not offered inert edit commands', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'processj-lsp-no-apply-edit-'));
  const server = path.join(__dirname, '..', 'src', 'server.js');
  const client = new LspClient(server);
  t.after(() => {
    client.child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  });

  const initialized = await client.request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(root).toString(),
    capabilities: {},
    initializationOptions: { installDir: path.join(root, 'missing-processj') },
  });
  assert.equal(initialized.result.capabilities.codeActionProvider, true);
  assert.ok(!initialized.result.capabilities.executeCommandProvider.commands.includes('processj.applyWorkspaceEdit'));
  client.notify('initialized', {});

  const uri = pathToFileURL(path.join(root, 'legacy-no-edit.pj')).toString();
  const source = 'public void main(string[] args) {\n    pa { skip; }\n}\n';
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'processj', version: 1, text: source } });
  const published = await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === uri);
  const typo = published.params.diagnostics.find((diagnostic: any) => diagnostic.code === 'pj/syntax');
  assert.ok(typo);
  const actions = await client.request('textDocument/codeAction', {
    textDocument: { uri },
    range: typo.range,
    context: { diagnostics: [typo] },
  });
  assert.deepEqual(actions.result, []);
  const forged = await client.request('workspace/executeCommand', {
    command: 'processj.applyWorkspaceEdit',
    arguments: [{ changes: { [uri]: [] } }],
  });
  assert.match(forged.error?.message ?? '', /does not support workspace\/applyEdit/);

  await client.request('shutdown', null);
  client.notify('exit', null);
});

test('server exposes concurrency, protocol, inlay and refactoring features through LSP', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'processj-lsp-features-'));
  fs.mkdirSync(path.join(root, 'helper'));
  fs.writeFileSync(path.join(root, 'helper', 'ops.pj'), 'package helper;\npublic void externalWork() { }\n');
  const server = path.join(__dirname, '..', 'src', 'server.js');
  const client = new LspClient(server);
  t.after(() => {
    client.child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  });

  const initialized = await client.request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(root).toString(),
    capabilities: {
      workspace: { workspaceFolders: true, workspaceEdit: { documentChanges: true } },
      textDocument: {
        inlayHint: {},
        publishDiagnostics: { relatedInformation: true },
        codeAction: {
          disabledSupport: true,
          codeActionLiteralSupport: {
            codeActionKind: { valueSet: ['quickfix', 'refactor', 'refactor.extract', 'refactor.rewrite'] },
          },
        },
      },
    },
    initializationOptions: { installDir: path.join(root, 'missing-processj') },
  });
  assert.equal(initialized.result.capabilities.inlayHintProvider, true);
  assert.ok(initialized.result.capabilities.codeActionProvider.codeActionKinds.includes('refactor.extract'));
  client.notify('initialized', {});

  const uri = pathToFileURL(path.join(root, 'features.pj')).toString();
  const source = [
    'protocol Message { ping: { int value; } pong: { } }',
    'void consume(chan<Message>.read input) {',
    '    Message message = input.read();',
    '    switch (message) {',
    '    case ping:',
    '        println(message.value);',
    '        break;',
    '    }',
    '}',
    'void inline(Message message) { switch (message) { case ping: break; } }',
    'public void main(string[] args) {',
    '    chan<Message> messages;',
    '    chan<int> stranded;',
    '    int blocked = stranded.read();',
    '    par {',
    '        messages.write(new Message { ping: value = 1 });',
    '        consume(messages.read);',
    '    }',
    '}',
  ].join('\r\n');
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'processj', version: 1, text: source } });
  const published = await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === uri);
  const missing = published.params.diagnostics.find((diagnostic: any) => diagnostic.code === 'pj/protocol/missing-cases');
  assert.ok(missing, JSON.stringify(published.params.diagnostics));
  const channelHazard = published.params.diagnostics.find((diagnostic: any) => diagnostic.code === 'pj/channel-no-writer');
  assert.equal(channelHazard?.relatedInformation?.length, 1, 'advertised related locations are retained');

  const hints = await client.request('textDocument/inlayHint', {
    textDocument: { uri },
    range: { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } },
  });
  assert.ok(hints.result.some((hint: any) => String(hint.label).includes('read endpoint')));
  assert.ok(hints.result.some((hint: any) => String(hint.label).includes('messages') === false && String(hint.label).includes('exclusive')));

  const graph = await client.request('processj/concurrencyGraph', { textDocument: { uri } });
  assert.equal(graph.result.version, 1);
  assert.ok(graph.result.nodes.some((node: any) => node.kind === 'parallel'));
  assert.ok(graph.result.edges.some((edge: any) => edge.kind === 'write'));
  assert.ok(graph.result.procedureEffects && Object.keys(graph.result.procedureEffects).length >= 2);

  const protocols = await client.request('processj/protocolModel', { textDocument: { uri } });
  assert.equal(protocols.result.switches[0].coverage, 'non-exhaustive');
  assert.ok(protocols.result.flows.some((flow: any) => flow.kind === 'send' && flow.caseName === 'ping'));
  assert.ok(protocols.result.flows.some((flow: any) => flow.kind === 'match'));

  const actions = await client.request('textDocument/codeAction', {
    textDocument: { uri },
    range: missing.range,
    context: { diagnostics: [missing] },
  });
  const generated = actions.result.find((action: any) => /Generate 1 missing protocol case/.test(action.title));
  assert.ok(generated);
  assert.equal(generated.edit.documentChanges[0].textDocument.version, 1);
  assert.match(generated.edit.documentChanges[0].edits[0].newText, /case pong:\r\n\s+break;/);

  const inlineMissing = published.params.diagnostics.find((diagnostic: any) => diagnostic.code === 'pj/protocol/missing-cases' && diagnostic.range.start.line === 9);
  assert.ok(inlineMissing);
  const inlineActions = await client.request('textDocument/codeAction', {
    textDocument: { uri },
    range: inlineMissing.range,
    context: { diagnostics: [inlineMissing] },
  });
  const inlineGenerated = inlineActions.result.find((action: any) => /Generate 1 missing protocol case/.test(action.title));
  assert.match(inlineGenerated?.edit.documentChanges[0].edits[0].newText ?? '', /^\r\n\s+case pong:\r\n\s+break;\r\n\s*$/);

  // The closing brace shares a line with a case, so the indentation has to come
  // from where `switch` really starts rather than from that line's text.
  const braceUri = pathToFileURL(path.join(root, 'brace.pj')).toString();
  const braceSource = 'protocol Message { ping: { int value; } pong: { int value; } }\nvoid consume(Message message) {\n    switch (message) {\n    case ping: break; }\n}\npublic void main(string[] args) { }\n';
  client.notify('textDocument/didOpen', { textDocument: { uri: braceUri, languageId: 'processj', version: 1, text: braceSource } });
  const bracePublished = await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === braceUri);
  const braceMissing = bracePublished.params.diagnostics.find((diagnostic: any) => diagnostic.code === 'pj/protocol/missing-cases');
  assert.ok(braceMissing, JSON.stringify(bracePublished.params.diagnostics));
  const braceActions = await client.request('textDocument/codeAction', {
    textDocument: { uri: braceUri },
    range: braceMissing.range,
    context: { diagnostics: [braceMissing] },
  });
  const braceGenerated = braceActions.result.find((action: any) => /Generate 1 missing protocol case/.test(action.title));
  assert.equal(braceGenerated?.edit.documentChanges[0].edits[0].newText, '\n        case pong:\n            break;\n    ');

  const lenses = await client.request('textDocument/codeLens', { textDocument: { uri } });
  assert.ok(lenses.result.some((lens: any) => lens.command?.command === 'processj.showConcurrencyReport'));
  assert.ok(lenses.result.some((lens: any) => /producer.*consumer/.test(lens.command?.title ?? '')));
  assert.ok(lenses.result.some((lens: any) => /effects:/.test(lens.command?.title ?? '')));

  const duplicateA = pathToFileURL(path.join(root, 'one', 'same.pj')).toString();
  const duplicateB = pathToFileURL(path.join(root, 'two', 'same.pj')).toString();
  client.notify('textDocument/didOpen', { textDocument: { uri: duplicateA, languageId: 'processj', version: 1, text: 'void first() { }' } });
  client.notify('textDocument/didOpen', { textDocument: { uri: duplicateB, languageId: 'processj', version: 1, text: 'void second() { }' } });
  await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === duplicateA);
  await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === duplicateB);
  const firstEffects = await client.request('workspace/executeCommand', { command: 'processj.showEffectReport', arguments: [duplicateA] });
  const secondEffects = await client.request('workspace/executeCommand', { command: 'processj.showEffectReport', arguments: [duplicateB] });
  const repeatedEffects = await client.request('workspace/executeCommand', { command: 'processj.showEffectReport', arguments: [duplicateA] });
  assert.equal(path.basename(firstEffects.result), 'same.effects.pjreport', 'reports keep a readable, editor-safe filename');
  assert.notEqual(path.dirname(firstEffects.result), path.dirname(secondEffects.result), 'same-basename documents have private report directories');
  assert.equal(repeatedEffects.result, firstEffects.result, 'one document reuses its stable report path');
  assert.match(fs.readFileSync(firstEffects.result, 'utf8'), /## first/);
  assert.match(fs.readFileSync(secondEffects.result, 'utf8'), /## second/);

  const raceUri = pathToFileURL(path.join(root, 'race.pj')).toString();
  const raceSource = [
    'public void main(string[] args) {',
    '    int value = 0;',
    '    int seen = 0;',
    '    par {',
    '        value = 42;',
    '        seen = value;',
    '    }',
    '}',
  ].join('\n');
  client.notify('textDocument/didOpen', { textDocument: { uri: raceUri, languageId: 'processj', version: 1, text: raceSource } });
  const racePublished = await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === raceUri);
  const race = racePublished.params.diagnostics.find((diagnostic: any) => diagnostic.code === 'pj/parallel-usage');
  assert.ok(race);
  const raceActions = await client.request('textDocument/codeAction', { textDocument: { uri: raceUri }, range: race.range, context: { diagnostics: [race] } });
  const channelAction = raceActions.result.find((action: any) => /Communicate 'value' through/.test(action.title));
  assert.ok(channelAction);
  assert.equal(channelAction.kind, 'refactor.rewrite');
  assert.equal(channelAction.edit.documentChanges[0].textDocument.version, 1);
  const quickFixOnly = await client.request('textDocument/codeAction', {
    textDocument: { uri: raceUri },
    range: race.range,
    context: { diagnostics: [race], only: ['quickfix'] },
  });
  assert.ok(!quickFixOnly.result.some((action: any) => action.kind?.startsWith('refactor')), 'CodeActionContext.only filters out refactors');

  const selectionActions = await client.request('textDocument/codeAction', {
    textDocument: { uri: raceUri },
    range: { start: { line: 4, character: 8 }, end: { line: 5, character: 21 } },
    context: { diagnostics: [] },
  });
  assert.ok(selectionActions.result.some((action: any) => action.kind === 'refactor.extract' || action.disabled?.reason));

  const importedUri = pathToFileURL(path.join(root, 'imported-refactor.pj')).toString();
  const importedSource = [
    'import helper.ops;',
    'public void main(string[] args) {',
    '    externalWork();',
    '    int left;',
    '    int right;',
    '    left = 1;',
    '    right = 2;',
    '}',
  ].join('\n');
  client.notify('textDocument/didOpen', { textDocument: { uri: importedUri, languageId: 'processj', version: 1, text: importedSource } });
  await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === importedUri);
  const importedActions = await client.request('textDocument/codeAction', {
    textDocument: { uri: importedUri },
    range: { start: { line: 5, character: 4 }, end: { line: 6, character: 14 } },
    context: { diagnostics: [] },
  });
  const importedPar = importedActions.result.find((action: any) => action.title === 'Run independent statements in parallel');
  assert.ok(importedPar, JSON.stringify(importedActions.result));
  assert.equal(importedPar.edit.documentChanges[0].textDocument.version, 1);
  const extractOnly = await client.request('textDocument/codeAction', {
    textDocument: { uri: importedUri },
    range: { start: { line: 5, character: 4 }, end: { line: 6, character: 14 } },
    context: { diagnostics: [], only: ['refactor.extract'] },
  });
  assert.ok(extractOnly.result.length > 0 && extractOnly.result.every((action: any) => action.kind === 'refactor.extract'));

  const multiChannelUri = pathToFileURL(path.join(root, 'multi-channel.pj')).toString();
  const multiChannelSource = [
    'public void main(string[] args) {',
    '    chan<int> a, b;',
    '    par {',
    '        { int first = a.read(); }',
    '        { int second = a.read(); }',
    '        { a.write(1); a.write(2); }',
    '    }',
    '}',
  ].join('\n');
  client.notify('textDocument/didOpen', { textDocument: { uri: multiChannelUri, languageId: 'processj', version: 1, text: multiChannelSource } });
  const multiChannelPublished = await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === multiChannelUri);
  const sharedEnd = multiChannelPublished.params.diagnostics.find((diagnostic: any) => diagnostic.code === 'pj/shared-channel-end');
  assert.ok(sharedEnd);
  const sharedActions = await client.request('textDocument/codeAction', {
    textDocument: { uri: multiChannelUri },
    range: sharedEnd.range,
    context: { diagnostics: [sharedEnd], only: ['quickfix'] },
  });
  const sharedAction = sharedActions.result.find((action: any) => /shared/i.test(action.title));
  assert.ok(sharedAction?.disabled?.reason.includes('multi-variable'));
  assert.equal(sharedActions.result.some((action: any) => action.edit), false, 'an imprecise token hint cannot bypass the binding-aware sharing planner');

  const directionUri = pathToFileURL(path.join(root, 'public-direction.pj')).toString();
  const directionSource = 'public void writer(chan<int>.read output) { output.write(1); }\n';
  client.notify('textDocument/didOpen', { textDocument: { uri: directionUri, languageId: 'processj', version: 1, text: directionSource } });
  const directionPublished = await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === directionUri);
  const direction = directionPublished.params.diagnostics.find((diagnostic: any) => diagnostic.code === 'pj/channel-direction');
  assert.ok(direction);
  const directionActions = await client.request('textDocument/codeAction', {
    textDocument: { uri: directionUri },
    range: direction.range,
    context: { diagnostics: [direction], only: ['quickfix'] },
  });
  const disabledDirection = directionActions.result.find((action: any) => action.title === 'Correct channel endpoint direction');
  assert.match(disabledDirection?.disabled?.reason ?? '', /public\/protected signature/, 'a refused direction repair explains why it is unsafe');

  const controlRaceUri = pathToFileURL(path.join(root, 'control-race.pj')).toString();
  const controlRaceSource = [
    'public void main(string[] args) {',
    '    int value = 0;',
    '    int seen = 0;',
    '    par {',
    '        { value = 42; return; }',
    '        { seen = value; }',
    '    }',
    '}',
  ].join('\n');
  client.notify('textDocument/didOpen', { textDocument: { uri: controlRaceUri, languageId: 'processj', version: 1, text: controlRaceSource } });
  const controlRacePublished = await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === controlRaceUri);
  const controlRace = controlRacePublished.params.diagnostics.find((diagnostic: any) => diagnostic.code === 'pj/parallel-usage');
  assert.ok(controlRace);
  const controlRaceActions = await client.request('textDocument/codeAction', {
    textDocument: { uri: controlRaceUri },
    range: controlRace.range,
    context: { diagnostics: [controlRace], only: ['refactor.rewrite'] },
  });
  const disabledRace = controlRaceActions.result.find((action: any) => action.title === 'Communicate the raced value through a channel');
  assert.match(disabledRace?.disabled?.reason ?? '', /control transfers first|contains return/, 'a refused race repair exposes its control-flow hazard');

  client.notify('textDocument/didChange', {
    textDocument: { uri, version: 2 },
    contentChanges: [{ text: `${source}\r\n` }],
  });
  await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === uri && message.params?.version === 2);
  const staleActions = await client.request('textDocument/codeAction', {
    textDocument: { uri },
    range: missing.range,
    context: { diagnostics: [missing] },
  });
  assert.ok(!staleActions.result.some((action: any) => /Generate .* missing protocol case/.test(action.title)), 'stale diagnostic coordinates are not stamped onto the current document version');

  const yieldUri = pathToFileURL(path.join(root, 'yield-chain.pj')).toString();
  const yieldSource = [
    'void wait1() { timer clock; clock.timeout(1); }',
    'void middle() { wait1(); }',
    'void outer() { middle(); }',
  ].join('\n');
  client.notify('textDocument/didOpen', { textDocument: { uri: yieldUri, languageId: 'processj', version: 1, text: yieldSource } });
  const yieldPublished = await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === yieldUri);
  const oldYieldDiagnostics = yieldPublished.params.diagnostics.filter((diagnostic: any) => diagnostic.code === 'pj/needs-yield-annotation');
  assert.equal(oldYieldDiagnostics.length, 2);
  const currentYieldActions = await client.request('textDocument/codeAction', {
    textDocument: { uri: yieldUri },
    range: oldYieldDiagnostics[0].range,
    context: { diagnostics: oldYieldDiagnostics, only: ['refactor.rewrite'] },
  });
  assert.ok(currentYieldActions.result.some((action: any) => /throughout the 2-procedure call chain/.test(action.title)), 'current diagnostics offer the bulk yield repair');
  client.notify('textDocument/didChange', {
    textDocument: { uri: yieldUri, version: 2 },
    contentChanges: [{ text: `${yieldSource}\n` }],
  });
  await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === yieldUri && message.params?.version === 2);
  const staleYieldActions = await client.request('textDocument/codeAction', {
    textDocument: { uri: yieldUri },
    range: oldYieldDiagnostics[0].range,
    context: { diagnostics: oldYieldDiagnostics, only: ['refactor.rewrite'] },
  });
  assert.ok(!staleYieldActions.result.some((action: any) => /yield=true.*throughout/.test(action.title)), 'stale yield diagnostics cannot authorize a fresh multi-edit');

  await client.request('shutdown', null);
  client.notify('exit', null);
});

test('server follows reachable imported bodies for effects, yield overloads and overlay invalidation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'processj-lsp-import-analysis-'));
  const lib = path.join(root, 'lib');
  fs.mkdirSync(lib);
  const depPath = path.join(lib, 'dep.pj');
  const bridgePath = path.join(lib, 'bridge.pj');
  const deepPath = path.join(lib, 'deep.pj');
  fs.writeFileSync(depPath, [
    'package lib;',
    'public void leaf(int value) { }',
    'public void leaf(chan<int>.read input) { int value = input.read(); }',
    'public void neutral() { leaf(1); }',
  ].join('\n'));
  fs.writeFileSync(deepPath, [
    'package lib;',
    'public void deepRead(chan<int>.read input) { int value = input.read(); }',
    'public void waiter() { }',
  ].join('\n'));
  fs.writeFileSync(bridgePath, [
    'package lib;',
    'import lib.deep;',
    'public void bridge(chan<int>.read input) { deepRead(input); }',
    'public void waiting() { waiter(); }',
  ].join('\n'));

  const server = path.join(__dirname, '..', 'src', 'server.js');
  const client = new LspClient(server);
  t.after(() => {
    client.child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  });
  await client.request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(root).toString(),
    capabilities: { workspace: { workspaceFolders: true, inlayHint: { refreshSupport: true }, codeLens: { refreshSupport: true } } },
    initializationOptions: { installDir: path.join(root, 'missing-processj') },
  });
  client.notify('initialized', {});

  const rootPath = path.join(root, 'main.pj');
  const uri = pathToFileURL(rootPath).toString();
  const source = [
    'import lib.dep;',
    'import lib.bridge;',
    'void ordinary() { neutral(); }',
    'void effect(chan<int>.read source) { bridge(source); }',
    'void caller() { waiting(); }',
  ].join('\n');
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'processj', version: 1, text: source } });
  const initial = await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === uri);
  assert.deepEqual(initial.params.diagnostics.filter((diagnostic: any) => diagnostic.code === 'pj/needs-yield-annotation'), [], 'the imported leaf(int) overload stays non-yielding');

  const graph = await client.request('processj/concurrencyGraph', { textDocument: { uri } });
  const effectNode = graph.result.nodes.find((node: any) => node.kind === 'procedure' && node.label === 'effect');
  assert.ok(effectNode);
  assert.ok(graph.result.procedureEffects[effectNode.id].some((fact: any) => fact.label === 'reads channel #1' && fact.confidence === 'exact'), JSON.stringify(graph.result.procedureEffects[effectNode.id]));
  assert.ok(!graph.result.procedureEffects[effectNode.id].some((fact: any) => fact.confidence === 'unknown'), 'the transitive imported channel effect is fully resolved');

  // `deep.pj` is not imported by the root. Opening an unsaved version must
  // still invalidate the root because it is an analysis dependency of the
  // reachable bridge body, and the editor buffer must win over the disk copy.
  const deepUri = pathToFileURL(deepPath).toString();
  const unsavedDeep = [
    'package lib;',
    'public void deepRead(chan<int>.read input) { int value = input.read(); }',
    'public void waiter() { timer clock; clock.timeout(1); }',
  ].join('\n');
  const decorationRefreshes = Promise.all([
    client.waitFor('workspace/inlayHint/refresh'),
    client.waitFor('workspace/codeLens/refresh'),
  ]);
  client.notify('textDocument/didOpen', { textDocument: { uri: deepUri, languageId: 'processj', version: 2, text: unsavedDeep } });
  await decorationRefreshes;
  const overlaid = await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === uri);
  assert.deepEqual(overlaid.params.diagnostics.filter((diagnostic: any) => diagnostic.code === 'pj/needs-yield-annotation').map((diagnostic: any) => diagnostic.range.start.line), [4]);

  client.notify('textDocument/didClose', { textDocument: { uri: deepUri } });
  const restored = await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === uri);
  assert.deepEqual(restored.params.diagnostics.filter((diagnostic: any) => diagnostic.code === 'pj/needs-yield-annotation'), [], 'closing the overlay restores the non-yielding disk dependency');

  await client.request('shutdown', null);
  client.notify('exit', null);
});

test('protocol transition reports never combine distinct overload bodies', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'processj-lsp-protocol-overloads-'));
  const server = path.join(__dirname, '..', 'src', 'server.js');
  const client = new LspClient(server);
  t.after(() => {
    client.child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  });
  await client.request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(root).toString(),
    capabilities: { workspace: { workspaceFolders: true } },
    initializationOptions: { installDir: path.join(root, 'missing-processj') },
  });
  client.notify('initialized', {});

  const uri = pathToFileURL(path.join(root, 'overloads.pj')).toString();
  const source = [
    'protocol Message { ping: { } pong: { } }',
    'void step(Message message) { switch (message) { case ping: break; default: break; } }',
    'void step(int ignored) { Message next = new Message { pong: }; }',
  ].join('\n');
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'processj', version: 1, text: source } });
  await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === uri);
  const report = await client.request('workspace/executeCommand', {
    command: 'processj.showProtocolReport',
    arguments: [uri],
  });
  assert.equal(typeof report.result, 'string');
  const markdown = fs.readFileSync(report.result, 'utf8');
  assert.doesNotMatch(markdown, /`ping` → `pong`/, 'same-named overloads are distinct procedures, not one observed transition');

  await client.request('shutdown', null);
  client.notify('exit', null);
});

test('only install-loaded std output declarations are transparent to exact rendezvous analysis', async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'processj-lsp-trusted-native-'));
  const installRoot = path.join(base, 'compiler');
  const trustedWorkspace = path.join(base, 'trusted-workspace');
  const spoofWorkspace = path.join(base, 'spoof-workspace');
  fs.mkdirSync(path.join(installRoot, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(installRoot, 'resources', 'jars'), { recursive: true });
  fs.mkdirSync(path.join(installRoot, 'include', 'std'), { recursive: true });
  fs.mkdirSync(trustedWorkspace, { recursive: true });
  fs.mkdirSync(path.join(spoofWorkspace, 'std'), { recursive: true });
  fs.writeFileSync(path.join(installRoot, 'bin', 'ProcessJc.class'), '');
  for (const jar of ['java_cup_runtime.jar', 'ST-4.0.7.jar', 'asm-all-5.2.jar']) {
    fs.writeFileSync(path.join(installRoot, 'resources', 'jars', jar), '');
  }
  const outputHeader = 'public native void println(int value);\n';
  fs.writeFileSync(path.join(installRoot, 'include', 'std', 'io.pj'), outputHeader);
  fs.writeFileSync(path.join(spoofWorkspace, 'std', 'io.pj'), outputHeader);

  const server = path.join(__dirname, '..', 'src', 'server.js');
  const clients: LspClient[] = [];
  t.after(() => {
    for (const client of clients) client.child.kill('SIGKILL');
    fs.rmSync(base, { recursive: true, force: true });
  });

  const analysisFor = async (workspaceRoot: string, name: string): Promise<{ diagnostics: any[]; effectTitle: string }> => {
    const client = new LspClient(server);
    clients.push(client);
    await client.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(workspaceRoot).toString(),
      capabilities: { workspace: { workspaceFolders: true } },
      initializationOptions: { installDir: installRoot },
    });
    client.notify('initialized', {});
    const uri = pathToFileURL(path.join(workspaceRoot, name)).toString();
    const source = [
      'import std.*;',
      'public void main(string[] args) {',
      '    chan<int> a;',
      '    chan<int> b;',
      '    par {',
      '        { println(1); a.write(1); int fromB = b.read(); }',
      '        { b.write(1); int fromA = a.read(); }',
      '    }',
      '}',
    ].join('\n');
    client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'processj', version: 1, text: source } });
    const published = await client.waitFor('textDocument/publishDiagnostics', (message) => message.params?.uri === uri);
    const lenses = await client.request('textDocument/codeLens', { textDocument: { uri } });
    const effectTitle = lenses.result.find((lens: any) => lens.command?.command === 'processj.showEffectReport')?.command?.title ?? '';
    await client.request('shutdown', null);
    client.notify('exit', null);
    return { diagnostics: published.params.diagnostics, effectTitle };
  };

  const trusted = await analysisFor(trustedWorkspace, 'trusted.pj');
  assert.ok(trusted.diagnostics.some((diagnostic: any) => diagnostic.code === 'pj/par-deadlock'), 'the real install declaration retains the useful exact proof');
  assert.doesNotMatch(trusted.effectTitle, /partial/, 'trusted std output does not make procedure effects opaque');
  const spoofed = await analysisFor(spoofWorkspace, 'spoofed.pj');
  assert.ok(!spoofed.diagnostics.some((diagnostic: any) => diagnostic.code === 'pj/par-deadlock'), 'a workspace std/io.pj lookalike remains an opaque call boundary');
  assert.match(spoofed.effectTitle, /partial/, 'a workspace lookalike remains opaque to effect analysis too');
});
