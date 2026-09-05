/**
 * Cross-file index for `.pj` files: parsed programs and their symbols, re-read
 * only when a file's mtime changes. Open documents are always taken from the
 * editor's buffer instead of disk (the server passes them in).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { astSymbols } from './astsymbols';
import { check } from './checker/checker';
import { DeclIndex } from './checker/index';
import type * as A from './parser/ast';
import { parse } from './parser/parser';
import type { PJSymbol } from './symbols';

const SKIP_DIRS = new Set(['node_modules', '.git', 'workingpj', '.workingpj', 'dist', 'bin', 'build', 'Library', 'Applications']);
const MAX_DEPTH = 6;
/** Stop indexing a root once it holds this many .pj files; it is not a project, it is a disk. */
const MAX_FILES = 2000;

interface Entry {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  program: A.Program;
  symbols: PJSymbol[];
  /** Flat line/start/end triples keep the workspace-wide occurrence index compact. */
  occurrences: Map<string, number[]>;
  /** Built lazily: exact declaration/use spans belonging to local variables. */
  localSpans?: Set<string>;
}

export interface WorkspaceOccurrence {
  file: string;
  line: number;
  startCol: number;
  endCol: number;
}

export interface WorkspaceCompletion {
  items: Array<{ file: string; symbol: PJSymbol }>;
  /** More prefix matches exist; the client should ask again as the user types. */
  isIncomplete: boolean;
}

export class WorkspaceIndex {
  constructor(private readonly onRefresh?: (changed: ReadonlySet<string>, structureChanged: boolean) => void) {}

  private readonly cache = new Map<string, Entry>();
  /** Exact-name index, then file, so definition/hover do not scan every symbol. */
  private readonly symbolsByName = new Map<string, Map<string, PJSymbol[]>>();
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
    // The home directory or a filesystem root is never a project: indexing it would
    // walk the whole disk and mix unrelated files into every lookup.
    const home = path.resolve(os.homedir());
    for (const file of [...this.cache.keys()]) this.deleteEntry(file);
    this.roots = roots.map((r) => path.resolve(r)).filter((r) => r !== home && r !== path.parse(r).root);
    this.lastRefresh = 0;
  }

  getRoots(): string[] {
    return this.roots;
  }

  /** Parsed program for a file (from cache if unchanged), or undefined if unreadable. */
  programFor(file: string): A.Program | undefined {
    return this.entryFor(file)?.program;
  }

  /** One exact declaration from a known file, without refreshing every root. */
  symbolAt(file: string, kind: PJSymbol['kind'], name: string, line: number, startCol: number): PJSymbol | undefined {
    const entry = this.entryFor(file);
    if (!entry) return undefined;
    for (const symbol of entry.symbols) {
      if (symbol.kind === kind && symbol.name === name && symbol.line === line && symbol.startCol === startCol) return symbol;
      for (const child of symbol.children ?? []) {
        if (child.kind === kind && child.name === name && child.line === line && child.startCol === startCol) return child;
      }
    }
    return undefined;
  }

  /** Find every top-level symbol named `name` across the workspace, excluding `excludePath`. */
  lookup(name: string, excludePath?: string): Array<{ file: string; symbol: PJSymbol }> {
    this.refresh();
    const hits: Array<{ file: string; symbol: PJSymbol }> = [];
    const excluded = excludePath ? path.resolve(excludePath) : undefined;
    for (const [file, symbols] of this.symbolsByName.get(name) ?? []) {
      if (file === excluded) continue;
      for (const symbol of symbols) hits.push({ file, symbol });
    }
    return hits;
  }

  /** All top-level symbols in the workspace, for completion. */
  all(excludePath?: string): Array<{ file: string; symbol: PJSymbol }> {
    this.refresh();
    const out: Array<{ file: string; symbol: PJSymbol }> = [];
    const excluded = excludePath ? path.resolve(excludePath) : undefined;
    for (const [file, entry] of this.cache) {
      if (file === excluded) continue;
      for (const symbol of entry.symbols) out.push({ file, symbol });
    }
    return out;
  }

  /**
   * A bounded prefix view for auto-import completion. Walking the name index
   * avoids allocating every symbol in a very large workspace on each keypress.
   */
  completions(prefix: string, limit: number, excludedFiles: ReadonlySet<string> = new Set(), excludePath?: string): WorkspaceCompletion {
    this.refresh();
    const items: Array<{ file: string; symbol: PJSymbol }> = [];
    const wanted = prefix.toLowerCase();
    const excluded = excludePath ? path.resolve(excludePath) : undefined;
    const visit = (name: string, files: Map<string, PJSymbol[]>): boolean => {
      if (wanted && !name.toLowerCase().startsWith(wanted)) return false;
      for (const [file, symbols] of files) {
        if (file === excluded || excludedFiles.has(file)) continue;
        for (const symbol of symbols) {
          // Members cannot be imported independently of their owner.
          if (symbol.kind === 'field' || symbol.kind === 'case' || (symbol.kind === 'proc' && symbol.name === 'main')) continue;
          if (items.length >= limit) return true;
          items.push({ file, symbol });
        }
      }
      return false;
    };
    // Never let a broad-prefix budget hide an exact match that happens to have
    // been indexed after hundreds of longer names. Keep the remaining pass in
    // insertion order so this stays linear rather than sorting the whole index
    // on every keystroke.
    let exact: [string, Map<string, PJSymbol[]>] | undefined;
    if (wanted) {
      for (const entry of this.symbolsByName) {
        if (entry[0].toLowerCase() === wanted) {
          exact = entry;
          break;
        }
      }
    }
    if (exact && visit(exact[0], exact[1])) return { items, isIncomplete: true };
    for (const [name, files] of this.symbolsByName) {
      if (exact && files === exact[1]) continue;
      if (visit(name, files)) return { items, isIncomplete: true };
    }
    return { items, isIncomplete: false };
  }

  /**
   * Identifier occurrences across on-disk workspace files. They are collected
   * from the tokens produced by the file's existing parse, so references and
   * rename do not read and tokenize the entire workspace again on every request.
   */
  occurrences(name: string, excludePath?: string, excludeLocals = false): WorkspaceOccurrence[] {
    this.refresh();
    const excluded = excludePath ? path.resolve(excludePath) : undefined;
    const out: WorkspaceOccurrence[] = [];
    for (const [file, entry] of this.cache) {
      if (file === excluded) continue;
      const positions = entry.occurrences.get(name) ?? [];
      if (positions.length === 0) continue;
      const localSpans = excludeLocals ? this.localSpans(file, entry) : undefined;
      for (let i = 0; i < positions.length; i += 3) {
        if (localSpans?.has(`${positions[i]}:${positions[i + 1]}:${positions[i + 2]}`)) continue;
        out.push({ file, line: positions[i], startCol: positions[i + 1], endCol: positions[i + 2] });
      }
    }
    return out;
  }

  /** Forget a file: it changed on disk, was deleted, or the editor now owns it. */
  invalidate(file: string): void {
    this.deleteEntry(path.resolve(file));
  }

  /** A file appeared on disk (from a watcher notification). */
  add(file: string): void {
    this.entryFor(file);
  }

  private entryFor(file: string): Entry | undefined {
    const abs = path.resolve(file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      this.deleteEntry(abs);
      return undefined;
    }
    const cached = this.cache.get(abs);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs && cached.size === stat.size) return cached;
    try {
      const parsed = parse(fs.readFileSync(abs, 'utf8'));
      const occurrences = new Map<string, number[]>();
      for (let i = 0; i < parsed.tokens.length; i++) {
        const token = parsed.tokens[i];
        if (token.kind !== 'ident') continue;
        const prev = parsed.tokens[i - 1];
        if (prev?.kind === 'punct' && prev.text === '.') continue;
        const list = occurrences.get(token.text);
        if (list) list.push(token.line, token.col, token.end);
        else occurrences.set(token.text, [token.line, token.col, token.end]);
      }
      const entry: Entry = { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, program: parsed.program, symbols: astSymbols(parsed).symbols, occurrences };
      this.replaceEntry(abs, entry);
      return entry;
    } catch {
      this.deleteEntry(abs);
      return undefined;
    }
  }

  /** Poll before using dependent analysis, as well as before symbol lookups. */
  refresh(): void {
    const now = Date.now();
    if (this.lastRefresh > 0 && (this.watched || now - this.lastRefresh < WorkspaceIndex.POLL_INTERVAL_MS)) return;
    const initialized = this.lastRefresh > 0;
    this.lastRefresh = now;
    const previous = new Map(this.cache);
    const seen = new Set<string>();
    for (const root of this.roots) this.walk(root, 0, seen);
    for (const file of [...this.cache.keys()]) if (!seen.has(file)) this.deleteEntry(file);
    const changed = new Set<string>();
    let structureChanged = false;
    for (const [file, entry] of this.cache) {
      if (previous.get(file) !== entry) changed.add(file);
      if (!previous.has(file)) structureChanged = true;
    }
    for (const file of previous.keys()) {
      if (!this.cache.has(file)) {
        changed.add(file);
        structureChanged = true;
      }
    }
    // Initial discovery establishes the baseline; there is no old analysis
    // to invalidate, and aborting the check that requested it wastes work.
    if (initialized && changed.size) this.onRefresh?.(changed, structureChanged);
  }

  private walk(dir: string, depth: number, seen: Set<string>): void {
    if (depth > MAX_DEPTH || seen.size >= MAX_FILES) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Deterministic truncation under MAX_FILES; code-unit order is enough and far cheaper than collation.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (seen.size >= MAX_FILES) return;
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

  private replaceEntry(file: string, entry: Entry): void {
    this.deleteEntry(file);
    this.cache.set(file, entry);
    for (const symbol of entry.symbols) {
      this.addNamedSymbol(file, symbol);
      for (const child of symbol.children ?? []) this.addNamedSymbol(file, child);
    }
  }

  private addNamedSymbol(file: string, symbol: PJSymbol): void {
    let files = this.symbolsByName.get(symbol.name);
    if (!files) {
      files = new Map();
      this.symbolsByName.set(symbol.name, files);
    }
    const symbols = files.get(file);
    if (symbols) symbols.push(symbol);
    else files.set(file, [symbol]);
  }

  /** Resolve locals once on the rare references/rename path, without re-reading the file. */
  private localSpans(file: string, entry: Entry): Set<string> {
    if (entry.localSpans) return entry.localSpans;
    const index = new DeclIndex();
    index.addProgram(entry.program, file);
    const checked = check(entry.program, { index, unresolvedImports: true });
    const spans = new Set<string>();
    const add = (span: A.Span) => spans.add(`${span.start.line}:${span.start.col}:${span.end.col}`);
    for (const variable of checked.vars) add(variable.decl.span);
    for (const [expr] of checked.resolutions) add(expr.name.span);
    entry.localSpans = spans;
    return spans;
  }

  private deleteEntry(file: string): void {
    const entry = this.cache.get(file);
    if (!entry) return;
    this.cache.delete(file);
    for (const symbol of entry.symbols) {
      this.deleteNamedSymbol(file, symbol.name);
      for (const child of symbol.children ?? []) this.deleteNamedSymbol(file, child.name);
    }
  }

  private deleteNamedSymbol(file: string, name: string): void {
    const files = this.symbolsByName.get(name);
    if (!files) return;
    files.delete(file);
    if (files.size === 0) this.symbolsByName.delete(name);
  }
}
