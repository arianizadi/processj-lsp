/**
 * A small tokenizer for ProcessJ. Comments are skipped, but the lexer-level
 * problems that crash the real compiler are recorded as issues so they can be
 * reported before the compiler ever runs.
 */
import { KEYWORDS, LITERALS, PRIMITIVE_TYPES } from './keywords';

export type TokenKind = 'ident' | 'keyword' | 'number' | 'string' | 'char' | 'punct';

export interface Token {
  kind: TokenKind;
  text: string;
  line: number;
  col: number;
  /** Exclusive end column on the same line (strings never span lines). */
  end: number;
}

export interface CommentToken {
  kind: 'line' | 'block';
  text: string;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

export interface LexIssue {
  line: number;
  col: number;
  end: number;
  code: string;
  message: string;
}

const KEYWORD_SET = new Set<string>([...KEYWORDS, ...PRIMITIVE_TYPES, ...LITERALS]);

const PUNCT = [
  '>>>=', '<<=', '>>=', '>>>', '&&', '||', '==', '!=', '<=', '>=', '++', '--', '+=', '-=', '*=', '/=', '%=',
  '&=', '|=', '^=', '<<', '>>', '::', '->',
  '{', '}', '(', ')', '[', ']', ';', ',', '.', '=', '<', '>', '+', '-', '*', '/', '%', '!', '~', '&', '|',
  '^', '?', ':', '#', '@',
];

export function tokenize(text: string): { tokens: Token[]; issues: LexIssue[]; comments: CommentToken[] } {
  const tokens: Token[] = [];
  const issues: LexIssue[] = [];
  const comments: CommentToken[] = [];
  let i = 0;
  let line = 0;
  let lineStart = 0;
  const n = text.length;

  // The compiler's JFlex spec is %7bit: any byte above 127 throws inside the scanner,
  // even inside a comment, so scan the raw text once up front.
  {
    let l = 0;
    let ls = 0;
    for (let k = 0; k < n; k++) {
      const ch = text.charCodeAt(k);
      if (ch === 10) {
        l++;
        ls = k + 1;
      } else if (ch > 127) {
        let e = k;
        while (e < n && text.charCodeAt(e) > 127) e++;
        issues.push({ line: l, col: k - ls, end: e - ls, code: 'pj/non-ascii', message: 'Non-ASCII character: the ProcessJ lexer is 7-bit and crashes on it, even inside a comment' });
        k = e - 1;
      }
    }
  }

  const col = () => i - lineStart;
  const newline = () => {
    line++;
    lineStart = i + 1;
  };

  while (i < n) {
    const c = text[i];
    const code = text.charCodeAt(i);

    if (code > 127) {
      i++;
      continue;
    }

    if (c === '\n') {
      newline();
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f') {
      i++;
      continue;
    }

    // Comments.
    if (c === '/' && text[i + 1] === '/') {
      const start = i;
      const startCol = col();
      while (i < n && text[i] !== '\n') i++;
      comments.push({ kind: 'line', text: text.slice(start, i).replace(/\r$/, ''), line, col: startCol, endLine: line, endCol: col() });
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      if (text[i + 2] === '*' && text[i + 3] === '/') {
        issues.push({ line, col: col(), end: col() + 4, code: 'pj/empty-comment', message: "'/**/' is not recognised as a comment by the ProcessJ lexer; use '/* */' with a space" });
        i += 4;
        continue;
      }
      const start = i;
      const startLine = line;
      const startCol = col();
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        if (text[i] === '\n') newline();
        i++;
      }
      i += 2;
      comments.push({ kind: 'block', text: text.slice(start, Math.min(i, n)), line: startLine, col: startCol, endLine: line, endCol: col() });
      continue;
    }

    // Strings and chars.
    if (c === '"' || c === "'") {
      const start = i;
      const startCol = col();
      let hasEscape = false;
      i++;
      while (i < n && text[i] !== c && text[i] !== '\n') {
        if (text[i] === '\\') {
          hasEscape = true;
          i += 2;
        } else i++;
      }
      if (i < n && text[i] === c) i++;
      const raw = text.slice(start, i);
      const kind: TokenKind = c === '"' ? 'string' : 'char';
      tokens.push({ kind, text: raw, line, col: startCol, end: startCol + raw.length });
      if (kind === 'string' && hasEscape) {
        issues.push({ line, col: startCol, end: startCol + raw.length, code: 'pj/string-escape', message: 'Escape sequences are not accepted in string literals by the ProcessJ lexer (it throws "Illegal character"); only char literals support them' });
      }
      continue;
    }

    // Numbers.
    if (isDigit(code) || (c === '.' && isDigit(text.charCodeAt(i + 1)))) {
      const start = i;
      const startCol = col();
      if (c === '0' && /[xX]/.test(text[i + 1] ?? '')) {
        i += 2;
        while (i < n && /[0-9a-fA-F_]/.test(text[i])) i++;
      } else {
        while (i < n && /[0-9._]/.test(text[i])) i++;
        if (/[eE]/.test(text[i] ?? '')) {
          i++;
          if (/[+-]/.test(text[i] ?? '')) i++;
          while (i < n && /[0-9]/.test(text[i])) i++;
        }
      }
      if (/[lLfFdD]/.test(text[i] ?? '')) i++;
      const raw = text.slice(start, i);
      tokens.push({ kind: 'number', text: raw, line, col: startCol, end: startCol + raw.length });
      continue;
    }

    // Identifiers and keywords.
    if (isIdentStart(code)) {
      const start = i;
      const startCol = col();
      while (i < n && isIdentPart(text.charCodeAt(i))) i++;
      const word = text.slice(start, i);
      tokens.push({ kind: KEYWORD_SET.has(word) ? 'keyword' : 'ident', text: word, line, col: startCol, end: startCol + word.length });
      continue;
    }

    // Punctuation, longest match first.
    let matched = false;
    for (const p of PUNCT) {
      if (text.startsWith(p, i)) {
        tokens.push({ kind: 'punct', text: p, line, col: col(), end: col() + p.length });
        i += p.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      issues.push({ line, col: col(), end: col() + 1, code: 'pj/illegal-char', message: `Illegal character '${c}'` });
      i++;
    }
  }
  return { tokens, issues, comments };
}

function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}
function isIdentStart(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
}
function isIdentPart(c: number): boolean {
  return isIdentStart(c) || isDigit(c);
}

/** Index of the token that closes the block opened at `openIdx` (which must be `{`, `(` or `[`). */
export function matchingClose(tokens: Token[], openIdx: number): number {
  const open = tokens[openIdx].text;
  const close = open === '{' ? '}' : open === '(' ? ')' : ']';
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== 'punct') continue;
    if (t.text === open) depth++;
    else if (t.text === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}
