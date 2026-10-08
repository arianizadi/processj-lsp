/**
 * Verification results per document, and the live viewer server.
 *
 * `publishVerification(uri, report)` is how a producer (the static checker now,
 * FDR later) makes a result visible: the store keeps the latest report of each
 * producer per document, and every open viewer of that document refreshes.
 *
 * The live server serves the viewer to a browser opened from an editor without
 * webviews (Neovim, Emacs): node:http on 127.0.0.1 and a random port, every path
 * under an unguessable token, only content generated here, no CORS. Pages
 * subscribe to updates with Server-Sent Events and fetch a fresh payload when
 * the document or its results change; an update can also name a check (and a
 * process of it) for the page to focus. A page in the background lets go of
 * its stream and checks in now and then instead: it is still open, and a focus
 * for it waits until it is shown again. It starts on first use and closes with
 * the language server.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { VerificationReport } from '../verification';
import type { ViewerFocus, ViewerPayload, ViewerView } from './payload';
import { contentSecurityPolicy, renderViewerHtml } from './render-html';
import type { MachineRequest, ViewerMachine, ViewerMachineError } from './render-machine';

type Producer = VerificationReport['producer'];

/** The latest report of each producer, per document. */
export class VerificationStore {
  private readonly byUri = new Map<string, Map<Producer, { report: VerificationReport; json: string }>>();
  private readonly listeners = new Set<(uri: string, producer: Producer) => void>();

  /**
   * Replace the report of `report.producer` for `uri`, and tell every listener.
   * The report is copied: a producer may keep changing its own object and
   * publish it again. Publishing a report equal to the current one does nothing.
   */
  publish(uri: string, report: VerificationReport): void {
    if (report.uri !== uri) throw new Error(`a verification report about ${report.uri} cannot be published for ${uri}`);
    const json = JSON.stringify(report);
    let reports = this.byUri.get(uri);
    if (!reports) this.byUri.set(uri, (reports = new Map()));
    const previous = reports.get(report.producer);
    if (previous?.json === json) return;
    reports.set(report.producer, { report: JSON.parse(json) as VerificationReport, json });
    for (const listener of this.listeners) listener(uri, report.producer);
  }

  /** Forget results for a document (one producer, or all), telling listeners about each producer removed. */
  clear(uri: string, producer?: Producer): void {
    const reports = this.byUri.get(uri);
    if (!reports) return;
    const removed = producer ? (reports.has(producer) ? [producer] : []) : [...reports.keys()];
    for (const entry of removed) reports.delete(entry);
    if (!reports.size) this.byUri.delete(uri);
    for (const entry of removed) for (const listener of this.listeners) listener(uri, entry);
  }

  /** Reports for a document, FDR first: a model check is preferred to static analysis. */
  get(uri: string): VerificationReport[] {
    const reports = this.byUri.get(uri);
    if (!reports) return [];
    return [reports.get('fdr')?.report, reports.get('checker')?.report].filter((report): report is VerificationReport => !!report);
  }

  onDidChange(listener: (uri: string, producer: Producer) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** The process-wide store the language server's features share. */
export const verificationStore = new VerificationStore();

/**
 * Make a verification result visible for a document: the graph viewer (live
 * page, VS Code panel, exports) shows it from then on. A new report from the
 * same producer replaces the previous one. The report is copied when published,
 * and `report.uri` must be `uri`. Results are dropped when the document closes.
 */
export function publishVerification(uri: string, report: VerificationReport): void {
  verificationStore.publish(uri, report);
}

export interface LiveSource {
  /** The viewer payload for an open document, or undefined when it is gone. */
  payload(uri: string): Promise<ViewerPayload | undefined>;
  /** One view of it, laid out on demand. */
  view(uri: string, id: string): Promise<ViewerView | undefined>;
  /** Show a location in the editor; resolves false when the client refused. */
  reveal(uri: string, line: number, col: number): Promise<boolean>;
  /** One state machine of the document's CSP model. */
  machine?(uri: string, request: MachineRequest): Promise<ViewerMachine | ViewerMachineError | undefined>;
}

interface LiveDocument {
  uri: string;
  id: string;
  clients: Set<http.ServerResponse>;
  timer?: NodeJS.Timeout;
  /** What the next update asks the pages to focus. */
  focus?: ViewerFocus;
  /** When a page in the background last checked in (it holds no stream while hidden). */
  seen?: number;
  /** A focus for that page, delivered with the payload it fetches when it is shown again. */
  pending?: ViewerFocus;
  /** URIs the page may ask to reveal: those in the last payload it was sent. */
  known: Set<string>;
}

/** A page in the background checks in every 30 s (a browser may slow its timers to one a minute); past this it is taken as closed. */
const HIDDEN_PAGE_MS = 150_000;

export interface LiveServerOptions {
  /** Coalesce bursts of edits into one refresh (default 350 ms). */
  debounceMs?: number;
  log?: (message: string) => void;
}

export class LiveViewerServer {
  private server?: http.Server;
  private starting?: Promise<void>;
  private port = 0;
  private readonly token = randomBytes(24).toString('base64url');
  private readonly documents = new Map<string, LiveDocument>();
  private readonly byId = new Map<string, LiveDocument>();
  private heartbeat?: NodeJS.Timeout;

  constructor(private readonly source: LiveSource, private readonly options: LiveServerOptions = {}) {}

  get running(): boolean {
    return !!this.server?.listening;
  }

  /** The page URL for a document, starting the server on first use; a focus becomes its query. */
  async urlFor(uri: string, focus?: ViewerFocus): Promise<string> {
    await this.start();
    const query = new URLSearchParams();
    if (focus?.check) query.set('check', focus.check);
    if (focus?.process !== undefined) query.set('process', focus.process);
    const search = query.toString();
    return `http://127.0.0.1:${this.port}${this.basePath(this.document(uri))}${search ? `?${search}` : ''}`;
  }

  /** Whether a page for this document is open right now. */
  watching(uri: string): boolean {
    return (this.documents.get(uri)?.clients.size ?? 0) > 0;
  }

  /**
   * Ask open pages of a document to fetch a new payload (debounced), and with
   * `focus` to show that check (and process) once they have it: `shown` when
   * a page on screen was asked, `pending` when the page is in the background
   * (it shows the focus when it is shown again), false when no page is open.
   */
  notify(uri: string, focus?: ViewerFocus): 'shown' | 'pending' | false {
    const document = this.documents.get(uri);
    if (!document) return false;
    if (!document.clients.size) {
      if (!focus || document.seen === undefined || Date.now() - document.seen > HIDDEN_PAGE_MS) return false;
      document.pending = focus;
      return 'pending';
    }
    if (document.timer) clearTimeout(document.timer);
    if (focus) document.focus = focus;
    document.timer = setTimeout(() => {
      document.timer = undefined;
      const data = JSON.stringify({ at: Date.now(), ...(document.focus ? { focus: document.focus } : {}) });
      document.focus = undefined;
      for (const client of document.clients) client.write(`event: update\ndata: ${data}\n\n`);
    }, this.options.debounceMs ?? 350);
    return 'shown';
  }

  async close(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const document of this.documents.values()) {
      if (document.timer) clearTimeout(document.timer);
      for (const client of document.clients) client.end();
      document.clients.clear();
    }
    const server = this.server;
    this.server = undefined;
    this.starting = undefined;
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
  }

  private start(): Promise<void> {
    if (this.server?.listening) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const server = http.createServer((request, response) => {
        void this.handle(request, response).catch((error) => {
          this.options.log?.(`live graph request failed: ${error instanceof Error ? error.message : String(error)}`);
          if (!response.headersSent) this.send(response, 500, 'text/plain; charset=utf-8', 'internal error');
          else response.end();
        });
      });
      server.on('error', (error) => {
        this.starting = undefined;
        reject(error);
      });
      // Loopback only: the page is for the person at this machine.
      server.listen(0, '127.0.0.1', () => {
        this.server = server;
        this.port = (server.address() as AddressInfo).port;
        this.heartbeat = setInterval(() => {
          for (const document of this.documents.values()) for (const client of document.clients) client.write(': keep-alive\n\n');
        }, 25_000);
        this.heartbeat.unref();
        server.unref();
        resolve();
      });
    });
    return this.starting;
  }

  private document(uri: string): LiveDocument {
    let document = this.documents.get(uri);
    if (!document) {
      document = { uri, id: randomBytes(9).toString('base64url'), clients: new Set(), known: new Set([uri]) };
      this.documents.set(uri, document);
      this.byId.set(document.id, document);
    }
    return document;
  }

  private basePath(document: LiveDocument): string {
    return `/${this.token}/d/${document.id}/`;
  }

  private send(response: http.ServerResponse, status: number, type: string, body: string, extra: Record<string, string> = {}): void {
    response.writeHead(status, {
      'Content-Type': type,
      'Content-Length': Buffer.byteLength(body),
      ...SECURITY_HEADERS,
      ...extra,
    });
    response.end(body);
  }

  private async handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    // DNS rebinding: only our own loopback address and port may be the host.
    const host = request.headers.host ?? '';
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) return this.send(response, 403, 'text/plain; charset=utf-8', 'forbidden');
    const url = new URL(request.url ?? '/', `http://${host}`);
    const parts = url.pathname.split('/');
    // ['', token, 'd', id, endpoint]
    if (parts.length < 5 || !this.tokenMatches(parts[1]) || parts[2] !== 'd') return this.send(response, 404, 'text/plain; charset=utf-8', 'not found');
    const document = this.byId.get(parts[3]);
    if (!document) return this.send(response, 404, 'text/plain; charset=utf-8', 'not found');
    const endpoint = parts.slice(4).join('/');
    if (request.method === 'GET' && endpoint === '') return this.page(document, response);
    if (request.method === 'GET' && endpoint === 'payload') return this.payload(document, response);
    if (request.method === 'GET' && endpoint === 'events') return this.events(document, request, response);
    if (request.method === 'GET' && endpoint === 'view') return this.view(document, url.searchParams.get('id') ?? '', response);
    if (request.method === 'GET' && endpoint === 'machine') return this.machine(document, url.searchParams, response);
    if (request.method === 'POST' && endpoint === 'reveal') return this.reveal(document, request, response);
    if (request.method === 'POST' && (endpoint === 'ping' || endpoint === 'gone')) return this.checkIn(document, endpoint === 'ping', request, response);
    if (request.method !== 'GET' && request.method !== 'POST') return this.send(response, 405, 'text/plain; charset=utf-8', 'method not allowed', { Allow: 'GET, POST' });
    return this.send(response, 404, 'text/plain; charset=utf-8', 'not found');
  }

  private tokenMatches(candidate: string): boolean {
    const expected = Buffer.from(this.token);
    const given = Buffer.from(candidate);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private async page(document: LiveDocument, response: http.ServerResponse): Promise<void> {
    const payload = await this.source.payload(document.uri);
    if (!payload) return this.send(response, 410, 'text/plain; charset=utf-8', 'This document is no longer open in the editor.');
    for (const uri of payload.knownUris) document.known.add(uri);
    const nonce = randomBytes(16).toString('base64');
    const options = { mode: 'live' as const, nonce, liveBase: this.basePath(document) };
    this.send(response, 200, 'text/html; charset=utf-8', renderViewerHtml(payload, options), { 'Content-Security-Policy': contentSecurityPolicy(options, nonce) });
  }

  private async payload(document: LiveDocument, response: http.ServerResponse): Promise<void> {
    const payload = await this.source.payload(document.uri);
    if (!payload) return this.send(response, 410, 'application/json; charset=utf-8', JSON.stringify({ error: 'This document is no longer open in the editor.' }));
    for (const uri of payload.knownUris) document.known.add(uri);
    // A page back from the background gets what it was asked to show meanwhile.
    const pending = document.pending;
    document.pending = undefined;
    this.send(response, 200, 'application/json; charset=utf-8', JSON.stringify(pending ? { ...payload, focus: pending } : payload));
  }

  /** A page in the background checking in (`ping`), or going away (`gone`): from our own page, nothing else. */
  private checkIn(document: LiveDocument, present: boolean, request: http.IncomingMessage, response: http.ServerResponse): void {
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://127.0.0.1:${this.port}` && origin !== `http://localhost:${this.port}`) return this.send(response, 403, 'text/plain; charset=utf-8', 'forbidden');
    request.resume();
    document.seen = present ? Date.now() : undefined;
    if (!present) document.pending = undefined;
    this.send(response, 204, 'text/plain; charset=utf-8', '');
  }

  private async view(document: LiveDocument, id: string, response: http.ServerResponse): Promise<void> {
    const view = id ? await this.source.view(document.uri, id) : undefined;
    if (!view) return this.send(response, 404, 'application/json; charset=utf-8', '{"error":"no such view"}');
    // A view laid out on demand may link to files the first payload did not (a callee declared elsewhere).
    for (const uri of view.knownUris ?? []) document.known.add(uri);
    this.send(response, 200, 'application/json; charset=utf-8', JSON.stringify(view));
  }

  private async machine(document: LiveDocument, params: URLSearchParams, response: http.ServerResponse): Promise<void> {
    const target = params.get('target') ?? '';
    const ref = params.get('ref') ?? '';
    const check = params.get('check') ?? undefined;
    const process = params.get('process') ?? undefined;
    const machine = target && ref && this.source.machine ? await this.source.machine(document.uri, { target, ref, ...(check ? { check } : {}), ...(process !== undefined ? { process } : {}) }) : undefined;
    if (!machine) return this.send(response, 404, 'application/json; charset=utf-8', '{"error":"no such state machine"}');
    // Its states link to their statements, possibly in imported files.
    if ('states' in machine) for (const state of machine.states) if (state.at) document.known.add(state.at.uri);
    this.send(response, 200, 'application/json; charset=utf-8', JSON.stringify(machine));
  }

  private events(document: LiveDocument, request: http.IncomingMessage, response: http.ServerResponse): void {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      ...SECURITY_HEADERS,
    });
    response.write(': connected\n\n');
    document.clients.add(response);
    request.on('close', () => document.clients.delete(response));
  }

  private async reveal(document: LiveDocument, request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    // A same-origin fetch from our page: JSON, from our origin, small.
    const origin = request.headers.origin;
    if (origin !== undefined && origin !== `http://127.0.0.1:${this.port}` && origin !== `http://localhost:${this.port}`) return this.send(response, 403, 'text/plain; charset=utf-8', 'forbidden');
    if (!String(request.headers['content-type'] ?? '').startsWith('application/json')) return this.send(response, 415, 'text/plain; charset=utf-8', 'unsupported media type');
    const body = await readBody(request, 4096);
    if (body === undefined) return this.send(response, 413, 'text/plain; charset=utf-8', 'too large');
    let value: { uri?: unknown; line?: unknown; col?: unknown };
    try {
      value = JSON.parse(body) as typeof value;
    } catch {
      return this.send(response, 400, 'text/plain; charset=utf-8', 'bad request');
    }
    const { uri, line, col } = value;
    // Only locations the page was given, with sane coordinates.
    if (typeof uri !== 'string' || !document.known.has(uri) || !Number.isInteger(line) || !Number.isInteger(col) || (line as number) < 0 || (col as number) < 0) return this.send(response, 400, 'text/plain; charset=utf-8', 'bad request');
    const shown = await this.source.reveal(uri, line as number, col as number);
    this.send(response, shown ? 204 : 409, 'text/plain; charset=utf-8', shown ? '' : 'the editor did not open it');
  }
}

const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

/** The request body, or undefined when it is larger than `limit` bytes (the rest is drained, not kept). */
function readBody(request: http.IncomingMessage, limit: number): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= limit) chunks.push(chunk);
    });
    request.on('end', () => resolve(size > limit ? undefined : Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}
