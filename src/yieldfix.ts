/**
 * Before handing a file to the ProcessJ compiler, mark every procedure that
 * suspends only through the procedures it calls with `[yield=true]`, so the
 * compiler compiles it as a suspending process. Lines are unchanged, so the
 * compiler's line numbers still map onto the editor buffer.
 */
import { DeclIndex } from './checker/index';
import { YieldAnalysis } from './checker/yields';
import { parse } from './parser/parser';

export function withYieldAnnotations(text: string): string {
  const parsed = parse(text);
  if (parsed.errors.length) return text;
  const index = new DeclIndex();
  index.addProgram(parsed.program);
  const procs = new YieldAnalysis(index).needingAnnotation(parsed.program);
  if (procs.length === 0) return text;
  const lines = text.split('\n');
  // Insert from the bottom up so earlier positions stay valid.
  for (const d of procs.sort((a, b) => b.body!.span.start.line - a.body!.span.start.line || b.body!.span.start.col - a.body!.span.start.col)) {
    const { line, col } = d.body!.span.start;
    const l = lines[line];
    if (l === undefined) continue;
    lines[line] = l.slice(0, col) + '[yield=true] ' + l.slice(col);
  }
  return lines.join('\n');
}
