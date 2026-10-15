/**
 * FDR's results on the graph, through the language server: the published
 * report (every target's checks of the current version), the viewer opened on
 * a failure or refreshed when a page is already open, the verdict lens and
 * the diagnostics' Show in graph, the hover, the state machines, and the
 * fdrShowGraph setting. refines is replayed from the recordings
 * (fdr-recordings.ts), so these run without FDR and always see the same
 * counterexamples.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { IMPORTED, replayingRefines } from './fdr-recordings';
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

/** An open page of the live viewer: its event stream, and what it has been told. */
function openPage(base: string): { events: string[]; close(): void } {
  const events: string[] = [];
  const request = http.get(`${base}events`, (response) => response.on('data', (chunk: Buffer) => events.push(chunk.toString('utf8'))));
  request.on('error', () => undefined);
  return { events, close: () => request.destroy() };
}

async function until<T>(get: () => T | undefined, what: string, timeoutMs = 10_000): Promise<T> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline;) {
    const value = get();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

interface Setup {
  client: Client;
  dir: string;
  uri: string;
  text: string;
  close(): Promise<void>;
}

async function start(options: Record<string, unknown>, capabilities: Record<string, unknown> = {}): Promise<Setup> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-fdr-graph-'));
  const file = path.join(dir, 'dining_philosophers.pj');
  const text = fs.readFileSync(path.join(ROOT, 'examples', 'dining_philosophers.pj'), 'utf8');
  fs.writeFileSync(file, text);
  const client = new Client();
  const uri = pathToFileURL(file).toString();
  await client.request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(dir).toString(),
    capabilities: {
      window: { showDocument: { support: true } },
      textDocument: { publishDiagnostics: { relatedInformation: true }, codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'refactor'] } } } },
      ...capabilities,
    },
    initializationOptions: { installDir: path.join(dir, 'no-processj'), fdrPath: replayingRefines(dir), ...options },
  });
  client.notify('initialized', {});
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'processj', version: 1, text } });
  await client.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri);
  return {
    client,
    dir,
    uri,
    text,
    close: async () => {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const external = (client: Client): any[] => client.messages.filter((m) => m.method === 'window/showDocument' && m.params.external === true);

/** refines replayed from the recordings after `seconds`: a check that takes a while (the group is killed on a timeout). */
function slowRefines(dir: string, seconds: number): string {
  const replay = replayingRefines(dir);
  const wrapper = path.join(dir, 'slow-refines');
  fs.writeFileSync(wrapper, `#!/bin/sh\nsleep ${seconds}\nexec ${JSON.stringify(replay)} "$@"\n`);
  fs.chmodSync(wrapper, 0o755);
  return wrapper;
}

/** A server on these files (paths relative to a fresh directory, its workspace), the first one open. */
async function startOn(files: Readonly<Record<string, string>>, options: Record<string, unknown> = {}, refines: (dir: string) => string = replayingRefines): Promise<Setup & { file: (name: string) => string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-fdr-graph-'));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  const [first, text] = Object.entries(files)[0];
  const client = new Client();
  const uri = pathToFileURL(path.join(dir, first)).toString();
  await client.request('initialize', {
    processId: process.pid,
    rootUri: pathToFileURL(dir).toString(),
    capabilities: { window: { showDocument: { support: true } }, workspace: { codeLens: { refreshSupport: true } }, textDocument: { publishDiagnostics: { relatedInformation: true }, codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ['quickfix', 'refactor'] } } } } },
    initializationOptions: { installDir: path.join(dir, 'no-processj'), fdrPath: refines(dir), ...options },
  });
  client.notify('initialized', {});
  client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'processj', version: 1, text } });
  await client.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri);
  return {
    client,
    dir,
    uri,
    text,
    file: (name) => path.join(dir, name),
    close: async () => {
      await client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

const fdrLens = async (client: Client, uri: string): Promise<any[]> => ((await client.request('textDocument/codeLens', { textDocument: { uri } })).result as any[]).filter((lens) => /^FDR/.test(lens.command.title));

test('Check with FDR opens the graph on the failure; the page then shows every target\'s results, its machines, and follows the next checks', { skip: SKIP }, async () => {
  const { client, uri, text, dir, close } = await start({});
  try {
    // A failed check: a page opens on its result; the text report is written, not opened.
    const checked = await client.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [uri] }, 60_000);
    assert.equal(checked.error, undefined);
    const pages = external(client);
    assert.equal(pages.length, 1);
    const page = new URL(pages[0].params.uri);
    assert.match(page.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(page.searchParams.get('check'), 'program/deadlock-free');
    assert.ok(fs.existsSync(checked.result.reportFile));
    assert.ok(!client.messages.some((m) => m.method === 'window/showDocument' && m.params.uri === pathToFileURL(checked.result.reportFile).toString()), 'the text report is not opened as well');
    const base = `${page.origin}${page.pathname}`;

    // What the page shows: FDR's checks (named by target), placed on the program view, the circle drawn.
    const payload = JSON.parse((await get(`${base}payload`)).body);
    const fdr = payload.chips.filter((chip: any) => chip.producer === 'fdr');
    assert.deepEqual(fdr.map((chip: any) => [chip.check, chip.status, chip.target]), [['program/deadlock-free', 'failed', 'program'], ['program/no-runtime-errors', 'passed', 'program'], ['program/terminates', 'failed', 'program']]);
    const overlay = payload.overlays.find((entry: any) => entry.check === 'program/deadlock-free');
    assert.equal(overlay.view, payload.views.find((view: any) => view.kind === 'program').id);
    assert.deepEqual(overlay.unplaced, []);
    assert.equal(overlay.cycles[0].nodes.length, 6);

    // A stuck philosopher's state machine, with FDR's states for it in order.
    const stuck = overlay.processes.find((entry: any) => entry.label.startsWith('philosopher(0'));
    const node = payload.views.find((view: any) => view.id === overlay.view).nodes.find((entry: any) => entry.id === stuck.node);
    const query = new URLSearchParams({ target: 'program', ref: node.machine, check: 'program/deadlock-free', process: stuck.key });
    const machine = JSON.parse((await get(`${base}machine?${query.toString()}`)).body);
    assert.equal(machine.label, 'philosopher');
    assert.equal(machine.model, 'the model FDR checked (the whole program)');
    assert.deepEqual(machine.trail.map((entry: any) => entry.id ?? null), [null, 'philosopher__27', 'philosopher__28']);
    assert.equal(machine.process.status, 'blocked');
    assert.match(JSON.parse((await get(`${base}machine?target=program&ref=nothing`)).body).error, /^No state machine for this process/);
    // Without a result, a machine of a procedure on its own comes from that procedure's own model.
    const chopstick = text.split('\n').findIndex((entry) => /void chopstick\(/.test(entry));
    const holder = payload.views.find((view: any) => view.id === overlay.view).nodes.find((entry: any) => entry.name.startsWith('chopstick('));
    const plain = JSON.parse((await get(`${base}machine?target=${encodeURIComponent(`proc:chopstick:${chopstick}`)}&ref=${encodeURIComponent(holder.machine)}`)).body);
    assert.equal(plain.label, 'chopstick');
    assert.equal(plain.model, 'the CSP model of chopstick on its own');
    assert.equal(plain.trail, undefined);

    // The verdict lens opens the graph on that result; the code action, on the stuck process.
    const lenses = (await client.request('textDocument/codeLens', { textDocument: { uri } })).result;
    const verdict = lenses.find((lens: any) => lens.command.title === 'FDR: deadlock (4 steps) · show graph');
    assert.deepEqual(verdict.command.arguments, [uri, 'viewer', { check: 'program/deadlock-free' }]);
    assert.equal(verdict.command.command, 'processj.showConcurrencyReport');
    const published = await client.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri && m.params.diagnostics.some((d: any) => d.source === 'fdr'));
    const onWrite = published.params.diagnostics.find((d: any) => d.source === 'fdr' && d.range.start.line === 27);
    const actions = (await client.request('textDocument/codeAction', { textDocument: { uri }, range: onWrite.range, context: { diagnostics: [onWrite] } })).result;
    const show = actions.find((action: any) => action.title === 'Show in graph');
    assert.equal(show.kind, 'quickfix');
    assert.equal(show.command.arguments[2].check, 'program/deadlock-free');
    assert.match(show.command.arguments[2].process, /^branch:/);

    // Hover on the stuck write: what FDR found there, and the steps that led to it.
    const line = text.split('\n')[27];
    const hover = (await client.request('textDocument/hover', { textDocument: { uri }, position: { line: 27, character: line.indexOf('right.write') + 2 } })).result;
    assert.match(hover.contents.value, /^\*\*FDR · Deadlock freedom\*\* \(the whole program\): deadlock after 4 steps/);
    assert.match(hover.contents.value, /waits to write true on right/);
    assert.match(hover.contents.value, /one of the 6 processes of a circular wait/);
    assert.match(hover.contents.value, /philosopher\(1, …\) and philosopher\(2, …\) are stuck here too\./);
    assert.match(hover.contents.value, /\n4\. philosopher\(2, …\) writes true on p2f2/);

    // A procedure checked on its own: its results join the program's, on its own view.
    const philosopher = text.split('\n').findIndex((entry) => /void philosopher\(/.test(entry));
    const alone = await client.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [uri, 'philosopher', philosopher] }, 60_000);
    assert.equal(alone.error, undefined);
    // It passes, and the graph still shows it (fdrShowGraph: always). Nothing has connected to the first
    // page yet, so a page opens on this check (an open page is moved instead: below); the report is written, not opened.
    assert.equal(external(client).length, 2);
    assert.equal(new URL(external(client)[1].params.uri).searchParams.get('check'), `proc:philosopher:${philosopher}/deadlock-free`);
    assert.ok(fs.existsSync(alone.result.reportFile));
    assert.ok(!client.messages.some((m) => m.method === 'window/showDocument' && m.params.uri === pathToFileURL(alone.result.reportFile).toString()), 'the text report is not opened as well');
    const both = JSON.parse((await get(`${base}payload`)).body);
    const ids = both.chips.filter((chip: any) => chip.producer === 'fdr').map((chip: any) => [chip.check, chip.status]);
    const p = `proc:philosopher:${philosopher}`;
    assert.deepEqual(ids, [['program/deadlock-free', 'failed'], ['program/no-runtime-errors', 'passed'], ['program/terminates', 'failed'], [`${p}/deadlock-free`, 'passed'], [`${p}/divergence-free`, 'passed'], [`${p}/no-runtime-errors`, 'passed'], [`${p}/deterministic`, 'passed']]);
    assert.equal(both.chips.find((chip: any) => chip.check === `${p}/deadlock-free`).targetLabel, 'philosopher on its own');
    assert.equal(both.chips.find((chip: any) => chip.check === 'program/deadlock-free').targetLabel, undefined);
    // Assumptions both models share are said once; the others say which check they are about.
    const report = both.reports.find((entry: any) => entry.producer === 'fdr');
    assert.ok(report.assumptions.some((entry: string) => entry.startsWith('philosopher on its own: ')));
    assert.ok(report.assumptions.some((entry: string) => /^Time is abstract/.test(entry)));

    // A page that is open is told to show the next result: no second tab.
    const open = openPage(base);
    await until(() => (open.events.join('').includes(': connected') ? true : undefined), 'the page to connect');
    const again = await client.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [uri] }, 60_000);
    assert.equal(again.error, undefined);
    const update = await until(() => open.events.join('').match(/event: update\ndata: (.*)\n/)?.[1], 'the page to be told');
    assert.deepEqual(JSON.parse(update).focus, { check: 'program/deadlock-free' });
    assert.equal(external(client).length, 2, 'no further page: the open one is moved');
    assert.ok(client.messages.some((m) => m.method === 'window/showMessage' && /the graph page open for this file now shows the result/.test(m.params.message)));
    // Show in graph on the stuck process: the open page selects it.
    const before = open.events.length;
    await client.request('workspace/executeCommand', show.command);
    const focused = await until(() => open.events.slice(before).join('').match(/event: update\ndata: (.*)\n/)?.[1], 'the page to focus the process');
    assert.equal(JSON.parse(focused).focus.process, show.command.arguments[2].process);
    open.close();

    // An edit: FDR's results no longer describe the text, and the page forgets them.
    client.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: `${text}\n` }] });
    await client.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri && m.params.version === 2);
    const edited = JSON.parse((await get(`${base}payload`)).body);
    assert.deepEqual(edited.chips.filter((chip: any) => chip.producer === 'fdr'), []);
    const fresh = (await client.request('textDocument/codeLens', { textDocument: { uri } })).result;
    assert.ok(fresh.some((lens: any) => lens.command.title === 'FDR: check program & show graph' && lens.command.command === 'processj.checkWithFdr'), 'a fresh lens runs the check');
    assert.ok(fs.existsSync(dir));
  } finally {
    await close();
  }
});

test('a procedure checked on its own is shown on its own view, its parameters as ports', { skip: SKIP }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pj-fdr-graph-'));
  const file = path.join(dir, 'commstime.pj');
  const text = fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'processj', 'commstime.pj'), 'utf8');
  fs.writeFileSync(file, text);
  const client = new Client();
  try {
    const uri = pathToFileURL(file).toString();
    await client.request('initialize', { processId: process.pid, rootUri: pathToFileURL(dir).toString(), capabilities: { window: { showDocument: { support: true } } }, initializationOptions: { installDir: path.join(dir, 'no-processj'), fdrPath: replayingRefines(dir) } });
    client.notify('initialized', {});
    client.notify('textDocument/didOpen', { textDocument: { uri, languageId: 'processj', version: 1, text } });
    await client.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri);
    const succ = text.split('\n').findIndex((entry) => /void succ\(/.test(entry));
    const checked = await client.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [uri, 'succ', succ] }, 60_000);
    assert.equal(checked.error, undefined);
    // Leaving the modelled integers is a failure worth a look: the page opens on it.
    const page = new URL(external(client)[0].params.uri);
    assert.equal(page.searchParams.get('check'), `proc:succ:${succ}/no-runtime-errors`);
    const payload = JSON.parse((await get(`${page.origin}${page.pathname}payload`)).body);
    const chip = payload.chips.find((entry: any) => entry.check === `proc:succ:${succ}/no-runtime-errors`);
    const view = payload.views.find((entry: any) => entry.id === chip.preferredView);
    assert.deepEqual([view.kind, view.procedure], ['procedure', 'succ']);
    assert.deepEqual(view.nodes.filter((node: any) => node.kind === 'port').map((node: any) => node.label).sort(), ['in', 'out']);
    const overlay = payload.overlays.find((entry: any) => entry.check === chip.check && entry.view === view.id);
    assert.deepEqual(overlay.unplaced, []);
    assert.equal(overlay.relocated, undefined);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a procedure whose arguments decide its network is checked as its calls give it, and says so in the report, the lens and the diagnostics', { skip: SKIP }, async () => {
  const fifo = path.join(ROOT, 'test', 'fixtures', 'fifo');
  const read = (name: string): string => fs.readFileSync(path.join(fifo, name), 'utf8');
  const { client, uri, text, close } = await startOn({ 'blocks.pj': read('blocks.pj') });
  try {
    const line = text.split('\n').findIndex((entry) => /void altFIFO\(/.test(entry));
    const checked = await client.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [uri, 'altFIFO'] }, 60_000);
    assert.equal(checked.error, undefined);
    assert.deepEqual(checked.result.report.checks.map((c: any) => [c.id, c.status, c.target.arguments]), [['deadlock-free', 'passed', 'size = 6'], ['divergence-free', 'passed', 'size = 6'], ['no-runtime-errors', 'passed', 'size = 6'], ['deterministic', 'passed', 'size = 6']]);
    assert.ok(checked.result.report.assumptions.some((entry: string) => entry.startsWith('altFIFO checked with size = 6 (the call at line 75)')));
    // The editor's message, the text report and the lens name the arguments.
    assert.ok(client.messages.some((m) => m.method === 'window/showMessage' && /^FDR, procedure altFIFO \(size = 6\): no deadlock, [\d,]+ states$/.test(m.params.message)), 'the message names the arguments');
    assert.match(fs.readFileSync(checked.result.reportFile, 'utf8'), /^Checked: procedure altFIFO on its own, with size = 6 \(the call at line 75\) · /m);
    const lens = (await fdrLens(client, uri)).find((entry) => entry.range.start.line === line);
    assert.match(lens.command.title, /^FDR: no deadlock, [\d,]+ states · size = 6 · show graph$/);
    // A check that passes opens the graph too (fdrShowGraph: always), on that procedure's check.
    assert.ok(external(client).some((m) => /[?&]check=proc%3AaltFIFO%3A\d+%2Fdeadlock-free$/.test(m.params.uri)), 'the passing check opened the graph on itself');
  } finally {
    await close();
  }
  // A broken copy: the deadlock's diagnostics say which arguments, and the graph draws the six stages it was found in.
  const broken = await startOn({ 'blocks_alt.pj': read('blocks_alt.pj') });
  try {
    const line = broken.text.split('\n').findIndex((entry) => /void altFIFO\(/.test(entry));
    const checked = await broken.client.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [broken.uri, 'altFIFO', line] }, 60_000);
    assert.equal(checked.error, undefined);
    const published = await broken.client.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === broken.uri && m.params.diagnostics.some((d: any) => d.source === 'fdr'));
    const fdr = published.params.diagnostics.filter((d: any) => d.source === 'fdr');
    assert.ok(fdr.length && fdr.every((d: any) => d.message.startsWith('FDR (altFIFO on its own, size = 6): ')), fdr.map((d: any) => d.message).join('\n'));
    const page = new URL(external(broken.client)[0].params.uri);
    assert.equal(page.searchParams.get('check'), `proc:altFIFO:${line}/deadlock-free`);
    const payload = JSON.parse((await get(`${page.origin}${page.pathname}payload`)).body);
    const chip = payload.chips.find((entry: any) => entry.check === `proc:altFIFO:${line}/deadlock-free`);
    const view = payload.views.find((entry: any) => entry.id === chip.preferredView);
    assert.deepEqual([view.kind, view.procedure], ['procedure', 'altFIFO']);
    assert.ok(view.notes.some((note: string) => note.startsWith('Drawn with size = 6')));
    assert.equal(view.nodes.filter((node: any) => node.name === 'id(in, middle)').length, 5);
    const overlay = payload.overlays.find((entry: any) => entry.check === chip.check && entry.view === view.id);
    assert.deepEqual(overlay.unplaced, []);
    assert.ok(overlay.processes.every((entry: any) => entry.exact));
  } finally {
    await broken.close();
  }
});

test('fdrShowGraph never opens the text report instead; a client with a graph panel is asked to show it there', { skip: SKIP }, async () => {
  const never = await start({ fdrShowGraph: 'never' });
  try {
    const checked = await never.client.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [never.uri] }, 60_000);
    assert.equal(external(never.client).length, 0);
    assert.ok(never.client.messages.some((m) => m.method === 'window/showDocument' && m.params.uri === pathToFileURL(checked.result.reportFile).toString()));
  } finally {
    await never.close();
  }
  const panel = await start({ graphPanel: true, verificationNotifications: true });
  try {
    await panel.client.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [panel.uri] }, 60_000);
    const shown = await panel.client.waitFor((m) => m.method === 'processj/showGraph');
    assert.deepEqual(shown.params, { uri: panel.uri, focus: { check: 'program/deadlock-free' } });
    assert.equal(external(panel.client).length, 0, 'no browser page next to the panel');
    assert.ok(panel.client.messages.some((m) => m.method === 'processj/verificationChanged' && m.params.uri === panel.uri));
    // The panel's own requests: the page with the focus in it, one state machine.
    const page = await panel.client.request('processj/processNetwork', { textDocument: { uri: panel.uri }, nonce: 'abcdefghijklmnop0123', focus: { check: 'program/deadlock-free' } });
    assert.deepEqual(page.result.payload.focus, { check: 'program/deadlock-free' });
    const view = page.result.payload.views.find((entry: any) => entry.kind === 'program');
    const ref = view.nodes.find((node: any) => node.name.startsWith('chopstick(')).machine;
    const machine = await panel.client.request('processj/processNetwork', { textDocument: { uri: panel.uri }, machine: { target: 'program', ref } });
    assert.equal(machine.result.machine.label, 'chopstick');
    assert.equal(machine.result.machine.trail, undefined, 'without a process, no run');
  } finally {
    await panel.close();
  }
});

test('the hover inside a par block tells the process whose statement is under the cursor, and nothing where nobody is stuck', { skip: SKIP }, async () => {
  const { client, uri, text, close } = await startOn({ 'par_deadlock.pj': fs.readFileSync(path.join(ROOT, 'examples', 'par_deadlock.pj'), 'utf8') });
  try {
    await client.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [uri] }, 60_000);
    const lines = text.split('\n');
    const hover = async (pattern: RegExp): Promise<string> => {
      const line = lines.findIndex((entry) => pattern.test(entry));
      const result = (await client.request('textDocument/hover', { textDocument: { uri }, position: { line, character: lines[line].search(/\S/) + 1 } })).result;
      return result?.contents?.value ?? '';
    };
    // The write branch 1 is stuck at is about branch 1, not about main waiting at its par.
    const write = await hover(/^\s*c\.write\(1\);/);
    assert.match(write, /\n\nbranch 1 waits to write 1 on c \(line 12\): branch 2, the only reader of c/);
    assert.doesNotMatch(write, /main waits at its par|stuck here too/);
    // main is told on its par's first line; the statements after the stuck writes have nothing from FDR.
    assert.match(await hover(/^\s*par \{/), /\n\nmain waits at its par for branch 1 and branch 2 to finish \(line 10\)/);
    for (const pattern of [/^\s*int x = d\.read\(\);/, /println\("left got "/, /^\s*int y = c\.read\(\);/]) assert.doesNotMatch(await hover(pattern), /FDR ·/, String(pattern));
  } finally {
    await close();
  }
  // A run that relies on what the model abstracts says so where it is read.
  const alt = await startOn({ 'alt_skip.pj': fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'processj', 'alttest.pj'), 'utf8') });
  try {
    const checked = await alt.client.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [alt.uri] }, 60_000);
    assert.equal(checked.result.report.checks[0].status, 'failed');
    const said = alt.client.messages.find((m) => m.method === 'window/showMessage' && /^FDR, the program/.test(m.params.message));
    assert.match(said.params.message, /the real program may not do this: the run relies on something the model abstracts/);
    const line = alt.text.split('\n').findIndex((entry) => /out\.write\(42\)/.test(entry));
    const hover = (await alt.client.request('textDocument/hover', { textDocument: { uri: alt.uri }, position: { line, character: 6 } })).result;
    assert.match(hover.contents.value, /\*\*Caveat:\*\* reader takes the skip guard at line 18 \(step 2\)/);
  } finally {
    await alt.close();
  }
});

test('a program too big to model is not checked and says so: a warning, and a lens that checks again', { skip: SKIP }, async () => {
  const source = ['public void worker(chan<int>.write out, int i) {', '    out.write(i);', '}', 'public void main(string[] args) {', '    chan<int> c;', '    par {', '        par for (int i = 0; i < 3000; i++) {', '            worker(c.write, i);', '        }', '        c.read();', '    }', '}', ''].join('\n');
  const { client, uri, file, close } = await startOn({ 'too_big.pj': source });
  try {
    const checked = await client.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [uri] }, 60_000);
    assert.deepEqual(checked.result.report.checks.map((check: any) => check.status), ['skipped', 'skipped', 'skipped']);
    const said = client.messages.filter((m) => m.method === 'window/showMessage' && /^FDR, the program/.test(m.params.message));
    assert.deepEqual(said.map((m) => m.params.type), [2], 'a warning');
    assert.doesNotMatch(said[0].params.message, /no deadlock/);
    // Every lens is still there (Run, Build, the graph), and the verdict's runs the check again.
    const lenses = await client.request('textDocument/codeLens', { textDocument: { uri } });
    assert.equal(lenses.error, undefined);
    const verdict = (lenses.result as any[]).find((lens) => lens.command.title.startsWith('FDR: not modelled'));
    assert.equal(verdict.command.command, 'processj.checkWithFdr');
    assert.ok((lenses.result as any[]).some((lens) => lens.command.title === 'Concurrency graph'));
    // The stub next to the file is marked as generated: the next translation replaces it.
    assert.match(fs.readFileSync(file('too_big.csp'), 'utf8'), /^-- Generated by processj-lsp from too_big\.pj\./);
  } finally {
    await close();
  }
});

test('a check whose file changes while FDR runs shows nothing as current, and says so', { skip: SKIP }, async () => {
  const { client, uri, text, close } = await startOn({ 'dining_philosophers.pj': fs.readFileSync(path.join(ROOT, 'examples', 'dining_philosophers.pj'), 'utf8') }, {}, (dir) => slowRefines(dir, 2));
  try {
    const running = client.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [uri] }, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 700));
    client.notify('textDocument/didChange', { textDocument: { uri, version: 2 }, contentChanges: [{ text: `${text}\n` }] });
    const checked = await running;
    assert.equal(checked.result.stale, true);
    const said = client.messages.find((m) => m.method === 'window/showMessage' && /^FDR, the program/.test(m.params.message));
    assert.equal(said.params.type, 2);
    assert.match(said.params.message, /the file changed while FDR ran, so this result is about the text before that edit .*Run the check again/);
    // Not opened over the editing, not shown as current anywhere; the report says it at its top.
    assert.ok(!client.messages.some((m) => m.method === 'window/showDocument'), 'no page, no report opened');
    assert.match(fs.readFileSync(checked.result.reportFile, 'utf8'), /^# FDR check: dining_philosophers\.pj\n\n\*\*The file changed while FDR ran/);
    assert.deepEqual((await fdrLens(client, uri)).map((lens) => lens.command.title), ['FDR: check & show graph', 'FDR: check & show graph', 'FDR: check program & show graph']);
    assert.equal((await client.request('processj/fdrReport', { textDocument: { uri } })).result, null);
  } finally {
    await close();
  }
});

test('an edit of an imported file takes back the FDR results of the file that imports it', { skip: SKIP }, async () => {
  const { client, uri, file, close } = await startOn(IMPORTED);
  try {
    const checked = await client.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [uri] }, 60_000);
    assert.equal(checked.result.report.checks[0].status, 'failed', JSON.stringify(checked.result.report.checks[0].message));
    await client.waitFor((m) => m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri && m.params.diagnostics.some((d: any) => d.source === 'fdr'));
    assert.match((await fdrLens(client, uri))[0].command.title, /^FDR: deadlock/);
    // The imported file is opened and its second write removed: the importer's text is the same, its model is not.
    const lib = pathToFileURL(file('lib/workers.pj')).toString();
    const libText = IMPORTED['lib/workers.pj'];
    client.notify('textDocument/didOpen', { textDocument: { uri: lib, languageId: 'processj', version: 1, text: libText } });
    assert.ok((await client.request('processj/fdrReport', { textDocument: { uri } })).result, 'opening it unchanged keeps the result');
    const before = client.messages.length;
    client.notify('textDocument/didChange', { textDocument: { uri: lib, version: 2 }, contentChanges: [{ text: libText.replace('    out.write(2);\n', '') }] });
    const republished = await client.waitFor((m) => client.messages.indexOf(m) >= before && m.method === 'textDocument/publishDiagnostics' && m.params.uri === uri);
    assert.deepEqual(republished.params.diagnostics.filter((d: any) => d.source === 'fdr'), []);
    assert.equal((await client.request('processj/fdrReport', { textDocument: { uri } })).result, null);
    assert.equal((await fdrLens(client, uri))[0].command.title, 'FDR: check program & show graph');
  } finally {
    await close();
  }
});

test('a timed-out check\'s lens runs the check again', { skip: SKIP }, async () => {
  const { client, uri, close } = await startOn({ 'dining_philosophers.pj': fs.readFileSync(path.join(ROOT, 'examples', 'dining_philosophers.pj'), 'utf8') }, { fdrTimeoutMs: 1000 }, (dir) => slowRefines(dir, 4));
  try {
    const checked = await client.request('workspace/executeCommand', { command: 'processj.checkWithFdr', arguments: [uri] }, 60_000);
    assert.ok(checked.result.report.checks.every((check: any) => check.status === 'timeout'));
    const lens = (await fdrLens(client, uri)).find((entry) => entry.command.title.startsWith('FDR: timed out'));
    assert.equal(lens.command.title, 'FDR: timed out · check again');
    assert.deepEqual([lens.command.command, lens.command.arguments], ['processj.checkWithFdr', [uri]]);
  } finally {
    await close();
  }
});

test('a big program\'s state machines come from each procedure on its own, not from translating every process', { skip: SKIP }, async () => {
  const source = ['public void worker(chan<int>.write out, int i) {', '    out.write(i);', '}', 'public void main(string[] args) {', '    shared write chan<int> c;', '    par {', '        par for (int i = 0; i < 500; i++) {', '            worker(c.write, i);', '        }', '        c.read();', '    }', '}', ''].join('\n');
  const { client, uri, close } = await startOn({ 'big.pj': source });
  try {
    const page = await client.request('processj/processNetwork', { textDocument: { uri }, html: false });
    const view = page.result.payload.views.find((entry: any) => entry.kind === 'program');
    const worker = view.nodes.find((node: any) => node.machine && node.machine.startsWith('worker@'));
    const started = Date.now();
    const machine = (await client.request('processj/processNetwork', { textDocument: { uri }, machine: { target: 'program', ref: worker.machine } })).result.machine;
    assert.equal(machine.label, 'worker');
    assert.equal(machine.model, 'the CSP model of worker on its own');
    assert.match(machine.notes[0], /^This is worker's machine in a model of worker on its own: the program has 50\d processes, more than the 400/);
    // A branch's machine is the program's own: it says why there is none, at once.
    const branch = view.nodes.find((node: any) => node.machine && node.machine.includes('|'));
    const refused = (await client.request('processj/processNetwork', { textDocument: { uri }, machine: { target: 'program', ref: branch.machine } })).result.machine;
    assert.match(refused.error, /^No state machine: the program has 50\d processes, more than the 400/);
    assert.ok(Date.now() - started < 5_000);
  } finally {
    await close();
  }
});

/** A small LSP client over stdio, answering the server's own requests. */
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

  request(method: string, params: unknown, timeoutMs = 10_000): Promise<any> {
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
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.find(predicate);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('timed out waiting for a message from the server');
  }

  /** Shut the server down the LSP way and wait for it to exit (it removes its report directory and sandboxes on the way out). */
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
