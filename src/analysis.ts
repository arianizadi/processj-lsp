/**
 * Shared diagnostic shapes, plus the lexer-level notes: things the real compiler's
 * 7-bit JFlex scanner cannot handle, reported as low-severity information.
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
    message: `Note: ${issue.message}`,
    severity: 'info' as const,
    code: issue.code,
    source: 'lsp' as const,
  }));
}
