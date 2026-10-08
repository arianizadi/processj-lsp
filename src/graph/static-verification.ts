/**
 * The checker's proven concurrency facts as a VerificationReport, so the graph
 * shows stuck processes without FDR:
 *
 * - every straight-line par deadlock (DeadlockFact) becomes a failed deadlock
 *   check whose final state names each blocked branch, the operation it waits
 *   on, and why its partner can never come (finished, waiting elsewhere, or
 *   missing), with the cycle when the waits are circular;
 * - every channel hazard (no writer, no reader, both ends in one process)
 *   becomes a "this read/write waits forever" check.
 *
 * Nothing here is new analysis: the checker proved each fact, and the wording
 * says exactly what it proved. Static analysis has no traces, so `steps` is
 * empty, and the report never claims deadlock freedom.
 */
import type * as A from '../parser/ast';
import type { ChannelFact, CheckResult, DeadlockFact, VarInfo } from '../checker/checker';
import type { ChannelRef, CheckOutcome, ProcessRef, ProcessSnapshot, VerificationReport, WaitInfo } from '../verification';
import { branchStep, findOperations, visitStatement, type NetNode, type NetworkModel, type NetworkView } from './network';

export interface StaticReportOptions {
  uri: string;
  documentVersion?: number;
  /** Network of the same analysis: process paths and names come from it. */
  model: NetworkModel;
  /** Server version, for `tool`. */
  version?: string;
}

export const STATIC_ASSUMPTIONS: readonly string[] = Object.freeze([
  'Static analysis by the language server\'s checker, not a model check.',
  'A par deadlock is reported only when every legal rendezvous order of its straight-line branches gets stuck; a par with loops, alts, conditions or calls in a branch is not analysed, so no result here is not a proof of deadlock freedom.',
  'Each failure holds whenever the reported par or statement is reached; whether the program reaches it is not checked.',
]);

/** Build the checker's report for one document. */
export function staticVerificationReport(program: A.Program, checked: CheckResult, options: StaticReportOptions): VerificationReport {
  const checks: CheckOutcome[] = [];
  const procedures = program.decls.filter((decl): decl is A.ProcDecl => decl.kind === 'ProcDecl' && !!decl.body);
  for (const fact of checked.deadlocks) {
    const owner = procedures.find((decl) => contains(decl.span, fact.par.span));
    if (owner) checks.push(deadlockOutcome(fact, owner, checked, options));
  }
  for (const fact of checked.channels) {
    if (!fact.hazard) continue;
    const outcome = hazardOutcome(fact, checked, options);
    if (outcome) checks.push(outcome);
  }
  return {
    version: 1,
    producer: 'checker',
    uri: options.uri,
    documentVersion: options.documentVersion,
    tool: { name: 'processj-lsp checker', version: options.version },
    assumptions: [...STATIC_ASSUMPTIONS],
    checks,
  };
}

/** The view whose root is `decl`: the program view for main, else its own. */
function viewOf(model: NetworkModel, decl: A.ProcDecl): NetworkView | undefined {
  return model.views.find((view) => view.procedure === decl.name.name && view.source.span.start.line === decl.name.span.start.line && view.source.span.start.col === decl.name.span.start.col);
}

function target(decl: A.ProcDecl, uri: string): CheckOutcome['target'] {
  return decl.name.name === 'main'
    ? { kind: 'program', name: 'main', at: { uri, span: decl.name.span } }
    : { kind: 'procedure', name: decl.name.name, at: { uri, span: decl.name.span } };
}

function channelRef(variable: VarInfo, uri: string): ChannelRef {
  const barrier = variable.type.k === 'prim' && variable.type.name === 'barrier';
  // The channels the checker reasons about are locals of the checked procedure: owned by its root.
  return { name: variable.name, kind: barrier ? 'barrier' : 'channel', declaration: { uri, span: variable.decl.span }, owner: [] };
}

interface Operation {
  kind: 'read' | 'write';
  channel: VarInfo;
  span: A.Span;
}

function deadlockOutcome(fact: DeadlockFact, owner: A.ProcDecl, checked: CheckResult, options: StaticReportOptions): CheckOutcome {
  const uri = options.uri;
  const view = viewOf(options.model, owner);
  const branches = fact.par.body.stmts;
  const line = fact.par.span.start.line + 1;
  // Each branch is straight-line code (that is what the checker simulates): its
  // operations in evaluation order, and where the wait sits among them.
  const operations = branches.map((branch) => straightLineOperations(branch, checked));
  const waitOf = new Map(fact.waits.map((wait) => [wait.branch, wait]));
  const headOf = (branch: number): number => {
    const wait = waitOf.get(branch);
    if (!wait) return operations[branch - 1].length;
    const index = operations[branch - 1].findIndex((op) => sameSpan(op.span, wait.span));
    return index < 0 ? 0 : index;
  };
  const refs = branches.map((statement, index) => processRef(view, statement, index + 1, uri));
  const opposite = (kind: 'read' | 'write'): 'read' | 'write' => kind === 'read' ? 'write' : 'read';
  /** Branches other than `branch` whose remaining work can still meet this wait. */
  const peers = (branch: number, kind: 'read' | 'write', channel: VarInfo): number[] => {
    const out: number[] = [];
    for (let other = 1; other <= branches.length; other++) {
      if (other === branch) continue;
      const remaining = operations[other - 1].slice(headOf(other));
      if (remaining.some((op) => op.channel === channel && op.kind === opposite(kind))) out.push(other);
    }
    return out;
  };

  // A wait's partner when exactly one branch could still meet it: the links of a circular wait.
  const partnerOf = new Map<number, number>();
  const reachOf = new Map<number, number[]>();
  const final: ProcessSnapshot[] = branches.map((statement, index) => {
    const branch = index + 1;
    const ref = refs[index];
    const wait = waitOf.get(branch);
    if (!wait) {
      const finished = fact.finishedBranches.includes(branch);
      return { process: ref, status: finished ? 'terminated' : 'unknown', at: finished ? undefined : { uri, span: statement.span }, description: finished ? `${ref.label} has finished` : `${ref.label}: state not determined by the checker` };
    }
    const reach = peers(branch, wait.operation, wait.channel);
    reachOf.set(branch, reach);
    let partner: WaitInfo['partner'];
    if (reach.length) {
      if (reach.length === 1) partnerOf.set(branch, reach[0]);
      const other = waitOf.get(reach[0]);
      const names = reach.map((entry) => refs[entry - 1].label);
      partner = {
        process: reach.length === 1 ? refs[reach[0] - 1] : undefined,
        state: 'blocked-elsewhere',
        detail: other
          ? `${names.join(' and ')} would ${opposite(wait.operation)} '${wait.channel.name}' later, but ${reach.length === 1 ? `is waiting to ${other.operation} '${other.channel.name}' first` : 'each waits on something else first'}`
          : `${names.join(' and ')} would ${opposite(wait.operation)} '${wait.channel.name}' later`,
      };
    } else {
      // No unfinished branch can still meet it. A finished branch that did the other side is
      // the partner that left, when it is the only one; otherwise say only what is proved.
      const finishedPartners = fact.finishedBranches.filter((other) => other !== branch && operations[other - 1].some((op) => op.channel === wait.channel && op.kind === opposite(wait.operation)));
      const missing = `no unfinished branch can still ${opposite(wait.operation)} '${wait.channel.name}'`;
      partner = finishedPartners.length === 1
        ? { process: refs[finishedPartners[0] - 1], state: 'terminated', detail: `${refs[finishedPartners[0] - 1].label}, which ${opposite(wait.operation) === 'read' ? 'read' : 'wrote'} '${wait.channel.name}', has finished; ${missing}` }
        : { state: 'missing', detail: missing };
    }
    const at = { uri, span: wait.span };
    return {
      process: ref,
      status: 'blocked',
      at,
      waits: [{ operation: wait.operation, channel: channelRef(wait.channel, uri), at, detail: `waits to ${wait.operation} '${wait.channel.name}'`, partner }],
      description: `${ref.label} waits to ${wait.operation} '${wait.channel.name}' at line ${wait.span.start.line + 1}`,
    };
  });

  // A circular wait can sit beside a missing partner (two crossed branches next to a lone writer).
  const cycles = circularWaits(fact, partnerOf, refs, uri);
  const blocked = fact.waits.map((wait) => `${refs[wait.branch - 1].label} waits to ${wait.operation} '${wait.channel.name}'`);
  // The root causes are the waits nothing can meet any more; the others wait on a stuck branch.
  const missing = fact.waits.filter((wait) => !reachOf.get(wait.branch)?.length);
  const behind = fact.waits.filter((wait) => reachOf.get(wait.branch)?.length);
  const unique = (texts: string[]): string[] => texts.filter((text, index, all) => all.indexOf(text) === index);
  const why = fact.cause === 'circular-wait' || !missing.length
    ? fact.waits.length === 2 ? 'neither can reach the operation the other needs' : 'each waits for the next one in a circle'
    : [
      `nothing can still ${unique(missing.map((wait) => `${opposite(wait.operation)} '${wait.channel.name}'`)).join(' or ')}`,
      ...behind.map((wait) => `${refs[wait.branch - 1].label} waits on ${reachOf.get(wait.branch)!.map((other) => refs[other - 1].label).join(' or ')}`),
    ].join('; ');
  const finished = fact.finishedBranches.length ? `; ${fact.finishedBranches.map((branch) => refs[branch - 1].label).join(', ')} finished` : '';
  return {
    id: `checker:deadlock:${fact.par.span.start.line}:${fact.par.span.start.col}`,
    property: 'deadlock-free',
    label: 'Deadlock freedom',
    target: target(owner, uri),
    status: 'failed',
    severity: 'error',
    message: `Proved by the static checker: every legal order of the rendezvous in the par at line ${line} gets stuck.`,
    counterexample: {
      kind: 'deadlock',
      steps: [],
      final,
      cycles: cycles?.length ? cycles : undefined,
      summary: `deadlock when the par at line ${line} runs: ${blocked.length > 2 ? `${blocked.slice(0, -1).join(', ')} and ${blocked[blocked.length - 1]}` : blocked.join(' while ')}${finished}; ${why}`,
    },
  };
}

/** Follow each blocked branch to the one branch it waits for; report every loop whose links are all unambiguous. */
function circularWaits(fact: DeadlockFact, partnerOf: Map<number, number>, refs: ProcessRef[], uri: string): NonNullable<NonNullable<CheckOutcome['counterexample']>['cycles']> {
  const waitOf = new Map(fact.waits.map((wait) => [wait.branch, wait]));
  const cycles: NonNullable<NonNullable<CheckOutcome['counterexample']>['cycles']> = [];
  const seen = new Set<string>();
  for (const { branch: start } of fact.waits) {
    const order: number[] = [];
    for (let branch: number | undefined = start; branch !== undefined && !order.includes(branch); branch = partnerOf.get(branch)) {
      if (!waitOf.has(branch)) break;
      order.push(branch);
    }
    const loopStart = order.indexOf(partnerOf.get(order[order.length - 1]) ?? -1);
    if (loopStart < 0 || order.length - loopStart < 2) continue;
    const loop = order.slice(loopStart);
    // The same loop found from another of its branches: start it at its lowest branch.
    const first = loop.indexOf(Math.min(...loop));
    const rotated = [...loop.slice(first), ...loop.slice(0, first)];
    const key = rotated.join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    cycles.push(rotated.map((branch) => ({ process: refs[branch - 1], channel: channelRef(waitOf.get(branch)!.channel, uri) })));
  }
  return cycles;
}

/** The process of the `index`-th branch, as the network names and paths it. */
function processRef(view: NetworkView | undefined, statement: A.Stmt, index: number, uri: string): ProcessRef {
  const node = view?.nodes.find((entry) => {
    const last = entry.path?.[entry.path.length - 1];
    return last?.kind === 'branch' && last.index === index && last.site.uri === uri && sameSpan(last.site.span, statement.span);
  });
  if (node?.path) return { path: node.path, label: node.name, procedure: node.call?.procedure };
  // Not drawn (unreachable in the walk): the branch directly under the root.
  return { path: [branchStep(statement, index, uri)], label: `branch ${index}` };
}

function hazardOutcome(fact: ChannelFact, checked: CheckResult, options: StaticReportOptions): CheckOutcome | undefined {
  const uri = options.uri;
  const variable = fact.variable;
  const name = variable.name;
  const at = fact.hazardAt ? operationAt(fact.procedure, fact.hazardAt, checked) : undefined;
  if (!at) return undefined;
  const view = viewOf(options.model, fact.procedure);
  const placed = view ? findOperations(view, { uri, span: at.span }).find((entry) => entry.operation.at.uri === uri) : undefined;
  const node: NetNode | undefined = placed?.node;
  const process: ProcessRef = node?.path ? { path: node.path, label: node.name, procedure: node.call?.procedure } : { path: [], label: fact.procedure.name.name };
  const operation = at.kind;
  const line = at.span.start.line + 1;
  const where = fact.procedure.name.name;
  let partner: WaitInfo['partner'];
  let label: string;
  let reason: string;
  switch (fact.hazard) {
    case 'no-writer':
      label = `Read of '${name}' completes`;
      reason = `nothing in ${where} ever writes '${name}' or passes it to another process`;
      partner = { state: 'missing', detail: reason };
      break;
    case 'no-reader':
      label = `Write of '${name}' completes`;
      reason = `nothing in ${where} ever reads '${name}' or passes it to another process`;
      partner = { state: 'missing', detail: reason };
      break;
    default: {
      label = `'${name}' has a partner process`;
      const other = otherSide(fact, at.kind);
      reason = `the only ${at.kind === 'write' ? 'reader' : 'writer'} of '${name}' is this same process${other ? ` (line ${other.start.line + 1})` : ''}, which cannot get there`;
      partner = { process, state: 'blocked-elsewhere', detail: reason };
      break;
    }
  }
  const atRef = { uri, span: at.span };
  return {
    id: `checker:${fact.hazard}:${at.span.start.line}:${at.span.start.col}`,
    property: 'custom',
    label,
    target: target(fact.procedure, uri),
    status: 'failed',
    severity: 'warning',
    message: `Proved by the static checker: if line ${line} is reached, this ${operation} waits forever.`,
    counterexample: {
      kind: 'deadlock',
      steps: [],
      final: [{
        process,
        status: 'blocked',
        at: atRef,
        waits: [{ operation, channel: channelRef(variable, uri), at: atRef, detail: `waits to ${operation} '${name}'`, partner }],
        description: `${process.label} waits forever to ${operation} '${name}' at line ${line}`,
      }],
      summary: `${name}.${operation}() at line ${line} waits forever: ${reason}`,
    },
  };
}

/** The read or write expression whose channel name is at `nameSpan`. */
function operationAt(decl: A.ProcDecl, nameSpan: A.Span, checked: CheckResult): { kind: 'read' | 'write'; span: A.Span } | undefined {
  let found: { kind: 'read' | 'write'; span: A.Span } | undefined;
  visitStatement(decl.body!, {
    expr(expr) {
      if (found || (expr.kind !== 'ChanRead' && expr.kind !== 'ChanWrite')) return;
      const root = channelRoot(expr.target);
      if (root && sameSpan(root.span, nameSpan) && checked.resolutions.get(root)) found = { kind: expr.kind === 'ChanRead' ? 'read' : 'write', span: expr.span };
    },
  });
  return found;
}

/** The first direct use of the other side, for the self-deadlock explanation. */
function otherSide(fact: ChannelFact, side: 'read' | 'write'): A.Span | undefined {
  return fact.operations.find((op) => op.direct && op.end !== side)?.span;
}

/** Channel operations of straight-line code in evaluation order (a write after the value it sends). */
function straightLineOperations(statement: A.Stmt, checked: CheckResult): Operation[] {
  const out: Operation[] = [];
  const expr = (e: A.Expr | undefined): void => {
    if (!e) return;
    switch (e.kind) {
      case 'ChanWrite': {
        expr(e.value);
        const variable = channelVariable(e.target, checked);
        if (variable) out.push({ kind: 'write', channel: variable, span: e.span });
        return;
      }
      case 'ChanRead': {
        const variable = channelVariable(e.target, checked);
        if (variable) out.push({ kind: 'read', channel: variable, span: e.span });
        return;
      }
      case 'ParenExpr': case 'CastExpr': case 'IsExpr': return expr(e.expr);
      case 'BinaryExpr': expr(e.left); expr(e.right); return;
      case 'UnaryExpr': return expr(e.operand);
      case 'AssignExpr': if (e.target.kind !== 'NameExpr') expr(e.target); expr(e.value); return;
      case 'TernaryExpr': expr(e.cond); return;
      case 'Invocation': e.args.forEach(expr); return;
      case 'RecordAccess': return expr(e.target);
      case 'ArrayAccess': expr(e.target); expr(e.index); return;
      case 'NewArray': e.dimExprs.forEach(expr); return;
      case 'ArrayLiteral': e.elements.forEach(expr); return;
      case 'RecordLiteral': case 'ProtocolLiteral': e.fields.forEach((field) => expr(field.value)); return;
      default: return;
    }
  };
  const stmt = (s: A.Stmt): void => {
    if (s.kind === 'Block') s.stmts.forEach(stmt);
    else if (s.kind === 'ExprStmt') expr(s.expr);
    else if (s.kind === 'LocalDecl') s.declarators.forEach((declarator) => expr(declarator.init));
  };
  stmt(statement);
  return out;
}

function channelVariable(target: A.Expr, checked: CheckResult): VarInfo | undefined {
  const root = channelRoot(target);
  const variable = root ? checked.resolutions.get(root) : undefined;
  return variable?.type.k === 'chan' ? variable : undefined;
}

function channelRoot(target: A.Expr): A.NameExpr | undefined {
  while (target.kind === 'ParenExpr' || target.kind === 'CastExpr' || target.kind === 'ChanEnd') target = target.kind === 'ChanEnd' ? target.target : target.expr;
  return target.kind === 'NameExpr' ? target : undefined;
}

function contains(outer: A.Span, inner: A.Span): boolean {
  const before = (a: A.Pos, b: A.Pos): boolean => a.line < b.line || (a.line === b.line && a.col <= b.col);
  return before(outer.start, inner.start) && before(inner.end, outer.end);
}

function sameSpan(a: A.Span, b: A.Span): boolean {
  return a.start.line === b.start.line && a.start.col === b.start.col && a.end.line === b.end.line && a.end.col === b.end.col;
}
