/**
 * A lightweight, regex-driven symbol extractor for ProcessJ source.
 *
 * The real compiler has no library API and exits on the first fatal error, so for
 * completion, hover, definition and outline we scan the text ourselves. This is
 * deliberately tolerant: it works on half-typed files.
 */
import { NOT_A_TYPE } from './keywords';

export type PJSymbolKind = 'proc' | 'record' | 'protocol' | 'const' | 'field' | 'case' | 'var';

export interface PJSymbol {
  name: string;
  kind: PJSymbolKind;
  /** 0-based line of the declaration. */
  line: number;
  /** 0-based columns of the name on that line. */
  startCol: number;
  endCol: number;
  /** 0-based last line of the declaration body (same as `line` for one-liners). */
  endLine: number;
  /** Signature or type, e.g. `public void foo(chan<int>.read in)` or `int`. */
  detail: string;
  /** Comment block found directly above the declaration, if any. */
  doc?: string;
  /** For procs: parameter list as written, one entry per parameter. */
  params?: string[];
  /** Enclosing symbol name for fields, cases and locals. */
  container?: string;
  /** Nested declarations (record fields, protocol cases). */
  children?: PJSymbol[];
}

const MODIFIERS = String.raw`(?:(?:public|private|protected|native|mobile|extern|shared)\s+)*`;
// A type: optional `shared`, then either chan<...>[.read|.write] or an identifier with optional generics,
// followed by any number of [] pairs.
const TYPE = String.raw`(?:shared\s+)?(?:chan\s*<[^<>\n]*(?:<[^<>\n]*>[^<>\n]*)?>(?:\.(?:read|write))?|[A-Za-z_]\w*(?:\s*<[^<>\n]*>)?)(?:\s*\[\s*\])*`;
const IDENT = String.raw`[A-Za-z_]\w*`;

const PROC_RE = new RegExp(String.raw`^(\s*)(${MODIFIERS})(?:proc\s+)?(${TYPE})\s+(${IDENT})\s*\(([^()]*)\)`);
const RECORD_RE = new RegExp(String.raw`^(\s*)(${MODIFIERS})record\s+(${IDENT})(?:\s+extends\s+([\w\s,]+?))?\s*\{?`);
const PROTOCOL_RE = new RegExp(String.raw`^(\s*)(${MODIFIERS})protocol\s+(${IDENT})(?:\s+extends\s+([\w\s,]+?))?\s*\{?`);
const CONST_RE = new RegExp(String.raw`^(\s*)(${MODIFIERS})const\s+(${TYPE})\s+(${IDENT})`);
const FIELD_RE = new RegExp(String.raw`^(\s*)(${TYPE})\s+(${IDENT})\s*;`);
const CASE_RE = new RegExp(String.raw`^(\s*)(${IDENT})\s*:\s*\{`);
const LOCAL_RE = new RegExp(String.raw`(?:^|[;{}(,]|\bfor\s*\()\s*(${TYPE})\s+(${IDENT})((?:\s*,\s*${IDENT})*)\s*(?=[=;,)\]:])`, 'g');

/**
 * Replace comment bodies and string/char literal contents with spaces so brace
 * matching and regexes cannot be fooled by them. Newlines are preserved.
 */
export function maskCommentsAndStrings(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      while (i < n && text[i] !== '\n') {
        out += ' ';
        i++;
      }
    } else if (c === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        out += text[i] === '\n' ? '\n' : ' ';
        i++;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
    } else if (c === '"' || c === "'") {
      const q = c;
      out += q;
      i++;
      while (i < n && text[i] !== q && text[i] !== '\n') {
        if (text[i] === '\\' && i + 1 < n) {
          out += '  ';
          i += 2;
        } else {
          out += ' ';
          i++;
        }
      }
      if (i < n && text[i] === q) {
        out += q;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Given masked lines, find the line where the block opened at `startLine` closes. */
function findBlockEnd(masked: string[], startLine: number): number {
  let depth = 0;
  let opened = false;
  for (let l = startLine; l < masked.length; l++) {
    for (const ch of masked[l]) {
      if (ch === '{') {
        depth++;
        opened = true;
      } else if (ch === '}') {
        depth--;
        if (opened && depth === 0) return l;
      }
    }
    // A declaration with no body (e.g. `public native void println(string s);`).
    if (!opened && /;\s*$/.test(masked[l])) return l;
  }
  return masked.length - 1;
}

/** Collect a `//` run or a `/* ... *\/` block sitting directly above `line`. */
function docAbove(lines: string[], line: number): string | undefined {
  let l = line - 1;
  while (l >= 0 && lines[l].trim() === '') l--;
  if (l < 0) return undefined;
  const t = lines[l].trim();
  if (t.endsWith('*/')) {
    const block: string[] = [];
    while (l >= 0) {
      block.unshift(lines[l]);
      if (lines[l].trim().startsWith('/*')) break;
      l--;
    }
    return block
      .map((s) => s.trim().replace(/^\/\*+\s?/, '').replace(/\*+\/\s*$/, '').replace(/^\*\s?/, ''))
      .filter((s, i, arr) => !(s === '' && (i === 0 || i === arr.length - 1)))
      .join('\n')
      .trim() || undefined;
  }
  if (t.startsWith('//')) {
    const block: string[] = [];
    while (l >= 0 && lines[l].trim().startsWith('//')) {
      block.unshift(lines[l].trim().replace(/^\/\/\s?/, ''));
      l--;
    }
    return block.join('\n').trim() || undefined;
  }
  return undefined;
}

function splitParams(raw: string): string[] {
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Extract top-level declarations (procs, records, protocols, constants) with their members. */
export function extractSymbols(text: string): PJSymbol[] {
  const lines = text.split(/\r?\n/);
  const masked = maskCommentsAndStrings(text).split(/\r?\n/);
  const symbols: PJSymbol[] = [];

  for (let l = 0; l < masked.length; l++) {
    const line = masked[l];
    if (line.trim() === '') continue;

    let m = RECORD_RE.exec(line) ?? PROTOCOL_RE.exec(line);
    if (m) {
      const isRecord = /\brecord\b/.test(line);
      const name = m[3];
      const endLine = findBlockEnd(masked, l);
      const sym: PJSymbol = {
        name,
        kind: isRecord ? 'record' : 'protocol',
        line: l,
        startCol: line.indexOf(name, m[1].length + m[2].length),
        endCol: 0,
        endLine,
        detail: `${isRecord ? 'record' : 'protocol'} ${name}${m[4] ? ` extends ${m[4].trim()}` : ''}`,
        doc: docAbove(lines, l),
        children: [],
      };
      sym.endCol = sym.startCol + name.length;
      for (let k = l + 1; k <= endLine; k++) {
        const inner = masked[k];
        if (isRecord) {
          const f = FIELD_RE.exec(inner);
          if (f) {
            const col = inner.indexOf(f[3], f[1].length + f[2].length);
            sym.children!.push({
              name: f[3], kind: 'field', line: k, startCol: col, endCol: col + f[3].length, endLine: k,
              detail: `${f[2].replace(/\s+/g, ' ')} ${f[3]}`, container: name,
            });
          }
        } else {
          const c = CASE_RE.exec(inner);
          if (c) {
            const col = inner.indexOf(c[2], c[1].length);
            const caseEnd = findBlockEnd(masked, k);
            const fields: string[] = [];
            for (let q = k; q <= caseEnd; q++) {
              const body = q === k ? masked[q].slice(masked[q].indexOf('{') + 1) : masked[q];
              for (const part of body.split(';')) {
                const f = new RegExp(String.raw`^\s*(${TYPE})\s+(${IDENT})\s*$`).exec(part);
                if (f) fields.push(`${f[1].replace(/\s+/g, ' ')} ${f[2]}`);
              }
            }
            sym.children!.push({
              name: c[2], kind: 'case', line: k, startCol: col, endCol: col + c[2].length, endLine: caseEnd,
              detail: `${c[2]} : { ${fields.join('; ')}${fields.length ? ';' : ''} }`, container: name,
            });
          }
        }
      }
      symbols.push(sym);
      l = endLine;
      continue;
    }

    m = CONST_RE.exec(line);
    if (m) {
      const name = m[4];
      const col = line.indexOf(name, m[1].length + m[2].length + m[3].length);
      symbols.push({
        name, kind: 'const', line: l, startCol: col, endCol: col + name.length, endLine: l,
        detail: `${m[2]}const ${m[3].replace(/\s+/g, ' ')} ${name}`.trim(), doc: docAbove(lines, l),
      });
      continue;
    }

    m = PROC_RE.exec(line);
    if (m) {
      const type = m[3].replace(/\s+/g, ' ');
      const name = m[4];
      const typeHead = type.split(/[\s<[.]/)[0];
      if (NOT_A_TYPE.has(typeHead) || NOT_A_TYPE.has(name)) continue;
      const col = line.indexOf(name, m[1].length + m[2].length + m[3].length);
      const endLine = findBlockEnd(masked, l);
      const params = splitParams(m[5]);
      symbols.push({
        name, kind: 'proc', line: l, startCol: col, endCol: col + name.length, endLine,
        detail: `${m[2]}${type} ${name}(${params.join(', ')})`.replace(/\s+/g, ' ').trim(),
        doc: docAbove(lines, l), params,
      });
      l = endLine;
      continue;
    }
  }
  return symbols;
}

/**
 * Extract local variable and parameter declarations. Used for completion and
 * for "go to definition" on locals. Each entry's `container` is the enclosing proc.
 */
export function extractLocals(text: string, procs?: PJSymbol[]): PJSymbol[] {
  const masked = maskCommentsAndStrings(text);
  const lines = masked.split(/\r?\n/);
  const containers = (procs ?? extractSymbols(text)).filter((s) => s.kind === 'proc');
  const out: PJSymbol[] = [];
  const seen = new Set<string>();

  for (let l = 0; l < lines.length; l++) {
    const line = lines[l];
    // Parameters of a proc declared on this line come first; the parameter list is
    // then excluded from the local-declaration scan below.
    let paramSpan: [number, number] | undefined;
    const p = PROC_RE.exec(line);
    if (p && !NOT_A_TYPE.has(p[3].split(/[\s<[.]/)[0]) && !NOT_A_TYPE.has(p[4])) {
      const open = line.indexOf('(', p[1].length + p[2].length + p[3].length);
      const close = line.indexOf(')', open);
      paramSpan = [open, close < 0 ? line.length : close];
      for (const param of splitParams(p[5])) {
        const pm = new RegExp(String.raw`^(${TYPE})\s+(${IDENT})$`).exec(param.replace(/\s+/g, ' '));
        if (!pm) continue;
        const col = line.indexOf(pm[2], open);
        out.push({ name: pm[2], kind: 'var', line: l, startCol: col, endCol: col + pm[2].length, endLine: l, detail: `${pm[1]} ${pm[2]} (parameter)`, container: p[4] });
      }
    }
    LOCAL_RE.lastIndex = 0;
    for (let m = LOCAL_RE.exec(line); m; m = LOCAL_RE.exec(line)) {
      if (paramSpan && m.index >= paramSpan[0] && m.index <= paramSpan[1]) continue;
      const type = m[1].replace(/\s+/g, ' ');
      const typeHead = type.split(/[\s<[.]/)[0];
      if (NOT_A_TYPE.has(typeHead)) continue;
      const names = [m[2], ...m[3].split(',').map((s) => s.trim()).filter(Boolean)];
      const container = containers.find((p) => l >= p.line && l <= p.endLine)?.name;
      let searchFrom = m.index;
      for (const name of names) {
        if (NOT_A_TYPE.has(name)) continue;
        const col = line.indexOf(name, searchFrom + m[1].length);
        searchFrom = col + name.length;
        const key = `${container ?? ''}|${name}|${l}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ name, kind: 'var', line: l, startCol: col, endCol: col + name.length, endLine: l, detail: `${type} ${name}`, container });
      }
    }
  }
  return out;
}

/** Word under a cursor position, with its column span. */
export function wordAt(lineText: string, col: number): { word: string; start: number; end: number } | undefined {
  let start = col;
  while (start > 0 && /\w/.test(lineText[start - 1])) start--;
  let end = col;
  while (end < lineText.length && /\w/.test(lineText[end])) end++;
  if (start === end) return undefined;
  const word = lineText.slice(start, end);
  if (!/^[A-Za-z_]\w*$/.test(word)) return undefined;
  return { word, start, end };
}
