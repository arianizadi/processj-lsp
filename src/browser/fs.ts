/**
 * node:fs for the browser build: a synchronous file system in memory. The
 * server reads imports, the workspace and the standard library with
 * synchronous calls on its hot path, so the page puts the project's files
 * here up front (processj/writeFiles) rather than the server fetching them
 * when it needs them. Only the calls processj-lsp makes are here, with
 * Node's behaviour and error codes, except that a write makes the folders
 * it needs. There are no symbolic links.
 */
import * as path from 'node:path';

interface FileNode {
  kind: 'file';
  text: string;
  mtimeMs: number;
}

interface DirNode {
  kind: 'dir';
  children: Set<string>;
  mtimeMs: number;
}

type Entry = FileNode | DirNode;

const entries = new Map<string, Entry>([['/', { kind: 'dir', children: new Set(), mtimeMs: 0 }]]);
let clock = 0;

/** A modification time after every earlier one: a cache keyed by it sees two writes in one millisecond. */
function stamp(): number {
  clock = Math.max(Date.now(), clock + 1);
  return clock;
}

const MESSAGES: Record<string, string> = {
  ENOENT: 'no such file or directory',
  EEXIST: 'file already exists',
  EISDIR: 'illegal operation on a directory',
  ENOTDIR: 'not a directory',
  ENOTEMPTY: 'directory not empty',
  EBADF: 'bad file descriptor',
  ENOSYS: 'function not implemented',
};

function failure(code: string, syscall: string, file: string): Error {
  const error = new Error(`${code}: ${MESSAGES[code] ?? 'error'}, ${syscall} '${file}'`) as Error & { code: string; syscall: string; path: string };
  error.code = code;
  error.syscall = syscall;
  error.path = file;
  return error;
}

function resolve(file: unknown): string {
  return path.resolve(String(file));
}

function directory(dir: string, syscall: string, create: boolean): DirNode {
  const found = entries.get(dir);
  if (found?.kind === 'dir') return found;
  if (found) throw failure('ENOTDIR', syscall, dir);
  if (!create) throw failure('ENOENT', syscall, dir);
  const parent = directory(path.dirname(dir), syscall, true);
  const made: DirNode = { kind: 'dir', children: new Set(), mtimeMs: stamp() };
  entries.set(dir, made);
  parent.children.add(path.basename(dir));
  return made;
}

function text(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return new TextDecoder().decode(data);
  return String(data);
}

export class Stats {
  constructor(private readonly entry: Entry) {}

  isFile(): boolean {
    return this.entry.kind === 'file';
  }

  isDirectory(): boolean {
    return this.entry.kind === 'dir';
  }

  isSymbolicLink(): boolean {
    return false;
  }

  get mtimeMs(): number {
    return this.entry.mtimeMs;
  }

  get ctimeMs(): number {
    return this.entry.mtimeMs;
  }

  get mtime(): Date {
    return new Date(this.entry.mtimeMs);
  }

  get size(): number {
    return this.entry.kind === 'file' ? new TextEncoder().encode(this.entry.text).length : 0;
  }
}

export class Dirent {
  constructor(readonly name: string, private readonly entry: Entry) {}

  isFile(): boolean {
    return this.entry.kind === 'file';
  }

  isDirectory(): boolean {
    return this.entry.kind === 'dir';
  }

  isSymbolicLink(): boolean {
    return false;
  }
}

export function existsSync(file: unknown): boolean {
  return entries.has(resolve(file));
}

export function statSync(file: unknown, options?: { throwIfNoEntry?: boolean }): Stats | undefined {
  const entry = entries.get(resolve(file));
  if (entry) return new Stats(entry);
  if (options?.throwIfNoEntry === false) return undefined;
  throw failure('ENOENT', 'stat', String(file));
}

export const lstatSync = statSync;

export function readFileSync(file: unknown, options?: string | { encoding?: string | null }): string | Uint8Array {
  const entry = entries.get(resolve(file));
  if (!entry) throw failure('ENOENT', 'open', String(file));
  if (entry.kind !== 'file') throw failure('EISDIR', 'read', String(file));
  const encoding = typeof options === 'string' ? options : options?.encoding;
  return encoding ? entry.text : new TextEncoder().encode(entry.text);
}

export function writeFileSync(file: unknown, data: unknown): void {
  const target = resolve(file);
  if (entries.get(target)?.kind === 'dir') throw failure('EISDIR', 'open', String(file));
  directory(path.dirname(target), 'open', true).children.add(path.basename(target));
  entries.set(target, { kind: 'file', text: text(data), mtimeMs: stamp() });
}

export function mkdirSync(dir: unknown, options?: { recursive?: boolean } | number): string | undefined {
  const target = resolve(dir);
  const recursive = typeof options === 'object' && !!options?.recursive;
  if (entries.has(target)) {
    if (recursive && entries.get(target)?.kind === 'dir') return undefined;
    throw failure('EEXIST', 'mkdir', String(dir));
  }
  if (!recursive) directory(path.dirname(target), 'mkdir', false);
  // The first folder made, as Node answers a recursive mkdir.
  let first = target;
  for (let up = path.dirname(target); !entries.has(up); up = path.dirname(up)) first = up;
  directory(target, 'mkdir', true);
  return recursive ? first : undefined;
}

let temporary = 0;

export function mkdtempSync(prefix: string): string {
  let made: string;
  do made = `${prefix}${(++temporary).toString(36).padStart(6, '0')}`; while (entries.has(resolve(made)));
  directory(resolve(made), 'mkdtemp', true);
  return made;
}

export function readdirSync(dir: unknown, options?: { withFileTypes?: boolean } | string): Array<string | Dirent> {
  const target = resolve(dir);
  const entry = entries.get(target);
  if (!entry) throw failure('ENOENT', 'scandir', String(dir));
  if (entry.kind !== 'dir') throw failure('ENOTDIR', 'scandir', String(dir));
  const names = [...entry.children].sort();
  if (typeof options === 'object' && options?.withFileTypes) return names.map((name) => new Dirent(name, entries.get(path.join(target, name))!));
  return names;
}

export function realpathSync(file: unknown): string {
  const target = resolve(file);
  if (!entries.has(target)) throw failure('ENOENT', 'realpath', String(file));
  return target;
}

export function rmSync(file: unknown, options?: { recursive?: boolean; force?: boolean }): void {
  const target = resolve(file);
  const entry = entries.get(target);
  if (!entry) {
    if (options?.force) return;
    throw failure('ENOENT', 'rm', String(file));
  }
  if (target === '/') throw failure('EISDIR', 'rm', String(file));
  if (entry.kind === 'dir' && !options?.recursive) throw failure('EISDIR', 'rm', String(file));
  const remove = (at: string): void => {
    const node = entries.get(at);
    if (node?.kind === 'dir') for (const child of node.children) remove(path.join(at, child));
    entries.delete(at);
  };
  remove(target);
  const parent = entries.get(path.dirname(target));
  if (parent?.kind === 'dir') parent.children.delete(path.basename(target));
}

export function rm(file: unknown, options: { recursive?: boolean; force?: boolean }, callback: (error: Error | null) => void): void {
  let error: Error | null = null;
  try {
    rmSync(file, options);
  } catch (caught) {
    error = caught as Error;
  }
  queueMicrotask(() => callback(error));
}

export function renameSync(from: unknown, to: unknown): void {
  const source = resolve(from);
  const target = resolve(to);
  const entry = entries.get(source);
  if (!entry) throw failure('ENOENT', 'rename', String(from));
  if (entry.kind === 'dir') throw failure('ENOSYS', 'rename', String(from));
  if (entries.get(target)?.kind === 'dir') throw failure('EISDIR', 'rename', String(to));
  directory(path.dirname(target), 'rename', false).children.add(path.basename(target));
  entries.set(target, entry);
  if (source === target) return;
  entries.delete(source);
  const parent = entries.get(path.dirname(source));
  if (parent?.kind === 'dir') parent.children.delete(path.basename(source));
}

/** Files in memory have no permissions to change. */
export function chmodSync(file: unknown): void {
  if (!entries.has(resolve(file))) throw failure('ENOENT', 'chmod', String(file));
}

/**
 * No numeric open flags: openSync reads only, with 'r', so a caller that
 * builds flags from these (src/safewrite.ts outside the browser mode) fails
 * with ENOSYS instead of doing something else.
 */
export const constants: Readonly<Record<string, number>> = Object.freeze({});

export function unlinkSync(file: unknown): void {
  const entry = entries.get(resolve(file));
  if (!entry) throw failure('ENOENT', 'unlink', String(file));
  if (entry.kind === 'dir') throw failure('EISDIR', 'unlink', String(file));
  rmSync(file);
}

/** Open files, for reading only: the file, and its contents when it was opened. */
const descriptors = new Map<number, { entry: FileNode; contents: Uint8Array }>();
let nextDescriptor = 3;

export function openSync(file: unknown, flags: string | number = 'r'): number {
  if (flags !== 'r') throw failure('ENOSYS', 'open', String(file));
  const contents = readFileSync(file) as Uint8Array;
  const descriptor = nextDescriptor++;
  descriptors.set(descriptor, { entry: entries.get(resolve(file)) as FileNode, contents });
  return descriptor;
}

export function fstatSync(descriptor: number): Stats {
  const open = descriptors.get(descriptor);
  if (!open) throw failure('EBADF', 'fstat', String(descriptor));
  return new Stats(open.entry);
}

export function readSync(descriptor: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number {
  const contents = descriptors.get(descriptor)?.contents;
  if (!contents) throw failure('EBADF', 'read', String(descriptor));
  const start = position ?? 0;
  const chunk = contents.subarray(start, start + Math.min(length, buffer.length - offset));
  buffer.set(chunk, offset);
  return chunk.length;
}

export function closeSync(descriptor: number): void {
  if (!descriptors.delete(descriptor)) throw failure('EBADF', 'close', String(descriptor));
}

export function symlinkSync(target: unknown, file: unknown): never {
  throw failure('ENOSYS', 'symlink', `${String(target)}' -> '${String(file)}`);
}
