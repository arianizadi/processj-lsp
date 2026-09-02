/**
 * Shared diagnostic shapes for the checker and the server. The checker
 * (src/checker/checker.ts) produces every language-level diagnostic; this file
 * only holds the types they share with the compiler-output parser.
 */
import type { RawDiagnostic } from './diagnostics';

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
