/**
 * Before handing a file to the ProcessJ compiler, mark every procedure that
 * suspends only through the procedures it calls with `[yield=true]`, so the
 * compiler compiles it as a suspending process. Lines are unchanged, so the
 * compiler's line numbers still map onto the editor buffer.
 */
import { DeclIndex } from './checker/index';
import { YieldAnalysis, yieldAnnotationEdit } from './checker/yields';
import { parse } from './parser/parser';

export function withYieldAnnotations(text: string): string {
  const parsed = parse(text);
  if (parsed.errors.length) return text;
  const index = new DeclIndex();
  index.addProgram(parsed.program);
  const procs = new YieldAnalysis(index).needingAnnotation(parsed.program);
  if (procs.length === 0) return text;
  // Split keeps the line terminators at the odd indices, so any mix of LF, CRLF
  // and CR round-trips unchanged.
  const parts = text.split(/(\r\n|\r|\n)/);
  const edits = procs.map(yieldAnnotationEdit).sort((a, b) => b.line - a.line || b.col - a.col);
  // Apply from the bottom up (and right to left) so earlier positions stay valid.
  for (const { line, col, text: insert } of edits) {
    const l = parts[line * 2];
    if (l === undefined) continue;
    parts[line * 2] = l.slice(0, col) + insert + l.slice(col);
  }
  return parts.join('');
}
