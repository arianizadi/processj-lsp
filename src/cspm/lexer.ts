/**
 * Tokens of CSPm. Comments (`--` to the end of the line, nested `{- -}`) are
 * kept apart so a definition can show the comment above it. Every token knows
 * whether it is the first on its line: the parser splits a file into
 * declarations at line starts, as FDR's layout rule does in practice.
 * Unknown characters become `error` tokens; lexing never fails.
 */
import type { Span } from './ast';

export type TokenKind = 'ident' | 'num' | 'str' | 'char' | 'op' | 'error' | 'eof';

export interface Token {
  kind: TokenKind;
  text: string;
  span: Span;
  /** First token on its line. */
  first: boolean;
  /** Offset of the token in the text. */
  offset: number;
}

export interface Comment {
  text: string;
  /** Line the comment starts and ends on (0-based). */
  line: number;
  endLine: number;
  /** Nothing but whitespace before it on its line. */
  own: boolean;
}

export interface Lexed {
  tokens: Token[];
  comments: Comment[];
  /** Unterminated comments and strings. */
  problems: Array<{ message: string; span: Span }>;
}

/** Symbols, longest first. */
const SYMBOLS = [
  '[FD=', '[RD=', '[T=', '[F=', '[R=', '[V=',
  '|~|', '|||', '<->',
  '[|', '|]', '{|', '|}', '[[', ']]', '||', '[]', '[>', '/\\', '->', '<-', '<=', '>=', '==', '!=', '..', '@@', '::', '|>',
  '(', ')', '{', '}', '[', ']', '<', '>', ',', '.', ':', ';', '?', '!', '$', '@', '&', '|', '^', '#', '+', '-', '*', '/', '%', '=', '\\', '~',
];

export function lex(text: string): Lexed {
  const tokens: Token[] = [];
  const comments: Comment[] = [];
  const problems: Lexed['problems'] = [];
  let i = 0;
  let line = 0;
  let col = 0;
  let lineHasToken = false;
  let lineHasText = false;
  const advance = (n: number): void => {
    for (let k = 0; k < n; k++) {
      if (text[i] === '\n') {
        line++;
        col = 0;
        lineHasToken = false;
        lineHasText = false;
      } else col++;
      i++;
    }
  };
  const push = (kind: TokenKind, length: number): void => {
    const start = { line, col };
    const offset = i;
    const first = !lineHasToken;
    const value = text.slice(i, i + length);
    advance(length);
    tokens.push({ kind, text: value, span: { start, end: { line, col } }, first, offset });
    lineHasToken = true;
    lineHasText = true;
  };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\n' || ch === ' ' || ch === '\t' || ch === '\r' || ch === '\f') {
      advance(1);
      continue;
    }
    // `--` comment (but not `-->`, which no CSPm uses, nor a `-` followed by `-` inside `->`).
    if (ch === '-' && text[i + 1] === '-') {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      comments.push({ text: text.slice(i + 2, stop).trim(), line, endLine: line, own: !lineHasText });
      advance(stop - i);
      continue;
    }
    if (ch === '{' && text[i + 1] === '-') {
      const startLine = line;
      const own = !lineHasText;
      let depth = 0;
      let j = i;
      while (j < text.length) {
        if (text[j] === '{' && text[j + 1] === '-') {
          depth++;
          j += 2;
        } else if (text[j] === '-' && text[j + 1] === '}') {
          depth--;
          j += 2;
          if (depth === 0) break;
        } else j++;
      }
      if (depth > 0) problems.push({ message: 'this {- comment is never closed', span: { start: { line, col }, end: { line, col: col + 2 } } });
      const body = text.slice(i + 2, Math.max(i + 2, j - 2));
      advance(j - i);
      comments.push({ text: body.trim(), line: startLine, endLine: line, own });
      lineHasText = true;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z0-9_']/.test(text[j])) j++;
      push('ident', j - i);
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i + 1;
      while (j < text.length && /[0-9]/.test(text[j])) j++;
      push('num', j - i);
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"' && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      if (text[j] !== '"') problems.push({ message: 'this string is never closed', span: { start: { line, col }, end: { line, col: col + 1 } } });
      push('str', Math.min(text.length, j + 1) - i);
      continue;
    }
    if (ch === "'") {
      // A character literal: 'a', '\n'.
      const close = text[i + 1] === '\\' ? i + 3 : i + 2;
      if (text[close] === "'") {
        push('char', close + 1 - i);
        continue;
      }
    }
    const symbol = SYMBOLS.find((s) => text.startsWith(s, i));
    if (symbol) {
      // `[F=` and friends only as refinement operators: `[F == x]` is not one.
      if (symbol.endsWith('=') && symbol.startsWith('[') && text[i + symbol.length] === '=') {
        push('op', 1);
        continue;
      }
      push('op', symbol.length);
      continue;
    }
    push('error', 1);
  }
  tokens.push({ kind: 'eof', text: '', span: { start: { line, col }, end: { line, col } }, first: !lineHasToken, offset: text.length });
  return { tokens, comments, problems };
}
