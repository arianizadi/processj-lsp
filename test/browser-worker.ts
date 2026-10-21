/**
 * Language-server peers for the browser tests, both spoken to the same way:
 *
 * - WorkerClient runs the browser build (dist/browser/processj-lsp.worker.js)
 *   as a page does, in a vm context with a Web Worker's globals only (no
 *   require, process, Buffer, module, window or document; self ===
 *   globalThis), and exchanges LSP messages with it by postMessage;
 * - StdioClient runs the Node server (dist/src/server.js) over stdio, as
 *   an editor does.
 *
 * Requests from the server are answered by handlers the test registers (the
 * page's part: processj/runRefines, processj/compile), else as an editor
 * would answer them.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as vm from 'node:vm';
import { stopServer } from './server-process';

const ROOT = path.join(__dirname, '..', '..');
export const WORKER_BUNDLE = path.join(ROOT, 'dist', 'browser', 'processj-lsp.worker.js');

/** The worker bundle, built first if this test run has none (npm test builds it; a bare `node --test` may not have). */
export function workerBundle(): string {
  if (!fs.existsSync(WORKER_BUNDLE)) execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-browser.mjs')], { cwd: ROOT, stdio: 'inherit' });
  return WORKER_BUNDLE;
}

export interface Message {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: { code: number; message: string };
}

type Handler = (params: any) => unknown;

/** Requests an editor answers without being asked to (the test can still handle them itself). */
const EDITOR_ANSWERS: Record<string, unknown> = {
  'window/showDocument': { success: true },
  'workspace/applyEdit': { applied: true },
  'client/registerCapability': null,
  'client/unregisterCapability': null,
  'window/workDoneProgress/create': null,
  'workspace/codeLens/refresh': null,
  'workspace/inlayHint/refresh': null,
  'workspace/semanticTokens/refresh': null,
};

abstract class Peer {
  /** Everything the server sent, in order. */
  readonly messages: Message[] = [];
  /** Notifications and requests from the server that no waitFor has taken yet. */
  private readonly inbox: Message[] = [];
  private readonly waiters: Array<{ match: (message: Message) => boolean; resolve: (message: Message) => void }> = [];
  private readonly pending = new Map<number, { resolve: (message: Message) => void; timer: NodeJS.Timeout }>();
  private readonly handlers = new Map<string, Handler>();
  private nextId = 1;

  protected abstract post(message: Message): void;

  /** Answer the server's requests of this method (the page's part). */
  onRequest(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  async request<R = any>(method: string, params: unknown, timeoutMs = 20_000): Promise<R> {
    const id = this.nextId++;
    const reply = new Promise<Message>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`no answer to ${method} in ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, timer });
    });
    this.post({ jsonrpc: '2.0', id, method, params });
    const message = await reply;
    if (message.error) throw new Error(`${method}: ${message.error.message}`);
    return message.result as R;
  }

  notify(method: string, params: unknown): void {
    this.post({ jsonrpc: '2.0', method, params });
  }

  /** The first message from the server (not yet taken) that matches, waiting for one. */
  waitFor(match: (message: Message) => boolean, timeoutMs = 10_000): Promise<Message> {
    const index = this.inbox.findIndex(match);
    if (index >= 0) return Promise.resolve(this.inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { match, resolve: (message: Message) => {
        clearTimeout(timer);
        resolve(message);
      } };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`timed out after ${timeoutMs} ms; the server said: ${this.log().slice(-8).join(' | ')}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** The server's log and messages to the user. */
  log(): string[] {
    return this.messages.filter((m) => m.method === 'window/logMessage' || m.method === 'window/showMessage').map((m) => `${m.method === 'window/showMessage' ? 'show' : 'log'}[${m.params.type}] ${String(m.params.message).slice(0, 300)}`);
  }

  protected receive(message: Message): void {
    this.messages.push(message);
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(Number(message.id));
      pending.resolve(message);
      return;
    }
    if (message.id !== undefined && message.method) void this.answer(message);
    const waiter = this.waiters.find((entry) => entry.match(message));
    if (waiter) {
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    } else this.inbox.push(message);
  }

  private async answer(request: Message): Promise<void> {
    const handler = this.handlers.get(request.method!);
    if (!handler && !(request.method! in EDITOR_ANSWERS)) {
      this.post({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: `Unhandled method ${request.method}` } });
      return;
    }
    try {
      const result = handler ? await handler(request.params) : EDITOR_ANSWERS[request.method!];
      this.post({ jsonrpc: '2.0', id: request.id, result: result ?? null });
    } catch (error) {
      this.post({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
    }
  }
}

interface WorkerScope {
  onmessage: ((event: { data: unknown }) => void) | null;
}

export class WorkerClient extends Peer {
  /** Node globals that reached the worker's context (there must be none). */
  readonly leaked: string[];
  private readonly scope: WorkerScope;
  private readonly server: WorkerScope['onmessage'];

  constructor(bundle = workerBundle()) {
    super();
    const context = vm.createContext({
      postMessage: (message: unknown) => this.receive(structuredClone(message) as Message),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      onmessage: null,
      console,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      queueMicrotask,
      TextEncoder,
      TextDecoder,
      URL,
      URLSearchParams,
      AbortController,
      AbortSignal,
      Event,
      EventTarget,
      crypto: globalThis.crypto,
      btoa,
      atob,
      structuredClone,
      performance,
      // The worker's own URL, and importScripts for the files beside it (the layout engine).
      location: new URL(pathToFileURL(bundle).href),
      importScripts: (...urls: string[]) => {
        for (const url of urls) vm.runInContext(fs.readFileSync(fileURLToPath(url), 'utf8'), context, { filename: path.basename(fileURLToPath(url)) });
      },
    });
    vm.runInContext('globalThis.self = globalThis', context);
    this.leaked = ['require', 'process', 'Buffer', 'module', 'exports', 'global', 'window', 'document', '__dirname'].filter((name) => vm.runInContext(`typeof ${name}`, context) !== 'undefined');
    vm.runInContext(fs.readFileSync(bundle, 'utf8'), context, { filename: path.basename(bundle) });
    this.scope = vm.runInContext('self', context) as WorkerScope;
    this.server = this.scope.onmessage;
  }

  /** Whether the page's messages still reach the server: nothing has taken over the worker's onmessage. */
  get connected(): boolean {
    return typeof this.server === 'function' && this.scope.onmessage === this.server;
  }

  protected post(message: Message): void {
    this.scope.onmessage?.({ data: structuredClone(message) });
  }

  /** Shut the server down as a page does before it terminates the worker (it stops its timers). */
  async close(): Promise<void> {
    if (!this.connected) return;
    await this.request('shutdown', null, 5_000).catch(() => undefined);
    this.notify('exit', null);
  }
}

export class StdioClient extends Peer {
  readonly child: ChildProcessWithoutNullStreams;
  readonly sent = new Set<string>();
  private buffer = Buffer.alloc(0);

  constructor() {
    super();
    this.child = spawn(process.execPath, [path.join(ROOT, 'dist', 'src', 'server.js'), '--stdio'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdout.on('data', (chunk: Buffer) => this.read(chunk));
  }

  protected post(message: Message): void {
    if (message.method === 'shutdown' || message.method === 'exit') this.sent.add(message.method);
    const json = JSON.stringify(message);
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  }

  close(): Promise<void> {
    return stopServer(this);
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const length = Number(/Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString())?.[1] ?? 0);
      if (this.buffer.length < headerEnd + 4 + length) return;
      const message = JSON.parse(this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8')) as Message;
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      this.receive(message);
    }
  }
}
