#!/usr/bin/env node
/**
 * End-to-end check: start the server over stdio, open a ProcessJ file with real
 * errors, and confirm diagnostics, completion, hover, definition and signature
 * help all come back. Requires a working ProcessJ install (see README).
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const server = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'processj-lsp.js'), '--stdio'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});

let nextId = 1;
const waiting = new Map();
const notifications = [];
let buffer = Buffer.alloc(0);

server.stdout.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buffer.subarray(0, headerEnd).toString();
    const len = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1] ?? 0);
    if (buffer.length < headerEnd + 4 + len) return;
    const body = JSON.parse(buffer.subarray(headerEnd + 4, headerEnd + 4 + len).toString());
    buffer = buffer.subarray(headerEnd + 4 + len);
    if (body.id !== undefined && waiting.has(body.id)) {
      const pending = waiting.get(body.id);
      clearTimeout(pending.timer);
      pending.resolve(body);
      waiting.delete(body.id);
    } else if (body.id !== undefined && body.method) {
      // A request from the server (window/showDocument): acknowledge it.
      notifications.push(body);
      send({ jsonrpc: '2.0', id: body.id, result: { success: true } });
    } else if (body.method) {
      notifications.push(body);
      if (body.method === 'window/logMessage') console.log(`  [server] ${body.params.message}`);
    }
  }
});
server.on('exit', (code, signal) => {
  const error = new Error(`language server exited (${signal ?? code ?? 'unknown'})`);
  for (const pending of waiting.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  waiting.clear();
});

function send(msg) {
  const json = JSON.stringify(msg);
  server.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timeoutMs = method === 'workspace/executeCommand' ? 180000 : 30000;
    const timer = setTimeout(() => {
      waiting.delete(id);
      reject(new Error(`timed out waiting for ${method}`));
    }, timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    send({ jsonrpc: '2.0', id, method, params });
  });
}
function notify(method, params) {
  send({ jsonrpc: '2.0', method, params });
}
function waitFor(method, timeoutMs = 30000, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const i = notifications.findIndex((n) => n.method === method && predicate(n));
      if (i >= 0) return resolve(notifications.splice(i, 1)[0]);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for ${method}`));
      setTimeout(tick, 50);
    };
    tick();
  });
}
/** Diagnostics for one document. Lints publish instantly; pass wantCompiler to wait for the compiler's pass. */
function waitForDiagnostics(uri, wantCompiler) {
  return waitFor('textDocument/publishDiagnostics', 60000, (n) => n.params.uri === uri && (!wantCompiler || n.params.diagnostics.some((d) => d.source === 'processj')));
}

const SOURCE = `import std.*;

record Point { int x; int y; }

// Adds one.
public int inc(int v) { return v + 1; }

public void main(string[] args) {
    chan<int> c;
    int x = y + 1;
    string s = 5;
    println("hi" + inc(x));
}
`;

(async () => {
  const uri = pathToFileURL(path.join(__dirname, 'smoke-sample.pj')).toString();
  const init = await request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(path.join(__dirname, '..')).toString(),
    capabilities: {
      window: { showDocument: { support: true } },
      textDocument: {
        codeAction: {
          disabledSupport: true,
          codeActionLiteralSupport: {
            codeActionKind: { valueSet: ['quickfix', 'refactor', 'refactor.extract', 'refactor.rewrite'] },
          },
        },
      },
    },
    initializationOptions: { debounceMs: 0 },
  });
  console.log('initialize ok:', Object.keys(init.result.capabilities).join(', '));
  notify('initialized', {});

  notify('textDocument/didOpen', { textDocument: { uri, languageId: 'processj', version: 1, text: SOURCE } });
  const diag = await waitForDiagnostics(uri, true);
  console.log('diagnostics:');
  for (const d of diag.params.diagnostics) {
    console.log(`  L${d.range.start.line + 1}:${d.range.start.character + 1}-${d.range.end.character + 1} [${d.code}] ${d.message}`);
  }
  let failures = 0;
  const check = (cond, label) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'} ${label}`);
    if (!cond) failures++;
  };
  check(diag.params.diagnostics.some((d) => d.range.start.line === 9 && /'y'/.test(d.message)), "undefined 'y' reported on line 10");
  check(diag.params.diagnostics.some((d) => d.range.start.line === 10 && /string/.test(d.message)), 'int-to-string assignment reported on line 11');

  const completion = await request('textDocument/completion', { textDocument: { uri }, position: { line: 11, character: 4 } });
  const completionItems = Array.isArray(completion.result) ? completion.result : completion.result.items;
  const labels = new Set(completionItems.map((i) => i.label));
  check(labels.has('println') && labels.has('inc') && labels.has('Point') && labels.has('par') && labels.has('c'), 'completion lists library, proc, record, keyword and local');

  const hover = await request('textDocument/hover', { textDocument: { uri }, position: { line: 11, character: 20 } });
  check(/public int inc\(int v\)/.test(hover.result?.contents?.value ?? '') && /Adds one/.test(hover.result.contents.value), 'hover on inc shows signature and doc');

  const def = await request('textDocument/definition', { textDocument: { uri }, position: { line: 11, character: 20 } });
  check(Array.isArray(def.result) && def.result[0]?.range.start.line === 5, 'definition of inc points at line 6');

  const libDef = await request('textDocument/definition', { textDocument: { uri }, position: { line: 11, character: 6 } });
  check(Array.isArray(libDef.result) && libDef.result.some((l) => /io\.pj$/.test(l.uri)), 'definition of println points into std/io.pj');

  const libHover = await request('textDocument/hover', { textDocument: { uri }, position: { line: 11, character: 6 } });
  check(/println/.test(libHover.result?.contents?.value ?? '') && /std library \(io\.pj\)/.test(libHover.result.contents.value), 'hover on println shows its stdlib signature and source');

  const sig = await request('textDocument/signatureHelp', { textDocument: { uri }, position: { line: 11, character: 12 } });
  check(sig.result && sig.result.signatures.length >= 8, `signature help lists println overloads (${sig.result?.signatures.length ?? 0})`);

  const syms = await request('textDocument/documentSymbol', { textDocument: { uri } });
  check(syms.result.map((s) => s.name).join(',') === 'Point,inc,main', 'document symbols: Point, inc, main');

  check(diag.params.diagnostics.some((d) => d.source === 'processj-lint' && d.code === 'pj/unused' && /'c'/.test(d.message)), "lint: unused channel 'c' reported");

  const lenses = await request('textDocument/codeLens', { textDocument: { uri } });
  check(Array.isArray(lenses.result) && lenses.result.some((l) => l.command.command === 'processj.run'), 'code lens: Run offered on main');

  // Lint-only checks on a second document that the compiler would accept.
  const uri2 = pathToFileURL(path.join(__dirname, 'smoke-par.pj')).toString();
  const PAR = 'import std.*;\n\nprivate void w(chan<int>.write o) { o.write(1); }\nprivate void r(chan<int>.read i) { println(i.read()); }\n\npublic void main(string[] args) {\n    chan<int> c;\n    int x = 0;\n    par {\n        w(c.write);\n        w(c.write);\n        r(c.read);\n        x = 1;\n        println(x);\n    }\n}\n';
  notify('textDocument/didOpen', { textDocument: { uri: uri2, languageId: 'processj', version: 1, text: PAR } });
  const diag2 = await waitForDiagnostics(uri2, false);
  const codes2 = diag2.params.diagnostics.map((d) => d.code);
  check(codes2.includes('pj/shared-channel-end') && codes2.includes('pj/parallel-usage'), `lint: shared-channel-end and parallel-usage on par block (${codes2.join(', ')})`);
  const shared = diag2.params.diagnostics.find((d) => d.code === 'pj/shared-channel-end');
  const actions = await request('textDocument/codeAction', { textDocument: { uri: uri2 }, range: shared.range, context: { diagnostics: [shared] } });
  check(actions.result.some((a) => /shared/.test(a.title) && a.edit), 'code action: make channel shared');

  // Quick fix for a parser suggestion.
  const uri4 = pathToFileURL(path.join(__dirname, 'smoke-typo.pj')).toString();
  notify('textDocument/didOpen', { textDocument: { uri: uri4, languageId: 'processj', version: 1, text: 'import std.*;\n\npublic void main(string[] args) {\n    pa {\n        println("a");\n    }\n}\n' } });
  const diag4 = await waitForDiagnostics(uri4, false);
  const typo = diag4.params.diagnostics.find((d) => /did you mean 'par'/.test(d.message));
  check(!!typo, 'parser: typo diagnostic with suggestion');
  const fixes = await request('textDocument/codeAction', { textDocument: { uri: uri4 }, range: typo.range, context: { diagnostics: [typo] } });
  const fix = fixes.result.find((a) => a.title === "Change to 'par'");
  check(!!fix && fix.edit.changes[uri4][0].newText === 'par', "code action: Change to 'par'");

  // A compiler result depends on imported files as well as the open document
  // version. Saving an import must clear stale compiler errors and queue a
  // fresh compiler pass even though the importer text itself did not change.
  const dependencyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'processj-lsp-smoke-deps-'));
  try {
    const libDir = path.join(dependencyRoot, 'lib');
    fs.mkdirSync(libDir);
    const dependency = path.join(libDir, 'tools.pj');
    fs.writeFileSync(dependency, 'package lib;\npublic int existing() { return 1; }\npublic string importedFoo() { return "old"; }\n');
    const dependencyUri = pathToFileURL(path.join(dependencyRoot, 'DependencyUser.pj')).toString();
    notify('textDocument/didOpen', {
      textDocument: {
        uri: dependencyUri,
        languageId: 'processj',
        version: 1,
        text: 'import lib.*;\npublic int useDependency() { return importedFoo(); }\n',
      },
    });
    const initialDependency = await waitForDiagnostics(dependencyUri, true);
    check(initialDependency.params.diagnostics.some((d) => d.severity === 1), 'dependency: mismatched imported API is diagnosed');
    await waitFor('window/logMessage', 60000, (n) => /checked DependencyUser\.pj/.test(n.params.message));
    for (let i = notifications.length - 1; i >= 0; i--) {
      if (notifications[i].method === 'textDocument/publishDiagnostics' && notifications[i].params.uri === dependencyUri) notifications.splice(i, 1);
    }

    fs.writeFileSync(dependency, 'package lib;\npublic int existing() { return 1; }\npublic int importedFoo() { return 2; }\n');
    notify('workspace/didChangeWatchedFiles', { changes: [{ uri: pathToFileURL(dependency).toString(), type: 2 }] });
    const refreshedDependency = await waitFor('textDocument/publishDiagnostics', 60000, (n) => n.params.uri === dependencyUri);
    check(!refreshedDependency.params.diagnostics.some((d) => d.source === 'processj'), 'dependency: stale compiler errors disappear immediately after import save');
    await waitFor('window/logMessage', 60000, (n) => /checked DependencyUser\.pj/.test(n.params.message));
    check(true, 'dependency: import save queues a fresh compiler pass');
    notify('textDocument/didClose', { textDocument: { uri: dependencyUri } });
  } finally {
    fs.rmSync(dependencyRoot, { recursive: true, force: true });
  }

  // Full pipeline: build + run a valid program through the Run command.
  const uri3 = pathToFileURL(path.join(__dirname, 'SmokeHello.pj')).toString();
  const HELLO = 'import std.*;\n\npublic void main(string[] args) {\n    chan<int> c;\n    par {\n        c.write(41);\n        println("value " + (c.read() + 1));\n    }\n}\n';
  notify('textDocument/didOpen', { textDocument: { uri: uri3, languageId: 'processj', version: 1, text: HELLO } });
  await waitForDiagnostics(uri3, false);
  const member = await request('textDocument/completion', { textDocument: { uri: uri3 }, position: { line: 5, character: 10 } });
  check(member.result.some((i) => i.label === 'read()'), 'member completion after "c." offers read()');
  const ran = await request('workspace/executeCommand', { command: 'processj.run', arguments: [uri3] });
  const reportPath = typeof ran.result === 'string' ? ran.result : '';
  const report = reportPath ? fs.readFileSync(reportPath, 'utf8') : '';
  console.log(report.split('\n').map((l) => `    ${l}`).join('\n'));
  check(/value 42/.test(report), 'run: program output captured through the full pipeline');
  check(notifications.some((n) => n.method === 'window/showDocument'), 'run: server asked the editor to open the report');
  const refs = await request('textDocument/references', { textDocument: { uri: uri3 }, position: { line: 3, character: 14 }, context: { includeDeclaration: true } });
  check(Array.isArray(refs.result) && refs.result.length === 3, `references of 'c': ${refs.result?.length}`);
  const ren = await request('textDocument/rename', { textDocument: { uri: uri3 }, position: { line: 3, character: 14 }, newName: 'chan1' });
  check(ren.result && Object.values(ren.result.changes)[0].length === 3, 'rename produces 3 edits');

  await request('shutdown', null);
  notify('exit', null);
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
})().catch((err) => {
  console.error(err);
  server.kill();
  process.exit(1);
});
