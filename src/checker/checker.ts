/**
 * Type checker and AST-based lints for ProcessJ.
 *
 * One walk over the parse tree resolves every name to its declaration, computes
 * the type of every expression, and reports:
 *   - type errors (pj/type/*): the checks the compiler does badly or not at all
 *   - concurrency and code-generator lints (pj/*): the same codes the earlier
 *     token-based lints used, now computed from real scopes and types
 *
 * The result also exposes the resolutions (which declaration each name refers to)
 * and the type of every expression, for hover and semantic highlighting.
 */
import type { LintDiagnostic } from '../analysis';
import type { FixHint } from '../analysis';
import type * as A from '../parser/ast';
import { suggest } from '../parser/parser';
import { DeclIndex, signatureStr, type ProcSig } from './index';
import { hasYieldAnnotation, YieldAnalysis } from './yields';
import { assignable, endOf, isIntegral, isLenient, isNumeric, isPrim, isReference, isSubtype, promote, sameType, T, typeStr, whyNotAssignable, type Type } from './types';

export interface VarInfo {
  name: string;
  type: Type;
  isConst: boolean;
  isParam: boolean;
  decl: A.Ident;
  /** Name of the enclosing procedure. */
  proc: string;
  uses: number;
  /** Nesting depth of the scope the variable was declared in. */
  depth: number;
}

export interface CheckOptions {
  /** Declarations visible to this file: its own, its imports, the standard library. */
  index: DeclIndex;
  /** Standard-library declarations, used only for the missing-import hint. */
  stdIndex?: DeclIndex;
  /** Whether the file imports the standard library. */
  importsStd?: boolean;
  /** Names of imports that could not be resolved (their symbols are unknown, so stay quiet about them). */
  unresolvedImports?: boolean;
}

export interface CheckResult {
  diagnostics: LintDiagnostic[];
  vars: VarInfo[];
  /** Resolution of every name expression to a variable, when it is one. */
  resolutions: Map<A.NameExpr, VarInfo>;
  /** Procedure chosen for each call. */
  calls: Map<A.Invocation, ProcSig>;
  /** Type of every expression. */
  types: Map<A.Expr, Type>;
}

export function check(program: A.Program, opts: CheckOptions): CheckResult {
  const c = new Checker(opts);
  c.program(program);
  return { diagnostics: c.diags, vars: c.allVars, resolutions: c.resolutions, calls: c.calls, types: c.types };
}

class Scope {
  readonly vars = new Map<string, VarInfo>();
  constructor(
    readonly parent: Scope | undefined,
    readonly depth: number,
  ) {}
  lookup(name: string): VarInfo | undefined {
    return this.vars.get(name) ?? this.parent?.lookup(name);
  }
  names(): string[] {
    return [...this.vars.keys(), ...(this.parent?.names() ?? [])];
  }
}

/** Variable traffic of one `par` branch, for the parallel-usage and shared-end rules. */
interface BranchUse {
  reads: Map<VarInfo, A.Span>;
  writes: Map<VarInfo, A.Span>;
  ends: Map<string, { v: VarInfo; span: A.Span }>; // "name.read" / "name.write"
  bare: Set<VarInfo>;
  depth: number;
}

interface ChanUse {
  reads?: A.Span;
  writes?: A.Span;
  bare: boolean;
  /** Distinct par branches (or the sequential body, `undefined`) the channel's ends are used from. */
  branches: Set<BranchUse | undefined>;
  first?: A.Span;
  /** Every place an end of the channel is used. */
  spans: A.Span[];
}

class Checker {
  readonly diags: LintDiagnostic[] = [];
  readonly allVars: VarInfo[] = [];
  readonly resolutions = new Map<A.NameExpr, VarInfo>();
  readonly calls = new Map<A.Invocation, ProcSig>();
  readonly types = new Map<A.Expr, Type>();

  private readonly index: DeclIndex;
  private scope = new Scope(undefined, 0);
  private proc?: A.ProcDecl;
  private procRet: Type = T.void;
  private loopDepth = 0;
  private switchDepth = 0;
  /** Protocol variable -> case tag known to hold in the current region. */
  private activeCase = new Map<VarInfo, string>();
  private branchStack: BranchUse[] = [];
  private chanUses = new Map<VarInfo, ChanUse>();
  private insideAlt = 0;
  /** Name expressions that are the target of `.read` / `.write` / `.read()` / `.write(v)`: not "bare" uses of the channel. */
  private readonly endTargets = new WeakSet<A.Expr>();
  private readonly yields: YieldAnalysis;
  /** Barriers a proc enrolled on with `par enroll`, to spot syncs nobody enrolled. */
  private enrolled = new Set<VarInfo>();
  private syncs: Array<{ v: VarInfo; span: A.Span }> = [];
  /** Par blocks whose straight-line branches are simulated once the whole proc is known. */
  private pendingSims: Array<{ par: A.ParBlock; queues: Op[][] }> = [];

  constructor(private readonly opts: CheckOptions) {
    this.index = opts.index;
    this.yields = new YieldAnalysis(this.index);
  }

  // -------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------

  private report(span: A.Span, severity: LintDiagnostic['severity'], code: string, message: string, fix?: FixHint): void {
    this.diags.push({ line: span.start.line, startCol: span.start.col, endCol: span.end.line === span.start.line ? span.end.col : span.start.col + 1, message, severity, code, source: 'lsp', fix });
  }

  private error(span: A.Span, code: string, message: string, fix?: FixHint): Type {
    this.report(span, 'error', code, message, fix);
    return T.error;
  }

  private warn(span: A.Span, code: string, message: string): void {
    this.report(span, 'warning', code, message);
  }

  // -------------------------------------------------------------------------
  // Scopes
  // -------------------------------------------------------------------------

  private push(): void {
    this.scope = new Scope(this.scope, this.scope.depth + 1);
  }

  private pop(): void {
    this.scope = this.scope.parent ?? this.scope;
  }

  private declare(id: A.Ident, type: Type, isConst: boolean, isParam: boolean): VarInfo | undefined {
    if (id.name === '<missing>') return undefined;
    const existing = this.scope.vars.get(id.name);
    if (existing) {
      this.error(id.span, 'pj/type/duplicate', `'${id.name}' is already declared in this scope (line ${existing.decl.span.start.line + 1})`);
      return existing;
    }
    const info: VarInfo = { name: id.name, type, isConst, isParam, decl: id, proc: this.proc?.name.name ?? '', uses: 0, depth: this.scope.depth };
    this.scope.vars.set(id.name, info);
    this.allVars.push(info);
    if (!isParam && this.proc) {
      const param = this.proc.params.find((p) => p.name.name === id.name);
      if (param) this.warn(id.span, 'pj/shadows-parameter', `'${id.name}' shadows a parameter of '${this.proc.name.name}'; rename one of them`);
    }
    if (type.k === 'chan' && !type.end && !isParam) this.chanUses.set(info, { bare: false, branches: new Set(), spans: [] });
    return info;
  }

  private resolveType(node: A.TypeNode): Type {
    const t = this.index.resolve(node);
    this.checkTypeKnown(node);
    return t;
  }

  /** Warn about a named type nothing declares; suggest a close name. */
  private checkTypeKnown(node: A.TypeNode): void {
    if (node.kind === 'ArrayType') return this.checkTypeKnown(node.elem);
    if (node.kind === 'ChanType') return this.checkTypeKnown(node.elem);
    if (node.kind !== 'NamedType' || node.name.name === '<missing>') return;
    const name = node.name.name;
    if (this.index.isKnownType(name) || this.opts.unresolvedImports) return;
    const s = suggest(name, [...this.index.records.keys(), ...this.index.protocols.keys()]);
    this.report(node.span, 'warning', 'pj/type/unknown-type', `Unknown type '${name}'${s ? `; did you mean '${s}'?` : ' (not declared here, in an import, or in std)'}`, s ? { kind: 'edit', title: `Change to '${s}'`, line: node.name.span.start.line, col: node.name.span.start.col, endCol: node.name.span.end.col, text: s } : undefined);
  }

  // -------------------------------------------------------------------------
  // Program and declarations
  // -------------------------------------------------------------------------

  program(p: A.Program): void {
    const seenProcs = new Map<string, A.ProcDecl>();
    for (const d of p.decls) {
      switch (d.kind) {
        case 'RecordDecl': {
          const seen = new Set<string>();
          for (const m of d.members) {
            this.checkTypeKnown(m.type);
            if (seen.has(m.name.name)) this.error(m.name.span, 'pj/type/duplicate', `Field '${m.name.name}' is declared twice in record '${d.name.name}'`);
            seen.add(m.name.name);
          }
          for (const e of d.extends) {
            if (!this.index.records.has(e.name)) this.error(e.span, 'pj/type/unknown-type', `'${d.name.name}' extends '${e.name}', which is not a record`);
            else if (this.index.extendsName(e.name, d.name.name)) this.error(e.span, 'pj/type/cycle', `Record '${d.name.name}' extends itself through '${e.name}'`);
          }
          break;
        }
        case 'ProtocolDecl': {
          const seen = new Set<string>();
          for (const c of d.cases ?? []) {
            if (seen.has(c.name.name)) this.error(c.name.span, 'pj/type/duplicate', `Case '${c.name.name}' is declared twice in protocol '${d.name.name}'`);
            seen.add(c.name.name);
            for (const m of c.members) this.checkTypeKnown(m.type);
          }
          for (const e of d.extends) {
            if (!this.index.protocols.has(e.name)) this.error(e.span, 'pj/type/unknown-type', `'${d.name.name}' extends '${e.name}', which is not a protocol`);
          }
          break;
        }
        case 'ConstDecl': {
          const type = this.resolveType(d.type);
          for (const v of d.declarators) {
            if (!v.init) {
              if (!d.modifiers.includes('native')) this.error(v.name.span, 'pj/type/const-init', `Constant '${v.name.name}' needs an initialiser`);
              continue;
            }
            const vt: Type = v.dims > 0 ? { k: 'array', elem: type, dims: v.dims } : type;
            this.checkInit(vt, v.init, v.name.name);
            if (!(isLiteralInit(v.init) && this.onlyConstNames(v.init))) this.error(v.init.span, 'pj/type/const-init', 'A constant can only be initialised with literals and other constants');
          }
          break;
        }
        case 'ProcDecl': {
          const key = `${d.name.name}(${d.params.map((x) => typeStr(this.index.resolve(x.type))).join(',')})`;
          const prev = seenProcs.get(key);
          if (prev) this.error(d.name.span, 'pj/type/duplicate', `Procedure '${d.name.name}' with the same parameter types is already declared at line ${prev.name.span.start.line + 1}`);
          seenProcs.set(key, d);
          break;
        }
        default:
          break;
      }
    }
    for (const d of p.decls) if (d.kind === 'ProcDecl') this.procDecl(d);
    for (const d of this.yields.needingAnnotation(p)) {
      if (hasYieldAnnotation(d) || !d.body) continue;
      const at = d.body.span.start;
      this.report(d.name.span, 'warning', 'pj/needs-yield-annotation', `'${d.name.name}' suspends only through the procedures it calls; mark it [yield=true] so it is compiled as a suspending process`, { kind: 'edit', title: 'Add [yield=true]', line: at.line, col: at.col, endCol: at.col, text: '[yield=true] ' });
    }
  }

  private procDecl(d: A.ProcDecl): void {
    this.proc = d;
    this.procRet = this.resolveType(d.returnType);
    this.chanUses = new Map();
    this.activeCase = new Map();
    this.enrolled = new Set();
    this.syncs = [];
    this.pendingSims = [];
    this.push();
    for (const p of d.params) {
      const t = this.resolveType(p.type);
      this.declare(p.name, t, p.isConst, true);
    }
    if (d.body) {
      // The body block shares the parameter scope, as in the compiler (params and locals collide there too).
      this.push();
      this.stmts(d.body.stmts);
      this.pop();
    }
    this.pop();
    this.finishProc(d);
    this.proc = undefined;
  }

  private finishProc(d: A.ProcDecl): void {
    for (const v of this.allVars) {
      if (v.proc !== d.name.name || v.uses > 0) continue;
      if (v.isParam && v.name === 'args') continue;
      this.report(v.decl.span, v.isParam ? 'info' : 'warning', 'pj/unused', `'${v.name}' is never used`);
    }
    for (const [v, use] of this.chanUses) {
      if (use.bare) continue;
      if (use.reads && !use.writes) this.warn(use.reads, 'pj/channel-no-writer', `Nothing ever writes '${v.name}', so this read blocks forever`);
      else if (use.writes && !use.reads) this.warn(use.writes, 'pj/channel-no-reader', `Nothing ever reads '${v.name}', so this write blocks forever`);
      else if (use.reads && use.writes && use.branches.size <= 1 && use.first) {
        this.warn(use.first, 'pj/channel-self-deadlock', `This process is both the writer and the reader of '${v.name}', so this ${use.first === use.writes ? 'write' : 'read'} blocks forever. Put the two sides in different branches of a par.`);
      }
    }
    for (const sim of this.pendingSims) this.runSimulation(sim.par, sim.queues);
    for (const { v, span } of this.syncs) {
      if (!v.isParam && !this.enrolled.has(v)) this.warn(span, 'pj/barrier-not-enrolled', `No 'par enroll (${v.name})' here, so this sync() waits for nobody and returns at once`);
    }
  }

  // -------------------------------------------------------------------------
  // Yield analysis: can this code suspend, i.e. communicate or wait?
  // -------------------------------------------------------------------------

  /** A loop that never ends (constant-true condition) and cannot suspend starves every other process. */
  private checkStarvingLoop(loopSpan: A.Span, cond: A.Expr | undefined, body: A.Stmt, keyword: string): void {
    if (cond && !isTrueLiteral(cond)) return;
    if (containsExit(body) || this.yields.stmtYields(body, true)) return;
    const head: A.Span = { start: loopSpan.start, end: { line: loopSpan.start.line, col: loopSpan.start.col + keyword.length } };
    this.warn(head, 'pj/starving-loop', `This loop never ends and never communicates, so no other process ever runs again (the scheduler is cooperative). Add a channel operation, timeout or alt.`);
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  private block(b: A.Block): void {
    this.push();
    this.stmts(b.stmts);
    this.pop();
  }

  /** A statement list; reports the first statement after a return/break/continue/stop. */
  private stmts(list: A.Stmt[]): void {
    let dead = false;
    for (const s of list) {
      if (dead) {
        if (s.kind !== 'EmptyStmt') {
          this.warn(s.span, 'pj/unreachable', 'Unreachable code');
          dead = false; // one report per block
        }
      }
      this.stmt(s);
      if (s.kind === 'ReturnStmt' || s.kind === 'BreakStmt' || s.kind === 'ContinueStmt' || s.kind === 'StopStmt') dead = true;
    }
  }

  private stmt(s: A.Stmt): void {
    switch (s.kind) {
      case 'Block':
        return this.block(s);
      case 'EmptyStmt':
      case 'SkipStmt':
      case 'StopStmt':
      case 'SuspendStmt':
        return;
      case 'LocalDecl':
        return this.localDecl(s);
      case 'ExprStmt':
        this.expr(s.expr);
        return;
      case 'IfStmt': {
        this.condition(s.cond, 'if');
        const narrowed = this.narrowing(s.cond);
        this.withCase(narrowed, () => this.stmt(s.then));
        if (s.else) this.stmt(s.else);
        return;
      }
      case 'WhileStmt':
        this.condition(s.cond, 'while');
        this.checkStarvingLoop(s.span, s.cond, s.body, 'while');
        this.loop(() => this.stmt(s.body));
        return;
      case 'DoStmt':
        this.loop(() => this.stmt(s.body));
        this.condition(s.cond, 'do ... while');
        this.checkStarvingLoop(s.span, s.cond, s.body, 'do');
        return;
      case 'ForStmt': {
        const outerDepth = this.scope.depth;
        this.push();
        if (s.init) {
          if (Array.isArray(s.init)) for (const e of s.init) this.expr(e);
          else this.localDecl(s.init);
        }
        if (s.cond) this.condition(s.cond, 'for');
        for (const e of s.update) this.expr(e);
        for (const b of s.enroll) {
          this.expectType(b, T.barrier, 'enroll');
          if (b.kind === 'NameExpr') {
            const v = this.resolutions.get(b);
            if (v) this.enrolled.add(v);
          }
        }
        if (!s.isPar) this.checkStarvingLoop(s.span, s.cond, s.body, 'for');
        if (s.isPar) {
          const use = this.branch(this.scope.depth, () => this.loop(() => this.stmt(s.body)));
          // Every iteration is its own process, so anything from outside the loop is shared by all of them.
          const seen = new Set<VarInfo>();
          for (const [v, span] of use.writes) {
            if (v.depth <= outerDepth && !seen.has(v)) {
              seen.add(v);
              this.error(span, 'pj/parallel-usage', `Every iteration of this par for writes '${v.name}' at the same time (data race)`);
            }
          }
          for (const [key, { v, span }] of use.ends) {
            if (v.depth <= outerDepth && v.type.k === 'chan' && !v.type.shared) {
              const typeCol = Math.max(0, v.decl.span.start.col - (typeStr(v.type).length + 1));
              this.error(span, 'pj/shared-channel-end', `Every iteration of this par for holds '${key}'; declare it 'shared chan<${typeStr(v.type.elem)}>'`, { kind: 'make-shared', line: v.decl.span.start.line, col: typeCol, title: `Declare '${v.name}' as shared` });
            }
          }
        } else this.loop(() => this.stmt(s.body));
        this.pop();
        return;
      }
      case 'ParBlock':
        for (const b of s.barriers) {
          this.expectType(b, T.barrier, 'enroll');
          if (b.kind === 'NameExpr') {
            const v = this.resolutions.get(b);
            if (v) this.enrolled.add(v);
          }
        }
        if (s.body.stmts.length === 0) this.report(s.span, 'info', 'pj/trivial-par', "Empty par: nothing runs");
        else if (s.body.stmts.length === 1) this.report({ start: s.span.start, end: { line: s.span.start.line, col: s.span.start.col + 3 } }, 'info', 'pj/trivial-par', "A par with one branch runs nothing concurrently");
        this.parBlock(s);
        return;
      case 'SeqBlock':
        return this.block(s.body);
      case 'ClaimStmt':
        this.push();
        for (const c of s.channels) {
          if (c.kind === 'LocalDecl') this.localDecl(c);
          else {
            const t = this.expr(c);
            if (t.k === 'chan' && !t.shared) this.error(c.span, 'pj/type/claim', `'claim' needs a shared channel end; ${exprText(c)} is ${typeStr(t)}`);
            else if (!isLenient(t) && t.k !== 'chan') this.error(c.span, 'pj/type/claim', `'claim' needs a shared channel end, not ${typeStr(t)}`);
          }
        }
        this.stmt(s.body);
        this.pop();
        return;
      case 'SwitchStmt':
        return this.switchStmt(s);
      case 'AltStmt':
        return this.altStmt(s);
      case 'ReturnStmt': {
        if (!this.proc) return;
        if (isPrim(this.procRet, 'void')) {
          if (s.expr) {
            this.expr(s.expr);
            this.error(s.expr.span, 'pj/type/return', `'${this.proc.name.name}' returns void; it cannot return a value`);
          }
          return;
        }
        if (!s.expr) {
          this.error(s.span, 'pj/type/return', `'${this.proc.name.name}' must return a value of type ${typeStr(this.procRet)}`);
          return;
        }
        const t = this.expr(s.expr);
        if (!this.assignableExpr(this.procRet, t, s.expr)) this.error(s.expr.span, 'pj/type/return', `'${this.proc.name.name}' returns ${typeStr(this.procRet)}, but this expression is ${typeStr(t)}${why(this.procRet, t)}`);
        return;
      }
      case 'BreakStmt':
        if (this.loopDepth === 0 && this.switchDepth === 0) this.error(s.span, 'pj/type/break', "'break' outside of a loop or switch");
        return;
      case 'ContinueStmt':
        if (this.loopDepth === 0) this.error(s.span, 'pj/type/break', "'continue' outside of a loop");
        return;
      case 'LabeledStmt':
        return this.stmt(s.stmt);
    }
  }

  private loop(body: () => void): void {
    this.loopDepth++;
    body();
    this.loopDepth--;
  }

  private condition(e: A.Expr, owner: string): void {
    const t = this.expr(e);
    if (!isLenient(t) && !isPrim(t, 'boolean')) this.error(e.span, 'pj/type/condition', `The condition of '${owner}' must be boolean, not ${typeStr(t)}`);
    let inner = e;
    while (inner.kind === 'ParenExpr') inner = inner.expr;
    if (inner.kind === 'AssignExpr' && inner.op === '=' && isPrim(t, 'boolean')) this.warn(e.span, 'pj/assign-in-condition', `This assigns '${exprText(inner.target)}' instead of comparing it; did you mean '=='?`);
  }

  private localDecl(d: A.LocalDecl): void {
    const base = this.resolveType(d.type);
    if (isPrim(base, 'void')) this.error(d.type.span, 'pj/type/void', 'A variable cannot have type void');
    for (const v of d.declarators) {
      const t: Type = v.dims > 0 ? { k: 'array', elem: base.k === 'array' ? base.elem : base, dims: (base.k === 'array' ? base.dims : 0) + v.dims } : base;
      // The initialiser is checked before the name is in scope: `int x = x + 1` is an error.
      if (v.init) {
        this.checkInit(t, v.init, v.name.name);
        if (d.isConst && !(isLiteralInit(v.init) && this.onlyConstNames(v.init))) this.error(v.init.span, 'pj/type/const-init', 'A constant can only be initialised with literals and other constants');
      }
      this.declare(v.name, t, d.isConst, false);
    }
  }

  /** Every name inside a constant initialiser must itself be a constant. */
  private onlyConstNames(e: A.Expr): boolean {
    switch (e.kind) {
      case 'NameExpr': {
        const v = this.resolutions.get(e);
        return v ? v.isConst : this.index.consts.has(e.name.name) || e.name.name === '<missing>';
      }
      case 'ParenExpr':
        return this.onlyConstNames(e.expr);
      case 'UnaryExpr':
        return this.onlyConstNames(e.operand);
      case 'BinaryExpr':
        return this.onlyConstNames(e.left) && this.onlyConstNames(e.right);
      case 'ArrayLiteral':
        return e.elements.every((x) => this.onlyConstNames(x));
      default:
        return true;
    }
  }

  private checkInit(t: Type, init: A.Expr, name: string): void {
    if (init.kind === 'ArrayLiteral') {
      this.arrayLiteral(init, t, name);
      return;
    }
    const it = this.expr(init);
    if (!this.assignableExpr(t, it, init)) this.error(init.span, 'pj/type/assign', `Cannot initialise '${name}' (${typeStr(t)}) with a value of type ${typeStr(it)}${why(t, it)}`);
  }

  private arrayLiteral(lit: A.ArrayLiteral, expected: Type, name: string): void {
    if (expected.k !== 'array') {
      if (!isLenient(expected)) this.error(lit.span, 'pj/type/assign', `'${name}' is ${typeStr(expected)}, not an array; an array initialiser does not fit`);
      for (const e of lit.elements) if (e.kind !== 'ArrayLiteral') this.expr(e);
      return;
    }
    const elemType: Type = expected.dims > 1 ? { k: 'array', elem: expected.elem, dims: expected.dims - 1 } : expected.elem;
    for (const e of lit.elements) {
      if (e.kind === 'ArrayLiteral') this.arrayLiteral(e, elemType, name);
      else {
        const t = this.expr(e);
        if (!this.assignableExpr(elemType, t, e)) this.error(e.span, 'pj/type/assign', `Element of type ${typeStr(t)} does not fit in ${typeStr(expected)}`);
      }
    }
    this.types.set(lit, expected);
  }

  private switchStmt(s: A.SwitchStmt): void {
    const t = this.expr(s.expr);
    const protoVar = s.expr.kind === 'NameExpr' ? this.resolutions.get(s.expr) : undefined;
    const cases = t.k === 'protocol' ? this.index.protocolCases(t.name) : undefined;
    if (!isLenient(t) && !isIntegral(t) && !isPrim(t, 'string') && t.k !== 'protocol') this.error(s.expr.span, 'pj/type/switch', `Cannot switch on ${typeStr(t)}; use an integer, char, string or protocol value`);
    const seenLabels = new Set<string>();
    this.switchDepth++;
    for (const g of s.groups) {
      let tag: string | undefined;
      for (const l of g.labels) {
        if (!l) continue;
        if (cases) {
          if (l.kind !== 'NameExpr' || l.qualifier) {
            this.error(l.span, 'pj/type/switch', `A case of a protocol switch must be a case name of ${typeStr(t)}: ${[...cases.keys()].join(', ')}`);
            continue;
          }
          if (!cases.has(l.name.name)) {
            const sug = suggest(l.name.name, cases.keys());
            this.error(l.span, 'pj/type/switch', `'${l.name.name}' is not a case of protocol ${typeStr(t)} (cases: ${[...cases.keys()].join(', ')})${sug ? `; did you mean '${sug}'?` : ''}`);
            continue;
          }
          tag = l.name.name;
          this.types.set(l, t);
          if (seenLabels.has(tag)) this.error(l.span, 'pj/type/switch', `Duplicate case '${tag}'`);
          seenLabels.add(tag);
        } else {
          const lt = this.expr(l);
          if (!isLenient(t) && !isLenient(lt) && !assignable(t, lt, this.index)) this.error(l.span, 'pj/type/switch', `Case value of type ${typeStr(lt)} does not match the switch expression (${typeStr(t)})`);
          const key = exprText(l);
          if (seenLabels.has(key)) this.error(l.span, 'pj/type/switch', `Duplicate case ${key}`);
          seenLabels.add(key);
        }
      }
      this.push();
      this.withCase(protoVar && tag ? [protoVar, tag] : undefined, () => this.stmts(g.stmts));
      this.pop();
    }
    this.switchDepth--;
  }

  /** Run `body` with a protocol variable known to hold a given case. */
  private withCase(narrow: [VarInfo, string] | undefined, body: () => void): void {
    if (!narrow) return body();
    const [v, tag] = narrow;
    const prev = this.activeCase.get(v);
    this.activeCase.set(v, tag);
    body();
    if (prev === undefined) this.activeCase.delete(v);
    else this.activeCase.set(v, prev);
  }

  /** `if (p is tag)` narrows `p` inside the then-branch. */
  private narrowing(cond: A.Expr): [VarInfo, string] | undefined {
    let e = cond;
    while (e.kind === 'ParenExpr') e = e.expr;
    if (e.kind !== 'IsExpr' || e.expr.kind !== 'NameExpr') return undefined;
    const v = this.resolutions.get(e.expr);
    return v ? [v, e.typeName.name] : undefined;
  }

  private altStmt(s: A.AltStmt): void {
    this.insideAlt++;
    this.push();
    if (s.replicated) {
      const r = s.replicated;
      if (r.init) {
        if (Array.isArray(r.init)) for (const e of r.init) this.expr(e);
        else this.localDecl(r.init);
      }
      if (r.cond) this.condition(r.cond, 'alt');
      for (const e of r.update) this.expr(e);
    }
    if (s.isPri) {
      const skipAt = s.cases.findIndex((c) => c.guard?.kind === 'SkipGuard' && !c.precondition);
      if (skipAt >= 0 && skipAt < s.cases.length - 1) this.warn(s.cases[skipAt].guard!.span, 'pj/pri-alt-skip', `'skip' is always ready, so in a pri alt the guards after it are never chosen. Put skip last.`);
    }
    if (s.cases.length === 1 && !s.replicated && s.cases[0].guard?.kind === 'ReadGuard' && !s.cases[0].precondition) {
      this.report({ start: s.span.start, end: { line: s.span.start.line, col: s.span.start.col + (s.isPri ? 7 : 3) } }, 'info', 'pj/trivial-alt', "An alt with one guard is just a read");
    }
    for (const c of s.cases) {
      if (c.nested) {
        this.altStmt(c.nested);
        continue;
      }
      this.push();
      if (c.precondition) this.condition(c.precondition, 'the alt precondition');
      if (c.guard) {
        switch (c.guard.kind) {
          case 'SkipGuard':
            break;
          case 'TimeoutGuard':
            this.timeout(c.guard.timeout);
            break;
          case 'ReadGuard': {
            const vt = this.chanRead(c.guard.read);
            const lt = this.lvalue(c.guard.target);
            if (!this.assignableExpr(lt, vt, c.guard.read)) this.error(c.guard.span, 'pj/type/assign', `Cannot store a ${typeStr(vt)} read from the channel in '${exprText(c.guard.target)}' (${typeStr(lt)})`);
            break;
          }
        }
      }
      if (c.body) this.stmt(c.body);
      this.pop();
    }
    this.pop();
    this.insideAlt--;
  }

  // -------------------------------------------------------------------------
  // Par blocks: parallel usage and shared channel ends
  // -------------------------------------------------------------------------

  private parBlock(s: A.ParBlock): void {
    const branches: BranchUse[] = [];
    this.push();
    for (const st of s.body.stmts) {
      const use = this.branch(this.scope.depth, () => this.stmt(st));
      branches.push(use);
    }
    this.pop();
    this.simulateRendezvous(s);

    const reported = new Set<VarInfo>();
    for (let x = 0; x < branches.length; x++) {
      for (const [v, wspan] of branches[x].writes) {
        if (v.depth > branches[x].depth) continue; // declared inside this branch
        for (let y = 0; y < branches.length; y++) {
          if (x === y || reported.has(v)) continue;
          const other = branches[y].writes.get(v) ?? branches[y].reads.get(v);
          if (!other) continue;
          reported.add(v);
          const later = after(other, wspan) ? other : wspan;
          const what = branches[y].writes.has(v) ? 'written' : 'read';
          this.error(later, 'pj/parallel-usage', `'${v.name}' is written in one branch of this par and ${what} in another: a data race`);
        }
      }
    }
    const seenEnds = new Map<string, number>();
    for (let x = 0; x < branches.length; x++) {
      for (const [key, { v, span }] of branches[x].ends) {
        const first = seenEnds.get(key);
        if (first === undefined) {
          seenEnds.set(key, x);
          continue;
        }
        if (first === x || first === -1) continue;
        seenEnds.set(key, -1);
        if (v.type.k !== 'chan' || v.type.shared || v.depth > branches[x].depth) continue;
        const declLine = v.decl.span.start.line;
        const typeCol = Math.max(0, v.decl.span.start.col - (typeStr(v.type).length + 1));
        this.error(span, 'pj/shared-channel-end', `'${key}' is used by more than one branch of this par; declare it 'shared chan<${typeStr(v.type.elem)}>'`, { kind: 'make-shared', line: declLine, col: typeCol, title: `Declare '${v.name}' as shared` });
      }
    }
  }

  /**
   * Straight-line branches (only channel reads/writes, prints and plain statements)
   * are run through a rendezvous simulation: a write on a channel pairs with a read
   * on the same channel in another branch. Anything left waiting is a deadlock.
   * Branches with loops, alts, conditionals, nested pars or calls that receive
   * channels are opaque, and then the whole par is left alone.
   */
  private simulateRendezvous(s: A.ParBlock): void {
    if (s.body.stmts.length < 2) return;
    const queues: Op[][] = [];
    for (const st of s.body.stmts) {
      const ops = this.branchOps(st);
      if (!ops) return;
      queues.push(ops);
    }
    if (queues.every((q) => q.length === 0)) return;
    this.pendingSims.push({ par: s, queues });
  }

  /**
   * Only channels that live entirely inside this par can be simulated: a parameter,
   * a channel passed on to another process, or one also used outside the par may
   * have a partner we cannot see. Any such channel makes the whole par opaque.
   */
  private runSimulation(s: A.ParBlock, queues: Op[][]): void {
    const inside = (sp: A.Span) => !before(sp, s.span.start) && before(sp, s.span.end);
    for (const q of queues) {
      for (const op of q) {
        const v = op.chan;
        const use = this.chanUses.get(v);
        if (v.isParam || !use || use.bare || v.type.k !== 'chan' || v.type.end) return;
        if (!use.spans.every(inside)) return;
        if (use.branches.size <= 1) return; // a single-process channel is already a self-deadlock report
      }
    }
    const heads = queues.map(() => 0);
    for (;;) {
      let progressed = false;
      for (let i = 0; i < queues.length && !progressed; i++) {
        const a = queues[i][heads[i]];
        if (!a) continue;
        for (let j = 0; j < queues.length; j++) {
          if (i === j) continue;
          const b = queues[j][heads[j]];
          if (b && b.chan === a.chan && b.kind !== a.kind) {
            heads[i]++;
            heads[j]++;
            progressed = true;
            break;
          }
        }
      }
      if (!progressed) break;
    }
    const stuck = queues.map((q, i) => ({ i, op: q[heads[i]] })).filter((x) => x.op);
    if (stuck.length === 0) return;
    const first = stuck[0];
    const describe = (x: { i: number; op: Op }) => `branch ${x.i + 1} waits to ${x.op.kind} '${x.op.chan.name}'`;
    const others = stuck.slice(1).map(describe);
    const finished = stuck.length === 1 ? ' but every other branch has finished' : '';
    this.warn(first.op.span, 'pj/par-deadlock', `Deadlock: ${describe(first)}${others.length ? `, ${others.join(', ')}` : ''}${finished}. Writes and reads must pair up across branches in the same order.`);
  }

  /** Channel operations of a straight-line branch, or undefined if the branch is opaque. */
  private branchOps(st: A.Stmt): Op[] | undefined {
    const ops: Op[] = [];
    const visit = (x: A.Stmt): boolean => {
      switch (x.kind) {
        case 'Block':
          return x.stmts.every(visit);
        case 'EmptyStmt':
        case 'SkipStmt':
          return true;
        case 'LocalDecl':
          return x.declarators.every((d) => !d.init || this.exprOps(d.init, ops));
        case 'ExprStmt':
          return this.exprOps(x.expr, ops);
        default:
          return false;
      }
    };
    return visit(st) ? ops : undefined;
  }

  /**
   * Append the channel operations of an expression in evaluation order. Returns false
   * when the expression could communicate in a way we cannot model (an extended
   * rendezvous, a call that yields or that receives a channel).
   */
  private exprOps(e: A.Expr, ops: Op[]): boolean {
    switch (e.kind) {
      case 'ChanWrite': {
        if (e.target.kind !== 'NameExpr' || !this.exprOps(e.value, ops)) return false;
        const v = this.resolutions.get(e.target);
        if (!v) return false;
        ops.push({ kind: 'write', chan: v, span: e.span });
        return true;
      }
      case 'ChanRead': {
        if (e.extended || e.target.kind !== 'NameExpr') return false;
        const v = this.resolutions.get(e.target);
        if (!v) return false;
        ops.push({ kind: 'read', chan: v, span: e.span });
        return true;
      }
      case 'ChanEnd':
        return false; // an end being passed along
      case 'Sync':
      case 'Timeout':
        return false;
      case 'Invocation': {
        if (e.target) return false;
        const cands = this.index.procs.get(e.name.name) ?? [];
        if (cands.some((c) => this.yields.procYields(c.decl))) return false;
        return e.args.every((a) => this.exprOps(a, ops) && this.types.get(a)?.k !== 'chan');
      }
      case 'AssignExpr':
        return (e.target.kind === 'NameExpr' || this.exprOps(e.target, ops)) && this.exprOps(e.value, ops);
      case 'BinaryExpr':
        return this.exprOps(e.left, ops) && this.exprOps(e.right, ops);
      case 'UnaryExpr':
        return this.exprOps(e.operand, ops);
      case 'ParenExpr':
      case 'CastExpr':
        return this.exprOps(e.expr, ops);
      case 'TernaryExpr':
        return this.exprOps(e.cond, ops) && !this.yields.exprYields(e.then, true) && !this.yields.exprYields(e.else, true);
      case 'RecordAccess':
        return this.exprOps(e.target, ops);
      case 'ArrayAccess':
        return this.exprOps(e.target, ops) && this.exprOps(e.index, ops);
      case 'NewArray':
        return e.dimExprs.every((d) => this.exprOps(d, ops));
      case 'ArrayLiteral':
        return e.elements.every((x) => this.exprOps(x, ops));
      case 'RecordLiteral':
      case 'ProtocolLiteral':
        return e.fields.every((f) => this.exprOps(f.value, ops));
      case 'NameExpr':
        return this.types.get(e)?.k !== 'chan';
      default:
        return true;
    }
  }

  private branch(depth: number, body: () => void): BranchUse {
    const use: BranchUse = { reads: new Map(), writes: new Map(), ends: new Map(), bare: new Set(), depth };
    this.branchStack.push(use);
    body();
    this.branchStack.pop();
    // Propagate into the enclosing branch (for nested pars) as plain uses.
    const outer = this.branchStack[this.branchStack.length - 1];
    if (outer) {
      for (const [v, s] of use.reads) if (!outer.reads.has(v)) outer.reads.set(v, s);
      for (const [v, s] of use.writes) if (!outer.writes.has(v)) outer.writes.set(v, s);
      for (const [k, e] of use.ends) if (!outer.ends.has(k)) outer.ends.set(k, e);
    }
    return use;
  }

  private noteRead(v: VarInfo, span: A.Span): void {
    const b = this.branchStack[this.branchStack.length - 1];
    if (b && !b.reads.has(v)) b.reads.set(v, span);
  }

  private noteWrite(v: VarInfo, span: A.Span): void {
    const b = this.branchStack[this.branchStack.length - 1];
    if (b && !b.writes.has(v)) b.writes.set(v, span);
  }

  private noteEnd(v: VarInfo, end: 'read' | 'write', span: A.Span): void {
    const b = this.branchStack[this.branchStack.length - 1];
    if (b) {
      const key = `${v.name}.${end}`;
      if (!b.ends.has(key)) b.ends.set(key, { v, span });
    }
    const u = this.chanUses.get(v);
    if (u) {
      if (end === 'read') u.reads ??= span;
      else u.writes ??= span;
      u.first ??= span;
      u.branches.add(this.branchStack[this.branchStack.length - 1]);
      u.spans.push(span);
    }
  }

  private noteBare(v: VarInfo): void {
    const u = this.chanUses.get(v);
    if (u) u.bare = true;
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  private expr(e: A.Expr): Type {
    const t = this.exprInner(e);
    this.types.set(e, t);
    return t;
  }

  private exprInner(e: A.Expr): Type {
    switch (e.kind) {
      case 'Literal':
        switch (e.litKind) {
          case 'int':
            return T.int;
          case 'long':
            return T.long;
          case 'float':
            return T.float;
          case 'double':
            return T.double;
          case 'boolean':
            return T.boolean;
          case 'string':
            return T.string;
          case 'char':
            return T.char;
          case 'null':
            return T.null;
        }
        return T.unknown;
      case 'ErrorExpr':
        return T.error;
      case 'NameExpr':
        return this.name(e);
      case 'ParenExpr':
        return this.expr(e.expr);
      case 'BinaryExpr':
        return this.binary(e);
      case 'UnaryExpr':
        return this.unary(e);
      case 'AssignExpr':
        return this.assign(e);
      case 'TernaryExpr': {
        this.condition(e.cond, '?:');
        const a = this.expr(e.then);
        const b = this.expr(e.else);
        if (isLenient(a)) return b;
        if (isLenient(b)) return a;
        if (isNumeric(a) && isNumeric(b)) return promote(a, b);
        if (assignable(a, b, this.index)) return a;
        if (assignable(b, a, this.index)) return b;
        return this.error(e.span, 'pj/type/ternary', `The two branches of '?:' have different types: ${typeStr(a)} and ${typeStr(b)}`);
      }
      case 'CastExpr': {
        const to = this.resolveType(e.type);
        const from = this.expr(e.expr);
        if (isLenient(from) || isLenient(to)) return to;
        if (isNumeric(to) && isNumeric(from)) return to;
        if (sameType(to, from)) return to;
        if (isSubtype(to, from, this.index) || isSubtype(from, to, this.index)) return to;
        return this.error(e.span, 'pj/type/cast', `Cannot cast ${typeStr(from)} to ${typeStr(to)}`);
      }
      case 'IsExpr': {
        const t = this.expr(e.expr);
        if (isLenient(t)) return T.boolean;
        if (t.k !== 'protocol') return this.error(e.span, 'pj/type/is', `'is' tests a protocol value for its case; ${exprText(e.expr)} is ${typeStr(t)}`);
        const cases = this.index.protocolCases(t.name);
        if (!cases.has(e.typeName.name)) {
          const s = suggest(e.typeName.name, cases.keys());
          return this.error(e.typeName.span, 'pj/type/is', `'${e.typeName.name}' is not a case of protocol ${t.name} (cases: ${[...cases.keys()].join(', ')})${s ? `; did you mean '${s}'?` : ''}`);
        }
        return T.boolean;
      }
      case 'Invocation':
        return this.invocation(e);
      case 'RecordAccess':
        return this.access(e);
      case 'ArrayAccess': {
        const t = this.expr(e.target);
        const i = this.expr(e.index);
        if (!isLenient(i) && !isIntegral(i)) this.error(e.index.span, 'pj/type/index', `Array index must be an integer, not ${typeStr(i)}`);
        if (isLenient(t)) return T.unknown;
        if (t.k !== 'array') return this.error(e.target.span, 'pj/type/index', `${exprText(e.target)} is ${typeStr(t)}, not an array`);
        return t.dims > 1 ? { k: 'array', elem: t.elem, dims: t.dims - 1 } : t.elem;
      }
      case 'ChanEnd': {
        this.endTargets.add(e.target);
        const t = this.expr(e.target);
        this.noteChannel(e.target, e.end);
        if (isLenient(t)) return T.unknown;
        if (t.k !== 'chan') return this.error(e.span, 'pj/type/channel', `${exprText(e.target)} is ${typeStr(t)}, not a channel; '.${e.end}' needs a channel`);
        if (t.end) return this.error(e.span, 'pj/channel-direction', `'${exprText(e.target)}' is already a ${t.end} end; it has no '.${e.end}'`);
        return endOf(t, e.end);
      }
      case 'ChanRead':
        return this.chanRead(e);
      case 'ChanWrite': {
        this.endTargets.add(e.target);
        const t = this.expr(e.target);
        this.noteChannel(e.target, 'write');
        const v = this.expr(e.value);
        if (isLenient(t)) return T.void;
        if (t.k !== 'chan') return this.error(e.target.span, 'pj/type/channel', `${exprText(e.target)} is ${typeStr(t)}, not a channel; '.write' needs a channel or a write end`);
        if (t.end === 'read') return this.error(e.span, 'pj/channel-direction', `'${exprText(e.target)}' is a read end (${typeStr(t)}); it cannot write`);
        if (!this.assignableExpr(t.elem, v, e.value)) this.error(e.value.span, 'pj/channel-write-type', `Writing ${typeStr(v)} to '${exprText(e.target)}', which carries ${typeStr(t.elem)}${why(t.elem, v)}`);
        return T.void;
      }
      case 'Sync': {
        const t = this.expr(e.target);
        if (!isLenient(t) && !isPrim(t, 'barrier')) this.error(e.span, 'pj/type/barrier', `'.sync()' needs a barrier; ${exprText(e.target)} is ${typeStr(t)}`);
        if (e.target.kind === 'NameExpr') {
          const v = this.resolutions.get(e.target);
          if (v) this.syncs.push({ v, span: e.span });
        }
        return T.void;
      }
      case 'Timeout':
        return this.timeout(e);
      case 'NewArray': {
        const elem = this.resolveType(e.elem);
        for (const d of e.dimExprs) {
          const dt = this.expr(d);
          if (!isLenient(dt) && !isIntegral(dt)) this.error(d.span, 'pj/type/index', `Array size must be an integer, not ${typeStr(dt)}`);
        }
        const dims = e.dimExprs.length + e.extraDims;
        const t: Type = { k: 'array', elem: elem.k === 'array' ? elem.elem : elem, dims: dims + (elem.k === 'array' ? elem.dims : 0) };
        if (e.init) this.arrayLiteral(e.init, t, 'array');
        return t;
      }
      case 'ArrayLiteral':
        for (const x of e.elements) this.expr(x);
        return T.unknown;
      case 'RecordLiteral': {
        const rt = this.index.named(e.typeName.name);
        if (rt.k !== 'record') {
          for (const f of e.fields) this.expr(f.value);
          if (rt.k === 'protocol') return this.error(e.typeName.span, 'pj/type/literal', `'${e.typeName.name}' is a protocol; a protocol literal names its case first: 'new ${e.typeName.name} { case: field = value }'`);
          if (!this.opts.unresolvedImports) return this.error(e.typeName.span, 'pj/type/unknown-type', `Unknown record '${e.typeName.name}'`);
          return T.unknown;
        }
        const fields = this.index.recordFields(rt.name);
        const seen = new Set<string>();
        for (const f of e.fields) {
          const ft = fields.get(f.name.name);
          const vt = this.expr(f.value);
          if (!ft) {
            const s = suggest(f.name.name, fields.keys());
            this.error(f.name.span, 'pj/type/field', `Record '${rt.name}' has no field '${f.name.name}' (fields: ${[...fields.keys()].join(', ') || 'none'})${s ? `; did you mean '${s}'?` : ''}`);
            continue;
          }
          if (seen.has(f.name.name)) this.error(f.name.span, 'pj/type/field', `Field '${f.name.name}' is given twice`);
          seen.add(f.name.name);
          if (!this.assignableExpr(ft, vt, f.value)) this.error(f.value.span, 'pj/type/assign', `Field '${f.name.name}' is ${typeStr(ft)}, but this value is ${typeStr(vt)}${why(ft, vt)}`);
        }
        return rt;
      }
      case 'ProtocolLiteral': {
        const pt = this.index.named(e.typeName.name);
        if (pt.k !== 'protocol') {
          for (const f of e.fields) this.expr(f.value);
          if (pt.k === 'record') return this.error(e.tag.span, 'pj/type/literal', `'${e.typeName.name}' is a record, not a protocol; a record literal is 'new ${e.typeName.name} { field = value }'`);
          if (!this.opts.unresolvedImports) return this.error(e.typeName.span, 'pj/type/unknown-type', `Unknown protocol '${e.typeName.name}'`);
          return T.unknown;
        }
        const cases = this.index.protocolCases(pt.name);
        const fields = cases.get(e.tag.name);
        if (!fields) {
          for (const f of e.fields) this.expr(f.value);
          const s = suggest(e.tag.name, cases.keys());
          return this.error(e.tag.span, 'pj/type/literal', `'${e.tag.name}' is not a case of protocol ${pt.name} (cases: ${[...cases.keys()].join(', ')})${s ? `; did you mean '${s}'?` : ''}`);
        }
        const seen = new Set<string>();
        for (const f of e.fields) {
          const ft = fields.get(f.name.name);
          const vt = this.expr(f.value);
          if (!ft) {
            const s = suggest(f.name.name, fields.keys());
            this.error(f.name.span, 'pj/type/field', `Case '${e.tag.name}' of ${pt.name} has no field '${f.name.name}' (fields: ${[...fields.keys()].join(', ') || 'none'})${s ? `; did you mean '${s}'?` : ''}`);
            continue;
          }
          if (seen.has(f.name.name)) this.error(f.name.span, 'pj/type/field', `Field '${f.name.name}' is given twice`);
          seen.add(f.name.name);
          if (!this.assignableExpr(ft, vt, f.value)) this.error(f.value.span, 'pj/type/assign', `Field '${f.name.name}' is ${typeStr(ft)}, but this value is ${typeStr(vt)}${why(ft, vt)}`);
        }
        return pt;
      }
      case 'NewMobile':
        return T.unknown;
    }
  }

  private timeout(e: A.Timeout): Type {
    const t = this.expr(e.target);
    const d = this.expr(e.delay);
    if (!isLenient(t) && !isPrim(t, 'timer')) this.error(e.target.span, 'pj/type/timer', `'.timeout()' needs a timer; ${exprText(e.target)} is ${typeStr(t)}`);
    if (!isLenient(d) && !isIntegral(d)) this.error(e.delay.span, 'pj/type/timer', `The timeout delay must be an integer number of milliseconds, not ${typeStr(d)}`);
    return T.void;
  }

  private chanRead(e: A.ChanRead): Type {
    this.endTargets.add(e.target);
    const t = this.expr(e.target);
    if (isPrim(t, 'timer')) {
      // `t.read()` on a timer is the current time in milliseconds.
      if (e.extended) this.error(e.extended.span, 'pj/type/timer', 'A timer read takes no block');
      return T.long;
    }
    this.noteChannel(e.target, 'read');
    if (e.extended) this.block(e.extended);
    if (isLenient(t)) return T.unknown;
    if (t.k !== 'chan') return this.error(e.target.span, 'pj/type/channel', `${exprText(e.target)} is ${typeStr(t)}, not a channel; '.read()' needs a channel or a read end`);
    if (t.end === 'write') return this.error(e.span, 'pj/channel-direction', `'${exprText(e.target)}' is a write end (${typeStr(t)}); it cannot read`);
    return t.elem;
  }

  /** Record a channel-end use on a plain variable, for the par and no-partner rules. */
  private noteChannel(target: A.Expr, end: 'read' | 'write'): void {
    if (target.kind !== 'NameExpr') return;
    const v = this.resolutions.get(target);
    if (v && v.type.k === 'chan' && !v.type.end) this.noteEnd(v, end, target.span);
  }

  private name(e: A.NameExpr): Type {
    if (e.qualifier?.length) return T.unknown;
    const n = e.name.name;
    if (n === '<missing>') return T.error;
    const v = this.scope.lookup(n);
    if (v) {
      v.uses++;
      this.resolutions.set(e, v);
      this.noteRead(v, e.span);
      if (v.type.k === 'chan' && !v.type.end && !this.endTargets.has(e)) this.noteBare(v);
      return v.type;
    }
    const c = this.index.consts.get(n);
    if (c) return c.type;
    if (this.index.procs.has(n)) return this.error(e.span, 'pj/type/name', `'${n}' is a procedure; call it with parentheses`);
    if (this.index.records.has(n) || this.index.protocols.has(n)) return this.error(e.span, 'pj/type/name', `'${n}' is a type, not a value; create one with 'new ${n} { ... }'`);
    if (this.opts.unresolvedImports) return T.unknown;
    const s = suggest(n, [...this.scope.names(), ...this.index.allNames()]);
    return this.error(e.span, 'pj/type/name', `Cannot find '${n}'${s ? `; did you mean '${s}'?` : ''}`, s ? { kind: 'edit', title: `Change to '${s}'`, line: e.name.span.start.line, col: e.name.span.start.col, endCol: e.name.span.end.col, text: s } : undefined);
  }

  /** Type of an assignment target, with the write recorded for the par rules. */
  private lvalue(target: A.Expr): Type {
    if (target.kind === 'NameExpr') {
      const t = this.name(target);
      const v = this.resolutions.get(target);
      if (v) {
        v.uses--; // being assigned is not a use
        this.noteWrite(v, target.span);
        if (v.isConst) this.error(target.span, 'pj/type/const-assign', `'${v.name}' is a constant and cannot be assigned`);
      } else if (this.index.consts.has(target.name.name)) this.error(target.span, 'pj/type/const-assign', `'${target.name.name}' is a constant and cannot be assigned`);
      return t;
    }
    if (target.kind === 'RecordAccess' || target.kind === 'ArrayAccess') {
      // Writing one element or field: branches usually touch different elements (a[i] in a
      // par for), so this is recorded as a use of the container, not a write to it.
      return this.expr(target);
    }
    const t = this.expr(target);
    if (!isLenient(t)) this.error(target.span, 'pj/type/assign', 'The left side of an assignment must be a variable, field or array element');
    return t;
  }

  private assign(e: A.AssignExpr): Type {
    const lt = this.lvalue(e.target);
    if (e.value.kind === 'ArrayLiteral') {
      this.arrayLiteral(e.value, lt, exprText(e.target));
      return lt;
    }
    const rt = this.expr(e.value);
    if (e.op === '=') {
      if (!this.assignableExpr(lt, rt, e.value)) this.error(e.span, 'pj/type/assign', `Cannot assign ${typeStr(rt)} to '${exprText(e.target)}' (${typeStr(lt)})${why(lt, rt)}`);
      return lt;
    }
    // Compound assignment: x op= y  ==  x = x op y, with the implicit cast Java applies.
    const op = e.op.slice(0, -1);
    if (op === '+' && isPrim(lt, 'string')) return lt;
    if (isLenient(lt) || isLenient(rt)) return lt;
    if (['<<', '>>', '>>>', '&', '|', '^'].includes(op) ? !(isIntegral(lt) && isIntegral(rt)) && !(op !== '<<' && op !== '>>' && op !== '>>>' && isPrim(lt, 'boolean') && isPrim(rt, 'boolean')) : !(isNumeric(lt) && isNumeric(rt))) {
      return this.error(e.span, 'pj/type/operator', `'${e.op}' needs ${op === '&' || op === '|' || op === '^' ? 'integer or boolean' : ['<<', '>>', '>>>'].includes(op) ? 'integer' : 'numeric'} operands; here they are ${typeStr(lt)} and ${typeStr(rt)}`);
    }
    return lt;
  }

  private binary(e: A.BinaryExpr): Type {
    const l = this.expr(e.left);
    const r = this.expr(e.right);
    if (isLenient(l) || isLenient(r)) {
      if (['<', '>', '<=', '>=', '==', '!=', '&&', '||'].includes(e.op)) return T.boolean;
      if (e.op === '+' && (isPrim(l, 'string') || isPrim(r, 'string'))) return T.string;
      return isLenient(l) ? r : l;
    }
    switch (e.op) {
      case '+':
        if (isPrim(l, 'string') || isPrim(r, 'string')) {
          const other = isPrim(l, 'string') ? r : l;
          if (isPrim(other, 'void') || other.k === 'chan' || isPrim(other, 'barrier', 'timer')) return this.error(e.span, 'pj/type/operator', `Cannot concatenate ${typeStr(other)} to a string`);
          return T.string;
        }
      // fall through
      case '-':
      case '*':
      case '/':
      case '%':
        if (isNumeric(l) && isNumeric(r)) return promote(l, r);
        return this.error(e.span, 'pj/type/operator', `'${e.op}' needs numeric operands; here they are ${typeStr(l)} and ${typeStr(r)}`);
      case '<':
      case '>':
      case '<=':
      case '>=':
        if (isNumeric(l) && isNumeric(r)) return T.boolean;
        return this.error(e.span, 'pj/type/operator', `'${e.op}' compares numbers; here the operands are ${typeStr(l)} and ${typeStr(r)}`);
      case '==':
      case '!=':
        if ((isNumeric(l) && isNumeric(r)) || (isPrim(l, 'boolean') && isPrim(r, 'boolean'))) return T.boolean;
        if (l.k === 'null' && isReference(r)) return T.boolean;
        if (r.k === 'null' && isReference(l)) return T.boolean;
        if (sameType(l, r) && l.k !== 'null') return T.boolean;
        if ((l.k === 'record' && r.k === 'record') || (l.k === 'protocol' && r.k === 'protocol')) return T.boolean;
        return this.error(e.span, 'pj/type/operator', `Cannot compare ${typeStr(l)} with ${typeStr(r)}`);
      case '&&':
      case '||':
        if (isPrim(l, 'boolean') && isPrim(r, 'boolean')) return T.boolean;
        return this.error(e.span, 'pj/type/operator', `'${e.op}' needs boolean operands; here they are ${typeStr(l)} and ${typeStr(r)}`);
      case '&':
      case '|':
      case '^':
        if (isIntegral(l) && isIntegral(r)) return promote(l, r);
        if (isPrim(l, 'boolean') && isPrim(r, 'boolean')) return T.boolean;
        return this.error(e.span, 'pj/type/operator', `'${e.op}' needs integer or boolean operands; here they are ${typeStr(l)} and ${typeStr(r)}`);
      case '<<':
      case '>>':
      case '>>>':
        if (isIntegral(l) && isIntegral(r)) return promote(l, T.int);
        return this.error(e.span, 'pj/type/operator', `'${e.op}' needs integer operands; here they are ${typeStr(l)} and ${typeStr(r)}`);
      default:
        return T.unknown;
    }
  }

  private unary(e: A.UnaryExpr): Type {
    if (e.op === '++' || e.op === '--') {
      const t = this.lvalue(e.operand);
      if (!isLenient(t) && !isNumeric(t)) return this.error(e.span, 'pj/type/operator', `'${e.op}' needs a numeric variable; ${exprText(e.operand)} is ${typeStr(t)}`);
      return t;
    }
    const t = this.expr(e.operand);
    if (isLenient(t)) return t;
    switch (e.op) {
      case '!':
        if (isPrim(t, 'boolean')) return T.boolean;
        return this.error(e.span, 'pj/type/operator', `'!' needs a boolean; ${exprText(e.operand)} is ${typeStr(t)}`);
      case '~':
        if (isIntegral(t)) return promote(t, T.int);
        return this.error(e.span, 'pj/type/operator', `'~' needs an integer; ${exprText(e.operand)} is ${typeStr(t)}`);
      default:
        if (isNumeric(t)) return promote(t, T.int);
        return this.error(e.span, 'pj/type/operator', `Unary '${e.op}' needs a number; ${exprText(e.operand)} is ${typeStr(t)}`);
    }
  }

  private access(e: A.RecordAccess): Type {
    const t = this.expr(e.target);
    const m = e.member.name;
    if (isLenient(t)) return T.unknown;
    if (t.k === 'array') {
      if (m === 'size' || m === 'length') return T.int;
      return this.error(e.member.span, 'pj/type/field', `Arrays have '.size', not '.${m}'`);
    }
    if (isPrim(t, 'string')) {
      if (m === 'length' || m === 'size') return T.int;
      return this.error(e.member.span, 'pj/type/field', `Strings have '.length', not '.${m}'`);
    }
    if (t.k === 'record') {
      const fields = this.index.recordFields(t.name);
      const ft = fields.get(m);
      if (ft) return ft;
      const s = suggest(m, fields.keys());
      return this.error(e.member.span, 'pj/type/field', `Record '${t.name}' has no field '${m}' (fields: ${[...fields.keys()].join(', ') || 'none'})${s ? `; did you mean '${s}'?` : ''}`, s ? { kind: 'edit', title: `Change to '${s}'`, line: e.member.span.start.line, col: e.member.span.start.col, endCol: e.member.span.end.col, text: s } : undefined);
    }
    if (t.k === 'protocol') {
      const cases = this.index.protocolCases(t.name);
      const v = e.target.kind === 'NameExpr' ? this.resolutions.get(e.target) : undefined;
      const active = v ? this.activeCase.get(v) : undefined;
      if (active) {
        const fields = cases.get(active);
        const ft = fields?.get(m);
        if (ft) return ft;
        const owners = [...cases].filter(([, f]) => f.has(m)).map(([c]) => c);
        return this.error(e.member.span, 'pj/type/field', owners.length ? `'${m}' belongs to case ${owners.join('/')}, but here '${exprText(e.target)}' is case '${active}' (fields: ${[...(fields?.keys() ?? [])].join(', ') || 'none'})` : `Protocol ${t.name} has no field '${m}' in any case`);
      }
      for (const [, fields] of cases) {
        const ft = fields.get(m);
        if (ft) return ft;
      }
      return this.error(e.member.span, 'pj/type/field', `Protocol ${t.name} has no field '${m}' in any case (cases: ${[...cases.keys()].join(', ')})`);
    }
    if (t.k === 'chan') return this.error(e.member.span, 'pj/type/field', `A channel has '.read', '.write', '.read()' and '.write(v)', not '.${m}'`);
    return this.error(e.member.span, 'pj/type/field', `${typeStr(t)} has no field '${m}'`);
  }

  private invocation(e: A.Invocation): Type {
    const args = e.args.map((a) => this.expr(a));
    for (const a of e.args) if (a.kind === 'NameExpr') this.markBareArg(a);
    if (e.qualifier?.length) return T.unknown;
    if (e.target) {
      this.expr(e.target);
      return this.error(e.name.span, 'pj/type/call', `ProcessJ has no methods; call '${e.name.name}(...)' as a procedure and pass '${exprText(e.target)}' as an argument`);
    }
    const n = e.name.name;
    if (n === '<missing>') return T.error;
    const cands = this.index.procs.get(n);
    if (!cands || cands.length === 0) {
      if (this.scope.lookup(n)) return this.error(e.name.span, 'pj/type/call', `'${n}' is a variable, not a procedure`);
      if (this.opts.stdIndex?.procs.has(n) && !this.opts.importsStd) {
        return this.error(e.name.span, 'pj/missing-import', `'${n}' needs 'import std.*;' at the top of the file`, { kind: 'add-import', line: 0, col: 0, title: "Add 'import std.*;'" });
      }
      if (this.opts.unresolvedImports) return T.unknown;
      const s = suggest(n, [...this.index.procs.keys()]);
      return this.error(e.name.span, 'pj/type/call', `Cannot find a procedure named '${n}'${s ? `; did you mean '${s}'?` : ''}`, s ? { kind: 'edit', title: `Change to '${s}'`, line: e.name.span.start.line, col: e.name.span.start.col, endCol: e.name.span.end.col, text: s } : undefined);
    }
    const applicable = cands.filter((c) => c.params.length === args.length && c.params.every((p, i) => this.assignableExpr(p, args[i], e.args[i])));
    if (applicable.length === 0) {
      const argList = args.map(typeStr).join(', ');
      const sameArity = cands.filter((c) => c.params.length === args.length);
      const detail = sameArity.length === 1 ? explainMismatch(sameArity[0], args) : '';
      const shown = cands.slice(0, 3).map(signatureStr).join('; ') + (cands.length > 3 ? `; and ${cands.length - 3} more` : '');
      return this.error(e.span, 'pj/type/call', `No version of '${n}' accepts (${argList})${detail}. Available: ${shown}`);
    }
    // Most specific: every parameter assignable to the other candidate's parameter.
    let best = applicable.filter((a) => applicable.every((b) => a === b || a.params.every((p, i) => assignable(b.params[i], p, this.index))));
    if (best.length === 0) best = applicable;
    if (best.length > 1) {
      const exact = best.filter((c) => c.params.every((p, i) => sameType(p, args[i]) && !isLenient(args[i])));
      if (exact.length === 1) best = exact;
    }
    if (best.length > 1 && !args.some(isLenient)) this.warn(e.span, 'pj/type/call', `Ambiguous call to '${n}': ${best.map(signatureStr).join(' or ')}`);
    const chosen = best[0];
    this.calls.set(e, chosen);
    return chosen.ret;
  }

  /** A whole channel passed as an argument counts as both ends being handed away. */
  private markBareArg(a: A.NameExpr): void {
    const v = this.resolutions.get(a);
    if (v && v.type.k === 'chan' && !v.type.end) {
      this.noteBare(v);
      this.noteEnd(v, 'read', a.span);
      this.noteEnd(v, 'write', a.span);
    }
  }

  /** Assignability with Java's constant narrowing: an int literal fits in byte/short/char. */
  private assignableExpr(to: Type, from: Type, e: A.Expr): boolean {
    if (assignable(to, from, this.index)) return true;
    if (isPrim(to, 'byte', 'short', 'char') && isPrim(from, 'int') && isIntLiteral(e)) return true;
    if (isPrim(to, 'float') && isPrim(from, 'double') && e.kind === 'Literal') return true;
    return false;
  }

  private expectType(e: A.Expr, t: Type, owner: string): void {
    const et = this.expr(e);
    if (!isLenient(et) && !sameType(et, t)) this.error(e.span, `pj/type/${t.k === 'prim' ? t.name : t.k}`, `'${owner}' needs a ${typeStr(t)}; ${exprText(e)} is ${typeStr(et)}`);
  }

}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Op {
  kind: 'read' | 'write';
  chan: VarInfo;
  span: A.Span;
}

function isTrueLiteral(e: A.Expr): boolean {
  while (e.kind === 'ParenExpr') e = e.expr;
  return e.kind === 'Literal' && e.text === 'true';
}

/** Does the loop body contain a break, return or stop that can end the loop? (Nested loops' breaks do not count.) */
function containsExit(s: A.Stmt): boolean {
  switch (s.kind) {
    case 'BreakStmt':
    case 'ReturnStmt':
    case 'StopStmt':
      return true;
    case 'Block':
      return s.stmts.some(containsExit);
    case 'IfStmt':
      return containsExit(s.then) || (!!s.else && containsExit(s.else));
    case 'SwitchStmt':
      return s.groups.some((g) => g.stmts.some((x) => x.kind === 'ReturnStmt' || x.kind === 'StopStmt' || (x.kind !== 'BreakStmt' && containsExit(x))));
    case 'AltStmt':
      return s.cases.some((c) => (!!c.body && containsExit(c.body)) || (!!c.nested && containsExit(c.nested)));
    case 'ParBlock':
    case 'SeqBlock':
      return s.body.stmts.some((x) => x.kind === 'ReturnStmt' || x.kind === 'StopStmt' || containsExit(x));
    case 'ClaimStmt':
    case 'LabeledStmt':
      return containsExit(s.kind === 'ClaimStmt' ? s.body : s.stmt);
    case 'WhileStmt':
    case 'DoStmt':
    case 'ForStmt':
      // A return or stop inside an inner loop still leaves the outer one; a break does not.
      return returnsInside(s.body);
    default:
      return false;
  }
}

function returnsInside(s: A.Stmt): boolean {
  switch (s.kind) {
    case 'ReturnStmt':
    case 'StopStmt':
      return true;
    case 'Block':
      return s.stmts.some(returnsInside);
    case 'IfStmt':
      return returnsInside(s.then) || (!!s.else && returnsInside(s.else));
    case 'WhileStmt':
    case 'DoStmt':
    case 'ForStmt':
    case 'ClaimStmt':
      return returnsInside(s.body);
    case 'SwitchStmt':
      return s.groups.some((g) => g.stmts.some(returnsInside));
    case 'AltStmt':
      return s.cases.some((c) => (!!c.body && returnsInside(c.body)) || (!!c.nested && returnsInside(c.nested)));
    case 'ParBlock':
    case 'SeqBlock':
      return s.body.stmts.some(returnsInside);
    case 'LabeledStmt':
      return returnsInside(s.stmt);
    default:
      return false;
  }
}

function isIntLiteral(e: A.Expr): boolean {
  if (e.kind === 'ParenExpr') return isIntLiteral(e.expr);
  if (e.kind === 'UnaryExpr' && (e.op === '-' || e.op === '+') && e.prefix) return isIntLiteral(e.operand);
  return e.kind === 'Literal' && (e.litKind === 'int' || e.litKind === 'char');
}

/** A constant expression: literals, other constants, and arithmetic on them. */
function isLiteralInit(e: A.Expr): boolean {
  switch (e.kind) {
    case 'Literal':
      return true;
    case 'NameExpr':
      return true; // resolved to a constant or reported as unknown by the name check
    case 'ParenExpr':
      return isLiteralInit(e.expr);
    case 'UnaryExpr':
      return e.prefix && (e.op === '-' || e.op === '+' || e.op === '!' || e.op === '~') && isLiteralInit(e.operand);
    case 'BinaryExpr':
      return isLiteralInit(e.left) && isLiteralInit(e.right);
    case 'ArrayLiteral':
      return e.elements.every(isLiteralInit);
    default:
      return false;
  }
}

function before(a: A.Span, p: A.Pos): boolean {
  return a.start.line < p.line || (a.start.line === p.line && a.start.col < p.col);
}

function after(a: A.Span, b: A.Span): boolean {
  return a.start.line > b.start.line || (a.start.line === b.start.line && a.start.col > b.start.col);
}

function why(to: Type, from: Type): string {
  const w = whyNotAssignable(to, from);
  return w ? ` (${w})` : '';
}

function explainMismatch(sig: ProcSig, args: Type[]): string {
  for (let i = 0; i < args.length; i++) {
    if (!isLenient(args[i]) && typeStr(sig.params[i]) !== typeStr(args[i])) {
      const w = whyNotAssignable(sig.params[i], args[i]);
      return `: argument ${i + 1} ('${sig.paramNames[i]}') needs ${typeStr(sig.params[i])}${w ? `, ${w}` : ''}`;
    }
  }
  return '';
}

/** Short source rendering for messages. */
export function exprText(e: A.Expr): string {
  switch (e.kind) {
    case 'NameExpr':
      return `${e.qualifier?.length ? e.qualifier.map((q) => q.name).join('::') + '::' : ''}${e.name.name}`;
    case 'RecordAccess':
      return `${exprText(e.target)}.${e.member.name}`;
    case 'ChanEnd':
      return `${exprText(e.target)}.${e.end}`;
    case 'ArrayAccess':
      return `${exprText(e.target)}[...]`;
    case 'Literal':
      return e.text;
    case 'Invocation':
      return `${e.name.name}(...)`;
    case 'ChanRead':
      return `${exprText(e.target)}.read()`;
    case 'ParenExpr':
      return `(${exprText(e.expr)})`;
    default:
      return 'this expression';
  }
}
