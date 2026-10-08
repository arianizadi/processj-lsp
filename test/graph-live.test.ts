import assert from 'node:assert/strict';
import * as http from 'node:http';
import * as path from 'node:path';
import { test } from 'node:test';
import { LiveViewerServer, VerificationStore } from '../src/graph/live';
import { buildViewerPayload, type ViewerPayload } from '../src/graph/payload';
import type { VerificationReport } from '../src/verification';
import { analyzeFile, FIXTURES } from './graph-helpers';

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(url: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = http.request({ host: target.hostname, port: target.port, path: target.pathname + target.search, method: options.method ?? 'GET', headers: options.headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

async function fixture(): Promise<{ uri: string; payload: ViewerPayload }> {
  const analyzed = analyzeFile(path.join(FIXTURES, 'commstime.pj'));
  return { uri: analyzed.uri, payload: await buildViewerPayload({ model: analyzed.model, source: { uri: analyzed.uri, text: analyzed.text } }) };
}

test('the live viewer binds loopback only and answers nothing without its token', async (t) => {
  const { uri, payload } = await fixture();
  const revealed: Array<[string, number, number]> = [];
  const server = new LiveViewerServer({
    payload: async (asked) => asked === uri ? payload : undefined,
    view: async (asked, id) => asked === uri ? payload.views.find((view) => view.id === id) : undefined,
    reveal: async (asked, line, col) => {
      revealed.push([asked, line, col]);
      return true;
    },
  }, { debounceMs: 10 });
  t.after(() => server.close());
  assert.equal(server.running, false, 'started only on first use');
  const url = await server.urlFor(uri);
  assert.equal(server.running, true);
  const parsed = new URL(url);
  assert.equal(parsed.hostname, '127.0.0.1');
  const address = (server as unknown as { server: http.Server }).server.address();
  assert.equal(typeof address === 'object' && address?.address, '127.0.0.1');
  const [, token, , id] = parsed.pathname.split('/');
  assert.ok(token.length >= 32, 'an unguessable token');
  assert.equal(await server.urlFor(uri), url, 'one stable page per document');

  const page = await request(url);
  assert.equal(page.status, 200);
  assert.match(String(page.headers['content-type']), /text\/html/);
  assert.match(String(page.headers['content-security-policy']), /script-src 'nonce-[^']+'/);
  assert.equal(page.headers['access-control-allow-origin'], undefined, 'no CORS');
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.match(page.body, /data-mode="live"/);

  const origin = `http://127.0.0.1:${parsed.port}`;
  for (const pathname of [`/d/${id}/`, `/${'x'.repeat(token.length)}/d/${id}/`, `/${token}/d/unknown/`, '/', `/${token}`]) {
    assert.equal((await request(origin + pathname)).status, 404, pathname);
  }
  // DNS rebinding: a foreign Host header is refused even with the token.
  assert.equal((await request(url, { headers: { Host: `evil.example:${parsed.port}` } })).status, 403);
  assert.equal((await request(url, { method: 'DELETE' })).status, 405);

  const data = await request(`${url}payload`);
  assert.equal(data.status, 200);
  assert.equal((JSON.parse(data.body) as ViewerPayload).title, 'commstime.pj');
  const view = await request(`${url}view?id=${encodeURIComponent(payload.views[1].id)}`);
  assert.equal(JSON.parse(view.body).id, payload.views[1].id);
  assert.equal((await request(`${url}view?id=nope`)).status, 404);

  // Reveal: JSON from our own origin, for a location the page was given.
  const reveal = (body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json' }) => request(`${url}reveal`, { method: 'POST', headers, body: JSON.stringify(body) });
  assert.equal((await reveal({ uri, line: 4, col: 2 })).status, 204);
  assert.deepEqual(revealed, [[uri, 4, 2]]);
  assert.equal((await reveal({ uri: 'file:///etc/passwd', line: 0, col: 0 })).status, 400);
  assert.equal((await reveal({ uri, line: -1, col: 0 })).status, 400);
  assert.equal((await reveal({ uri, line: 1.5, col: 0 })).status, 400);
  assert.equal((await reveal({ uri, line: 1, col: 0 }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await reveal({ uri, line: 1, col: 0 }, { 'Content-Type': 'application/json', Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request(`${url}reveal`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'x'.repeat(10_000) })).status, 413);
  assert.equal(revealed.length, 1);
});

test('open pages hear about edits and new results through server-sent events', async (t) => {
  const { uri, payload } = await fixture();
  const server = new LiveViewerServer({ payload: async () => payload, view: async () => undefined, reveal: async () => false }, { debounceMs: 5 });
  t.after(() => server.close());
  const url = await server.urlFor(uri);
  assert.equal(server.watching(uri), false);
  const events = await new Promise<string>((resolve, reject) => {
    const target = new URL(`${url}events`);
    const req = http.get({ host: target.hostname, port: target.port, path: target.pathname }, (response) => {
      assert.match(String(response.headers['content-type']), /text\/event-stream/);
      let text = '';
      response.on('data', (chunk: Buffer) => {
        text += chunk.toString('utf8');
        if (text.includes(': connected')) {
          assert.equal(server.watching(uri), true);
          server.notify(uri);
          server.notify(uri);
        }
        if (text.includes('event: update')) {
          req.destroy();
          resolve(text);
        }
      });
    });
    req.on('error', (error) => {
      if (!String(error).includes('socket hang up')) reject(error);
    });
  });
  // Two notifications in a burst make one refresh.
  assert.equal(events.split('event: update').length - 1, 1);
  await server.close();
  await assert.rejects(request(url), /ECONNREFUSED/);
});

test('a page in the background is still open: a result for it waits, and comes with the payload it fetches when shown', async (t) => {
  const { uri, payload } = await fixture();
  const server = new LiveViewerServer({ payload: async () => payload, view: async () => undefined, reveal: async () => false }, { debounceMs: 5 });
  t.after(() => server.close());
  const url = await server.urlFor(uri);
  const focus = { check: 'program/deadlock-free' };
  // No page has been open: the editor opens one.
  assert.equal(server.notify(uri, focus), false);
  // A page in the background checks in (it holds no stream while hidden): the focus waits for it.
  assert.equal((await request(`${url}ping`, { method: 'POST' })).status, 204);
  assert.equal(server.notify(uri, focus), 'pending');
  assert.deepEqual((JSON.parse((await request(`${url}payload`)).body) as ViewerPayload).focus, focus);
  assert.equal((JSON.parse((await request(`${url}payload`)).body) as ViewerPayload).focus, undefined, 'given once');
  // Only our own page checks in; a page that went away is no longer there to show anything.
  assert.equal((await request(`${url}ping`, { method: 'POST', headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request(`${url}gone`, { method: 'POST' })).status, 204);
  assert.equal(server.notify(uri, focus), false);
});

test('the store keeps the latest report per producer, FDR first', () => {
  const store = new VerificationStore();
  const changes: string[] = [];
  const stop = store.onDidChange((uri, producer) => changes.push(`${uri}:${producer}`));
  const report = (producer: VerificationReport['producer'], label: string): VerificationReport => ({ version: 1, producer, uri: 'file:///a.pj', assumptions: [], checks: [{ id: label, property: 'custom', label, target: { kind: 'program', name: 'main' }, status: 'passed', severity: 'info' }] });
  store.publish('file:///a.pj', report('checker', 'one'));
  store.publish('file:///a.pj', report('fdr', 'two'));
  store.publish('file:///a.pj', report('checker', 'three'));
  store.publish('file:///a.pj', report('checker', 'three'));
  assert.deepEqual(store.get('file:///a.pj').map((entry) => `${entry.producer}:${entry.checks[0].label}`), ['fdr:two', 'checker:three']);
  assert.deepEqual(changes, ['file:///a.pj:checker', 'file:///a.pj:fdr', 'file:///a.pj:checker'], 'an identical report is not a change');
  store.clear('file:///a.pj', 'fdr');
  assert.deepEqual(store.get('file:///a.pj').map((entry) => entry.producer), ['checker']);
  stop();
  store.clear('file:///a.pj');
  assert.equal(changes.length, 4);
  assert.deepEqual(store.get('file:///a.pj'), []);
});

test('the store copies what it is given, refuses a report about another file, and tells which producer was cleared', () => {
  const store = new VerificationStore();
  const changes: string[] = [];
  store.onDidChange((uri, producer) => changes.push(`${producer}`));
  const report: VerificationReport = { version: 1, producer: 'fdr', uri: 'file:///a.pj', assumptions: [], checks: [] };
  // A producer that keeps one object and adds each check as it finishes, publishing every time.
  store.publish('file:///a.pj', report);
  report.checks.push({ id: 'one', property: 'deadlock-free', label: 'Deadlock freedom', target: { kind: 'program', name: 'main' }, status: 'passed', severity: 'error' });
  store.publish('file:///a.pj', report);
  report.checks[0].status = 'failed';
  store.publish('file:///a.pj', report);
  assert.deepEqual(changes, ['fdr', 'fdr', 'fdr'], 'every real change is announced');
  assert.equal(store.get('file:///a.pj')[0].checks[0].status, 'failed');
  report.checks[0].status = 'error';
  assert.equal(store.get('file:///a.pj')[0].checks[0].status, 'failed', 'the stored report is a copy');
  assert.throws(() => store.publish('file:///b.pj', report), /about file:\/\/\/a\.pj cannot be published for file:\/\/\/b\.pj/);
  store.publish('file:///a.pj', { ...report, producer: 'checker' });
  changes.length = 0;
  store.clear('file:///a.pj');
  assert.deepEqual(changes.sort(), ['checker', 'fdr'], 'clearing everything names each producer removed');
  store.clear('file:///a.pj', 'fdr');
  assert.deepEqual(changes.sort(), ['checker', 'fdr'], 'nothing left to clear: no change');
});
