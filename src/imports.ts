/**
 * Resolve `import a.b.c;` and `import a.b.*;` to files on disk.
 *
 * Search order mirrors what a user expects and what the compiler does with its
 * include directory: the importing file's own directory, each workspace root,
 * then the install's include directory (with its JVM/ language subfolder).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as A from './parser/ast';

export interface ResolvedImport {
  import: A.Import;
  /** Absolute paths of the files this import brings in (empty when unresolved). */
  files: string[];
  /** Directories that were searched, for the diagnostic. */
  searched: string[];
  /** The search base the import was found under (absent when unresolved). */
  base?: string;
  /** Found outside the install's include directory: a user library the compiler cannot build against. */
  userLibrary: boolean;
}

export interface ImportDiagnostic {
  line: number;
  startCol: number;
  endCol: number;
  message: string;
  severity: 'warning' | 'info';
  code: 'pj/import';
  source: 'lsp';
}

/** Warnings about imports that resolve nowhere. */
export function importDiagnostics(res: ImportResolution, haveInstall: boolean): ImportDiagnostic[] {
  const out: ImportDiagnostic[] = [];
  for (const r of res.imports) {
    const name = r.import.path.map((p) => p.name).join('.') + (r.import.wildcard ? '.*' : '');
    const span = r.import.span;
    if (r.files.length === 0) {
      const where = haveInstall ? '' : ' (no ProcessJ install found, so the standard library is unavailable)';
      out.push({ line: span.start.line, startCol: span.start.col, endCol: span.end.col, message: `Cannot find import '${name}'${where}; looked in ${r.searched.map((d) => path.basename(d) || d).join(', ')}`, severity: 'warning', code: 'pj/import', source: 'lsp' });
    }
  }
  return out;
}

export interface ImportResolution {
  imports: ResolvedImport[];
  /** All imported files, in order, without duplicates. */
  files: string[];
  /** Whether any import refers to the standard library (`std`). */
  importsStd: boolean;
}

export function resolveImports(program: A.Program, ownPath: string | undefined, roots: string[], includeDir: string | undefined): ImportResolution {
  const bases: string[] = [];
  if (ownPath) bases.push(path.dirname(ownPath));
  for (const r of roots) if (!bases.includes(r)) bases.push(r);
  if (includeDir) {
    for (const sub of ['JVM', '']) {
      const dir = sub ? path.join(includeDir, sub) : includeDir;
      if (!bases.includes(dir)) bases.push(dir);
    }
  }

  const imports: ResolvedImport[] = [];
  const files: string[] = [];
  const seen = new Set<string>();
  let importsStd = false;
  for (const im of program.imports) {
    const parts = im.path.map((p) => p.name);
    if (parts[0] === 'std') importsStd = true;
    const found: string[] = [];
    const searched: string[] = [];
    let userLibrary = false;
    let matchedBase: string | undefined;
    for (const base of bases) {
      const target = path.join(base, ...parts);
      searched.push(base);
      const inInclude = !!includeDir && base.startsWith(includeDir);
      if (im.wildcard) {
        if (isDir(target)) {
          for (const f of listPj(target)) found.push(f);
          userLibrary = !inInclude;
          matchedBase = base;
          break;
        }
      } else if (isFile(`${target}.pj`)) {
        found.push(`${target}.pj`);
        userLibrary = !inInclude;
        matchedBase = base;
        break;
      }
    }
    imports.push({ import: im, files: found, searched, userLibrary, base: matchedBase });
    for (const f of found) {
      if (seen.has(f)) continue;
      seen.add(f);
      files.push(f);
    }
  }
  return { imports, files, importsStd };
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Deeper than any real package tree; also stops a symlink cycle. */
const MAX_WILDCARD_DEPTH = 8;
/** A wildcard import that reaches this many files is a disk, not a package. */
const MAX_WILDCARD_FILES = 2000;

/**
 * Every `.pj` file under `dir`, including sub-directories: the compiler's
 * ResolveImports.makeFileList walks the whole package tree for `import a.*;`.
 * Files come before sub-directories, each group sorted, so output is stable.
 */
function listPj(dir: string, depth = 0, out: string[] = [], visited = new Set<string>()): string[] {
  if (depth > MAX_WILDCARD_DEPTH || out.length >= MAX_WILDCARD_FILES) return out;
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    return out;
  }
  if (visited.has(real)) return out;
  visited.add(real);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (out.length >= MAX_WILDCARD_FILES) break;
    if (entry.name.endsWith('.pj') && (entry.isFile() || (entry.isSymbolicLink() && isFile(path.join(dir, entry.name))))) out.push(path.join(dir, entry.name));
  }
  for (const entry of entries) {
    if (out.length >= MAX_WILDCARD_FILES) break;
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory() || (entry.isSymbolicLink() && isDir(path.join(dir, entry.name)))) listPj(path.join(dir, entry.name), depth + 1, out, visited);
  }
  return out;
}
