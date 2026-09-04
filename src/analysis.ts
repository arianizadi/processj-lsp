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

/** A same-document location that explains why a lint was emitted. */
export interface LintRelated {
  line: number;
  startCol: number;
  endCol: number;
  message: string;
}

export type LintDiagnostic = RawDiagnostic & { fix?: FixHint; related?: LintRelated[] };
