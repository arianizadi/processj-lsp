import type * as A from './parser/ast';
import type { CheckResult, ChannelFact, VarInfo } from './checker/checker';
import type { EffectAnalysis, ProcedureEffectSummary } from './checker/effects';
import { typeStr } from './checker/types';

export interface ChannelInlay {
  position: A.Pos;
  label: string;
  tooltip: string;
  variable: VarInfo;
}

/**
 * One compact hint per channel declaration/parameter. Operation sites remain
 * uncluttered; the tooltip contains counts and uncertainty details.
 */
export function channelInlays(program: A.Program, checked: CheckResult, effects?: EffectAnalysis, range?: A.Span): ChannelInlay[] {
  const facts = new Map<VarInfo, ChannelFact>(checked.channels.map((fact) => [fact.variable, fact]));
  const procEffects = new Map<A.ProcDecl, ProcedureEffectSummary>();
  const proceduresByName = new Map<string, A.ProcDecl[]>();
  for (const decl of program.decls) if (decl.kind === 'ProcDecl') {
    const procedures = proceduresByName.get(decl.name.name);
    if (procedures) procedures.push(decl);
    else proceduresByName.set(decl.name.name, [decl]);
    const summary = effects?.get(decl);
    if (summary) procEffects.set(decl, summary);
  }

  const out: ChannelInlay[] = [];
  for (const variable of checked.vars) {
    if (variable.type.k !== 'chan' || !positionInside(variable.decl.span.end, range)) continue;
    const fact = facts.get(variable);
    const procedure = findProcedure(proceduresByName, variable);
    const summary = procedure ? procEffects.get(procedure) : undefined;
    const parameterIndex = procedure?.params.findIndex((p) => p.name === variable.decl) ?? -1;
    const reads = fact?.operations.filter((op) => op.end === 'read' && op.direct).length ?? 0;
    const writes = fact?.operations.filter((op) => op.end === 'write' && op.direct).length ?? 0;
    const passed = fact?.operations.filter((op) => !op.direct).length ?? 0;
    const directRead = parameterIndex >= 0 && !!summary?.direct.channelReads.has(parameterIndex);
    const directWrite = parameterIndex >= 0 && !!summary?.direct.channelWrites.has(parameterIndex);
    const transitiveRead = parameterIndex >= 0 && !!summary?.transitive.channelReads.has(parameterIndex) && !directRead;
    const transitiveWrite = parameterIndex >= 0 && !!summary?.transitive.channelWrites.has(parameterIndex) && !directWrite;

    const pieces: string[] = [role(variable)];
    if (reads || writes) pieces.push(`${count(reads, 'read')}, ${count(writes, 'write')}`);
    else {
      if (directRead || directWrite) pieces.push(`${[directRead ? 'read' : '', directWrite ? 'write' : ''].filter(Boolean).join('+')} directly`);
      if (transitiveRead || transitiveWrite) pieces.push(`${[transitiveRead ? 'read' : '', transitiveWrite ? 'write' : ''].filter(Boolean).join('+')} transitively`);
    }
    if (fact?.branchCount) pieces.push(`${fact.branchCount} ${fact.branchCount === 1 ? 'branch' : 'branches'}`);
    if (fact?.escaped || passed || summary?.transitive.unknown) pieces.push(summary?.transitive.unknown ? 'partly unknown' : 'escapes');
    if (fact?.hazard) pieces.push(`⚠ ${fact.hazard.replaceAll('-', ' ')}`);

    const detail: string[] = [`Declared as ${typeStr(variable.type)}.`];
    if (reads || writes) detail.push(`Direct traffic in this procedure: ${count(reads, 'read')} and ${count(writes, 'write')}.`);
    if (directRead || directWrite) detail.push(`This procedure directly uses the parameter for ${directRead && directWrite ? 'reading and writing' : directRead ? 'reading' : 'writing'}.`);
    if (transitiveRead || transitiveWrite) detail.push(`A called procedure uses this parameter for ${transitiveRead && transitiveWrite ? 'reading and writing' : transitiveRead ? 'reading' : 'writing'}.`);
    if (fact?.escaped || passed) detail.push('An endpoint is passed onward or the whole channel is used opaquely, so downstream topology is conservative.');
    if (summary?.transitive.unknown) detail.push('Some call or channel-resource binding is opaque, so downstream topology is conservative.');
    if (fact?.hazard === 'no-writer') detail.push('A blocking read has no reachable writer in this procedure.');
    if (fact?.hazard === 'no-reader') detail.push('A blocking write has no reachable reader in this procedure.');
    if (fact?.hazard === 'self-deadlock') detail.push('Both rendezvous endpoints are used sequentially by the same process.');

    out.push({ position: variable.decl.span.end, label: `⇢ ${pieces.join(' · ')}`, tooltip: detail.join(' '), variable });
  }
  return out;
}

function findProcedure(proceduresByName: ReadonlyMap<string, readonly A.ProcDecl[]>, variable: VarInfo): A.ProcDecl | undefined {
  const candidates = proceduresByName.get(variable.proc) ?? [];
  return candidates.find((d) => d.params.some((p) => p.name === variable.decl) || (!!d.body && contains(d.body.span, variable.decl.span.start)));
}

function role(variable: VarInfo): string {
  const type = variable.type;
  if (type.k !== 'chan') return 'channel';
  if (type.end) return `${type.shared ? 'shared ' : ''}${type.end} endpoint`;
  if (!type.shared) return 'exclusive';
  if (type.sharedSide) return `shared-${type.sharedSide}`;
  return 'shared read+write';
}

function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? '' : 's'}`;
}

function positionInside(position: A.Pos, range: A.Span | undefined): boolean {
  if (!range) return true;
  // LSP ranges are end-exclusive, and every returned hint position must be in
  // the requested viewport rather than merely have a declaration overlapping it.
  return compare(position, range.start) >= 0 && compare(position, range.end) < 0;
}

function contains(span: A.Span, position: A.Pos): boolean {
  return compare(span.start, position) <= 0 && compare(position, span.end) <= 0;
}

function compare(a: A.Pos, b: A.Pos): number {
  return a.line - b.line || a.col - b.col;
}
