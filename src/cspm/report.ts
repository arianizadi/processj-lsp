/**
 * FDR's results on a CSPm file as plain text (the report the editor opens
 * when the graph is not wanted), and as diagnostics on the file: each failed
 * or unchecked assertion at its line, and where the processes of a
 * counterexample are stuck. Pure functions of a VerificationReport.
 */
import type { CheckOutcome, VerificationReport } from '../verification';
import type { Span } from './ast';

export interface CspmFdrDiagnostic {
  span: Span;
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** The check it is about (for "show in graph"). */
  check?: string;
}

const STATUS: Record<CheckOutcome['status'], string> = {
  passed: 'holds',
  failed: 'FAILS',
  error: 'error',
  timeout: 'not finished',
  cancelled: 'cancelled',
  skipped: 'not checked',
};

/** The text report of an FDR run on a .csp file. */
export function formatCspmReport(report: VerificationReport, ctx: { fileName: string; durationMs?: number; jsonFile?: string; stale?: string }): string {
  const lines: string[] = [];
  lines.push(`FDR${report.tool?.version ? ` ${report.tool.version}` : ''} on ${ctx.fileName}${ctx.durationMs !== undefined ? ` (${(ctx.durationMs / 1000).toFixed(1)} s)` : ''}`);
  if (ctx.stale) lines.push('', ctx.stale);
  lines.push('');
  const width = Math.max(10, ...report.checks.map((check) => check.label.length));
  for (const check of report.checks) {
    const stats = check.stats?.states !== undefined ? `  ${check.stats.states.toLocaleString('en-US')} states` : '';
    lines.push(`${check.label.padEnd(width)}  ${STATUS[check.status]}${stats}`);
  }
  if (!report.checks.length) lines.push('This file has no assertions: there is nothing for FDR to check.');
  for (const check of report.checks) {
    if (check.status === 'passed') continue;
    lines.push('', `${check.id}: ${check.label}`, `  ${check.message ?? STATUS[check.status]}`);
    const cx = check.counterexample;
    if (!cx) continue;
    if (cx.steps.length) {
      lines.push('', '  Run:');
      for (const step of cx.steps) lines.push(`    ${String(step.index + 1).padStart(3)}. ${step.event}${step.visible === false ? ' (hidden)' : ''}  ${step.description}${cx.loopStart !== undefined && step.index === cx.loopStart ? '   <- from here on, repeats forever' : ''}`);
    }
    if (cx.final.length) {
      lines.push('', '  At the end:');
      for (const snapshot of cx.final) lines.push(`    ${snapshot.description}${snapshot.at ? ` (line ${snapshot.at.span.start.line + 1})` : ''}`);
    }
    for (const cycle of cx.cycles ?? []) lines.push('', `  Circular wait: ${[...cycle, cycle[0]].map((entry) => entry.process.label).join(' -> ')}`);
  }
  if (report.assumptions.length) lines.push('', 'Notes:', ...report.assumptions.map((note) => `  - ${note}`));
  if (ctx.jsonFile) lines.push('', `The report as JSON: ${ctx.jsonFile}`);
  return `${lines.join('\n')}\n`;
}

/** Diagnostics for a report: each assertion that failed or was not checked, and where its processes are stuck. */
export function cspmFdrDiagnostics(report: VerificationReport, assertionSpans: ReadonlyMap<string, Span>): CspmFdrDiagnostic[] {
  const out: CspmFdrDiagnostic[] = [];
  for (const check of report.checks) {
    const span = assertionSpans.get(check.id);
    if (!span) continue;
    // The diagnostic's source is FDR: the message does not say it again.
    if (check.status === 'failed') out.push({ span, severity: check.severity, message: `${check.label} does not hold: ${check.message ?? ''}`.trim(), check: check.id });
    else if (check.status === 'error' || check.status === 'timeout') out.push({ span, severity: 'warning', message: `could not check ${check.label}: ${check.message ?? check.status}`, check: check.id });
    const cx = check.counterexample;
    if (!cx || check.status !== 'failed') continue;
    // Where the processes are stuck, one diagnostic per place (three philosophers at the same prefix are one).
    const places = new Map<string, { span: Span; status: string; who: string[]; what: string[] }>();
    for (const snapshot of cx.final) {
      const telling = snapshot.status === 'blocked' || snapshot.status === 'diverging' || (snapshot.status === 'running' && /does not allow|refuse it/.test(snapshot.description));
      const at = snapshot.at;
      if (!telling || !at || at.uri !== report.uri) continue;
      const key = `${at.span.start.line}:${at.span.start.col}:${snapshot.status}`;
      const place = places.get(key) ?? { span: at.span, status: snapshot.status, who: [], what: [] };
      place.who.push(snapshot.process.label);
      if (snapshot.status === 'blocked') place.what.push(...(snapshot.waits?.length ? snapshot.waits.map((wait) => wait.detail.replace(/^waits to /, '')) : ['offer anything']));
      else place.what.push(snapshot.description.startsWith(snapshot.process.label) ? snapshot.description.slice(snapshot.process.label.length).trim() : snapshot.description);
      places.set(key, place);
    }
    const line = (assertionSpans.get(check.id)?.start.line ?? 0) + 1;
    for (const place of places.values()) {
      const what = [...new Set(place.what)];
      const who = listText(place.who);
      const message = place.status === 'blocked'
        ? `${who} ${place.who.length === 1 ? 'is' : 'are'} stuck here, waiting to ${what.slice(0, 4).join(', ')}${what.length > 4 ? ', …' : ''}`
        : place.status === 'diverging' ? `${who} can take internal steps here forever` : `${who} ${what[0]}`;
      out.push({ span: place.span, severity: 'info', message: `${message} (${check.label}, line ${line})`, check: check.id });
    }
  }
  return out;
}

function listText(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length > 4) return `${items.slice(0, 3).join(', ')} and ${items.length - 3} more`;
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
