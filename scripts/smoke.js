#!/usr/bin/env node
/**
 * End-to-end check: start the server over stdio, open a ProcessJ file with real
 * errors, and confirm diagnostics, completion, hover, definition and signature
 * help all come back. Requires a working ProcessJ install (see README).
 */
const { spawn } = require('node:child_process');
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
      waiting.get(body.id)(body);
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

function send(msg) {
  const json = JSON.stringify(msg);
  server.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
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
    capabilities: { window: { showDocument: { support: true } } },
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
  const labels = new Set(completion.result.map((i) => i.label));
  check(labels.has('println') && labels.has('inc') && labels.has('Point') && labels.has('par') && labels.has('c'), 'completion lists library, proc, record, keyword and local');

  const hover = await request('textDocument/hover', { textDocument: { uri }, position: { line: 11, character: 20 } });
  check(/public int inc\(int v\)/.test(hover.result?.contents?.value ?? '') && /Adds one/.test(hover.result.contents.value), 'hover on inc shows signature and doc');

  const def = await request('textDocument/definition', { textDocument: { uri }, position: { line: 11, character: 20 } });
  check(Array.isArray(def.result) && def.result[0]?.range.start.line === 5, 'definition of inc points at line 6');

  const libDef = await request('textDocument/definition', { textDocument: { uri }, position: { line: 11, character: 6 } });
  check(Array.isArray(libDef.result) && libDef.result.some((l) => /io\.pj$/.test(l.uri)), 'definition of println points into std/io.pj');

  const sig = await request('textDocument/signatureHelp', { textDocument: { uri }, position: { line: 11, character: 12 } });
  check(sig.result && sig.result.signatures.length >= 8, `signature help lists println overloads (${sig.result?.signatures.length ?? 0})`);

  const syms = await request('textDocument/documentSymbol', { textDocument: { uri } });
  check(syms.result.map((s) => s.name).join(',') === 'Point,inc,main', 'document symbols: Point, inc, main');

  check(diag.params.diagnostics.some((d) => d.source === 'processj-lint' && d.code === 'pj/unused' && /'c'/.test(d.message)), "lint: unused channel 'c' reported");

  const lenses = await request('textDocument/codeLens', { textDocument: { uri } });
  check(Array.isArray(lenses.result) && lenses.result.some((l) => l.command.command === 'processj.run'), 'code lens: Run offered on main');

  // Lint-only checks on a second document that the compiler would accept.
  const uri2 = pathToFileURL(path.join(__dirname, 'smoke-par.pj')).toString();
  const PAR = 'import std.*;\n\npublic void w(chan<int>.write o) { o.write(1); }\npublic void r(chan<int>.read i) { println(i.read()); }\n\npublic void main(string[] args) {\n    chan<int> c;\n    int x = 0;\n    par {\n        w(c.write);\n        w(c.write);\n        r(c.read);\n        x = 1;\n        println(x);\n    }\n}\n';
  notify('textDocument/didOpen', { textDocument: { uri: uri2, languageId: 'processj', version: 1, text: PAR } });
  const diag2 = await waitForDiagnostics(uri2, false);
  const codes2 = diag2.params.diagnostics.map((d) => d.code);
  check(codes2.includes('pj/shared-channel-end') && codes2.includes('pj/parallel-usage'), `lint: shared-channel-end and parallel-usage on par block (${codes2.join(', ')})`);
  const shared = diag2.params.diagnostics.find((d) => d.code === 'pj/shared-channel-end');
  const actions = await request('textDocument/codeAction', { textDocument: { uri: uri2 }, range: shared.range, context: { diagnostics: [shared] } });
  check(actions.result.some((a) => /shared/.test(a.title) && a.edit), 'code action: make channel shared');

  // Full pipeline: build + run a valid program through the Run command.
  const uri3 = pathToFileURL(path.join(__dirname, 'SmokeHello.pj')).toString();
  const HELLO = 'import std.*;\n\npublic void main(string[] args) {\n    chan<int> c;\n    par {\n        c.write(41);\n        println("value " + (c.read() + 1));\n    }\n}\n';
  notify('textDocument/didOpen', { textDocument: { uri: uri3, languageId: 'processj', version: 1, text: HELLO } });
  await waitForDiagnostics(uri3, false);
  const member = await request('textDocument/completion', { textDocument: { uri: uri3 }, position: { line: 5, character: 10 } });
  check(member.result.some((i) => i.label === 'read()'), 'member completion after "c." offers read()');
  const ran = await request('workspace/executeCommand', { command: 'processj.run', arguments: [uri3] });
  const reportPath = typeof ran.result === 'string' ? ran.result : '';
  const report = reportPath ? require('node:fs').readFileSync(reportPath, 'utf8') : '';
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
