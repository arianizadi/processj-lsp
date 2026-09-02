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
  let importsStd = false;
  for (const im of program.imports) {
    const parts = im.path.map((p) => p.name);
    if (parts[0] === 'std') importsStd = true;
    const found: string[] = [];
    const searched: string[] = [];
    for (const base of bases) {
      const target = path.join(base, ...parts);
      searched.push(base);
      if (im.wildcard) {
        if (isDir(target)) {
          for (const f of listPj(target)) found.push(f);
          break;
        }
      } else if (isFile(`${target}.pj`)) {
        found.push(`${target}.pj`);
        break;
      }
    }
    imports.push({ import: im, files: found, searched });
    for (const f of found) if (!files.includes(f)) files.push(f);
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

function listPj(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.pj'))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}
