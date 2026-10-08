/**
 * What an FDR report looks like in an editor: diagnostics on the statements
 * that are stuck (derived from the VerificationReport, never computed on
 * their own), a code-lens verdict, and a readable text report with a results
 * table and the step-by-step story of every counterexample.
 */
import type { Span } from '../parser/ast';
import type { CheckOutcome, Counterexample, ProcessRef, ProcessSnapshot, SourceRef, VerificationReport, WaitInfo } from '../verification';
import { samePath } from '../verification';
import { processNames, specErrors, where } from './explain';
import type { FdrRun } from './fdr';
import type { CspModel } from './model';

type Names = (process: ProcessRef) => string;

/** The short names the explanation uses for processes (`branch 1 of delta`); without a model, the report's own (else the labels). */
function namesFor(report: VerificationReport, model: Pick<CspModel, 'sourceMap' | 'target'> | undefined): Names {
  if (!model?.sourceMap) return (p) => p.name ?? p.label;
  const names = processNames(model, report.uri);
  const procs = model.sourceMap.processes;
  return (p) => {
    const i = procs.findIndex((x) => x.process && samePath(x.process.path, p.path));
    return (i >= 0 ? names[i] : undefined) ?? p.name ?? p.label;
  };
}

export interface FdrDiagnostic {
  uri: string;
  span: Span;
  severity: 'error' | 'warning' | 'info';
  /**
   * `fdr/deadlock`, `fdr/partial-deadlock`, `fdr/runtime-error`, `fdr/range`, `fdr/divergence`,
   * `fdr/nondeterminism`, `fdr/assertion`, `fdr/spec-error`, `fdr/not-modelled`.
   */
  code: string;
  message: string;
  related: Array<{ uri: string; span: Span; message: string }>;
  /** The check (CheckOutcome.id) the diagnostic is about. */
  check?: string;
  /** The process it is about, when it is one process's statement (a stuck operation, a runtime error, a loop). */
  process?: ProcessRef;
}

/**
 * Diagnostics for a report: every stuck operation of a deadlock (with the
 * partner that cannot answer it), every operation left waiting for good while
 * other processes run on (a partial deadlock, from the termination check),
 * the site of a runtime error, the loop of a divergence, and a note on the
 * checked procedure for termination, determinism and assertions. Constructs
 * the model cannot express are reported where they are, since no check ran;
 * an error in the user's own CSPm (with `run`, refines' output) is reported
 * at that line of the specification.
 */
export function fdrDiagnostics(report: VerificationReport, model?: Pick<CspModel, 'unsupported' | 'assertions' | 'sourceMap' | 'target'>, run?: Pick<FdrRun, 'errors'> & Partial<Pick<FdrRun, 'results'>>): FdrDiagnostic[] {
  const out: FdrDiagnostic[] = [];
  const names = namesFor(report, model);
  const add = (d: FdrDiagnostic): void => {
    // Several processes stuck at one statement (three reindeer at one write): one diagnostic naming them.
    const same = out.find((x) => x.uri === d.uri && x.code === d.code && sameSpan(x.span, d.span));
    if (!same) out.push(d);
  };
  for (const u of model?.unsupported ?? []) {
    if (!u.at) continue;
    add({ uri: u.at.uri, span: u.at.span, severity: 'warning', code: 'fdr/not-modelled', message: `FDR: not checked, the CSP model cannot express this: ${u.message}`, related: [] });
  }
  // FDR rejected the user's own CSPm: at that line of the specification, not on the program.
  const errors = [...(run?.errors ?? []), ...(run?.results ?? []).flatMap((r) => r.errors)];
  const specs = model?.sourceMap && errors.length ? specErrors(model, errors).filter((e) => e.user && e.at) : [];
  for (const e of specs) add({ uri: e.at!.uri, span: e.at!.span, severity: 'error', code: 'fdr/spec-error', message: `FDR: error in your CSPm specification: ${e.message}`, related: [] });
  // A run that cannot terminate because of a deadlock or an error is already explained where they are.
  const defectFound = report.checks.some((c) => c.status === 'failed' && c.severity !== 'info');
  for (const check of report.checks) {
    const cx = check.counterexample;
    const target = check.target.at;
    if (check.status === 'timeout' || check.status === 'error') {
      // An error in the user's specification is reported on it (above), not on the program.
      if (specs.length && check.status === 'error') continue;
      if (target) add({ uri: target.uri, span: target.span, severity: 'info', code: 'fdr/assertion', message: `FDR: ${check.label}: ${check.message ?? check.status}`, related: [], check: check.id });
      continue;
    }
    if (check.status !== 'failed' || !cx) continue;
    switch (cx.kind) {
      case 'deadlock':
        stuckDiagnostics(report, check, cx, 'error', 'fdr/deadlock', add, names, model?.assertions.find((a) => a.id === check.id)?.at);
        break;
      case 'runtime-error': {
        // A value outside the modelled integers is the model's limit: the program has no error there.
        const range = cx.error?.kind === 'range';
        const code = range ? 'fdr/range' : 'fdr/runtime-error';
        const severity = range ? 'warning' : 'error';
        const when = cx.steps.length ? `after ${cx.steps.length} step${cx.steps.length === 1 ? '' : 's'}` : 'at the start';
        const limit = range ? '; this is where the model stops following the run, not an error of the program: give it more integers with //@csp int lo..hi' : '';
        const failing = cx.final.find((snap) => snap.status === 'error')?.process;
        const about = { check: check.id, ...(failing ? { process: failing } : {}) };
        if (cx.error?.at) {
          add({ uri: cx.error.at.uri, span: cx.error.at.span, severity, code, message: `FDR: ${cx.error.message} (${when})${limit}`, related: lastSteps(report, cx, 3), ...about });
        } else if (target) add({ uri: target.uri, span: target.span, severity, code, message: `FDR: ${cx.summary}${limit}`, related: lastSteps(report, cx, 3), ...about });
        break;
      }
      case 'divergence': {
        const looping = cx.final.filter((s) => s.status === 'diverging' && s.at);
        for (const s of looping) add({ uri: s.at!.uri, span: s.at!.span, severity: 'warning', code: 'fdr/divergence', message: `FDR: ${s.description}`, related: lastSteps(report, cx, 2), check: check.id, process: s.process });
        if (!looping.length && target) add({ uri: target.uri, span: target.span, severity: 'warning', code: 'fdr/divergence', message: `FDR: ${cx.summary}`, related: [], check: check.id });
        // A process left waiting for good beside the loop is a defect of its own.
        partialDeadlockDiagnostics(report, check, cx, add, names);
        break;
      }
      case 'no-termination':
        // Operations left waiting for good while other processes run on are defects of their own.
        if (cx.loopStart !== undefined && partialDeadlockDiagnostics(report, check, cx, add, names)) break;
        if (!defectFound && target) add({ uri: target.uri, span: target.span, severity: 'info', code: 'fdr/assertion', message: `FDR: ${check.label}: ${cx.summary}`, related: lastSteps(report, cx, 2), check: check.id });
        break;
      case 'nondeterminism':
        if (target) add({ uri: target.uri, span: target.span, severity: 'info', code: 'fdr/nondeterminism', message: `FDR: ${cx.summary}`, related: lastSteps(report, cx, 2), check: check.id });
        break;
      default: {
        const at = model?.assertions.find((a) => a.id === check.id)?.at ?? target;
        if (at) add({ uri: at.uri, span: at.span, severity: check.severity === 'info' ? 'info' : 'error', code: 'fdr/assertion', message: `FDR: ${cx.summary}`, related: lastSteps(report, cx, 3), check: check.id });
      }
    }
  }
  return out;
}

/**
 * A run that repeats forever while some process waits for good (its partner is
 * gone, has passed its last use of the channel, or waits in a circle with it):
 * a partial deadlock, on each such operation. Whether anything was reported.
 */
function partialDeadlockDiagnostics(report: VerificationReport, check: CheckOutcome, cx: Counterexample, add: (d: FdrDiagnostic) => void, names: Names): boolean {
  const running = cx.final.filter((s) => s.status === 'running' || s.status === 'diverging').map((s) => names(s.process));
  const meanwhile = running.length ? ` while ${running.length > 1 ? `${running.slice(0, -1).join(', ')} and ${running[running.length - 1]}` : running[0]} ${running.length === 1 ? 'keeps' : 'keep'} running` : '';
  const inCycle = (snap: ProcessSnapshot): boolean => !!cx.cycles?.some((c) => c.length > 1 && c.some((m) => m.process === snap.process));
  const caveat = cx.caveats?.length ? '; the real program may not do this, see the caveats in the report' : '';
  let found = false;
  for (const snap of cx.final) {
    if (snap.status !== 'blocked') continue;
    for (const wait of snap.waits ?? []) {
      if (wait.operation === 'other' || !wait.at) continue;
      const forever = wait.partner?.state === 'terminated' || wait.partner?.state === 'missing' || inCycle(snap);
      if (!forever) continue;
      found = true;
      const related: FdrDiagnostic['related'] = [];
      const partner = cx.final.find((s) => wait.partner?.process && s.process === wait.partner.process);
      if (partner?.at && partner !== snap) related.push({ uri: partner.at.uri, span: partner.at.span, message: partner.description });
      related.push(...lastSteps(report, cx, 2, snap));
      add({
        uri: wait.at.uri,
        span: wait.at.span,
        severity: 'error',
        code: 'fdr/partial-deadlock',
        message: `FDR: this ${operationNoun(wait)} waits forever${meanwhile}: ${wait.partner?.detail ?? 'it waits in a circle'} (a run that never ends, after ${cx.steps.length} step${cx.steps.length === 1 ? '' : 's'}${caveat})`,
        related,
        check: check.id,
        process: snap.process,
      });
    }
  }
  return found;
}

function stuckDiagnostics(report: VerificationReport, check: CheckOutcome, cx: Counterexample, severity: FdrDiagnostic['severity'], code: string, add: (d: FdrDiagnostic) => void, names: Names, assertionAt?: SourceRef): void {
  const steps = cx.steps.length;
  const after = steps ? `deadlock after ${steps} step${steps === 1 ? '' : 's'}` : 'deadlock at the start';
  const byPlace = new Map<string, Array<{ snap: ProcessSnapshot; wait: WaitInfo }>>();
  for (const snap of cx.final) {
    if (snap.status !== 'blocked') continue;
    // A process that reached `stop` waits for nothing: the statement it stopped at is the place.
    if (!snap.waits?.length && snap.at) {
      add({ uri: snap.at.uri, span: snap.at.span, severity, code, message: `FDR: ${snap.description} (${after})`, related: lastSteps(report, cx, 2, snap), check: check.id, process: snap.process });
      byPlace.set(`${snap.at.uri}#stop`, []);
      continue;
    }
    for (const wait of snap.waits ?? []) {
      // A par waiting for its branches is a consequence; the branches carry the explanation.
      if (wait.operation === 'other' || !wait.at) continue;
      const key = `${wait.at.uri}#${wait.at.span.start.line}:${wait.at.span.start.col}`;
      byPlace.set(key, [...(byPlace.get(key) ?? []), { snap, wait }]);
    }
  }
  for (const group of byPlace.values()) {
    if (!group.length) continue;
    const { snap, wait } = group[0];
    const who = group.length > 1 ? ` (in ${group.map((g) => names(g.snap.process)).join(', ')})` : '';
    const caveat = cx.caveats?.length ? '; the real program may not do this, see the caveats in the report' : '';
    // Several processes stuck at one statement: each one's reason, when they differ.
    const reasons = [...new Set(group.map((g) => g.wait.partner?.detail ?? 'no process can complete it'))];
    const why = reasons.length === 1 ? reasons[0] : group.map((g) => `${names(g.snap.process)}: ${g.wait.partner?.detail ?? 'no process can complete it'}`).join('; ');
    const message = `FDR: this ${operationNoun(wait)} waits forever${who}: ${why} (${after}${caveat})`;
    const related: FdrDiagnostic['related'] = [];
    // The other processes of a circular wait, where they wait.
    for (const cycle of cx.cycles ?? []) {
      if (!cycle.some((c) => c.process === snap.process || c.process.label === snap.process.label)) continue;
      for (const member of cycle) {
        const other = cx.final.find((s) => s.process === member.process);
        if (!other || other === snap || !other.at) continue;
        related.push({ uri: other.at.uri, span: other.at.span, message: other.description });
      }
    }
    // The partner, where it is stuck.
    const partner = cx.final.find((s) => wait.partner?.process && s.process === wait.partner.process);
    if (partner?.at && partner !== snap && !related.some((r) => sameSpan(r.span, partner.at!.span))) related.push({ uri: partner.at.uri, span: partner.at.span, message: partner.description });
    related.push(...lastSteps(report, cx, 2, snap));
    add({ uri: wait.at!.uri, span: wait.at!.span, severity, code, message, related, check: check.id, process: snap.process });
  }
  // Nothing is stuck at a statement (a user's `:[deadlock free]` on a program that terminates): on the assertion, or the procedure.
  const at = assertionAt ?? check.target.at;
  if (!byPlace.size && at) add({ uri: at.uri, span: at.span, severity: assertionAt && cx.final.every((s) => s.status === 'terminated') ? 'info' : severity, code: assertionAt ? 'fdr/assertion' : code, message: `FDR: ${cx.summary}`, related: lastSteps(report, cx, 3), check: check.id });
}

/** A run that repeats forever while some process waits for good (see partialDeadlockDiagnostics). */
export function isPartialDeadlock(cx: Counterexample): boolean {
  if (cx.loopStart === undefined) return false;
  return cx.final.some((s) => s.status === 'blocked' && (s.waits ?? []).some((w) => w.operation !== 'other' && (w.partner?.state === 'terminated' || w.partner?.state === 'missing' || !!cx.cycles?.some((c) => c.length > 1 && c.some((m) => m.process === s.process)))));
}

function operationNoun(w: WaitInfo): string {
  switch (w.operation) {
    case 'write':
      return 'write';
    case 'read':
    case 'extended-read':
      return 'read';
    case 'alt-guard':
      return 'alt guard';
    case 'sync':
      return 'barrier sync';
    case 'timeout':
      return 'timeout';
    default:
      return 'statement';
  }
}

/** The last steps of a trace (those of one process when given), as related locations. */
function lastSteps(report: VerificationReport, cx: Counterexample, count: number, of?: ProcessSnapshot): FdrDiagnostic['related'] {
  const out: FdrDiagnostic['related'] = [];
  for (let i = cx.steps.length - 1; i >= 0 && out.length < count; i--) {
    const step = cx.steps[i];
    if (step.kind === 'internal') continue;
    const part = of ? step.participants.find((p) => p.process === of.process) : step.participants.find((p) => p.at);
    if (!part?.at) continue;
    out.push({ uri: part.at.uri, span: part.at.span, message: `step ${step.index + 1}: ${step.description}` });
  }
  return out.reverse().filter((r) => r.uri === report.uri || r.uri.startsWith('file:'));
}

function sameSpan(a: Span, b: Span): boolean {
  return a.start.line === b.start.line && a.start.col === b.start.col && a.end.line === b.end.line && a.end.col === b.end.col;
}

// ---------------------------------------------------------------------------
// Code lens verdicts
// ---------------------------------------------------------------------------

/**
 * One short verdict for a code lens: `FDR: deadlock (6 steps)`, `FDR: no
 * deadlock, 1,204 states`, with what the proof does not cover
 * (`; the compiled program may differ`). A report without a check proves nothing.
 */
export function lensVerdict(report: VerificationReport): string {
  if (!report.checks.length) return 'FDR: not checked';
  const failed = report.checks.find((c) => c.status === 'failed' && c.severity !== 'info');
  // No deadlock of the whole program, but a process waits forever while others run on.
  const partial = !failed ? report.checks.find((c) => c.status === 'failed' && c.counterexample && isPartialDeadlock(c.counterexample)) : undefined;
  if (partial) return `FDR: partial deadlock (${partial.counterexample!.steps.length} step${partial.counterexample!.steps.length === 1 ? '' : 's'})`;
  if (failed) {
    const cx = failed.counterexample;
    const n = cx?.steps.length;
    const steps = n === undefined ? '' : ` (${n} step${n === 1 ? '' : 's'})`;
    switch (cx?.kind) {
      case 'deadlock':
        return `FDR: deadlock${steps}`;
      case 'runtime-error':
        return cx.error?.kind === 'range' ? `FDR: integers out of range${steps}` : `FDR: runtime error${steps}`;
      case 'divergence':
        return 'FDR: divergence';
      default:
        return `FDR: ${failed.label} fails`;
    }
  }
  if (report.checks.some((c) => c.status === 'skipped' && /incomplete/.test(c.message ?? ''))) return 'FDR: not modelled';
  if (report.checks.some((c) => c.status === 'timeout' && outOfMemory(c))) return 'FDR: out of memory';
  if (report.checks.some((c) => c.status === 'timeout')) return 'FDR: timed out';
  if (report.checks.some((c) => c.status === 'cancelled')) return 'FDR: cancelled';
  if (report.checks.some((c) => c.status === 'error')) return 'FDR: error';
  if (report.checks.some((c) => c.status === 'skipped')) return 'FDR: not run';
  const deadlock = report.checks.find((c) => c.property === 'deadlock-free');
  const states = deadlock?.stats?.states;
  const limits = deadlock?.limits?.length ? `; ${deadlock.limits.join('; ')}` : '';
  return `FDR: no deadlock${states !== undefined ? `, ${states.toLocaleString('en-US')} state${states === 1 ? '' : 's'}` : ''}${limits}`;
}

// ---------------------------------------------------------------------------
// Text report
// ---------------------------------------------------------------------------

export interface ReportContext {
  /** The .pj file name. */
  fileName: string;
  /** Where the CSPm model was written for the user, when it was. */
  cspFile?: string;
  model: Pick<CspModel, 'target' | 'intRange' | 'warnings' | 'unsupported' | 'sourceMap'>;
  /** The whole run, wall clock. */
  durationMs?: number;
  /** Where the report's JSON was written. */
  jsonFile?: string;
  /** The text the check was about has changed since: said at the top. */
  stale?: string;
}

/** The report as Markdown-like text (a .pjreport): results table, then each counterexample step by step. */
export function formatFdrReport(report: VerificationReport, ctx: ReportContext): string {
  const lines: string[] = [];
  const names = namesFor(report, ctx.model);
  const target = ctx.model.target.kind === 'program' ? 'the whole program, from main' : `procedure ${ctx.model.target.name} on its own`;
  lines.push(`# FDR check: ${ctx.fileName}`, '');
  if (ctx.stale) lines.push(`**${ctx.stale}**`, '');
  const facts = [
    `Checked: ${target}`,
    `${report.tool?.name ?? 'FDR'}${report.tool?.version ? ` ${report.tool.version}` : ''}`,
    `integers ${ctx.model.intRange.lo}..${ctx.model.intRange.hi}`,
    ...(ctx.durationMs !== undefined ? [`${seconds(ctx.durationMs)} in all`] : []),
  ];
  lines.push(facts.join(' · '), '');
  if (ctx.cspFile) lines.push(`CSPm model: ${ctx.cspFile}`, '');
  lines.push('| Check | Result | States | Transitions | Time |', '| --- | --- | --- | --- | --- |');
  for (const c of report.checks) {
    const label = `${c.label}${c.severity === 'info' ? ' (informational)' : ''}`;
    lines.push(`| ${cell(label)} | ${cell(verdictText(c))} | ${c.stats?.states?.toLocaleString('en-US') ?? ''} | ${c.stats?.transitions?.toLocaleString('en-US') ?? ''} | ${c.stats?.ms !== undefined ? seconds(c.stats.ms) : ''} |`);
  }
  lines.push('');
  const defect = report.checks.find((c) => c.status === 'failed' && c.severity !== 'info');
  for (const c of report.checks) {
    const cx = c.counterexample;
    if (!cx) continue;
    lines.push(`## ${c.label}${c.severity === 'info' ? ' (informational)' : ''}`, '', cx.summary, '');
    for (const caveat of cx.caveats ?? []) lines.push(`Caveat: ${caveat}.`, '');
    if (c.property === 'terminates' && defect && cx.loopStart === undefined) {
      // A run that cannot finish because it gets stuck or fails is the defect already told above.
      lines.push(`Every deadlock or runtime error (and every run the model stops following) is also a run that does not terminate: see ${defect.label} above.`, '');
      continue;
    }
    if (cx.error) lines.push(`${cx.error.kind === 'range' ? 'Out of the modelled integers (the model stops following the run here; //@csp int lo..hi gives it more)' : 'Runtime error'}: ${cx.error.message}${cx.error.at ? ` (${where(cx.error.at, report.uri)})` : ''}`, '');
    lines.push('### Where every process ends up', '');
    for (const s of cx.final) {
      lines.push(`- **${s.status}**: ${s.description}`);
      for (const w of s.waits ?? []) if (w.partner) lines.push(`  - ${w.detail}: ${w.partner.detail}`);
    }
    lines.push('');
    if (cx.cycles?.length) {
      lines.push('### Circular waits', '');
      for (const cycle of cx.cycles) {
        const hops = cycle.map((m) => `${names(m.process)}${m.channel ? ` -(${m.channel.name})->` : ' ->'}`);
        lines.push(`- ${hops.join(' ')} ${names(cycle[0].process)}`);
      }
      lines.push('');
    }
    lines.push('### Steps', '');
    if (!cx.steps.length) lines.push('(none: the problem is there from the start)');
    for (const step of cx.steps) {
      const loop = cx.loopStart !== undefined && step.index === cx.loopStart ? ' **← from here on, the steps repeat forever**' : '';
      const text = step.kind === 'internal' ? `*${step.description}*` : step.description;
      lines.push(`${step.index + 1}. ${text}${loop}`);
    }
    lines.push('');
  }
  const notes = report.checks.filter((c) => !c.counterexample && c.status !== 'passed' && c.message);
  if (notes.length) {
    lines.push('## Notes', '');
    for (const c of notes) lines.push(`- ${c.label}: ${c.message}`);
    lines.push('');
  }
  lines.push('## What the model assumes', '');
  for (const a of report.assumptions) lines.push(`- ${a}`);
  lines.push('');
  if (ctx.jsonFile) lines.push(`The full report (src/verification.ts format) is in ${ctx.jsonFile}.`, '');
  return lines.join('\n');
}

function verdictText(c: CheckOutcome): string {
  switch (c.status) {
    case 'passed':
      return `✓ ${c.message ?? 'holds'}`;
    case 'failed':
      return `✗ ${c.counterexample ? shortSummary(c, c.counterexample) : c.message ?? 'fails'}`;
    case 'timeout':
      return outOfMemory(c) ? '⏱ out of memory' : '⏱ timed out';
    case 'cancelled':
      return 'cancelled';
    case 'skipped':
      return `– ${c.message ?? 'skipped'}`;
    default:
      return `! ${c.message ?? 'error'}`;
  }
}

/** A check stopped because refines used more memory than allowed (fdr.ts' watchdog), not because time ran out. */
function outOfMemory(c: CheckOutcome): boolean {
  return /^FDR was stopped after using more than /.test(c.message ?? '');
}

function shortSummary(c: CheckOutcome, cx: Counterexample): string {
  // A user's assertion is named in its summary (`MAIN :[has trace]: <a.1> fails ...`): keep what follows.
  const summary = cx.summary.startsWith(c.label) ? cx.summary.slice(c.label.length).trim() : cx.summary;
  const i = summary.indexOf(': ');
  return i > 0 ? summary.slice(0, i) : summary;
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function seconds(ms: number): string {
  return ms < 1000 ? `${(ms / 1000).toFixed(2)} s` : ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

/** Re-export for callers that place diagnostics themselves. */
export type { SourceRef };
