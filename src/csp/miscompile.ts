/**
 * Programs this ProcessJ build compiles into something other than what the
 * language says, which the checker does not lint (they were information notes
 * once, removed as noise in the editor) but a model check has to name: FDR
 * answers about the language, and these make the compiled program hang where
 * the model does not. Both were verified on the installed compiler
 * (test/differential):
 *
 * - `compiler/loop-labels`: a break or continue that follows a nested for,
 *   par for or do loop inside the body of an enclosing loop, in a procedure
 *   compiled as a process (main always is, and any procedure that can
 *   suspend). The compiler's loop rewriter sets its break and continue labels
 *   on entering a for, par for or do loop and never restores them (a while
 *   does), so the jump goes to the inner loop's exit and the program hangs
 *   or crashes (break_after_nested_for.pj, main_break_after_for.pj, ...).
 * - `compiler/stop-ignored` (reported by lower.ts where it models `stop`):
 *   this build ignores `stop` and carries on (stop_ignored.pj).
 * - `compiler/par-loop-calls`: a par branch whose (sequential) loop calls
 *   procedures that suspend; the calls are counted against the wrong par and
 *   the par can end early (par_loop_of_calls.pj; the same calls in a par for
 *   are counted correctly).
 * - `compiler/short-circuit-read`: a channel read in the right operand of
 *   `&&` or `||`. The compiler lifts every channel read of an expression into
 *   a statement of its own before the expression (rewriters/ChannelRead.java,
 *   visitBinaryExpr), so the read happens even when the left operand decides
 *   the result and Java would skip it (short_circuit_read.pj hangs).
 * - `compiler/replicated-alt-precondition`: a precondition of a replicated
 *   alt that uses the alt's index. The generated code evaluates it once,
 *   before the index loop, and uses that value for every index (CodeGenJava,
 *   the `btemp` local of a replicated alt), so `(i == 2) && ...` is false for
 *   every index and the program stops with "One of the boolean pre-guards
 *   must be true!".
 * - `compiler/labelled-break` (reported by lower.ts where it models the
 *   break): a `break` out of a labelled statement that is not a loop.
 */
import type * as A from '../parser/ast';
import type { CheckResult } from '../checker/checker';
import type { DeclIndex } from '../checker/index';
import { hasYieldAnnotation, YieldAnalysis } from '../checker/yields';
import { forEachChildExpr, forEachChildStmt, forEachExprInStmt } from './lower';
import type { CspDiagnostic } from './model';

const LOOP_LABELS = (kw: string): string =>
  `a '${kw}' after a for, par for or do loop in the same loop body — this ProcessJ build compiles it as a jump to the exit of that inner loop (its loop rewriter never restores the labels), so the compiled program hangs or crashes here; the model follows the language`;
const PAR_LOOP_CALLS = 'a par branch looping over calls of procedures that suspend — this ProcessJ build counts those calls against the wrong par, so the compiled par can end before this branch has; the model follows the language';
const SHORT_CIRCUIT_READ = (op: string): string =>
  `a channel read in the right operand of '${op}' — this ProcessJ build performs every channel read of an expression before evaluating it, so this read happens even when the left operand decides the result (Java skips it); the model follows the language`;
const REPLICATED_PRECONDITION = (index: string): string =>
  `a precondition of a replicated alt that uses its index '${index}' — this ProcessJ build evaluates it once, before the alt's index loop, and uses that value for every index (so the program can stop with "One of the boolean pre-guards must be true!"); the model follows the language`;

/** The known miscompilations in a procedure body, at the statements they affect. */
export function miscompilations(decl: A.ProcDecl, checked: CheckResult, index: DeclIndex, uri: string): CspDiagnostic[] {
  if (!decl.body) return [];
  const yields = new YieldAnalysis(index, checked.calls);
  const isProcess = decl.name.name === 'main' || hasYieldAnnotation(decl) || yields.procYields(decl);
  const suspends = (call: A.Invocation): boolean => {
    const callee = checked.calls.get(call)?.decl;
    return !!callee && yields.procYields(callee);
  };
  const out: CspDiagnostic[] = [];
  const note = (span: A.Span, message: string, code: string): void => {
    const at = firstLine(span);
    if (out.some((d) => d.code === code && d.at?.span.start.line === at.start.line && d.at.span.start.col === at.start.col)) return;
    out.push({ message, at: { uri, span: at }, code });
  };
  /** Innermost construct a plain 'break' leaves (the compiler rewrites loop breaks into jumps; switch breaks stay). */
  const breakables: Array<'loop' | 'switch'> = [];
  let loops = 0;
  let pars = 0;
  /** A for, par for or do loop has been walked earlier in the enclosing loop body: its labels are the live ones. */
  let stale = false;
  const clobbering = (body: A.Stmt): void => {
    stale = false;
    loop(body);
    stale = true;
  };
  const loop = (body: A.Stmt): void => {
    loops++;
    breakables.push('loop');
    stmt(body);
    breakables.pop();
    loops--;
  };
  const stmt = (s: A.Stmt | undefined): void => {
    if (!s) return;
    switch (s.kind) {
      case 'Block':
        s.stmts.forEach(stmt);
        return;
      case 'IfStmt':
        stmt(s.then);
        stmt(s.else);
        return;
      case 'WhileStmt': {
        const saved = stale;
        stale = false;
        loop(s.body);
        stale = saved;
        return;
      }
      case 'DoStmt':
        clobbering(s.body);
        return;
      case 'ForStmt':
        if (s.isPar) {
          pars++;
          clobbering(s.body);
          pars--;
        } else clobbering(s.body);
        return;
      case 'ParBlock': {
        pars++;
        const branches = s.body.stmts;
        if (branches.length >= 2) {
          for (const b of branches) if (containsLoop(b) && loopCalls(b, suspends)) note(b.span, PAR_LOOP_CALLS, 'compiler/par-loop-calls');
        }
        branches.forEach(stmt);
        pars--;
        return;
      }
      case 'SeqBlock':
      case 'ClaimStmt':
        stmt(s.body);
        return;
      case 'LabeledStmt':
        stmt(s.stmt);
        return;
      case 'SwitchStmt':
        breakables.push('switch');
        for (const g of s.groups) g.stmts.forEach(stmt);
        breakables.pop();
        return;
      case 'AltStmt':
        for (const c of s.cases) {
          if (c.nested) stmt(c.nested);
          stmt(c.body);
        }
        return;
      case 'BreakStmt':
        // A break inside a par branch does not compile at all (pj/compiler-limit).
        if (loops > 0 && pars === 0 && stale && breakables[breakables.length - 1] === 'loop' && isProcess) note(s.span, LOOP_LABELS('break'), 'compiler/loop-labels');
        return;
      case 'ContinueStmt':
        if (loops > 0 && pars === 0 && stale && isProcess) note(s.span, LOOP_LABELS('continue'), 'compiler/loop-labels');
        return;
      default:
        return;
    }
  };
  stmt(decl.body);
  // Expressions: channel reads on the right of && and ||.
  forEachExprInStmt(decl.body, (e) => {
    const visit = (x: A.Expr): void => {
      if (x.kind === 'BinaryExpr' && (x.op === '&&' || x.op === '||')) {
        const read = channelRead(x.right, checked);
        if (read) note(read.span, SHORT_CIRCUIT_READ(x.op), 'compiler/short-circuit-read');
      }
      forEachChildExpr(x, visit);
    };
    visit(e);
  });
  // Replicated alts whose preconditions use the index.
  const alts = (s: A.Stmt | undefined): void => {
    if (!s) return;
    if (s.kind === 'AltStmt' && s.replicated) {
      const init = s.replicated.init;
      const indices = new Set(init && !Array.isArray(init) ? init.declarators.map((d) => d.name.name) : []);
      for (const c of s.cases) {
        const uses = c.precondition ? mentions(c.precondition, indices) : undefined;
        if (uses && c.precondition) note(c.precondition.span, REPLICATED_PRECONDITION(uses), 'compiler/replicated-alt-precondition');
      }
    }
    forEachChildStmt(s, alts);
  };
  alts(decl.body);
  return out;
}

/** The first channel read (not a timer read) in an expression. */
function channelRead(e: A.Expr, checked: CheckResult): A.ChanRead | undefined {
  if (e.kind === 'ChanRead') {
    const t = checked.types.get(e.target);
    if (!(t?.k === 'prim' && t.name === 'timer')) return e;
  }
  let found: A.ChanRead | undefined;
  forEachChildExpr(e, (x) => {
    found ??= channelRead(x, checked);
  });
  return found;
}

/** The first of `names` an expression mentions. */
function mentions(e: A.Expr, names: ReadonlySet<string>): string | undefined {
  if (e.kind === 'NameExpr' && names.has(e.name.name)) return e.name.name;
  let found: string | undefined;
  forEachChildExpr(e, (x) => {
    found ??= mentions(x, names);
  });
  return found;
}

function firstLine(span: A.Span): A.Span {
  return span.end.line === span.start.line ? span : { start: span.start, end: { line: span.start.line, col: span.start.col + 1 } };
}

/** A sequential loop (a par for runs its body as new processes, which this build counts correctly: verified). */
function containsLoop(s: A.Stmt): boolean {
  switch (s.kind) {
    case 'WhileStmt':
    case 'DoStmt':
      return true;
    case 'ForStmt':
      return !s.isPar;
    case 'Block':
      return s.stmts.some(containsLoop);
    case 'IfStmt':
      return containsLoop(s.then) || (!!s.else && containsLoop(s.else));
    case 'LabeledStmt':
      return containsLoop(s.stmt);
    default:
      return false;
  }
}

/** A loop in `s` whose body calls a procedure that suspends. */
function loopCalls(s: A.Stmt, suspends: (call: A.Invocation) => boolean): boolean {
  const callsIn = (x: A.Stmt): boolean => {
    switch (x.kind) {
      case 'ExprStmt':
        return x.expr.kind === 'Invocation' && suspends(x.expr);
      case 'Block':
        return x.stmts.some(callsIn);
      case 'IfStmt':
        return callsIn(x.then) || (!!x.else && callsIn(x.else));
      case 'WhileStmt':
      case 'DoStmt':
        return callsIn(x.body);
      case 'ForStmt':
        return !x.isPar && callsIn(x.body);
      default:
        return false;
    }
  };
  switch (s.kind) {
    case 'WhileStmt':
    case 'DoStmt':
      return callsIn(s.body);
    case 'ForStmt':
      return !s.isPar && callsIn(s.body);
    case 'Block':
      return s.stmts.some((x) => loopCalls(x, suspends));
    case 'IfStmt':
      return loopCalls(s.then, suspends) || (!!s.else && loopCalls(s.else, suspends));
    default:
      return false;
  }
}
