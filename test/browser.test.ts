/**
 * The browser build (scripts/build-browser.mjs): the worker the web IDE runs,
 * driven as its page drives it (test/browser-worker.ts), next to the Node
 * server where they must agree. FDR's answers come from the recordings
 * (fdr-recordings.ts), as refines' output locally and as a runner's frames
 * in the worker, so these run without FDR, a compiler or a runner.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { StdioClient, WorkerClient, WORKER_BUNDLE, workerBundle, type Message } from './browser-worker';
import { recordedFrames, replayingRefines } from './fdr-recordings';

const ROOT = path.join(__dirname, '..', '..');
const EXAMPLES = path.join(ROOT, 'examples');
const WORKSPACE = 'file:///workspace';
const VERSION = (JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version: string }).version;
/** What the web IDE passes (docs/worker-contract.md of the IDE). */
const IDE_OPTIONS = { graphPanel: true, verificationNotifications: true, liveViewer: false, browser: { remoteFdr: true, remoteCompile: true } };
const CAPABILITIES = {
  workspace: { didChangeWatchedFiles: { dynamicRegistration: true }, codeLens: { refreshSupport: true }, applyEdit: true },
  window: { showDocument: { support: true } },
  textDocument: { publishDiagnostics: { relatedInformation: true }, codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'refactor'] } } }, completion: { completionItem: { snippetSupport: true } } },
};
const SKIP_REPLAY = process.platform === 'win32' && 'the replayed refines is a shell script';

async function startWorker(options: Record<string, unknown> = IDE_OPTIONS): Promise<{ worker: WorkerClient; init: any }> {
  const worker = new WorkerClient();
  const init = await worker.request('initialize', { processId: null, rootUri: WORKSPACE, capabilities: CAPABILITIES, initializationOptions: options });
  worker.notify('initialized', {});
  return { worker, init };
}

/** Put project files into the worker's file system (paths relative to the workspace). */
function writeFiles(worker: WorkerClient, files: Record<string, string>): void {
  worker.notify('processj/writeFiles', { files: Object.entries(files).map(([name, text]) => ({ uri: `${WORKSPACE}/${name}`, text })) });
}

const example = (name: string): string => fs.readFileSync(path.join(EXAMPLES, name), 'utf8');

/** Open a document and wait for its first diagnostics. */
async function open(peer: WorkerClient | StdioClient, uri: string, text: string, languageId = 'processj'): Promise<Message> {
  peer.notify('textDocument/didOpen', { textDocument: { uri, languageId, version: 1, text } });
  return peer.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri);
}

const brief = (d: any): string => `${d.range.start.line}:${d.range.start.character}-${d.range.end.line}:${d.range.end.character} ${d.severity} ${d.source} ${d.code} ${d.message}`;

/** A report as it would read in another workspace: URIs under `root` moved to the worker's, timings dropped. */
function portable(value: unknown, root: string): unknown {
  return JSON.parse(JSON.stringify(value, (key, entry) => (key === 'ms' ? undefined : typeof entry === 'string' ? entry.split(root).join(WORKSPACE) : entry)));
}

/** A workspace folder on disk named like the worker's, with these files, and a Node server on it (`options` may use a folder of the test's). */
async function startNode(files: Record<string, string>, options: (base: string) => Record<string, unknown>): Promise<{ client: StdioClient; root: string; uri: (name: string) => string; close(): Promise<void> }> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-browser-'));
  const dir = path.join(base, 'workspace');
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  const root = pathToFileURL(dir).toString();
  const client = new StdioClient();
  await client.request('initialize', { processId: process.pid, rootUri: root, capabilities: CAPABILITIES, initializationOptions: { installDir: path.join(base, 'no-processj'), ...options(base) } });
  client.notify('initialized', {});
  return {
    client,
    root,
    uri: (name) => `${root}/${name}`,
    close: async () => {
      await client.close();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

test('the worker runs on a Web Worker\'s globals alone, with the standard library inside', async () => {
  const { worker, init } = await startWorker();
  try {
    assert.deepEqual(worker.leaked, [], 'no Node globals in the worker context');
    assert.equal(init.serverInfo.version, VERSION);
    assert.ok(worker.log().some((line) => /ProcessJ install: \/processj .*library symbols/.test(line)), worker.log().join('\n'));
    const uri = `${WORKSPACE}/dining_philosophers.pj`;
    const text = example('dining_philosophers.pj');
    writeFiles(worker, { 'dining_philosophers.pj': text });
    const published = await open(worker, uri, text);
    assert.deepEqual(published.params.diagnostics.map((d: any) => `${d.range.start.line + 1} ${d.code} ${d.message}`), ['15 pj/unused \'b\' is never used']);
    const lines = text.split('\n');
    const at = (needle: string): { line: number; character: number } => {
      const line = lines.findIndex((entry) => entry.includes(needle));
      return { line, character: lines[line].indexOf(needle) };
    };
    const hover = await worker.request('textDocument/hover', { textDocument: { uri }, position: at('println') });
    assert.match(hover.contents.value, /std library \(io\.pj\)/);
    const completion = await worker.request('textDocument/completion', { textDocument: { uri }, position: at('left.write') });
    assert.ok((Array.isArray(completion) ? completion : completion.items).some((item: any) => item.label === 'println'));
    assert.deepEqual(await worker.request('textDocument/formatting', { textDocument: { uri }, options: { tabSize: 4, insertSpaces: true } }), []);
    assert.ok((await worker.request('textDocument/semanticTokens/full', { textDocument: { uri } })).data.length > 0);
    // FDR runs on the page's runner, so its lenses are there without a local refines; Run and Build are the page's.
    const lenses = (await worker.request('textDocument/codeLens', { textDocument: { uri } })).map((lens: any) => lens.command.title);
    for (const title of ['FDR: check program & show graph', '▶ Run', 'Build']) assert.ok(lenses.includes(title), `${title} in ${lenses.join(', ')}`);
    assert.equal(await worker.request('workspace/executeCommand', { command: 'processj.run', arguments: [uri] }), null);
    await worker.waitFor((m) => m.method === 'window/showMessage' && /Run and Build are done by the editor/.test(m.params.message));
  } finally {
    await worker.close();
  }
});

test('lint and parser diagnostics in the worker are the Node server\'s, over every example', { skip: SKIP_REPLAY && 'the stand-in compiler is a shell script' }, async () => {
  const names = fs.readdirSync(EXAMPLES).filter((name) => name.endsWith('.pj')).sort();
  const files: Record<string, string> = { 'lib/geometry.pj': example('lib/geometry.pj') };
  for (const name of names) files[name] = example(name);
  // The Node server gets the standard library from an install of its own (the same headers), and a
  // compiler that finds nothing wrong: what is compared is the analysis both builds share.
  const install = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-browser-install-'));
  const java = path.join(install, 'java');
  fs.writeFileSync(java, '#!/bin/sh\necho "** COMPILATION COMPLITED SUCCESSFULLY **"\n');
  fs.chmodSync(java, 0o755);
  fs.cpSync(path.join(ROOT, 'test', 'fixtures', 'include'), path.join(install, 'include', 'JVM'), { recursive: true });
  fs.mkdirSync(path.join(install, 'bin'));
  fs.writeFileSync(path.join(install, 'bin', 'ProcessJc.class'), '');
  fs.mkdirSync(path.join(install, 'resources', 'jars'), { recursive: true });
  for (const jar of ['java_cup_runtime.jar', 'ST-4.0.7.jar', 'asm-all-5.2.jar']) fs.writeFileSync(path.join(install, 'resources', 'jars', jar), '');
  const node = await startNode(files, () => ({ installDir: install, javaBin: java, liveViewer: false }));
  const { worker } = await startWorker({ liveViewer: false });
  try {
    writeFiles(worker, files);
    const analysis = (message: Message): string[] => message.params.diagnostics.filter((d: any) => d.source !== 'processj').map(brief).sort();
    let compared = 0;
    for (const name of names) {
      const inNode = analysis(await open(node.client, node.uri(name), files[name]));
      const inWorker = analysis(await open(worker, `${WORKSPACE}/${name}`, files[name]));
      assert.deepEqual(inWorker, inNode, name);
      compared += inNode.length;
    }
    assert.ok(names.length >= 25 && compared >= 30, `${names.length} files, ${compared} diagnostics`);
    // Without remoteCompile the worker asks for no compiler run, and starts none.
    assert.ok(!worker.messages.some((m) => m.method === 'processj/compile'));
  } finally {
    await worker.close();
    await node.close();
    fs.rmSync(install, { recursive: true, force: true });
  }
});

test('ELK lays out the process network inside the worker, and the connection survives it', async () => {
  const { worker } = await startWorker();
  try {
    const uri = `${WORKSPACE}/dining_philosophers.pj`;
    const text = example('dining_philosophers.pj');
    writeFiles(worker, { 'dining_philosophers.pj': text });
    await open(worker, uri, text);
    const { payload } = await worker.request('processj/processNetwork', { textDocument: { uri }, html: false });
    assert.ok(worker.connected, 'ELK left the worker\'s onmessage to the language server');
    assert.deepEqual(payload.notes, [], 'no plain arrangement in place of a layout');
    const program = payload.views.find((view: any) => view.kind === 'program');
    assert.ok(program && !program.pending && program.width > 0 && /<g/.test(program.svg));
    // Still answering, and the state machines lay out too.
    assert.equal((await worker.request('textDocument/documentSymbol', { textDocument: { uri } })).length, 3);
    const ref = program.nodes.find((node: any) => node.machine)?.machine;
    const { machine } = await worker.request('processj/processNetwork', { textDocument: { uri }, machine: { target: 'program', ref } });
    assert.ok(machine && !machine.error && machine.svg, JSON.stringify(machine).slice(0, 200));
    // The webview page carries the viewer script the bundle holds.
    const { html } = await worker.request('processj/processNetwork', { textDocument: { uri }, nonce: 'bm9uY2Utbm9uY2Utbm9uY2U=' });
    assert.match(html, /data-mode="webview"/);
    assert.match(html, /acquireVsCodeApi/);
    assert.ok(worker.connected);
  } finally {
    await worker.close();
  }
});

test('processj/writeFiles, deleteFiles and readFile keep the in-memory project and its analysis in step', async () => {
  const { worker } = await startWorker({ liveViewer: false });
  try {
    const uri = `${WORKSPACE}/use_import.pj`;
    const text = example('use_import.pj');
    writeFiles(worker, { 'use_import.pj': text });
    const missing = /Cannot find import 'lib\.geometry'/;
    assert.ok((await open(worker, uri, text)).params.diagnostics.some((d: any) => missing.test(d.message)));
    // The import's file arrives: the importer is analysed again, and the import resolves.
    writeFiles(worker, { 'lib/geometry.pj': example('lib/geometry.pj') });
    const resolved = await worker.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri);
    assert.deepEqual(resolved.params.diagnostics.map(brief), []);
    const lines = text.split('\n');
    const line = lines.findIndex((entry) => entry.includes('area('));
    const definition = await worker.request('textDocument/definition', { textDocument: { uri }, position: { line, character: lines[line].indexOf('area(') + 1 } });
    assert.equal((Array.isArray(definition) ? definition[0] : definition).uri, `${WORKSPACE}/lib/geometry.pj`);
    assert.deepEqual(await worker.request('processj/readFile', { uri: `${WORKSPACE}/lib/geometry.pj` }), { text: example('lib/geometry.pj') });
    // A folder deleted takes its files along.
    worker.notify('processj/deleteFiles', { uris: [`${WORKSPACE}/lib`] });
    const gone = await worker.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri);
    assert.ok(gone.params.diagnostics.some((d: any) => missing.test(d.message)));
    assert.equal(await worker.request('processj/readFile', { uri: `${WORKSPACE}/lib/geometry.pj` }), null);
    // Only the workspace is the page's to write.
    worker.notify('processj/writeFiles', { files: [{ uri: 'file:///processj/include/JVM/std/io.pj', text: '' }, { uri: 'file:///elsewhere/x.pj', text: 'x' }] });
    assert.equal(await worker.request('processj/readFile', { uri: 'file:///elsewhere/x.pj' }), null);
    assert.notEqual((await worker.request('processj/readFile', { uri: 'file:///processj/include/JVM/std/io.pj' }))?.text, '');
  } finally {
    await worker.close();
  }
});

test('Convert to CSP in the worker writes the model beside the source and tells the page', async () => {
  const { worker } = await startWorker();
  try {
    const uri = `${WORKSPACE}/dining_philosophers.pj`;
    const text = example('dining_philosophers.pj');
    writeFiles(worker, { 'dining_philosophers.pj': text });
    await open(worker, uri, text);
    const converted = await worker.request('workspace/executeCommand', { command: 'processj.convertToCsp', arguments: [uri] });
    assert.equal(converted.cspFile, '/workspace/dining_philosophers.csp');
    const written = await worker.waitFor((m) => m.method === 'processj/fileWritten' && m.params.uri === `${WORKSPACE}/dining_philosophers.csp`);
    assert.match(written.params.text, /^-- Generated by processj-lsp from dining_philosophers\.pj/);
    await worker.waitFor((m) => m.method === 'window/showDocument' && m.params.uri === `${WORKSPACE}/dining_philosophers.csp`);
    assert.deepEqual(await worker.request('processj/readFile', { uri: written.params.uri }), { text: written.params.text });
  } finally {
    await worker.close();
  }
});

test('Check with FDR through processj/runRefines gives the report the Node server gets from refines', { skip: SKIP_REPLAY }, async () => {
  const name = 'dining_philosophers.pj';
  const text = example(name);
  const node = await startNode({ [name]: text }, (base) => ({ fdrPath: replayingRefines(base), liveViewer: false, graphPanel: true }));
  const { worker } = await startWorker();
  const asked: any[] = [];
  worker.onRequest('processj/runRefines', (params) => {
    asked.push(params);
    return recordedFrames(params.model);
  });
  try {
    await open(node.client, node.uri(name), text);
    const local = await node.client.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [node.uri(name)] }, 60_000);
    const uri = `${WORKSPACE}/${name}`;
    writeFiles(worker, { [name]: text });
    await open(worker, uri, text);
    const remote = await worker.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [uri] }, 60_000);
    // The runner was asked for the model the worker translated, at the top of the job.
    assert.equal(asked.length, 1);
    assert.deepEqual({ name: asked[0].name, mode: asked[0].mode, files: asked[0].files, timeoutMs: asked[0].timeoutMs }, { name: 'dining_philosophers.csp', mode: 'check', files: [], timeoutMs: 120_000 });
    assert.match(asked[0].model, /^-- Generated by processj-lsp from dining_philosophers\.pj/);
    assert.ok(remote.report.checks.some((check: any) => check.status === 'failed' && check.counterexample), 'the deadlock was found');
    assert.deepEqual(portable(remote.report, node.root), portable(local.report, node.root));
    // Everything after it works as for a local run: the graph opens on it, the lens says it, the diagnostics show it.
    const shown = await worker.waitFor((m) => m.method === 'processj/showGraph' && m.params.uri === uri);
    assert.match(shown.params.focus.check, /^program\//);
    const lenses = (await worker.request('textDocument/codeLens', { textDocument: { uri } })).map((lens: any) => lens.command.title);
    assert.ok(lenses.some((title: string) => /^FDR: .*deadlock.* · show graph$/.test(title)), lenses.join(', '));
    await worker.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri && m.params.diagnostics.some((d: any) => d.source === 'fdr'));
    const { payload } = await worker.request('processj/processNetwork', { textDocument: { uri }, html: false });
    assert.ok(payload.chips.some((chip: any) => chip.producer === 'fdr' && chip.status === 'failed'));
    const report = await worker.request('processj/fdrReport', { textDocument: { uri } });
    assert.deepEqual(report.checks.map((check: any) => check.status), remote.report.checks.map((check: any) => check.status));
    // The page hears of the files the check wrote: the model beside the source, and the reports.
    const written = worker.messages.filter((m) => m.method === 'processj/fileWritten').map((m) => m.params.uri);
    assert.ok(written.includes(`${WORKSPACE}/dining_philosophers.csp`));
    assert.ok(written.some((entry) => /\.fdr\.pjreport$/.test(entry)) && written.some((entry) => /\.fdr\.json$/.test(entry)), written.join(', '));
  } finally {
    await worker.close();
    await node.close();
  }
});

test('a CSPm file is type-checked and checked with FDR through processj/runRefines', { skip: SKIP_REPLAY }, async () => {
  const name = 'dining.csp';
  const text = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'cspm', name), 'utf8');
  const node = await startNode({ [name]: text }, (base) => ({ fdrPath: replayingRefines(base), liveViewer: false, graphPanel: true }));
  const { worker } = await startWorker();
  const asked: any[] = [];
  worker.onRequest('processj/runRefines', (params) => {
    asked.push(params);
    // refines --typecheck prints nothing for a file without type errors.
    return params.mode === 'typecheck' ? { exitCode: 0, frames: [] } : recordedFrames(params.model);
  });
  try {
    await open(node.client, node.uri(name), text, 'cspm');
    const local = await node.client.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [node.uri(name)] }, 60_000);
    const uri = `${WORKSPACE}/${name}`;
    writeFiles(worker, { [name]: text });
    await open(worker, uri, text, 'cspm');
    // FDR's type check on open, on the runner.
    await worker.waitFor((m) => m.method === 'processj/runRefines' && m.params.mode === 'typecheck');
    assert.deepEqual({ name: asked[0].name, files: asked[0].files, model: asked[0].model }, { name, files: [], model: text });
    const lenses = (await worker.request('textDocument/codeLens', { textDocument: { uri } })).map((lens: any) => lens.command.title);
    assert.deepEqual(lenses, ['Process network', 'FDR: check & show graph']);
    const remote = await worker.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [uri] }, 60_000);
    assert.deepEqual(remote.report.checks.map((check: any) => `${check.label}:${check.status}`), ['SYSTEM :[deadlock free [F]]:failed']);
    assert.deepEqual(portable(remote.report, node.root), portable(local.report, node.root));
    const after = (await worker.request('textDocument/codeLens', { textDocument: { uri } })).map((lens: any) => lens.command.title);
    assert.deepEqual(after, ['Process network', 'FDR: deadlock after 6 steps · show graph']);
  } finally {
    await worker.close();
    await node.close();
  }
});

test('an include of a project file goes to the runner with the model, at its project path', async () => {
  const { worker } = await startWorker();
  const asked: any[] = [];
  worker.onRequest('processj/runRefines', (params) => {
    asked.push(params);
    return { exitCode: -1, frames: [], error: 'Stopped: took longer than 120s.' };
  });
  try {
    const spec = 'channel tick\nSPEC = tick -> SPEC\n';
    const model = 'include "../specs/spec.csp"\nP = tick -> P\nassert P [T= SPEC\n';
    writeFiles(worker, { 'specs/spec.csp': spec, 'models/check.csp': model });
    const uri = `${WORKSPACE}/models/check.csp`;
    await open(worker, uri, model, 'cspm');
    const typecheck = await worker.waitFor((m) => m.method === 'processj/runRefines');
    assert.deepEqual(typecheck.params, { model: 'include "specs/spec.csp"\nP = tick -> P\nassert P [T= SPEC\n', name: 'check.csp', files: [{ path: 'specs/spec.csp', text: spec }], mode: 'typecheck', timeoutMs: 20_000 });
    // A runner that fails says why, as refines would.
    const checked = await worker.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [uri] }, 30_000);
    assert.equal(checked.report.checks[0].status, 'error');
    assert.match(checked.report.checks[0].message, /Stopped: took longer than 120s\./);
  } finally {
    await worker.close();
  }
});

test('compiler diagnostics come from processj/compile: after a pause in typing, one request at a time per file', async () => {
  const { worker } = await startWorker();
  const answers: Array<{ params: any; answer: (result: unknown) => void }> = [];
  worker.onRequest('processj/compile', (params) => new Promise((resolve) => answers.push({ params, answer: resolve })));
  try {
    const uri = `${WORKSPACE}/use_import.pj`;
    const text = example('use_import.pj');
    writeFiles(worker, { 'use_import.pj': text, 'lib/geometry.pj': example('lib/geometry.pj'), 'unrelated.pj': 'public void other() { }\n' });
    await open(worker, uri, text);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(answers.length, 0, 'no compile before the pause');
    const first = await worker.waitFor((m) => m.method === 'processj/compile', 5_000);
    // The file and the project files it imports, as the runner's compiler resolves them; not the rest of the project.
    assert.deepEqual({ ...first.params, files: first.params.files.map((file: any) => file.path).sort() }, { entry: 'use_import.pj', mode: 'check', files: ['lib/geometry.pj', 'use_import.pj'] });
    assert.equal(first.params.files.find((file: any) => file.path === 'use_import.pj').text, text);
    // An edit cancels the request; the next one waits for the client's answer to it.
    const edited = `${text}\n`;
    worker.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: edited }] });
    await worker.waitFor((m) => m.method === '$/cancelRequest' && m.params.id === first.id, 3_000);
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.equal(answers.length, 1, 'one request in flight per file');
    answers[0].answer({ output: 'use_import.pj:1: stale\nError number: 1\n', ok: false });
    const second = await worker.waitFor((m) => m.method === 'processj/compile', 5_000);
    assert.equal(second.params.files.find((file: any) => file.path === 'use_import.pj').text, edited);
    const line = edited.split('\n').findIndex((entry) => entry.includes('area('));
    // A line the file does not have (the runner mapped a merged project's line wrongly): said at the top.
    const past = edited.split('\n').length + 5;
    answers[1].answer({
      output: [
        '\x1b[2mprocessjc use_import.pj\x1b[0m',
        `use_import.pj:${line + 1}: Cannot assign value of type double to variable of type int.`,
        'Error number: 3058',
        'lib/geometry.pj:5: Something in the library.',
        'Error number: 3029',
        `use_import.pj:${past}: No suitable procedure found.`,
        'Error number: 3047',
        '\x1b[2mcompilation failed\x1b[0m',
        '',
      ].join('\n'),
      ok: false,
    });
    const published = await worker.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri && m.params.version === 2 && m.params.diagnostics.some((d: any) => d.source === 'processj'));
    const compiler = published.params.diagnostics.filter((d: any) => d.source === 'processj').map((d: any) => `${d.range.start.line} ${d.code} ${d.message}`);
    assert.deepEqual(compiler, [
      `${line} 3058 Cannot assign value of type double to variable of type int.`,
      '0 3029 In geometry.pj:5: Something in the library.',
      `0 3047 The compiler reports this at line ${past}, past the end of use_import.pj: No suitable procedure found.`,
    ]);
    assert.ok(!worker.messages.some((m) => m.method === 'processj/compile' && m.params.files.some((file: any) => file.path === 'unrelated.pj')));
  } finally {
    for (const pending of answers) pending.answer({ output: '', ok: true });
    await worker.close();
  }
});

test('processj/buildInputs: the project for Run and Build, the entry and the files it imports as the compiler should read them', async () => {
  const { worker } = await startWorker();
  worker.onRequest('processj/compile', () => ({ output: '', ok: true }));
  const waits = 'package lib;\nimport std.*;\n\npublic void wait1() { timer t; t.timeout(t.read() + 1); }\n\npublic void twice() { wait1(); wait1(); }\n';
  const main = 'import std.*;\nimport lib.waits;\n\npublic void run2() { twice(); }\n\npublic void main(string[] args) { run2(); println("ok"); }\n';
  // Not imported by main.pj: it would need an annotation, and is sent as it is.
  const other = 'import std.*;\npublic void w() { timer t; t.timeout(1); }\npublic void v() { w(); }\n';
  try {
    writeFiles(worker, {
      'yield_through_calls.pj': example('yield_through_calls.pj'),
      'main.pj': main,
      'lib/waits.pj': waits,
      'other.pj': other,
      'notes.txt': 'not ProcessJ\n',
      'model.csp': 'channel a\nP = a -> P\n',
    });
    const lines = (text: string): number => text.split('\n').length;

    // The example: `twice` suspends only through `wait1`, so it is marked; main and wait1 are not.
    const single = await worker.request('processj/buildInputs', { entry: 'yield_through_calls.pj' });
    assert.equal(single.entry, 'yield_through_calls.pj');
    const marked = single.files.find((f: any) => f.path === 'yield_through_calls.pj').text;
    assert.match(marked, /public void twice\(\) \[yield=true\] \{ wait1\(\); wait1\(\); \}/);
    assert.match(marked, /public void wait1\(\) \{ timer t;/);
    assert.match(marked, /public void main\(string\[\] args\) \{ twice\(\);/);
    assert.equal(lines(marked), lines(example('yield_through_calls.pj')), 'no line added or removed');
    assert.deepEqual(single.augmented, ['yield_through_calls.pj']);

    // An entry with an import: both files annotated, each in its own context; the rest of the project as it is.
    const both = await worker.request('processj/buildInputs', { entry: `${WORKSPACE}/main.pj` });
    const byPath = new Map<string, string>(both.files.map((f: any) => [f.path, f.text]));
    assert.deepEqual([...byPath.keys()].sort(), ['lib/waits.pj', 'main.pj', 'model.csp', 'notes.txt', 'other.pj', 'yield_through_calls.pj']);
    assert.match(byPath.get('main.pj')!, /public void run2\(\) \[yield=true\] \{ twice\(\); \}/);
    assert.match(byPath.get('lib/waits.pj')!, /public void twice\(\) \[yield=true\] \{ wait1\(\); wait1\(\); \}/);
    assert.equal(lines(byPath.get('lib/waits.pj')!), lines(waits));
    assert.equal(byPath.get('other.pj'), other, 'a file the entry does not reach is sent as it is');
    assert.equal(byPath.get('yield_through_calls.pj'), example('yield_through_calls.pj'));
    assert.equal(byPath.get('notes.txt'), 'not ProcessJ\n');
    assert.deepEqual(both.augmented.sort(), ['lib/waits.pj', 'main.pj']);

    // The entry as the background compile sends it (runRemoteCheck): the same text. An open buffer wins over the file.
    const edited = main.replace('println("ok")', 'println("edited")');
    await open(worker, `${WORKSPACE}/main.pj`, edited);
    const asked = await worker.waitFor((m) => m.method === 'processj/compile', 5_000);
    const fromBuffer = await worker.request('processj/buildInputs', { entry: 'main.pj' });
    const sent = fromBuffer.files.find((f: any) => f.path === 'main.pj').text;
    assert.match(sent, /println\("edited"\)/);
    assert.equal(sent, asked.params.files.find((f: any) => f.path === 'main.pj').text);

    // Nothing for what is not a .pj file of the workspace.
    for (const entry of ['notes.txt', 'model.csp', 'missing.pj', '../outside.pj', 'file:///elsewhere/x.pj']) {
      assert.equal(await worker.request('processj/buildInputs', { entry }), null, entry);
    }
  } finally {
    await worker.close();
  }
});

test('processj/buildInputs is the browser build\'s: the Node server, whose files are on disk, answers null', async () => {
  const node = await startNode({ 'main.pj': 'public void main(string[] args) { }\n' }, () => ({}));
  try {
    assert.equal(await node.client.request('processj/buildInputs', { entry: node.uri('main.pj') }), null);
  } finally {
    await node.close();
  }
});

test('the compiler runs unasked only on files inside the workspace, and the log says why for one outside', async () => {
  const { worker } = await startWorker();
  const asked: string[] = [];
  worker.onRequest('processj/compile', (params) => {
    asked.push(params.entry);
    return { output: '', ok: true };
  });
  try {
    const text = 'public void main(string[] args) { }\n';
    await open(worker, 'file:///elsewhere/outside.pj', text);
    await worker.waitFor((m) => m.method === 'window/logMessage' && /^not running the compiler on \/elsewhere\/outside\.pj: it is outside the workspace/.test(m.params.message), 5_000);
    await open(worker, `${WORKSPACE}/inside.pj`, text);
    // Both waited out the same pause; only the file inside the workspace was sent.
    await worker.waitFor((m) => m.method === 'processj/compile', 5_000);
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(asked, ['inside.pj']);
  } finally {
    await worker.close();
  }
});

test('the graph viewer page and manifest of the browser build', () => {
  workerBundle();
  const dir = path.dirname(WORKER_BUNDLE);
  const html = fs.readFileSync(path.join(dir, 'graph-viewer.html'), 'utf8');
  assert.match(html, /<html lang="en" data-mode="webview">/);
  // In the page's Content-Security-Policy (a meta element, so its quotes are escaped).
  const nonce = /script-src &#39;nonce-([^&]+)&#39;/.exec(html)?.[1];
  assert.ok(nonce);
  // Every script runs with the page's nonce: the stand-in for acquireVsCodeApi first, then the viewer.
  const scripts = [...html.matchAll(/<script([^>]*)>/g)].map((m) => m[1]).filter((attributes) => !/type="application\/json"/.test(attributes));
  assert.deepEqual(scripts, [` nonce="${nonce}"`, ` nonce="${nonce}"`]);
  assert.ok(html.indexOf('window.acquireVsCodeApi') < html.indexOf('const buildExcalidrawScene'));
  assert.match(html, /window\.parent\.postMessage\(\{ pjViewer: message \}, '\*'\)/);
  assert.match(html, /pjViewer: \{ type: 'ready' \}/);
  // The IDE's theme, only from the embedding page.
  assert.match(html, /event\.source === window\.parent && data && data\.type === 'theme'/);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.version, VERSION);
  assert.ok(typeof manifest.commit === 'string' && manifest.commit.length > 0);
  for (const file of ['processj-lsp.worker.js', 'graph-viewer.html']) assert.ok(manifest.files.includes(file), file);
  // The nonce is made from the page itself (scripts/build-browser.mjs), so the same source builds the same file.
  assert.equal(createHash('sha256').update(html.split(nonce!).join('processjViewerNonceSlot')).digest('base64').slice(0, 24), nonce);
  // The layout engine is a file of its own, named by its content, which the worker loads on its first layout.
  const elk = manifest.files.filter((file: string) => /^elk\.[0-9a-f]{12}\.js$/.test(file));
  assert.equal(elk.length, 1, manifest.files.join(', '));
  const worker = fs.readFileSync(WORKER_BUNDLE, 'utf8');
  assert.ok(worker.includes(JSON.stringify(elk[0])) && !worker.includes('org.eclipse.elk'), 'the worker names the engine but does not carry it');
  assert.ok(fs.readFileSync(path.join(dir, elk[0]), 'utf8').includes('org.eclipse.elk'));
});
