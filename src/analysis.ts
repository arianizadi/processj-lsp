/** Shared diagnostic shapes. */
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

