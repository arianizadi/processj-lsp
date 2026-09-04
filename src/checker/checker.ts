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
import type { LintDiagnostic, LintRelated } from '../analysis';
import type { FixHint } from '../analysis';
import type * as A from '../parser/ast';
import { identToString, qualifierToString } from '../parser/ast';
import { PRIMITIVE_TYPES } from '../keywords';
import { suggest } from '../parser/parser';
import { directlyTransfersControl } from './controlflow';
import { DeclIndex, signatureStr, type ProcSig } from './index';
import { searchRendezvousHeads } from './rendezvous';
import { YieldAnalysis, yieldAnnotationEdit, type YieldCallProvider } from './yields';
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
  /** Source text, used to build quick fixes that rewrite a statement. */
  text?: string;
  /** Exact calls inside reachable imported bodies, used only for transitive yield analysis. */
  yieldCalls?: ReadonlyMap<A.Invocation, ProcSig>;
  /** Lazily resolve calls from an imported body in that file's own import scope. */
  yieldCallProvider?: YieldCallProvider;
  /** Exact compiler-distributed native declarations proven not to block or rendezvous. */
  trustedNonBlockingNativeDeclarations?: ReadonlySet<A.ProcDecl>;
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
  /** Structured channel topology retained for inlays, graphs and refactor safety. */
  channels: ChannelFact[];
  /** Confirmed straight-line rendezvous deadlocks with every blocked operation. */
  deadlocks: DeadlockFact[];
}

export interface ChannelOperationFact {
  end: 'read' | 'write';
  span: A.Span;
  /** False when an end is passed/selected rather than operated directly. */
  direct: boolean;
  /** The lexical par branch, when this use occurs inside one. */
  branch?: number;
  replicated: boolean;
}

export interface ChannelFact {
  variable: VarInfo;
  procedure: A.ProcDecl;
  operations: ChannelOperationFact[];
  /** The whole channel escaped or was used opaquely. */
  escaped: boolean;
  branchCount: number;
  hazard?: 'no-writer' | 'no-reader' | 'self-deadlock';
}

export interface DeadlockWait {
  branch: number;
  operation: 'read' | 'write';
  channel: VarInfo;
  span: A.Span;
}

export interface DeadlockFact {
  par: A.ParBlock;
  waits: DeadlockWait[];
  finishedBranches: number[];
  confidence: 'exact';
  cause: 'circular-wait' | 'missing-peer';
}

export function check(program: A.Program, opts: CheckOptions): CheckResult {
  const c = new Checker(opts);
  c.program(program);
  return { diagnostics: c.diags, vars: c.allVars, resolutions: c.resolutions, calls: c.calls, types: c.types, channels: c.channelFacts, deadlocks: c.deadlocks };
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
  id: number;
  reads: Map<VarInfo, A.Span>;
  writes: Map<VarInfo, A.Span>;
  ends: Map<string, { v: VarInfo; span: A.Span }>; // "name.read" / "name.write"
  bare: Set<VarInfo>;
  depth: number;
  /** A `par for` body: one branch in the source, many processes at runtime. */
  replicated: boolean;
}

/**
 * One use of a channel end from inside a par branch.
 *
 * The ProcessJ code generator emits the runtime's `claimRead`/`claimWrite` lock
 * only when the operated expression's static type is a *shared channel end*,
 * which in practice means a parameter declared `shared chan<T>.read/.write`.
 * Every operation written directly on a whole-channel variable is unlocked, and
 * so is one handed to a parameter that drops the `shared` keyword.
 */
interface EndOperation {
  variable: VarInfo;
  end: 'read' | 'write';
  span: A.Span;
  branch: BranchUse;
  /** Proven to run without the runtime's lock for this side. */
  unlocked: boolean;
  /** The parameter the end was handed to, when it was passed rather than operated here. */
  via?: { procedure: string; parameter: string };
}

/** Is the `end` side of this channel type declared shared? */
function sharedSideOf(t: Type, end: 'read' | 'write'): boolean {
  if (t.k !== 'chan') return false;
  return t.shared && (!t.sharedSide || t.sharedSide === end);
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
  operations: ChannelOperationFact[];
}

class Checker {
  readonly diags: LintDiagnostic[] = [];
  readonly allVars: VarInfo[] = [];
  readonly resolutions = new Map<A.NameExpr, VarInfo>();
  readonly calls = new Map<A.Invocation, ProcSig>();
  readonly types = new Map<A.Expr, Type>();
  readonly channelFacts: ChannelFact[] = [];
  readonly deadlocks: DeadlockFact[] = [];
  private readonly pendingStarvingLoops: Array<{ loopSpan: A.Span; body: A.Stmt; keyword: string }> = [];

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
  /** Channel-end uses of the current procedure, for the runtime-lock rules. */
  private endOperations: EndOperation[] = [];
  /** The `c.read` / `c.write` expression that produced each pending end operation. */
  private endOperationBySite = new Map<A.Expr, EndOperation>();
  private insideAlt = 0;
  /**
   * Limits the compiler applies per *generated process class* rather than per
   * procedure. It emits one class for a procedure body, one for each par branch
   * and one for each statement of a par for body.
   */
  private processAlts = 0;
  private processParFors = 0;
  /** >0 while inside a par block's branches. */
  private parDepth = 0;
  /** >0 while checking a read guard of an alt that has other guards: such a read does not block by itself. */
  private inChoiceGuard = 0;
  /** Name expressions that are the target of `.read` / `.write` / `.read()` / `.write(v)`: not "bare" uses of the channel. */
  private readonly endTargets = new WeakSet<A.Expr>();
  private readonly yields: YieldAnalysis;
  /** Barriers a proc enrolled on with `par enroll`, to spot syncs nobody enrolled. */
  private enrolled = new Set<VarInfo>();
  private syncs: Array<{ v: VarInfo; span: A.Span }> = [];
  /** Par blocks whose straight-line branches are simulated once the whole proc is known. */
  private pendingSims: Array<{ par: A.ParBlock; queues: Op[][] }> = [];
  private nextBranchId = 1;
  /** False only while type-checking code that cannot execute after a transfer. */
  private collectExecutionFacts = true;

  private readonly lines: string[] | undefined;

  constructor(private readonly opts: CheckOptions) {
    this.index = opts.index;
    this.yields = new YieldAnalysis(this.index, this.calls, opts.yieldCalls, opts.yieldCallProvider);
    this.lines = opts.text?.split('\n');
  }

  /** Source text of a span, when the text was provided. */
  private slice(span: A.Span): string | undefined {
    if (!this.lines) return undefined;
    if (span.start.line === span.end.line) return this.lines[span.start.line]?.slice(span.start.col, span.end.col);
    const parts = [this.lines[span.start.line]?.slice(span.start.col) ?? ''];
    for (let l = span.start.line + 1; l < span.end.line; l++) parts.push(this.lines[l] ?? '');
    parts.push(this.lines[span.end.line]?.slice(0, span.end.col) ?? '');
    return parts.join('\n');
  }

  private indentOf(line: number): string {
    return /^\s*/.exec(this.lines?.[line] ?? '')?.[0] ?? '';
  }

  // -------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------

  private report(span: A.Span, severity: LintDiagnostic['severity'], code: string, message: string, fix?: FixHint, related?: LintRelated[]): void {
    this.diags.push({ line: span.start.line, startCol: span.start.col, endCol: span.end.line === span.start.line ? span.end.col : span.start.col + 1, message, severity, code, source: 'lsp', fix, related });
  }

  private error(span: A.Span, code: string, message: string, fix?: FixHint): Type {
    this.report(span, 'error', code, message, fix);
    return T.error;
  }

  private warn(span: A.Span, code: string, message: string, related?: LintRelated[]): void {
    this.report(span, 'warning', code, message, undefined, related);
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
    if (this.collectExecutionFacts && type.k === 'chan' && !type.end && !isParam) this.chanUses.set(info, { bare: false, branches: new Set(), spans: [], operations: [] });
    return info;
  }

  private resolveType(node: A.TypeNode): Type {
    const t = this.index.resolve(node);
    this.checkTypeKnown(node);
    this.checkCompilable(node);
    return t;
  }

  /**
   * Features this ProcessJ build does not compile (verified by building them): arrays of
   * channels, variables holding a channel end. The program is not wrong; it just cannot be
   * built with this compiler, and the warning says so where the feature is used.
   */
  private checkCompilable(node: A.TypeNode): void {
    if (node.kind === 'ArrayType' && node.elem.kind === 'ChanType') this.report(node.span, 'warning', 'pj/compiler-limit', 'Arrays of channels cannot be compiled by this ProcessJ build; use separate channels');
    if (node.kind === 'ChanType' && node.elem.kind === 'PrimitiveType' && node.elem.name === 'string') {
      this.report(node.span, 'warning', 'pj/compiler-limit', "A channel carrying 'string' cannot be compiled by this ProcessJ build: its code generator has no wrapper type for string and throws while generating the channel. Send the value as a 'chan<int>' code or a 'chan<char>' sequence instead.");
    }
    if (node.kind === 'ArrayType' || node.kind === 'ChanType') return this.checkCompilable(node.elem);
  }

  /** Warn about a named type nothing declares; suggest a close name. */
  private checkTypeKnown(node: A.TypeNode): void {
    if (node.kind === 'ArrayType') return this.checkTypeKnown(node.elem);
    if (node.kind === 'ChanType') return this.checkTypeKnown(node.elem);
    if (node.kind !== 'NamedType' || node.name.name === '<missing>' || node.name.qualifier?.length) return;
    const name = node.name.name;
    if (this.index.isKnownType(name) || this.opts.unresolvedImports) return;
    const s = suggest(name, [...this.index.records.keys(), ...this.index.protocols.keys(), ...PRIMITIVE_TYPES]);
    this.report(node.span, 'warning', 'pj/type/unknown-type', `Unknown type '${name}'${s ? `; did you mean '${s}'?` : ' (not declared here, in an import, or in std)'}`, s ? { kind: 'edit', title: `Change to '${s}'`, line: node.name.span.start.line, col: node.name.span.start.col, endCol: node.name.span.end.col, text: s } : undefined);
  }

  // -------------------------------------------------------------------------
  // Program and declarations
  // -------------------------------------------------------------------------

  program(p: A.Program): void {
    const seenProcs = new Map<string, A.ProcDecl>();
    const seenTop = new Map<string, { kind: 'procedure' | 'record' | 'protocol' | 'constant' | 'extern type'; id: A.Ident }>();
    const procGroups = new Map<string, A.ProcDecl[]>();
    const noteTop = (id: A.Ident, kind: 'procedure' | 'record' | 'protocol' | 'constant' | 'extern type'): void => {
      const prev = seenTop.get(id.name);
      if (!prev) {
        seenTop.set(id.name, { kind, id });
        return;
      }
      if (kind === 'procedure' && prev.kind === 'procedure') return;
      this.error(id.span, 'pj/type/duplicate', `Top-level name '${id.name}' is already used by a ${prev.kind} on line ${prev.id.span.start.line + 1}`);
    };
    for (const d of p.decls) {
      switch (d.kind) {
        case 'RecordDecl': {
          noteTop(d.name, 'record');
          const seen = new Set<string>();
          for (const m of d.members) {
            this.checkTypeKnown(m.type);
            this.checkCompilable(m.type);
            if (seen.has(m.name.name)) this.error(m.name.span, 'pj/type/duplicate', `Field '${m.name.name}' is declared twice in record '${d.name.name}'`);
            seen.add(m.name.name);
          }
          const parents = new Set<string>();
          for (const e of d.extends) {
            const parentName = identToString(e);
            if (parents.has(parentName)) this.error(e.span, 'pj/type/duplicate', `'${parentName}' appears more than once in the extends clause of record '${d.name.name}'`);
            parents.add(parentName);
            if (e.qualifier?.length) continue;
            if (!this.index.records.has(e.name)) this.error(e.span, 'pj/type/unknown-type', `'${d.name.name}' extends '${e.name}', which is not a record`);
            else if (this.index.extendsName(e.name, d.name.name)) this.error(e.span, 'pj/type/cycle', `Record '${d.name.name}' extends itself through '${e.name}'`);
          }
          break;
        }
        case 'ProtocolDecl': {
          noteTop(d.name, 'protocol');
          const seen = new Set<string>();
          for (const c of d.cases ?? []) {
            if (seen.has(c.name.name)) this.error(c.name.span, 'pj/type/duplicate', `Case '${c.name.name}' is declared twice in protocol '${d.name.name}'`);
            seen.add(c.name.name);
            const fields = new Set<string>();
            for (const m of c.members) {
              this.checkTypeKnown(m.type);
              this.checkCompilable(m.type);
              if (fields.has(m.name.name)) this.warn(m.name.span, 'pj/type/duplicate', `Field '${m.name.name}' is declared twice in case '${c.name.name}' of protocol '${d.name.name}' (accepted by this compiler build, but ambiguous to readers and tools)`);
              fields.add(m.name.name);
            }
          }
          const parents = new Set<string>();
          for (const e of d.extends) {
            const parentName = identToString(e);
            if (parents.has(parentName)) this.warn(e.span, 'pj/type/duplicate', `'${parentName}' appears more than once in the extends clause of protocol '${d.name.name}' (accepted by this compiler build, but redundant)`);
            parents.add(parentName);
            if (e.qualifier?.length) continue;
            if (!this.index.protocols.has(e.name)) this.error(e.span, 'pj/type/unknown-type', `'${d.name.name}' extends '${e.name}', which is not a protocol`);
            else if (this.index.extendsName(e.name, d.name.name)) this.error(e.span, 'pj/type/cycle', `Protocol '${d.name.name}' extends itself through '${e.name}'`);
          }
          break;
        }
        case 'ConstDecl': {
          const type = this.resolveType(d.type);
          for (const v of d.declarators) {
            noteTop(v.name, 'constant');
            if (!v.init) {
              if (!d.modifiers.includes('native')) this.error(v.name.span, 'pj/type/const-init', `Constant '${v.name.name}' needs an initialiser`);
              continue;
            }
            const vt: Type = v.dims > 0 ? { k: 'array', elem: type.k === 'array' ? type.elem : type, dims: (type.k === 'array' ? type.dims : 0) + v.dims } : type;
            this.checkInit(vt, v.init, v.name.name);
            if (!(isLiteralInit(v.init) && this.onlyConstNames(v.init))) this.error(v.init.span, 'pj/type/const-init', 'A constant can only be initialised with literals and other constants');
          }
          break;
        }
        case 'ProcDecl': {
          noteTop(d.name, 'procedure');
          const group = procGroups.get(d.name.name);
          if (group) group.push(d);
          else procGroups.set(d.name.name, [d]);
          if (d.modifiers.includes('mobile') && !isPrim(this.index.resolve(d.returnType), 'void')) {
            this.error(d.returnType.span, 'pj/type/mobile', `Mobile procedure '${d.name.name}' must return void`);
          }
          for (const implemented of d.implements) {
            if (implemented.qualifier?.length) continue;
            if (this.index.procs.has(implemented.name)) continue;
            const nonProc = this.index.records.has(implemented.name) || this.index.protocols.has(implemented.name) || this.index.consts.has(implemented.name) || this.index.externs.has(implemented.name);
            this.error(implemented.span, 'pj/type/implements', nonProc ? `'${implemented.name}' is not a procedure and cannot be implemented` : `Cannot find the procedure '${implemented.name}' named in the implements clause`);
          }
          const key = `${d.name.name}(${d.params.map((x) => typeStr(this.index.resolve(x.type))).join(',')})`;
          const prev = seenProcs.get(key);
          if (prev) this.error(d.name.span, 'pj/type/duplicate', `Procedure '${d.name.name}' with the same parameter types is already declared at line ${prev.name.span.start.line + 1}`);
          seenProcs.set(key, d);
          break;
        }
        case 'ExternDecl':
          noteTop(d.name, 'extern type');
          break;
        default:
          break;
      }
    }
    for (const [name, group] of procGroups) {
      // This compiler diagnoses a mobile declaration only when an earlier
      // declaration already owns the name. A later ordinary overload after the
      // first mobile declaration is accepted (despite a contrary source comment).
      for (const d of group.slice(1)) {
        if (d.modifiers.includes('mobile')) this.error(d.name.span, 'pj/type/mobile', `Mobile procedure '${name}' cannot be overloaded; give each mobile procedure a unique name`);
      }
    }
    for (const d of p.decls) {
      if (d.kind === 'RecordDecl' && this.memberCycle(d.name.name, 'record')) this.report(d.name.span, 'warning', 'pj/compiler-limit', `Record '${d.name.name}' refers back to itself through its fields, which overflows this ProcessJ build's stack; break the cycle`);
      if (d.kind === 'ProtocolDecl' && this.memberCycle(d.name.name, 'protocol')) this.report(d.name.span, 'warning', 'pj/compiler-limit', `Protocol '${d.name.name}' refers back to itself through its case fields, which overflows this ProcessJ build's stack; break the cycle`);
    }
    for (const d of p.decls) if (d.kind === 'ProcDecl') this.procDecl(d);
    // Earlier lints may consult yieldability before every call in the file has
    // been resolved. Never reuse that partially memoised analysis for a
    // file-level result after the walk: unresolved calls deliberately fail
    // closed as yielding, and that answer would otherwise become order-sensitive.
    const resolvedYields = new YieldAnalysis(this.index, this.calls, this.opts.yieldCalls, this.opts.yieldCallProvider);
    for (const pending of this.pendingStarvingLoops) {
      if (resolvedYields.stmtYields(pending.body, 'calls')) continue;
      const head: A.Span = { start: pending.loopSpan.start, end: { line: pending.loopSpan.start.line, col: pending.loopSpan.start.col + pending.keyword.length } };
      this.warn(head, 'pj/starving-loop', 'This loop never ends and never communicates, so no other process ever runs again (the scheduler is cooperative). Add a channel operation, timeout or alt.');
    }
    for (const d of p.decls) {
      if (d.kind !== 'ProcDecl' || !d.body) continue;
      const ret = this.index.resolve(d.returnType);
      if (isPrim(ret, 'void') || !resolvedYields.procYields(d)) continue;
      this.report(d.returnType.span, 'warning', 'pj/compiler-limit', `'${d.name.name}' returns ${typeStr(ret)} and can suspend, which this ProcessJ build cannot compile: it puts the 'return' inside the generated process body and turns every call into a process start. Make it 'void' and hand the result back through a channel parameter.`);
    }
    for (const d of new YieldAnalysis(this.index, this.calls, this.opts.yieldCalls, this.opts.yieldCallProvider, { unresolvedRootCallsYield: false }).needingAnnotation(p)) {
      const at = yieldAnnotationEdit(d);
      this.report(d.name.span, 'warning', 'pj/needs-yield-annotation', `'${d.name.name}' suspends only through the procedures it calls, which this ProcessJ build does not notice; mark it [yield=true] so it is compiled as a suspending process`, { kind: 'edit', title: 'Add [yield=true]', line: at.line, col: at.col, endCol: at.endCol, text: at.text });
    }
  }

  /** Does a record or protocol reach itself again through member types (records and protocol cases)? */
  private memberCycle(name: string, kind: 'record' | 'protocol'): boolean {
    const seen = new Set<string>();
    const visit = (n: string, k: 'record' | 'protocol', first: boolean): boolean => {
      const key = `${k}:${n}`;
      if (!first && key === `${kind}:${name}`) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      const types: Type[] = k === 'record' ? [...this.index.recordFields(n).values()] : [...this.index.protocolCases(n).values()].flatMap((f) => [...f.values()]);
      for (const t of types) {
        const inner = t.k === 'array' ? t.elem : t;
        if (inner.k === 'record' && visit(inner.name, 'record', false)) return true;
        if (inner.k === 'protocol' && visit(inner.name, 'protocol', false)) return true;
      }
      return false;
    };
    return visit(name, kind, true);
  }

  private procDecl(d: A.ProcDecl): void {
    this.proc = d;
    this.procRet = this.resolveType(d.returnType);
    this.chanUses = new Map();
    this.endOperations = [];
    this.endOperationBySite = new Map();
    this.activeCase = new Map();
    this.processAlts = 0;
    this.processParFors = 0;
    this.enrolled = new Set();
    this.syncs = [];
    this.pendingSims = [];
    this.nextBranchId = 1;
    const firstVar = this.allVars.length;
    this.push();
    for (const p of d.params) {
      const t = this.resolveType(p.type);
      if (t.k === 'protocol') this.report(p.type.span, 'warning', 'pj/compiler-limit', 'A protocol value received as a parameter cannot be inspected (switch, is, fields) by this ProcessJ build; inspect it in the procedure that created it, or pass the fields you need');
      this.declare(p.name, t, p.isConst, true);
    }
    if (d.body) {
      // The body block shares the parameter scope, as in the compiler (params and locals collide there too).
      this.push();
      this.stmts(d.body.stmts);
      this.pop();
    }
    this.pop();
    this.finishProc(d, firstVar);
    this.proc = undefined;
  }

  private finishProc(d: A.ProcDecl, firstVar: number): void {
    // Only this overload's variables: procedure names repeat across overloads.
    // A bodiless (native) declaration cannot use its parameters at all.
    if (d.body) {
      for (const v of this.allVars.slice(firstVar)) {
        if (v.uses > 0) continue;
        if (v.isParam && v.name === 'args') continue;
        this.report(v.decl.span, v.isParam ? 'info' : 'warning', 'pj/unused', `'${v.name}' is never used`);
      }
    }
    // Run the branch-order simulation first so its causal diagnostic precedes
    // the channel-topology diagnostics below. Keep both kinds of finding: a
    // par-level missing-peer explanation does not make an accurate
    // no-reader/no-writer warning redundant (and consumers use those stable
    // codes independently of the richer deadlock fact).
    for (const sim of this.pendingSims) this.runSimulation(sim.par, sim.queues);
    for (const [v, use] of this.chanUses) {
      let hazard: ChannelFact['hazard'];
      // An alt choice is not itself a guaranteed wait, but it is still a real
      // endpoint operation that can rendezvous with a peer in another process.
      // Use all direct operations to decide whether a peer exists, and retain
      // `reads`/`writes` for the operation that can definitely block.
      const hasDirectRead = use.operations.some((op) => op.direct && op.end === 'read');
      const hasDirectWrite = use.operations.some((op) => op.direct && op.end === 'write');
      if (!use.bare) {
        if (use.reads && !hasDirectWrite) {
          hazard = 'no-writer';
          this.warn(use.reads, 'pj/channel-no-writer', `Nothing ever writes '${v.name}', so this read blocks forever`, [{ line: v.decl.span.start.line, startCol: v.decl.span.start.col, endCol: v.decl.span.end.col, message: `'${v.name}' is declared here, but no matching writer is reachable in this procedure.` }]);
        } else if (use.writes && !hasDirectRead) {
          hazard = 'no-reader';
          this.warn(use.writes, 'pj/channel-no-reader', `Nothing ever reads '${v.name}', so this write blocks forever`, [{ line: v.decl.span.start.line, startCol: v.decl.span.start.col, endCol: v.decl.span.end.col, message: `'${v.name}' is declared here, but no matching reader is reachable in this procedure.` }]);
        } else if (use.reads && use.writes && use.branches.size <= 1 && use.first && ![...use.branches].some((b) => b?.replicated)) {
          hazard = 'self-deadlock';
          this.warn(use.first, 'pj/channel-self-deadlock', `This process is both the writer and the reader of '${v.name}', so this ${use.first === use.writes ? 'write' : 'read'} blocks forever. Put the two sides in different branches of a par.`, [
            { line: use.reads.start.line, startCol: use.reads.start.col, endCol: use.reads.end.line === use.reads.start.line ? use.reads.end.col : use.reads.start.col + 1, message: `The same sequential process reads '${v.name}' here.` },
            { line: use.writes.start.line, startCol: use.writes.start.col, endCol: use.writes.end.line === use.writes.start.line ? use.writes.end.col : use.writes.start.col + 1, message: `The same sequential process writes '${v.name}' here.` },
          ]);
        }
      }
      this.channelFacts.push({
        variable: v,
        procedure: d,
        operations: [...use.operations],
        escaped: use.bare || use.operations.some((op) => !op.direct),
        branchCount: new Set(use.operations.map((op) => op.branch).filter((id): id is number => id !== undefined)).size,
        hazard,
      });
    }
    for (const { v, span } of this.syncs) {
      if (!v.isParam && !this.enrolled.has(v)) this.warn(span, 'pj/barrier-not-enrolled', `No 'par enroll (${v.name})' here, so this sync() waits for nobody and returns at once`);
    }
  }

  // -------------------------------------------------------------------------
  // Yield analysis: can this code suspend, i.e. communicate or wait?
  // -------------------------------------------------------------------------

  /** A loop that never ends (constant-true condition) and cannot suspend starves every other process. */
  private checkStarvingLoop(loopSpan: A.Span, cond: A.Expr | undefined, body: A.Stmt, keyword: string): void {
    if (!this.collectExecutionFacts) return;
    if (cond && !isTrueLiteral(cond)) return;
    if (containsExit(body)) return;
    this.pendingStarvingLoops.push({ loopSpan, body, keyword });
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  private block(b: A.Block): void {
    this.push();
    this.stmts(b.stmts);
    this.pop();
  }

  /** Type-check every statement, but collect execution facts only for the reachable prefix. */
  private stmts(list: A.Stmt[]): void {
    let reachable = true;
    let reported = false;
    for (const s of list) {
      if (!reachable && !reported && s.kind !== 'EmptyStmt') {
        this.warn(s.span, 'pj/unreachable', 'Unreachable code');
        reported = true;
      }
      this.withExecutionFacts(reachable, () => this.stmt(s));
      if (reachable && directlyTransfersControl(s)) reachable = false;
    }
  }

  private withExecutionFacts(reachable: boolean, body: () => void): void {
    const previous = this.collectExecutionFacts;
    this.collectExecutionFacts = previous && reachable;
    try {
      body();
    } finally {
      this.collectExecutionFacts = previous;
    }
  }

  private stmt(s: A.Stmt): void {
    switch (s.kind) {
      case 'Block':
        return this.block(s);
      case 'EmptyStmt':
      case 'SkipStmt':
        return;
      case 'StopStmt':
        return;
      case 'SuspendStmt':
        if (!this.proc?.modifiers.includes('mobile')) this.error(s.span, 'pj/type/suspend', "'suspend' can only appear in a mobile procedure");
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
        this.loop(() => this.stmt(s.body));
        // Resolve calls in the body before asking whether it can suspend. This
        // keeps overload-sensitive yield analysis exact without another file pass.
        this.checkStarvingLoop(s.span, s.cond, s.body, 'while');
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
            if (v && this.collectExecutionFacts) this.enrolled.add(v);
          }
        }
        if (s.isPar) {
          const head: A.Span = { start: s.span.start, end: { line: s.span.start.line, col: s.span.start.col + 3 } };
          this.processParFors++;
          if (this.processParFors >= 2) {
            this.report(head, 'warning', 'pj/compiler-limit', "A second 'par for' in the same process cannot be compiled by this ProcessJ build (its generated process array is declared twice); move this one into its own procedure");
          }
          // The generated code turns every statement of the body into its own
          // process, exactly as in a par block, so locals declared beside the
          // work are copied per process instead of being shared with it.
          if (s.body.kind === 'Block' && s.body.stmts.length > 1) {
            this.warn(s.body.span, 'pj/par-for-body', `Each of these ${s.body.stmts.length} statements becomes its own process, so they run in parallel rather than in sequence and a local declared in one is not visible to the others. Wrap the body in an inner '{ ... }' block to make each iteration a single process.`);
          }
          const use = this.branch(this.scope.depth, () => this.inProcess(() => this.loop(() => this.stmt(s.body))), true);
          // Every iteration is its own process, so anything from outside the loop is shared by all of them.
          const seen = new Set<VarInfo>();
          for (const [v, span] of use.writes) {
            if (v.depth <= outerDepth && !seen.has(v)) {
              seen.add(v);
              this.error(span, 'pj/parallel-usage', `Every iteration of this par for writes '${v.name}' at the same time (data race)`);
            }
          }
          for (const [key, { v, span }] of use.ends) {
            // Only the side actually held needs sharing: `shared write chan<T>`
            // leaves its read side with a single-reader slot.
            const side = key.endsWith('.read') ? 'read' : 'write';
            if (v.depth <= outerDepth && v.type.k === 'chan' && !sharedSideOf(v.type, side)) {
              const typeCol = Math.max(0, v.decl.span.start.col - (typeStr(v.type).length + 1));
              this.error(span, 'pj/shared-channel-end', `Every iteration of this par for holds '${key}'; declare it 'shared chan<${typeStr(v.type.elem)}>'`, { kind: 'make-shared', line: v.decl.span.start.line, col: typeCol, title: `Declare '${v.name}' as shared` });
            }
          }
          this.reportUnlockedEnds([use]);
        } else {
          this.loop(() => this.stmt(s.body));
          this.checkStarvingLoop(s.span, s.cond, s.body, 'for');
        }
        this.pop();
        return;
      }
      case 'ParBlock':
        for (const b of s.barriers) {
          this.expectType(b, T.barrier, 'enroll');
          if (b.kind === 'NameExpr') {
            const v = this.resolutions.get(b);
            if (v && this.collectExecutionFacts) this.enrolled.add(v);
          }
        }
        if (s.body.stmts.length === 0) this.report(s.span, 'info', 'pj/trivial-par', "Empty par: nothing runs");
        else if (s.body.stmts.length === 1) this.report({ start: s.span.start, end: { line: s.span.start.line, col: s.span.start.col + 3 } }, 'info', 'pj/trivial-par', "A par with one branch runs nothing concurrently");
        this.parBlock(s);
        return;
      case 'SeqBlock':
        return this.block(s.body);
      case 'ClaimStmt':
        this.report({ start: s.span.start, end: { line: s.span.start.line, col: s.span.start.col + 5 } }, 'warning', 'pj/compiler-limit', "'claim' cannot be compiled by this ProcessJ build");
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
        if (s.expr) this.noteNull(s.expr);
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
        else if (this.parDepth > 0) this.report(s.span, 'warning', 'pj/compiler-limit', "'break' inside a par branch, even within a loop, is rejected by this ProcessJ build; move the loop into its own procedure");
        return;
      case 'ContinueStmt':
        if (this.loopDepth === 0) this.error(s.span, 'pj/type/break', "'continue' outside of a loop");
        else if (this.parDepth > 0) this.report(s.span, 'warning', 'pj/compiler-limit', "'continue' inside a par branch is rejected by this ProcessJ build; move the loop into its own procedure");
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
    const isLoopOrBranch = owner === 'if' || owner === 'while' || owner === 'do ... while' || owner === 'for';
    let call: A.Expr = inner;
    let negated = false;
    while (call.kind === 'UnaryExpr' && call.op === '!' && call.prefix) {
      negated = !negated;
      call = call.operand;
      while (call.kind === 'ParenExpr') call = call.expr;
    }
    // A negated call has its own, more specific rule below.
    if (inner.kind === 'UnaryExpr' && inner.op === '!' && inner.prefix && isLoopOrBranch && call.kind !== 'Invocation') {
      // The generated code renders a whole-condition `!x` as a statement and the
      // javac step then fails on the stray `;`. Inside a larger condition
      // (`!a && b`) the same operand compiles.
      const operand = this.slice(inner.operand.span);
      const fix: FixHint | undefined = operand && inner.span.start.line === inner.span.end.line
        ? { kind: 'edit', title: `Compare with '== false'`, line: inner.span.start.line, col: inner.span.start.col, endCol: inner.span.end.col, text: `${operand} == false` }
        : undefined;
      this.report(inner.span, 'warning', 'pj/compiler-limit', `'!' as the whole condition of '${owner}' cannot be compiled by this ProcessJ build; write '${operand ?? 'x'} == false' instead`, fix);
      return;
    }
    if (call.kind === 'Invocation' && isLoopOrBranch) {
      const negatedText = negated ? this.slice(call.span) : undefined;
      const fix: FixHint | undefined = negated
        ? negatedText && inner.span.start.line === inner.span.end.line
          ? { kind: 'edit', title: "Compare with '== false'", line: inner.span.start.line, col: inner.span.start.col, endCol: inner.span.end.col, text: `${negatedText} == false` }
          : undefined
        : { kind: 'edit', title: "Compare with '== true'", line: call.span.end.line, col: call.span.end.col, endCol: call.span.end.col, text: ' == true' };
      this.error(e.span, 'pj/call-as-condition', `A call cannot be the whole condition of '${owner}'; compare its result (${negated ? `${exprText(call)} == false` : `${exprText(call)} == true`}) or store it in a boolean first`, fix);
    }
  }

  /** Quick fix for `x.write(... c.read() ...)`: read into a variable on the line above, then write it. */
  private hoistReadFix(write: A.ChanWrite, read: A.ChanRead): FixHint | undefined {
    const stmtText = this.slice(write.span);
    const readText = this.slice(read.span);
    if (!stmtText || !readText || read.span.start.line !== read.span.end.line || write.span.start.line !== write.span.end.line) return undefined;
    const t = this.types.get(read);
    if (!t || isLenient(t)) return undefined;
    const name = `read${read.span.start.line + 1}`;
    const indent = this.indentOf(write.span.start.line);
    const rewritten = stmtText.replace(readText, name);
    return { kind: 'edit', title: `Read into '${name}' first`, line: write.span.start.line, col: write.span.start.col, endCol: write.span.end.col, text: `${typeStr(t)} ${name} = ${readText};\n${indent}${rewritten}` };
  }

  private localDecl(d: A.LocalDecl): void {
    const base = this.resolveType(d.type);
    if (base.k === 'chan' && base.end) this.report(d.type.span, 'warning', 'pj/compiler-limit', 'A variable holding a channel end cannot be compiled by this ProcessJ build; use the channel directly or pass the end to a procedure');
    if (isPrim(base, 'void')) this.error(d.type.span, 'pj/type/void', 'A variable cannot have type void');
    for (const v of d.declarators) {
      const t: Type = v.dims > 0 ? { k: 'array', elem: base.k === 'array' ? base.elem : base, dims: (base.k === 'array' ? base.dims : 0) + v.dims } : base;
      // The initialiser is checked before the name is in scope: `int x = x + 1` is an error.
      if (v.init) {
        this.checkInit(t, v.init, v.name.name);
        if (d.isConst && !(isLiteralInit(v.init) && this.onlyConstNames(v.init))) this.error(v.init.span, 'pj/type/const-init', 'A constant can only be initialised with literals and other constants; this ProcessJ build computes it before the procedure runs, so the value would be 0 (or the build fails in a non-suspending procedure)');
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
    this.noteNull(init);
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
        if (!sameType(elemType, t) && !this.assignableExpr(elemType, t, e)) this.error(e.span, 'pj/type/assign', `Element of type ${typeStr(t)} does not fit in ${typeStr(expected)}`);
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
      const groupTags: string[] = [];
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
          const caseName = l.name.name;
          groupTags.push(caseName);
          this.types.set(l, t);
          if (seenLabels.has(caseName)) this.error(l.span, 'pj/type/switch', `Duplicate case '${caseName}'`);
          seenLabels.add(caseName);
        } else {
          const lt = this.expr(l);
          if (!isLenient(t) && !isLenient(lt) && !assignable(t, lt, this.index)) this.error(l.span, 'pj/type/switch', `Case value of type ${typeStr(lt)} does not match the switch expression (${typeStr(t)})`);
          const key = exprText(l);
          if (seenLabels.has(key)) this.error(l.span, 'pj/type/switch', `Duplicate case ${key}`);
          seenLabels.add(key);
        }
      }
      if (cases && groupTags.length > 1) {
        this.report(g.span, 'warning', 'pj/compiler-limit', `This ProcessJ build rejects multiple protocol labels in one switch group (${groupTags.join(', ')}); give each case its own body and break`);
      }
      const tag = groupTags.length === 1 ? groupTags[0] : undefined;
      this.push();
      this.withCase(protoVar && tag ? [protoVar, tag] : undefined, () => this.stmts(g.stmts));
      this.pop();
      for (const st of g.stmts) {
        if ((st.kind === 'WhileStmt' || st.kind === 'DoStmt' || st.kind === 'ForStmt') && containsBreak(st.body)) {
          this.report(st.span.start.line === st.span.end.line ? st.span : { start: st.span.start, end: { line: st.span.start.line, col: st.span.start.col + 5 } }, 'warning', 'pj/compiler-limit', "A loop with 'break' inside a switch case is rejected as unreachable by this ProcessJ build; move the loop into its own procedure");
          break;
        }
      }
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
    if (e.kind !== 'IsExpr' || e.expr.kind !== 'NameExpr' || e.typeName.qualifier?.length) return undefined;
    const v = this.resolutions.get(e.expr);
    return v ? [v, e.typeName.name] : undefined;
  }

  private altStmt(s: A.AltStmt, nested = false): void {
    // The compiler merges a nested non-replicated alt into its parent, so only
    // top-level and replicated alts count towards the one-alt limit.
    if (!nested || s.replicated) this.processAlts++;
    if (this.processAlts >= 2) this.error({ start: s.span.start, end: { line: s.span.start.line, col: s.span.start.col + (s.isPri ? 7 : 3) } }, 'pj/multiple-alts', `A second alt in the same process cannot be compiled by this ProcessJ build (its generated guard array is declared twice); move this one into its own procedure or into a separate par branch`);
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
        this.altStmt(c.nested, true);
        continue;
      }
      this.push();
      if (c.precondition) this.condition(c.precondition, 'the alt precondition');
      if (c.guard) {
        switch (c.guard.kind) {
          case 'SkipGuard':
            break;
          case 'TimeoutGuard':
            this.timeout(c.guard.timeout, true);
            break;
          case 'ReadGuard': {
            if (s.cases.length > 1) this.inChoiceGuard++;
            const vt = this.chanRead(c.guard.read);
            if (s.cases.length > 1) this.inChoiceGuard--;
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
    this.parDepth++;
    this.push();
    for (const st of s.body.stmts) {
      const use = this.branch(this.scope.depth, () => this.inProcess(() => this.stmt(st)));
      branches.push(use);
    }
    this.pop();
    this.parDepth--;
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
        const side = key.endsWith('.read') ? 'read' : 'write';
        if (v.type.k !== 'chan' || sharedSideOf(v.type, side) || v.depth > branches[x].depth) continue;
        const declLine = v.decl.span.start.line;
        const typeCol = Math.max(0, v.decl.span.start.col - (typeStr(v.type).length + 1));
        this.error(span, 'pj/shared-channel-end', `'${key}' is used by more than one branch of this par; declare it 'shared chan<${typeStr(v.type.elem)}>'`, { kind: 'make-shared', line: declLine, col: typeCol, title: `Declare '${v.name}' as shared` });
      }
    }
    this.reportUnlockedEnds(branches);
  }

  /**
   * Straight-line branches (only channel reads/writes, prints and plain statements)
   * are run through a rendezvous simulation: a write on a channel pairs with a read
   * on the same channel in another branch. Anything left waiting is a deadlock.
   * Branches with loops, alts, conditionals, nested pars or calls that receive
   * channels are opaque, and then the whole par is left alone.
   */
  private simulateRendezvous(s: A.ParBlock): void {
    if (!this.collectExecutionFacts) return;
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
    // A channel with several ready peers is nondeterministic. A greedy first
    // match can manufacture a dead end even when another legal rendezvous
    // completes, making the result depend on source branch order. Explore the
    // bounded head-state graph and report only when *every* legal schedule is
    // stuck. If the proof budget is exhausted, fail closed and make no claim.
    const proof = searchRendezvousHeads(queues, (left, right) => left.chan === right.chan && left.kind !== right.kind);
    if (proof.kind !== 'deadlock') return;
    const heads = proof.heads;
    const stuck = queues.map((q, i) => ({ i, op: q[heads[i]] })).filter((x) => x.op);
    const first = stuck[0];
    const describe = (x: { i: number; op: Op }) => `branch ${x.i + 1} waits to ${x.op.kind} '${x.op.chan.name}'`;
    const others = stuck.slice(1).map(describe);
    const finished = stuck.length === 1 ? ' but every other branch has finished' : '';
    const finishedBranches = queues.map((_, i) => i).filter((i) => !queues[i][heads[i]]).map((i) => i + 1);
    // A collection of blocked heads is not necessarily a circular wait. For
    // each head, look for the opposite operation in another branch's remaining
    // work. If none exists, that wait has a genuinely missing peer and is a
    // root cause. If every head has a future peer, the finite dependency graph
    // necessarily contains a cycle: each branch is waiting for another blocked
    // branch to advance before its peer can be reached.
    const remainingByChannel = new Map<VarInfo, { read: Set<number>; write: Set<number> }>();
    queues.forEach((queue, branch) => {
      for (let i = heads[branch]; i < queue.length; i++) {
        const op = queue[i];
        let remaining = remainingByChannel.get(op.chan);
        if (!remaining) {
          remaining = { read: new Set(), write: new Set() };
          remainingByChannel.set(op.chan, remaining);
        }
        remaining[op.kind].add(branch);
      }
    });
    const missingPeers = stuck.filter((x) => {
      const peers = remainingByChannel.get(x.op.chan)?.[x.op.kind === 'read' ? 'write' : 'read'];
      return !peers || peers.size === 0 || (peers.size === 1 && peers.has(x.i));
    });
    const cause = missingPeers.length > 0 ? 'missing-peer' : 'circular-wait';
    this.deadlocks.push({
      par: s,
      waits: stuck.map((x) => ({ branch: x.i + 1, operation: x.op.kind, channel: x.op.chan, span: x.op.span })),
      finishedBranches,
      confidence: 'exact',
      cause,
    });
    const why = cause === 'missing-peer'
      ? `No unfinished branch can reach ${missingPeers.map((x) => `a matching ${x.op.kind === 'read' ? 'write' : 'read'} on '${x.op.chan.name}' for branch ${x.i + 1}`).join(' or ')}.`
      : 'Each listed branch is blocked at its next rendezvous, so none can reach the operation another branch needs.';
    const related = stuck.map((x) => ({
      line: x.op.span.start.line,
      startCol: x.op.span.start.col,
      endCol: x.op.span.end.line === x.op.span.start.line ? x.op.span.end.col : x.op.span.start.col + 1,
      message: `Branch ${x.i + 1} is blocked here waiting to ${x.op.kind} '${x.op.chan.name}'.`,
    }));
    this.warn(first.op.span, 'pj/par-deadlock', `Deadlock: ${describe(first)}${others.length ? `, ${others.join(', ')}` : ''}${finished}. ${why}`, related);
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
        const target = this.channelRoot(e.target);
        const targetType = this.types.get(e.target);
        if (!target || targetType?.k !== 'chan' || targetType.end === 'read' || !this.exprOps(e.value, ops)) return false;
        const v = this.resolutions.get(target);
        if (!v || v.type.k !== 'chan') return false;
        ops.push({ kind: 'write', chan: v, span: e.span });
        return true;
      }
      case 'ChanRead': {
        const targetType = this.types.get(e.target);
        if (targetType?.k === 'prim' && targetType.name === 'timer') return !e.extended;
        const target = this.channelRoot(e.target);
        if (e.extended || !target || targetType?.k !== 'chan' || targetType.end === 'write') return false;
        const v = this.resolutions.get(target);
        if (!v || v.type.k !== 'chan') return false;
        ops.push({ kind: 'read', chan: v, span: e.span });
        return true;
      }
      case 'ChanEnd':
        return false; // an end being passed along
      case 'Sync':
      case 'Timeout':
        return false;
      case 'Invocation': {
        if (e.target || e.qualifier?.length) return false;
        const chosen = this.calls.get(e);
        if (!chosen) return false;
        const decl = chosen.decl;
        // The shipped std output leaves are native but compiler-verified not
        // to rendezvous. Every other bodyless or incompletely-resolved call is
        // opaque: treating it as plain computation could manufacture an exact
        // deadlock proof from only the channel operations around it.
        const isProvenStdOutputLeaf = (decl.name.name === 'print' || decl.name.name === 'println')
          && decl.modifiers.includes('native')
          && !decl.modifiers.includes('mobile')
          && !decl.body
          && this.opts.trustedNonBlockingNativeDeclarations?.has(decl) === true
          && !decl.annotations.some((annotation) => annotation.name === 'yield' && annotation.value === 'true');
        // A body-bearing call can still diverge or transfer control before the
        // following channel operation (for example `while (true) {}`). Unless
        // the whole body is proven terminating, it is not a transparent step
        // in an exact rendezvous schedule. Keep the proof boundary deliberately
        // narrow: only the explicitly trusted compiler-native output leaves.
        if (!isProvenStdOutputLeaf) return false;
        return e.args.every((a) => this.exprOps(a, ops) && this.types.get(a)?.k !== 'chan');
      }
      case 'AssignExpr':
        return (e.target.kind === 'NameExpr' || this.exprOps(e.target, ops)) && this.exprOps(e.value, ops);
      case 'BinaryExpr': {
        if (!this.exprOps(e.left, ops)) return false;
        if (e.op !== '&&' && e.op !== '||') return this.exprOps(e.right, ops);
        // The right operand is conditional. Recording its channel operation as
        // an unconditional branch head can manufacture an exact deadlock (or
        // an exact schedule) for an operation that never executes.
        if (this.yields.exprYields(e.right, 'calls')) return false;
        const conditionalOps: Op[] = [];
        return this.exprOps(e.right, conditionalOps) && conditionalOps.length === 0;
      }
      case 'UnaryExpr':
        return this.exprOps(e.operand, ops);
      case 'ParenExpr':
      case 'CastExpr':
        return this.exprOps(e.expr, ops);
      case 'TernaryExpr':
        return this.exprOps(e.cond, ops) && !this.yields.exprYields(e.then, 'calls') && !this.yields.exprYields(e.else, 'calls');
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

  /**
   * Run `body` as its own generated process class, so the per-class compiler
   * limits (one alt, one par for) are counted separately from the enclosing one.
   */
  private inProcess<T>(body: () => T): T {
    const alts = this.processAlts;
    const parFors = this.processParFors;
    this.processAlts = 0;
    this.processParFors = 0;
    try {
      return body();
    } finally {
      this.processAlts = alts;
      this.processParFors = parFors;
    }
  }

  private branch(depth: number, body: () => void, replicated = false): BranchUse {
    const use: BranchUse = { id: this.nextBranchId++, reads: new Map(), writes: new Map(), ends: new Map(), bare: new Set(), depth, replicated };
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
    if (!this.collectExecutionFacts) return;
    const b = this.branchStack[this.branchStack.length - 1];
    if (b && !b.reads.has(v)) b.reads.set(v, span);
  }

  private noteWrite(v: VarInfo, span: A.Span): void {
    if (!this.collectExecutionFacts) return;
    const b = this.branchStack[this.branchStack.length - 1];
    if (b && !b.writes.has(v)) b.writes.set(v, span);
  }

  private noteEnd(v: VarInfo, end: 'read' | 'write', span: A.Span, direct = true, blocking = direct, site?: A.Expr): void {
    if (!this.collectExecutionFacts) return;
    const b = this.branchStack[this.branchStack.length - 1];
    if (b) {
      const key = `${v.name}.${end}`;
      if (!b.ends.has(key)) b.ends.set(key, { v, span });
      // A direct operation on a whole-channel variable is never locked. An end
      // handed to a procedure is assumed locked until overload resolution shows
      // the receiving parameter drops `shared`.
      const operation: EndOperation = { variable: v, end, span, branch: b, unlocked: direct };
      this.endOperations.push(operation);
      if (site) this.endOperationBySite.set(site, operation);
    }
    const u = this.chanUses.get(v);
    if (!u) return;
    u.operations.push({ end, span, direct, branch: b?.id, replicated: b?.replicated ?? false });
    if (!direct) {
      u.bare = true; // handed to another process: we cannot know what it does with it
      return;
    }
    if (blocking) {
      if (end === 'read') u.reads ??= span;
      else u.writes ??= span;
      u.first ??= span;
    }
    u.branches.add(b);
    u.spans.push(span);
  }

  /**
   * The generated code takes the runtime lock from the *parameter's* declared
   * type, so a shared end handed to a plain `chan<T>.end` parameter is operated
   * without it.
   */
  private noteEndArguments(e: A.Invocation, chosen: ProcSig): void {
    for (let i = 0; i < e.args.length; i++) {
      const operation = this.endOperationBySite.get(e.args[i]);
      const parameter = chosen.params[i];
      if (!operation || !parameter) continue;
      operation.unlocked = !(parameter.k === 'chan' && !!parameter.end && parameter.shared);
      operation.via = { procedure: chosen.name, parameter: typeStr(parameter) };
    }
  }

  /**
   * A `shared` channel only serialises its processes where the generated code
   * claims the runtime lock. Without it several processes overwrite the single
   * reader/writer slot the runtime keeps per channel, and the program can hang.
   */
  private reportUnlockedEnds(branches: readonly BranchUse[]): void {
    const ids = new Set(branches.map((b) => b.id));
    // Keyed by the declaration itself: two branches may each declare their own
    // channel with the same name, and those are different channels.
    const bySide = new Map<VarInfo, Map<'read' | 'write', EndOperation[]>>();
    for (const operation of this.endOperations) {
      if (!ids.has(operation.branch.id)) continue;
      if (!sharedSideOf(operation.variable.type, operation.end)) continue;
      let sides = bySide.get(operation.variable);
      if (!sides) {
        sides = new Map();
        bySide.set(operation.variable, sides);
      }
      const list = sides.get(operation.end);
      if (list) list.push(operation);
      else sides.set(operation.end, [operation]);
    }
    const groups = [...bySide.values()].flatMap((sides) => [...sides.values()]);
    for (const operations of groups) {
      // A replicated body is one branch in the source but many processes at runtime.
      const processes = new Set(operations.map((o) => o.branch.id)).size;
      if (processes < 2 && !operations.some((o) => o.branch.replicated)) continue;
      const unlocked = operations.filter((o) => o.unlocked);
      if (unlocked.length === 0) continue;
      const last = unlocked[unlocked.length - 1];
      const key = `${last.variable.name}.${last.end}`;
      const elem = last.variable.type.k === 'chan' ? typeStr(last.variable.type.elem) : '?';
      const wanted = `shared chan<${elem}>.${last.end}`;
      const how = last.via
        ? `it is passed to '${last.via.procedure}', which declares it as '${last.via.parameter}'`
        : `this build claims the lock only for a parameter declared '${wanted}', never for an operation written directly on the channel`;
      const remedy = last.end === 'write'
        ? `Pass '${key}' to a procedure whose parameter is '${wanted}'.`
        : `Keep all reads in one sequential process; this compiler build cannot generate reads through a '${wanted}' parameter.`;
      this.warn(last.span, 'pj/shared-unlocked-end', `'${key}' is used by more than one process here without the runtime's ${last.end} lock: ${how}. The processes then share the runtime's single ${last.end} slot, so the program can hang. ${remedy}`);
    }
  }

  private noteBare(v: VarInfo): void {
    if (!this.collectExecutionFacts) return;
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
        const nested = findRead(e.then) ?? findRead(e.else) ?? findRead(e.cond);
        if (nested) this.error(nested.span, 'pj/read-placement', "A channel read cannot be part of a '?:' expression; read it into a variable first");
        if (isLenient(a)) return b;
        if (isLenient(b)) return a;
        if (isNumeric(a) && isNumeric(b)) return promote(a, b);
        // `assignable` rejects whole channels even against themselves; identical
        // branch types are trivially compatible.
        if (sameType(a, b)) return a;
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
        this.report(e.span, 'warning', 'pj/compiler-limit', "'is' cannot be compiled by this ProcessJ build; use 'switch' on the protocol value instead");
        if (e.typeName.qualifier?.length) return T.boolean;
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
        const consumedByOperation = this.endTargets.has(e);
        this.markEndTarget(e.target);
        const t = this.expr(e.target);
        // `c.read` passed as a value escapes; the same syntax inside
        // `c.read.read()` is only a selector for the direct operation.
        if (!consumedByOperation) this.noteChannel(e.target, e.end, false, false, e);
        if (isLenient(t)) return T.unknown;
        if (t.k !== 'chan') return this.error(e.span, 'pj/type/channel', `${exprText(e.target)} is ${typeStr(t)}, not a channel; '.${e.end}' needs a channel`);
        if (t.end) return this.error(e.span, 'pj/channel-direction', `'${exprText(e.target)}' is already a ${t.end} end; it has no '.${e.end}'`);
        return endOf(t, e.end);
      }
      case 'ChanRead':
        return this.chanRead(e);
      case 'ChanWrite': {
        this.markEndTarget(e.target);
        const t = this.expr(e.target);
        this.noteChannel(e.target, 'write', true);
        const v = this.expr(e.value);
        const nested = findRead(e.value);
        if (nested) this.error(nested.span, 'pj/read-placement', "A channel read cannot be part of a write's value; read it into a variable first", this.hoistReadFix(e, nested));
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
          if (v && this.collectExecutionFacts) this.syncs.push({ v, span: e.span });
        }
        return T.void;
      }
      case 'Timeout':
        return this.timeout(e, false);
      case 'NewArray': {
        const elem = this.resolveType(e.elem);
        for (const d of e.dimExprs) {
          const dt = this.expr(d);
          const nested = findRead(d);
          if (nested) this.error(nested.span, 'pj/read-placement', 'A channel read cannot be used as an array size; read it into a variable first');
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
        if (e.typeName.qualifier?.length) {
          for (const field of e.fields) this.expr(field.value);
          return { k: 'unknown', name: identToString(e.typeName) };
        }
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
          if (f.value.kind === 'RecordLiteral') this.report(f.value.span, 'warning', 'pj/compiler-limit', 'A record literal nested inside another cannot be compiled by this ProcessJ build; build the inner record in a variable first');
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
        const missing = [...fields.keys()].filter((name) => !seen.has(name));
        if (missing.length) {
          const names = missing.map((name) => `'${name}'`).join(', ');
          this.warn(e.typeName.span, 'pj/missing-field', `Record '${rt.name}' leaves ${missing.length === 1 ? 'field' : 'fields'} ${names} at ${missing.length === 1 ? 'its' : 'their'} default value`);
        }
        return rt;
      }
      case 'ProtocolLiteral': {
        if (e.typeName.qualifier?.length) {
          for (const field of e.fields) this.expr(field.value);
          return { k: 'unknown', name: identToString(e.typeName) };
        }
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
        const missing = [...fields.keys()].filter((name) => !seen.has(name));
        if (missing.length) {
          const names = missing.map((name) => `'${name}'`).join(', ');
          this.warn(e.tag.span, 'pj/missing-field', `Case '${e.tag.name}' of ${pt.name} leaves ${missing.length === 1 ? 'field' : 'fields'} ${names} at ${missing.length === 1 ? 'its' : 'their'} default value`);
        }
        return pt;
      }
      case 'NewMobile': {
        if (e.typeName.qualifier?.length) return { k: 'unknown', name: identToString(e.typeName) };
        const candidates = this.index.procs.get(e.typeName.name);
        if (!candidates?.length) {
          if (!this.opts.unresolvedImports) return this.error(e.typeName.span, 'pj/type/mobile', `Cannot find a procedure named '${e.typeName.name}' to create as a mobile process`);
          return T.unknown;
        }
        const mobile = candidates.filter((p) => p.decl.modifiers.includes('mobile'));
        if (mobile.length === 0) return this.error(e.typeName.span, 'pj/type/mobile', `'${e.typeName.name}' is not a mobile procedure`);
        if (mobile.length > 1) return this.error(e.typeName.span, 'pj/type/mobile', `Mobile procedure '${e.typeName.name}' is overloaded, so the process type is ambiguous`);
        return T.unknown;
      }
    }
  }

  private timeout(e: A.Timeout, inAlt = false): Type {
    const t = this.expr(e.target);
    const d = this.expr(e.delay);
    if (!isLenient(t) && !isPrim(t, 'timer')) this.error(e.target.span, 'pj/type/timer', `'.timeout()' needs a timer; ${exprText(e.target)} is ${typeStr(t)}`);
    if (!isLenient(d) && !isIntegral(d)) this.error(e.delay.span, 'pj/type/timer', `The timeout delay must be an integer number of milliseconds, not ${typeStr(d)}`);
    // The runtime stores the argument as the wall-clock millisecond at which the
    // timer expires, so `t.timeout(300)` is a deadline 300 ms after the epoch:
    // it has already passed and the timeout returns at once. Verified by running
    // both spellings: 1 ms elapsed against 306 ms for `t.timeout(t.read() + 300)`.
    // An alt guard is generated inline, so a read inside its deadline expression
    // produces invalid Java. A deadline computed into a local first is fine.
    const guardRead = inAlt ? findRead(e.delay) : undefined;
    if (guardRead) {
      this.report(guardRead.span, 'warning', 'pj/compiler-limit', "A read inside an alt timeout guard cannot be compiled by this ProcessJ build; compute the deadline into a variable before the alt and use that variable as the guard");
    }
    if (isPrim(t, 'timer') && this.isConstantDelay(e.delay)) {
      const timer = this.slice(e.target.span);
      const delay = this.slice(e.delay.span);
      // The same rewrite would not compile as an alt guard, so there it is
      // described rather than offered.
      const fix: FixHint | undefined = !inAlt && timer && e.delay.span.start.line === e.delay.span.end.line
        ? { kind: 'edit', title: `Wait from now: '${timer}.read() + ...'`, line: e.delay.span.start.line, col: e.delay.span.start.col, endCol: e.delay.span.start.col, text: `${timer}.read() + ` }
        : undefined;
      const remedy = inAlt
        ? `Set 'long deadline = ${timer ?? 'timer'}.read() + ${delay ?? 'delay'};' before the alt and use 'deadline' here.`
        : `Write '${timer ?? 'timer'}.read() + ${delay ?? 'delay'}' to wait that many milliseconds from now.`;
      this.report(e.delay.span, 'warning', 'pj/timeout-deadline', `'.timeout()' takes the absolute time to wake up, not how long to wait, so this returns immediately. ${remedy}`, fix);
    }
    return T.void;
  }

  /**
   * Is the delay a compile-time constant? Then it is certainly not a wall-clock
   * deadline. Anything computed from a variable, parameter or call may well be
   * one (`long when = t.read() + 300;`), so those are left alone.
   */
  private isConstantDelay(e: A.Expr): boolean {
    switch (e.kind) {
      case 'Literal':
        return e.litKind !== 'null';
      case 'ParenExpr':
      case 'CastExpr':
        return this.isConstantDelay(e.expr);
      case 'UnaryExpr':
        return e.op !== '++' && e.op !== '--' && this.isConstantDelay(e.operand);
      case 'BinaryExpr':
        return this.isConstantDelay(e.left) && this.isConstantDelay(e.right);
      case 'NameExpr': {
        const v = this.resolutions.get(e);
        if (v) return v.isConst;
        return this.index.consts.has(e.name.name);
      }
      default:
        return false;
    }
  }

  private chanRead(e: A.ChanRead): Type {
    this.markEndTarget(e.target);
    const t = this.expr(e.target);
    if (isPrim(t, 'timer')) {
      // `t.read()` on a timer is the current time in milliseconds.
      if (e.extended) this.error(e.extended.span, 'pj/type/timer', 'A timer read takes no block');
      return T.long;
    }
    // A read guard among other alt guards is a choice, not a blocking read: the alt may take another guard.
    this.noteChannel(e.target, 'read', true, this.inChoiceGuard === 0);
    if (e.extended) this.block(e.extended);
    if (isLenient(t)) return T.unknown;
    if (t.k !== 'chan') return this.error(e.target.span, 'pj/type/channel', `${exprText(e.target)} is ${typeStr(t)}, not a channel; '.read()' needs a channel or a read end`);
    if (t.end === 'write') return this.error(e.span, 'pj/channel-direction', `'${exprText(e.target)}' is a write end (${typeStr(t)}); it cannot read`);
    if (t.end === 'read' && t.shared) {
      this.report(e.span, 'warning', 'pj/compiler-limit', `Reading through '${typeStr(t)}' cannot be compiled by this ProcessJ build: its code generator throws on the shared-read template. Give the reader a plain '${typeStr({ ...t, shared: false })}' parameter (one reader process), or read the channel where it is declared.`);
    }
    return t.elem;
  }

  /**
   * Record a channel-end use on a plain variable. A direct operation (`c.read()`,
   * `c.write(v)`) counts for the deadlock rules; an end handed to a procedure
   * (`f(c.read)`) only counts for the par sharing rule, since the callee may use it
   * in an alt or in another process.
   */
  private noteChannel(target: A.Expr, end: 'read' | 'write', direct: boolean, blocking = direct, site?: A.Expr): void {
    const root = this.channelRoot(target);
    if (!root) return;
    const v = this.resolutions.get(root);
    if (v && v.type.k === 'chan' && !v.type.end) this.noteEnd(v, end, root.span, direct, blocking, site);
  }

  /** Mark transparent endpoint wrappers so the root channel is not mistaken for an opaque use. */
  private markEndTarget(target: A.Expr): void {
    this.endTargets.add(target);
    if (target.kind === 'ParenExpr' || target.kind === 'CastExpr') this.markEndTarget(target.expr);
    else if (target.kind === 'ChanEnd') this.markEndTarget(target.target);
  }

  /** Recover a whole-channel variable through syntax that does not change its identity. */
  private channelRoot(target: A.Expr): A.NameExpr | undefined {
    if (target.kind === 'NameExpr') return target;
    if (target.kind === 'ParenExpr' || target.kind === 'CastExpr') return this.channelRoot(target.expr);
    if (target.kind === 'ChanEnd') return this.channelRoot(target.target);
    return undefined;
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
      this.types.set(target, t);
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

  /** `x = null` and `T x = null` are rejected by this compiler ("cannot assign void"); `x == null` is fine. */
  private noteNull(e: A.Expr): void {
    if (e.kind === 'Literal' && e.litKind === 'null') this.report(e.span, 'warning', 'pj/compiler-limit', "'null' cannot be assigned or passed in this ProcessJ build (it treats null as void, and later uses of the variable fail the build); comparing with null is fine");
  }

  private assign(e: A.AssignExpr): Type {
    const lt = this.lvalue(e.target);
    this.noteNull(e.value);
    if (e.target.kind === 'ArrayAccess') {
      // Reading into an index is fine on the right of an assignment; only the
      // array being written breaks the generated code.
      const nested = findRead(e.target.index);
      if (nested) this.error(nested.span, 'pj/read-placement', 'A channel read cannot index the array being assigned; read it into a variable first');
    }
    if (e.value.kind === 'RecordLiteral' || e.value.kind === 'ProtocolLiteral') {
      this.report(e.value.span, 'warning', 'pj/compiler-limit', 'A record or protocol literal can only be compiled as the initialiser of a declaration in this ProcessJ build; declare the variable together with the literal, then assign that variable');
    }
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
    if (e.target.kind === 'ChanRead') this.error(e.target.span, 'pj/read-placement', 'A field cannot be taken from a channel read directly; read it into a variable first');
    const m = e.member.name;
    if (isLenient(t)) return T.unknown;
    if (t.k === 'array') {
      if (m === 'size') return T.int;
      return this.error(e.member.span, 'pj/type/field', `Arrays have '.size', not '.${m}'`);
    }
    if (isPrim(t, 'string')) {
      if (m === 'length') return T.int;
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
      const owners = [...cases].filter(([, fields]) => fields.has(m)).map(([caseName]) => caseName);
      if (owners.length) {
        return this.error(e.member.span, 'pj/type/field', `Field '${m}' of protocol ${t.name} can only be inspected after a protocol switch proves the active case (${owners.join('/')})`);
      }
      return this.error(e.member.span, 'pj/type/field', `Protocol ${t.name} has no field '${m}' in any case (cases: ${[...cases.keys()].join(', ')})`);
    }
    if (t.k === 'chan') return this.error(e.member.span, 'pj/type/field', `A channel has '.read', '.write', '.read()' and '.write(v)', not '.${m}'`);
    return this.error(e.member.span, 'pj/type/field', `${typeStr(t)} has no field '${m}'`);
  }

  private invocation(e: A.Invocation): Type {
    const args = e.args.map((a) => this.expr(a));
    for (const a of e.args) this.noteNull(a);
    for (const a of e.args) {
      if (a.kind === 'RecordLiteral' || a.kind === 'ProtocolLiteral') this.report(a.span, 'warning', 'pj/compiler-limit', 'A record or protocol literal passed directly as an argument cannot be compiled by this ProcessJ build; store it in a variable first');
    }
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
    // The compiler matches arguments with plain assignment compatibility: `f(1)`
    // does not select `f(byte)`, and with only `f(byte)` declared it is an error.
    const applicable = cands.filter((c) => c.params.length === args.length && c.params.every((p, i) => assignable(p, args[i], this.index)));
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
    // Keep checking with a provisional return type, but expose a declaration
    // identity only when overload selection is actually proved. In particular,
    // an unknown argument can manufacture one "most specific" candidate even
    // though its real type may select another overload.
    if (best.length === 1 && !args.some(isLenient)) this.calls.set(e, chosen);
    if (best.length === 1) this.noteEndArguments(e, chosen);
    return chosen.ret;
  }

  /** A whole channel passed as an argument counts as both ends being handed away. */
  private markBareArg(a: A.NameExpr): void {
    const v = this.resolutions.get(a);
    if (v && v.type.k === 'chan' && !v.type.end) {
      this.noteBare(v);
      this.noteEnd(v, 'read', a.span, false);
      this.noteEnd(v, 'write', a.span, false);
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

function containsBreak(s: A.Stmt): boolean {
  switch (s.kind) {
    case 'BreakStmt':
      return true;
    case 'Block':
      return s.stmts.some(containsBreak);
    case 'IfStmt':
      return containsBreak(s.then) || (!!s.else && containsBreak(s.else));
    case 'WhileStmt':
    case 'DoStmt':
    case 'ForStmt':
      return containsBreak(s.body);
    case 'LabeledStmt':
      return containsBreak(s.stmt);
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

/** The first channel read inside an expression, if any. */
function findRead(e: A.Expr): A.ChanRead | undefined {
  switch (e.kind) {
    case 'ChanRead':
      return e;
    case 'ParenExpr':
    case 'CastExpr':
      return findRead(e.expr);
    case 'BinaryExpr':
      return findRead(e.left) ?? findRead(e.right);
    case 'UnaryExpr':
      return findRead(e.operand);
    case 'AssignExpr':
      return findRead(e.value);
    case 'TernaryExpr':
      return findRead(e.cond) ?? findRead(e.then) ?? findRead(e.else);
    case 'Invocation':
      for (const a of e.args) {
        const r = findRead(a);
        if (r) return r;
      }
      return undefined;
    case 'RecordAccess':
      return findRead(e.target);
    case 'ArrayAccess':
      return findRead(e.target) ?? findRead(e.index);
    case 'RecordLiteral':
    case 'ProtocolLiteral':
      for (const f of e.fields) {
        const r = findRead(f.value);
        if (r) return r;
      }
      return undefined;
    case 'ArrayLiteral':
      for (const x of e.elements) {
        const r = findRead(x);
        if (r) return r;
      }
      return undefined;
    default:
      return undefined;
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
    const w = whyNotAssignable(sig.params[i], args[i]);
    if (!isLenient(args[i]) && (typeStr(sig.params[i]) !== typeStr(args[i]) || w)) {
      return `: argument ${i + 1} ('${sig.paramNames[i]}') needs ${typeStr(sig.params[i])}${w ? `, ${w}` : ''}`;
    }
  }
  return '';
}

/** Short source rendering for messages. */
export function exprText(e: A.Expr): string {
  switch (e.kind) {
    case 'NameExpr':
      return `${qualifierToString(e.qualifier)}${e.name.name}`;
    case 'RecordAccess':
      return `${exprText(e.target)}.${e.member.name}`;
    case 'ChanEnd':
      return `${exprText(e.target)}.${e.end}`;
    case 'ArrayAccess':
      return `${exprText(e.target)}[...]`;
    case 'Literal':
      return e.text;
    case 'Invocation':
      return `${e.target ? exprText(e.target) + '.' : ''}${qualifierToString(e.qualifier)}${e.name.name}(...)`;
    case 'ChanRead':
      return `${exprText(e.target)}.read()`;
    case 'ParenExpr':
      return `(${exprText(e.expr)})`;
    default:
      return 'this expression';
  }
}
