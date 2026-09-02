/**
 * Cross-file symbol index for `.pj` files under the workspace folders. Files are
 * re-read only when their mtime changes; open documents are always taken from the
 * editor's buffer instead of disk.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractSymbols, type PJSymbol } from './symbols';

const SKIP_DIRS = new Set(['node_modules', '.git', 'workingpj', '.workingpj', 'dist', 'bin', 'build']);
const MAX_DEPTH = 8;

interface Entry {
  mtimeMs: number;
  symbols: PJSymbol[];
}

export class WorkspaceIndex {
  private readonly cache = new Map<string, Entry>();
  private roots: string[] = [];

  setRoots(roots: string[]): void {
    this.roots = roots.map((r) => path.resolve(r));
  }

  /** Find every top-level symbol named `name` across the workspace, excluding `excludePath`. */
  lookup(name: string, excludePath?: string): Array<{ file: string; symbol: PJSymbol }> {
    this.refresh();
    const hits: Array<{ file: string; symbol: PJSymbol }> = [];
    for (const [file, entry] of this.cache) {
      if (excludePath && path.resolve(file) === path.resolve(excludePath)) continue;
      for (const symbol of entry.symbols) {
        if (symbol.name === name) hits.push({ file, symbol });
        for (const child of symbol.children ?? []) {
          if (child.name === name) hits.push({ file, symbol: child });
        }
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

  private refresh(): void {
    const seen = new Set<string>();
    for (const root of this.roots) this.walk(root, 0, seen);
    for (const file of [...this.cache.keys()]) {
      if (!seen.has(file)) this.cache.delete(file);
    }
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
      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch {
        continue;
      }
      const cached = this.cache.get(full);
      if (cached && cached.mtimeMs === mtimeMs) continue;
      try {
        this.cache.set(full, { mtimeMs, symbols: extractSymbols(fs.readFileSync(full, 'utf8')) });
      } catch {
        this.cache.delete(full);
      }
    }
  }
}
