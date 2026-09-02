/**
 * Cross-file index for `.pj` files: parsed programs and their symbols, re-read
 * only when a file's mtime changes. Open documents are always taken from the
 * editor's buffer instead of disk (the server passes them in).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { astSymbols } from './astsymbols';
import type * as A from './parser/ast';
import { parse } from './parser/parser';
import type { PJSymbol } from './symbols';

const SKIP_DIRS = new Set(['node_modules', '.git', 'workingpj', '.workingpj', 'dist', 'bin', 'build']);
const MAX_DEPTH = 8;

interface Entry {
  mtimeMs: number;
  program: A.Program;
  symbols: PJSymbol[];
}

export class WorkspaceIndex {
  private readonly cache = new Map<string, Entry>();
  private roots: string[] = [];
  private lastRefresh = 0;
  /**
   * Without editor file-watch notifications the directory walk is repeated at most
   * this often (only on lookups that need it). With notifications it runs once.
   */
  static readonly POLL_INTERVAL_MS = 5000;
  /** True when the editor sends workspace/didChangeWatchedFiles, so no polling is needed. */
  watched = false;

  setRoots(roots: string[]): void {
    this.roots = roots.map((r) => path.resolve(r));
    this.lastRefresh = 0;
  }

  getRoots(): string[] {
    return this.roots;
  }

  /** Parsed program for a file (from cache if unchanged), or undefined if unreadable. */
  programFor(file: string): A.Program | undefined {
    return this.entryFor(file)?.program;
  }

  /** Find every top-level symbol named `name` across the workspace, excluding `excludePath`. */
  lookup(name: string, excludePath?: string): Array<{ file: string; symbol: PJSymbol }> {
    this.refresh();
    const hits: Array<{ file: string; symbol: PJSymbol }> = [];
    for (const [file, entry] of this.cache) {
      if (excludePath && path.resolve(file) === path.resolve(excludePath)) continue;
      for (const symbol of entry.symbols) {
        if (symbol.name === name) hits.push({ file, symbol });
        for (const child of symbol.children ?? []) if (child.name === name) hits.push({ file, symbol: child });
      }
    }
    return hits;
  }

  /** All top-level symbols in the workspace, for completion. */
  all(excludePath?: string): Array<{ file: string; symbol: PJSymbol }> {
    this.refresh();
    const out: Array<{ file: string; symbol: PJSymbol }> = [];
    for (const [file, entry] of this.cache) {
      if (excludePath && path.resolve(file) === path.resolve(excludePath)) continue;
      for (const symbol of entry.symbols) out.push({ file, symbol });
    }
    return out;
  }

  /** Forget a file: it changed on disk, was deleted, or the editor now owns it. */
  invalidate(file: string): void {
    this.cache.delete(path.resolve(file));
  }

  /** A file appeared on disk (from a watcher notification). */
  add(file: string): void {
    this.entryFor(file);
  }

  private entryFor(file: string): Entry | undefined {
    const abs = path.resolve(file);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(abs).mtimeMs;
    } catch {
      this.cache.delete(abs);
      return undefined;
    }
    const cached = this.cache.get(abs);
    if (cached && cached.mtimeMs === mtimeMs) return cached;
    try {
      const parsed = parse(fs.readFileSync(abs, 'utf8'));
      const entry: Entry = { mtimeMs, program: parsed.program, symbols: astSymbols(parsed).symbols };
      this.cache.set(abs, entry);
      return entry;
    } catch {
      this.cache.delete(abs);
      return undefined;
    }
  }

  private refresh(): void {
    const now = Date.now();
    if (this.lastRefresh > 0 && (this.watched || now - this.lastRefresh < WorkspaceIndex.POLL_INTERVAL_MS)) return;
    this.lastRefresh = now;
    const seen = new Set<string>();
    for (const root of this.roots) this.walk(root, 0, seen);
    for (const file of [...this.cache.keys()]) if (!seen.has(file)) this.cache.delete(file);
  }

  private walk(dir: string, depth: number, seen: Set<string>): void {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) this.walk(full, depth + 1, seen);
        continue;
      }
      if (!e.isFile() || !e.name.endsWith('.pj')) continue;
      seen.add(full);
      this.entryFor(full);
    }
  }
}
