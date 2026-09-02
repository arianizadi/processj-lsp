/**
 * Lexer-level diagnostics. Every other lint now lives in the type checker
 * (src/checker/checker.ts), which works on real scopes and types; what remains
 * here are the problems the compiler's 7-bit JFlex scanner has with the raw text.
 */
import type { RawDiagnostic } from './diagnostics';
import { tokenize } from './tokens';

export interface FixHint {
  kind: 'add-import' | 'make-shared' | 'edit';
  line: number;
  col: number;
  title: string;
  /** For 'edit': replace [col, endCol) on `line` with `text`. */
  endCol?: number;
  text?: string;
}

export type LintDiagnostic = RawDiagnostic & { fix?: FixHint };

export function lexDiagnostics(text: string): LintDiagnostic[] {
  return tokenize(text).issues.map((issue) => ({
    line: issue.line,
    startCol: issue.col,
    endCol: issue.end,
    message: issue.message,
    severity: 'error' as const,
    code: issue.code,
    source: 'lsp' as const,
  }));
}
