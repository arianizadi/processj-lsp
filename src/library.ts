/**
 * Index of the ProcessJ standard library shipped in <install>/include/JVM/**\/*.pj.
 * Those headers are ordinary ProcessJ declarations (`public native void println(int i);`),
 * so the same extractor used for user code works on them.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractSymbols, type PJSymbol } from './symbols';

export interface LibrarySymbol extends PJSymbol {
  /** Absolute path of the header the symbol was read from. */
  file: string;
  /** Package as declared in the header, e.g. `std`. */
  pkg: string;
  /** Header base name, e.g. `io`, so `std.io` can be shown. */
  module: string;
}

export function indexLibrary(includeDir: string): LibrarySymbol[] {
  const out: LibrarySymbol[] = [];
  const stack = [includeDir];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith('.pj')) out.push(...indexHeader(full));
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.detail.localeCompare(b.detail));
}

function indexHeader(file: string): LibrarySymbol[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const pkg = /^\s*package\s+([A-Za-z0-9_$.]+)\s*;/m.exec(text)?.[1] ?? '';
  const module = path.basename(file, '.pj');
  return extractSymbols(text)
    .filter((s) => s.kind === 'proc' || s.kind === 'const' || s.kind === 'record' || s.kind === 'protocol')
    .map((s) => ({ ...s, file, pkg, module }));
}
