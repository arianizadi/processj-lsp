/**
 * Before handing a file to the ProcessJ compiler, mark every procedure that
 * suspends only through the procedures it calls with `[yield=true]`, so the
 * compiler compiles it as a suspending process. Lines are unchanged, so the
 * compiler's line numbers still map onto the editor buffer.
 */
import type * as A from './parser/ast';
import { check } from './checker/checker';
import { DeclIndex } from './checker/index';
import type { ProcSig } from './checker/index';
import { YieldAnalysis, yieldAnnotationEdit, type YieldCallProvider } from './checker/yields';
import { parse } from './parser/parser';

export interface YieldAnnotationContext {
  /** The already parsed current buffer. It must correspond exactly to `text`. */
  program: A.Program;
  /** Current file plus visible imports. Imported source files are never changed. */
  index: DeclIndex;
  /** Exact overloads selected for invocations in `program`. */
  calls: ReadonlyMap<A.Invocation, ProcSig>;
  /** Lazily checked imported bodies, each resolved in its own import scope. */
  callProvider?: YieldCallProvider;
}

/** One source edit together with its position in the augmented compiler line. */
export interface AppliedYieldEdit {
  line: number;
  sourceStart: number;
  sourceEnd: number;
  generatedStart: number;
  generatedEnd: number;
}

/**
 * Enough information to translate a compiler column back to the editor buffer.
 * Yield annotations never add or remove line terminators, so a per-line map is
 * both exact and cheaper than a whole-document offset table.
 */
export interface YieldSourceMap {
  edits: readonly AppliedYieldEdit[];
  sourceLineLengths: readonly number[];
  generatedLineLengths: readonly number[];
}

export interface YieldAugmentation {
  text: string;
  sourceMap: YieldSourceMap;
}

export function withYieldAnnotations(text: string, context?: YieldAnnotationContext): string {
  return augmentYieldAnnotations(text, context).text;
}

/** Add private compiler annotations and retain an exact generated-to-source column map. */
export function augmentYieldAnnotations(text: string, context?: YieldAnnotationContext): YieldAugmentation {
  const sourceLines = text.split(/\r\n|\r|\n/);
  const identity = (): YieldAugmentation => ({
    text,
    sourceMap: {
      edits: [],
      sourceLineLengths: sourceLines.map((line) => line.length),
      generatedLineLengths: sourceLines.map((line) => line.length),
    },
  });
  const parsed = parse(text);
  if (parsed.errors.length) return identity();
  const program = context?.program ?? parsed.program;
  const index = context?.index ?? new DeclIndex();
  if (!context) index.addProgram(program);
  const calls = context?.calls ?? check(program, { index, text }).calls;
  const procs = new YieldAnalysis(index, calls, undefined, context?.callProvider).needingAnnotation(program);
  if (procs.length === 0) return identity();
  // Split keeps the line terminators at the odd indices, so any mix of LF, CRLF
  // and CR round-trips unchanged.
  const parts = text.split(/(\r\n|\r|\n)/);
  const edits = procs.map(yieldAnnotationEdit).sort((a, b) => a.line - b.line || a.col - b.col || a.endCol - b.endCol);
  const applied: AppliedYieldEdit[] = [];
  const deltaByLine = new Map<number, number>();
  for (const edit of edits) {
    const delta = deltaByLine.get(edit.line) ?? 0;
    const generatedStart = edit.col + delta;
    applied.push({
      line: edit.line,
      sourceStart: edit.col,
      sourceEnd: edit.endCol,
      generatedStart,
      generatedEnd: generatedStart + edit.text.length,
    });
    deltaByLine.set(edit.line, delta + edit.text.length - (edit.endCol - edit.col));
  }
  // Apply from the bottom up (and right to left) so earlier positions stay valid.
  for (const { line, col, endCol, text: insert } of [...edits].reverse()) {
    const l = parts[line * 2];
    if (l === undefined) continue;
    parts[line * 2] = l.slice(0, col) + insert + l.slice(endCol);
  }
  const generatedLines = parts.filter((_, index) => index % 2 === 0);
  return {
    text: parts.join(''),
    sourceMap: {
      edits: applied,
      sourceLineLengths: sourceLines.map((line) => line.length),
      generatedLineLengths: generatedLines.map((line) => line.length),
    },
  };
}

/**
 * Translate a half-open compiler range from the augmented buffer to the
 * original editor line. Positions inside synthetic text collapse onto the
 * insertion point; positions inside a replacement retain their relative span.
 */
export function mapYieldGeneratedRange(
  sourceMap: YieldSourceMap,
  line: number,
  startCol: number | undefined,
  endCol: number | undefined,
): { startCol?: number; endCol?: number } {
  const lineEdits = sourceMap.edits.filter((edit) => edit.line === line);
  if (lineEdits.length === 0) return { startCol, endCol };
  const sourceLength = sourceMap.sourceLineLengths[line];
  const generatedLength = sourceMap.generatedLineLengths[line];
  if (sourceLength === undefined || generatedLength === undefined) return { startCol, endCol };

  const mapColumn = (column: number, endBias: boolean): number => {
    const generatedColumn = Math.min(Math.max(column, 0), generatedLength);
    let delta = 0;
    for (const edit of lineEdits) {
      if (generatedColumn < edit.generatedStart) break;
      if (generatedColumn <= edit.generatedEnd) {
        const sourceWidth = edit.sourceEnd - edit.sourceStart;
        const generatedWidth = edit.generatedEnd - edit.generatedStart;
        if (sourceWidth === 0 || generatedWidth === 0) return edit.sourceStart;
        const relative = generatedColumn - edit.generatedStart;
        const scaled = (relative * sourceWidth) / generatedWidth;
        const mapped = edit.sourceStart + (endBias ? Math.ceil(scaled) : Math.floor(scaled));
        return Math.min(Math.max(mapped, edit.sourceStart), edit.sourceEnd);
      }
      delta += (edit.generatedEnd - edit.generatedStart) - (edit.sourceEnd - edit.sourceStart);
    }
    return Math.min(Math.max(generatedColumn - delta, 0), sourceLength);
  };

  const mappedStart = startCol === undefined ? undefined : mapColumn(startCol, false);
  let mappedEnd = endCol === undefined ? undefined : mapColumn(endCol, true);
  if (mappedStart !== undefined && mappedEnd !== undefined) mappedEnd = Math.max(mappedEnd, mappedStart);
  return { startCol: mappedStart, endCol: mappedEnd };
}
