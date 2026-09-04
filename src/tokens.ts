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
  '&=', '|=', '^=', '<<', '>>', '::',
  '{', '}', '(', ')', '[', ']', ';', ',', '.', '=', '<', '>', '+', '-', '*', '/', '%', '!', '~', '&', '|',
  '^', '?', ':', '#',
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
      if (ch === 13) {
        if (text.charCodeAt(k + 1) === 10) k++;
        l++;
        ls = k + 1;
      } else if (ch === 10) {
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

    if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      newline();
      i++;
      continue;
    }
    if (c === '\n') {
      newline();
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\f') {
      i++;
      continue;
    }

    // Comments.
    if (c === '/' && text[i + 1] === '/') {
      const start = i;
      const startCol = col();
      while (i < n && text[i] !== '\n' && text[i] !== '\r') i++;
      comments.push({ kind: 'line', text: text.slice(start, i), line, col: startCol, endLine: line, endCol: col() });
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
        if (text[i] === '\r') {
          if (text[i + 1] === '\n') i++;
          newline();
        } else if (text[i] === '\n') newline();
        i++;
      }
      const closed = i < n;
      if (closed) i += 2;
      else issues.push({ line: startLine, col: startCol, end: startCol + 2, code: 'pj/unterminated-comment', message: 'Unterminated block comment; add */ before the end of the file' });
      comments.push({ kind: 'block', text: text.slice(start, Math.min(i, n)), line: startLine, col: startCol, endLine: line, endCol: col() });
      continue;
    }

    // Strings and chars.
    if (c === '"' || c === "'") {
      const start = i;
      const startCol = col();
      let hasEscape = false;
      i++;
      while (i < n && text[i] !== c && text[i] !== '\n' && text[i] !== '\r') {
        if (text[i] === '\\') {
          hasEscape = true;
          // Do not skip across a line terminator: the real scanner stops the
          // literal there, including when the newline follows a backslash.
          i += text[i + 1] === '\n' || text[i + 1] === '\r' ? 1 : 2;
        } else i++;
      }
      const closed = i < n && text[i] === c;
      if (closed) i++;
      const raw = text.slice(start, i);
      const kind: TokenKind = c === '"' ? 'string' : 'char';
      tokens.push({ kind, text: raw, line, col: startCol, end: startCol + raw.length });
      if (!closed) {
        issues.push({
          line,
          col: startCol,
          end: startCol + Math.max(1, raw.length),
          code: kind === 'string' ? 'pj/unterminated-string' : 'pj/unterminated-char',
          message: `Unterminated ${kind === 'string' ? 'string' : 'character'} literal`,
        });
      } else if (kind === 'string' && hasEscape) {
        issues.push({ line, col: startCol, end: startCol + raw.length, code: 'pj/string-escape', message: 'Escape sequences are not accepted in string literals by the ProcessJ lexer (it throws "Illegal character"); only char literals support them' });
      } else if (kind === 'char' && !validCharLiteral(raw)) {
        issues.push({ line, col: startCol, end: startCol + raw.length, code: 'pj/char-literal', message: 'A character literal must contain exactly one character or a valid escape sequence' });
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
      if (!validNumericLiteral(raw)) {
        issues.push({ line, col: startCol, end: startCol + raw.length, code: 'pj/numeric-literal', message: `'${raw}' is not a numeric literal accepted by the ProcessJ lexer` });
      }
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

/** Exact spelling accepted by ProcessJ.flex for a character literal. */
function validCharLiteral(raw: string): boolean {
  if (/^'[^\r\n'\\]'$/.test(raw)) return true;
  const body = raw.slice(1, -1);
  return /^\\(?:[btnfr"'\\]|[0-3]?[0-7]?[0-7]|u[0-9a-fA-F]{4})$/.test(body);
}

// Exact numeric token forms from ProcessJ.flex (underscores are not supported).
// ProcessJ.flex's unsuffixed DoubleLiteral includes `[0-9]+`. JFlex chooses the
// longest match, so spellings such as `09` are one double token (while `077`
// ties with OctIntegerLiteral and the earlier integer rule wins).
const EXPONENT = '[eE][+-]?[0-9]+';
const FLOATING = `(?:[0-9]+\\.[0-9]*(?:${EXPONENT})?|\\.[0-9]+(?:${EXPONENT})?|[0-9]+${EXPONENT}|[0-9]+)`;
const NUMERIC_FORMS: readonly RegExp[] = [
  /^[0-9]+$/,
  /^(?:0|[1-9][0-9]*)[lL]$/,
  /^0[xX]0*[0-9a-fA-F]{1,8}$/,
  /^0[xX]0*[0-9a-fA-F]{1,16}[lL]$/,
  /^0+[1-3]?[0-7]{1,15}$/,
  /^0+1?[0-7]{1,21}[lL]$/,
  new RegExp(`^${FLOATING}[fF]$`),
  new RegExp(`^(?:${FLOATING}[dD]|[0-9]+\\.[0-9]*(?:${EXPONENT})?|\\.[0-9]+(?:${EXPONENT})?|[0-9]+${EXPONENT})$`),
];

function validNumericLiteral(raw: string): boolean {
  return NUMERIC_FORMS.some((form) => form.test(raw));
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
