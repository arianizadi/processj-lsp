/**
 * A message sequence chart of a counterexample: one lifeline per process, an
 * arrow from writer to reader for every communication (labelled channel.value),
 * a bar across the enrolled lifelines for a barrier sync, an end cap where a
 * process terminates (after its last step, when it ends without a step of its
 * own), and the end state: a red cross where a process is stuck for good with
 * the operation it waits on, an amber mark where a run that repeats forever
 * only leaves it waiting. Rows carry `data-step` so the viewer can follow its
 * timeline cursor; the whole chart exports as a standalone SVG.
 */
import { FONT_STACK, textWidth } from './layout';
import { truncate } from './network';
import { escapeXml, num } from './svg';
import type { Counterexample, ProcessPath, ProcessRef, ProcessSnapshot, TraceStep } from '../verification';
import { snapshotBadge, stuckForGood } from './overlay';

export interface MscOptions {
  title?: string;
  /** Plain light colours (files) or `--pj-*` custom properties with light fallbacks (viewer). */
  themed?: boolean;
  /** Rows beyond this are summarised (default 400). */
  maxSteps?: number;
}

const ROW = 34;
const HEAD = 46;
const LEFT = 56;

/** Light colours of the chart; the viewer redefines `--pj-msc-<name>` for dark themes. */
export const MSC_COLORS = {
  bg: '#ffffff',
  text: '#0f172a',
  muted: '#64748b',
  faint: '#cbd5e1',
  line: '#94a3b8',
  arrow: '#334155',
  head: '#f1f5f9',
  barrier: '#b45309',
  danger: '#dc2626',
  wait: '#b45309',
  ok: '#15803d',
  current: 'rgba(37, 99, 235, 0.1)',
  loop: '#7c3aed',
} as const;

function mscStyle(themed: boolean): string {
  const c = (name: keyof typeof MSC_COLORS): string => themed ? `var(--pj-msc-${name}, ${MSC_COLORS[name]})` : MSC_COLORS[name];
  return `
.pj-msc { font-family: ${FONT_STACK}; }
.pj-msc text { font-family: ${FONT_STACK}; }
.pj-msc-bg { fill: ${c('bg')}; }
.pj-msc-title { font-size: 14px; font-weight: 600; fill: ${c('text')}; }
.pj-msc-head { fill: ${c('head')}; stroke: ${c('line')}; }
.pj-msc-head-text { font-size: 12px; font-weight: 600; fill: ${c('text')}; }
.pj-msc-life { stroke: ${c('faint')}; stroke-width: 1.5; stroke-dasharray: 5 4; }
.pj-msc-life-done { stroke: ${c('faint')}; stroke-width: 1; stroke-dasharray: 1 5; }
.pj-msc-index { font-size: 10.5px; fill: ${c('muted')}; text-anchor: end; }
.pj-msc-arrow { stroke: ${c('arrow')}; stroke-width: 1.6; fill: none; }
.pj-msc-arrowhead { fill: ${c('arrow')}; }
.pj-msc-label { font-size: 11px; fill: ${c('text')}; text-anchor: middle; }
.pj-msc-hidden .pj-msc-arrow { stroke: ${c('muted')}; stroke-dasharray: 3 3; }
.pj-msc-hidden .pj-msc-label { fill: ${c('muted')}; }
.pj-msc-bar { fill: ${c('barrier')}; }
.pj-msc-bar-label { font-size: 11px; fill: ${c('barrier')}; font-weight: 600; }
.pj-msc-end { stroke: ${c('ok')}; stroke-width: 3; }
.pj-msc-end-label { font-size: 10.5px; fill: ${c('ok')}; }
.pj-msc-dot { fill: ${c('muted')}; }
.pj-msc-note { font-size: 10.5px; fill: ${c('muted')}; }
.pj-msc-x { stroke: ${c('danger')}; stroke-width: 3; stroke-linecap: round; }
.pj-msc-stuck { font-size: 11px; font-weight: 700; fill: ${c('danger')}; }
.pj-msc-error { font-size: 11px; font-weight: 700; fill: ${c('barrier')}; }
.pj-msc-row-bg { fill: transparent; }
.pj-msc-row.pj-current .pj-msc-row-bg { fill: ${c('current')}; }
.pj-msc-loop { fill: none; stroke: ${c('loop')}; stroke-width: 1.6; }
.pj-msc-loop-label { font-size: 10.5px; fill: ${c('loop')}; font-weight: 600; }
.pj-msc-wait-line { stroke: ${c('danger')}; stroke-width: 1.4; stroke-dasharray: 4 3; }
.pj-msc-wait-label { font-size: 10.5px; fill: ${c('danger')}; text-anchor: middle; }
.pj-msc-wait-none { font-size: 10.5px; fill: ${c('danger')}; font-style: italic; }
.pj-msc-x-small { stroke-width: 2; }
.pj-msc-left .pj-msc-x { stroke: ${c('wait')}; }
.pj-msc-left .pj-msc-stuck { fill: ${c('wait')}; }
.pj-msc-left .pj-msc-wait-line { stroke: ${c('wait')}; }
.pj-msc-left .pj-msc-wait-label, .pj-msc-left .pj-msc-wait-none { fill: ${c('wait')}; }
.pj-msc-pause { fill: ${c('wait')}; }
`;
}

/** Key a process by its path, so equal labels in different places stay apart. */
function processKey(ref: ProcessRef): string {
  return pathKeyOf(ref.path) || ref.label;
}

function pathKeyOf(path: ProcessPath): string {
  return path.map((step) => `${step.kind}:${step.site.uri}:${step.site.span.start.line}:${step.site.span.start.col}:${step.index ?? ''}`).join('/');
}

export function renderSequenceChart(counterexample: Counterexample, options: MscOptions = {}): string {
  const maxSteps = options.maxSteps ?? 400;
  const steps = counterexample.steps.slice(0, maxSteps);
  const omitted = counterexample.steps.length - steps.length;
  // Lifelines in order of first appearance.
  const lanes: Array<{ key: string; label: string; title: string }> = [];
  const laneOf = new Map<string, number>();
  const lane = (ref: ProcessRef): number => {
    const key = processKey(ref);
    let index = laneOf.get(key);
    if (index === undefined) {
      index = lanes.length;
      laneOf.set(key, index);
      // The name that tells two `branch 1` apart, with the full call in the head's title.
      lanes.push({ key, label: ref.name ?? ref.label, title: ref.label });
    }
    return index;
  };
  for (const step of steps) for (const participant of step.participants) lane(participant.process);
  for (const snapshot of counterexample.final) lane(snapshot.process);
  const width = Math.max(150, ...lanes.map((entry) => textWidth(truncate(entry.label, 26), 12) + 36));
  const x = (index: number): number => LEFT + width / 2 + index * width;
  const titleHeight = options.title ? 30 : 0;
  const top = titleHeight + 16;
  const rowY = (row: number): number => top + HEAD + 26 + row * ROW;
  const finalRow = steps.length + (omitted ? 1 : 0);
  // What each stuck process waits for, toward its partner's lifeline: one band row per wait.
  const waits = waitArrows(counterexample, laneOf);
  const band = waits.length * 20;
  const height = rowY(finalRow) + band + 64;
  const totalWidth = Math.max(LEFT + lanes.length * width + 24, 360);
  const out: string[] = [];
  const terminatedAt = new Map<number, number>();
  /** Lanes that end after a step they took part in (not at a termination step of their own). */
  const endedAfter = new Set<number>();
  const ends: string[] = [];

  // Rows first (their highlight sits under the lifelines).
  const rows: string[] = [];
  steps.forEach((step, row) => {
    const y = rowY(row);
    const parts: string[] = [`<rect class="pj-msc-row-bg" x="0" y="${num(y - ROW / 2)}" width="${num(totalWidth)}" height="${ROW}"/>`, `<text class="pj-msc-index" x="${LEFT - 14}" y="${num(y + 4)}">${step.index + 1}</text>`];
    parts.push(stepMarks(step, y, lane, x, terminatedAt, row, width));
    rows.push(`<g class="pj-msc-row${step.visible === false ? ' pj-msc-hidden' : ''}" data-step="${step.index}"><title>${escapeXml(step.description || step.event)}</title>${parts.join('')}</g>`);
  });
  if (omitted) rows.push(`<g class="pj-msc-row"><text class="pj-msc-note" x="${LEFT}" y="${num(rowY(steps.length) + 4)}">… ${omitted} more step${omitted === 1 ? '' : 's'} not drawn</text></g>`);
  // A process that ended without a step of its own (a par branch that ran to its end): its lifeline ends after
  // the last step it took part in, other than its par collecting it.
  for (const snapshot of counterexample.final) {
    const index = laneOf.get(processKey(snapshot.process));
    if (snapshot.status !== 'terminated' || index === undefined || terminatedAt.has(index)) continue;
    const key = processKey(snapshot.process);
    let last = -1;
    steps.forEach((step, row) => {
      if (!/^pj_join_/.test(step.event) && step.participants.some((participant) => processKey(participant.process) === key)) last = row;
    });
    if (last < 0) continue;
    terminatedAt.set(index, last);
    endedAfter.add(index);
    const y = rowY(last) + ROW / 2;
    ends.push(`<g class="pj-msc-ended"><line class="pj-msc-end" x1="${num(x(index) - 12)}" y1="${num(y)}" x2="${num(x(index) + 12)}" y2="${num(y)}"/><text class="pj-msc-end-label" x="${num(x(index) + 16)}" y="${num(y + 4)}">ends</text><title>${escapeXml(`${snapshot.process.name ?? snapshot.process.label} ends after step ${steps[last].index + 1}`)}</title></g>`);
  }

  // Lifelines, cut where a process terminated.
  const lifelines = lanes.map((_, index) => {
    const end = terminatedAt.get(index);
    const stop = end === undefined ? rowY(finalRow) + band : rowY(end) + (endedAfter.has(index) ? ROW / 2 : 0);
    const after = end === undefined ? '' : `<line class="pj-msc-life-done" x1="${num(x(index))}" y1="${num(stop)}" x2="${num(x(index))}" y2="${num(rowY(finalRow) + band)}"/>`;
    return `<line class="pj-msc-life" x1="${num(x(index))}" y1="${num(top + HEAD)}" x2="${num(x(index))}" y2="${num(stop)}"/>${after}`;
  });
  const heads = lanes.map((entry, index) => {
    const label = truncate(entry.label, 26);
    const w = width - 20;
    return `<g class="pj-msc-lane"><rect class="pj-msc-head" x="${num(x(index) - w / 2)}" y="${num(top)}" width="${num(w)}" height="${HEAD - 12}" rx="7"/><text class="pj-msc-head-text" x="${num(x(index) - textWidth(label, 12) / 2)}" y="${num(top + 21)}">${escapeXml(label)}</text><title>${escapeXml(entry.title)}</title></g>`;
  });

  // The end state: each wait toward the partner that never comes, then a cross where each process stuck for
  // good waits (red), or a pause where a run that repeats forever only leaves it waiting (amber).
  const finalMarks: string[] = [...ends];
  waits.forEach((wait, index) => {
    const wy = rowY(finalRow) - 8 + index * 20;
    const from = x(wait.from);
    const to = wait.to === undefined ? from + Math.min(width * 0.6, 90) : x(wait.to);
    const direction = to >= from ? 1 : -1;
    const label = truncate(wait.label, Math.max(8, Math.floor(Math.abs(to - from) / 7) - 2));
    const end = wait.to === undefined
      ? `<text class="pj-msc-wait-none" x="${num(to + direction * 6)}" y="${num(wy + 4)}"${direction < 0 ? ' text-anchor="end"' : ''}>${escapeXml(wait.missing)}</text>`
      : `<path class="pj-msc-x pj-msc-x-small" d="M${num(to - 4)},${num(wy - 4)} L${num(to + 4)},${num(wy + 4)} M${num(to + 4)},${num(wy - 4)} L${num(to - 4)},${num(wy + 4)}"/>`;
    finalMarks.push(`<g class="pj-msc-wait${wait.left ? ' pj-msc-left' : ''}"><line class="pj-msc-wait-line" x1="${num(from)}" y1="${num(wy)}" x2="${num(to - direction * 6)}" y2="${num(wy)}"/>${end}<text class="pj-msc-wait-label" x="${num((from + to) / 2)}" y="${num(wy - 4)}">${escapeXml(label)}</text><title>${escapeXml(wait.title)}</title></g>`);
  });
  const y = rowY(finalRow) + band;
  // A label under a lane fits that lane: neighbours' labels never run into each other.
  const fits = Math.max(8, Math.floor((width - 14) / (11 * 0.6)));
  for (const snapshot of counterexample.final) {
    const index = laneOf.get(processKey(snapshot.process));
    if (index === undefined) continue;
    finalMarks.push(finalMark(snapshot, x(index), y, terminatedAt.has(index), fits, stuckForGood(snapshot, counterexample)));
  }
  if (counterexample.loopStart !== undefined && counterexample.loopStart < steps.length) {
    const y1 = rowY(counterexample.loopStart) - ROW / 2 + 3;
    const y2 = rowY(steps.length - 1) + ROW / 2 - 3;
    finalMarks.push(`<path class="pj-msc-loop" d="M${LEFT - 30},${num(y1)} h-8 V${num(y2)} h8"/><text class="pj-msc-loop-label" x="4" y="${num((y1 + y2) / 2 + 4)}">loop</text>`);
  }

  out.push(`<rect class="pj-msc-bg" x="0" y="0" width="${num(totalWidth)}" height="${num(height)}"/>`);
  if (options.title) out.push(`<text class="pj-msc-title" x="16" y="24">${escapeXml(options.title)}</text>`);
  out.push(`<g class="pj-msc-rows">${rows.join('')}</g>`, `<g class="pj-msc-lifelines">${lifelines.join('')}</g>`, `<g class="pj-msc-heads">${heads.join('')}</g>`, `<g class="pj-msc-final" data-step="final">${finalMarks.join('')}</g>`);
  return `<svg xmlns="http://www.w3.org/2000/svg" class="pj-msc" viewBox="0 0 ${num(totalWidth)} ${num(height)}" width="${Math.ceil(totalWidth)}" height="${Math.ceil(height)}" data-heads="${num(top + HEAD - 4)}" role="img" aria-label="${escapeXml(options.title ?? 'sequence chart')}">
<style>${mscStyle(!!options.themed)}</style>
${out.join('\n')}
</svg>
`;
}

/** A stuck process's first wait, as an arrow toward the lane of the partner it names (or to nobody); `left` when the run only leaves it waiting. */
function waitArrows(counterexample: Counterexample, laneOf: ReadonlyMap<string, number>): Array<{ from: number; to?: number; label: string; missing: string; title: string; left: boolean }> {
  const out: Array<{ from: number; to?: number; label: string; missing: string; title: string; left: boolean }> = [];
  for (const snapshot of counterexample.final) {
    const wait = snapshot.status === 'blocked' ? snapshot.waits?.[0] : undefined;
    const from = laneOf.get(processKey(snapshot.process));
    if (!wait || from === undefined || (wait.operation !== 'read' && wait.operation !== 'write' && wait.operation !== 'sync' && wait.operation !== 'alt-guard' && wait.operation !== 'extended-read')) continue;
    const to = wait.partner?.process ? laneOf.get(processKey(wait.partner.process)) : undefined;
    if (to === from) continue;
    const verb = wait.operation === 'write' ? 'write' : wait.operation === 'sync' ? 'sync' : 'read';
    const side = wait.operation === 'write' ? 'reader' : wait.operation === 'sync' ? 'partner' : 'writer';
    const left = !stuckForGood(snapshot, counterexample);
    out.push({
      from,
      to,
      label: `${verb}${wait.channel ? ` ${wait.channel.name}` : ''}`,
      missing: wait.partner?.state === 'missing' || !wait.partner ? `no ${side}` : wait.partner.state === 'terminated' ? `${side} finished` : `${side} not ready`,
      title: `${snapshot.process.name ?? snapshot.process.label} ${wait.detail}${wait.partner?.detail ? `: ${wait.partner.detail}` : ''}${left ? ' (left waiting: this run never lets it go on)' : ''}`,
      left,
    });
  }
  return out;
}

function stepMarks(step: TraceStep, y: number, lane: (ref: ProcessRef) => number, x: (index: number) => number, terminatedAt: Map<number, number>, row: number, width: number): string {
  const writer = step.participants.find((participant) => participant.role === 'writer');
  const reader = step.participants.find((participant) => participant.role === 'reader');
  const what = step.channel ? `${step.channel.name}${step.value !== undefined ? `.${step.value}` : ''}` : step.value ?? step.event;
  if (step.kind === 'communication' && writer && reader) {
    const from = x(lane(writer.process));
    const to = x(lane(reader.process));
    if (from === to) {
      return `<path class="pj-msc-arrow" d="M${num(from)},${num(y - 8)} h28 v16 h-24"/><path class="pj-msc-arrowhead" d="M${num(from + 4)},${num(y + 4)} l8,-4 v8 z"/><text class="pj-msc-label" x="${num(from + 50)}" y="${num(y + 4)}">${escapeXml(truncate(what, 28))}</text>`;
    }
    const direction = to > from ? 1 : -1;
    const label = truncate(what, Math.max(6, Math.floor(Math.abs(to - from) / 7) - 2));
    return `<line class="pj-msc-arrow" x1="${num(from)}" y1="${num(y)}" x2="${num(to - direction * 9)}" y2="${num(y)}"/><path class="pj-msc-arrowhead" d="M${num(to)},${num(y)} l${-direction * 10},-5 v10 z"/><text class="pj-msc-label" x="${num((from + to) / 2)}" y="${num(y - 6)}">${escapeXml(label)}</text>`;
  }
  const lanes = step.participants.map((participant) => lane(participant.process));
  if (step.kind === 'barrier' && lanes.length) {
    const xs = lanes.map(x);
    const left = Math.min(...xs) - 12;
    const right = Math.max(...xs) + 12;
    return `<rect class="pj-msc-bar" x="${num(left)}" y="${num(y - 3)}" width="${num(right - left)}" height="6" rx="3"/><text class="pj-msc-bar-label" x="${num(right + 8)}" y="${num(y + 4)}">${escapeXml(truncate(step.channel ? `sync ${step.channel.name}` : step.event, 30))}</text>`;
  }
  if (step.kind === 'termination') {
    return lanes.map((index) => {
      terminatedAt.set(index, row);
      return `<line class="pj-msc-end" x1="${num(x(index) - 12)}" y1="${num(y)}" x2="${num(x(index) + 12)}" y2="${num(y)}"/><text class="pj-msc-end-label" x="${num(x(index) + 16)}" y="${num(y + 4)}">done</text>`;
    }).join('');
  }
  if (step.kind === 'error') {
    return lanes.map((index) => `<text class="pj-msc-error" x="${num(x(index) + 10)}" y="${num(y + 4)}">⚠ ${escapeXml(truncate(step.description || step.event, 36))}</text>`).join('');
  }
  // Internal or other events: a dot on each lifeline that takes part, and once, beside the first (the writer
  // whose write completes), what happens in ProcessJ terms.
  const first = step.participants.find((participant) => participant.role === 'writer') ?? step.participants[0];
  const note = noteText(step, first?.process);
  const at = first ? lane(first.process) : lanes[0];
  const dots = lanes.map((index) => `<circle class="pj-msc-dot" cx="${num(x(index))}" cy="${num(y)}" r="3.5"/>`).join('');
  return at === undefined ? dots : `${dots}<text class="pj-msc-note" x="${num(x(at) + 9)}" y="${num(y + 4)}">${escapeXml(truncate(note || what || step.event, Math.max(14, Math.floor((width * 1.6) / 6.3))))}</text>`;
}

/**
 * What an internal step does, from its description, without what the lane
 * already says: `starts branch 1 and branch 2`, `goes round its loop`,
 * `write on c completes`.
 */
function noteText(step: TraceStep, actor: ProcessRef | undefined): string {
  let text = step.description;
  if (!text) return '';
  const name = actor ? actor.name ?? actor.label : undefined;
  if (name && text.startsWith(`${name}'s `)) text = text.slice(name.length + 3);
  else if (name && text.startsWith(`${name} `)) text = text.slice(name.length + 1);
  // Where it happens is the row's own business (its title has the whole description).
  return text.replace(/ \((?:par|par for) at line \d+\)/g, '').replace(/ \(line \d+(?: of [^)]*)?\)/g, '').replace(/: .*$/, '');
}

function finalMark(snapshot: ProcessSnapshot, x: number, y: number, ended: boolean, fits: number, forGood: boolean): string {
  if (snapshot.status === 'blocked') {
    const text = truncate(snapshotBadge(snapshot), fits);
    // Stuck for good: a cross. Left waiting by a run that repeats forever: a pause, in amber.
    const mark = forGood
      ? `<path class="pj-msc-x" d="M${num(x - 7)},${num(y - 7)} L${num(x + 7)},${num(y + 7)} M${num(x + 7)},${num(y - 7)} L${num(x - 7)},${num(y + 7)}"/>`
      : `<rect class="pj-msc-pause" x="${num(x - 6)}" y="${num(y - 7)}" width="4" height="14" rx="1"/><rect class="pj-msc-pause" x="${num(x + 2)}" y="${num(y - 7)}" width="4" height="14" rx="1"/>`;
    return `<g class="pj-msc-blocked${forGood ? '' : ' pj-msc-left'}">${mark}<text class="pj-msc-stuck" x="${num(x - textWidth(text, 11) / 2)}" y="${num(y + 24)}">${escapeXml(text)}</text><title>${escapeXml(`${snapshot.description}${forGood ? '' : ' (left waiting: this run never lets it go on)'}`)}</title></g>`;
  }
  if (snapshot.status === 'terminated' && !ended) {
    return `<line class="pj-msc-end" x1="${num(x - 12)}" y1="${num(y)}" x2="${num(x + 12)}" y2="${num(y)}"/><text class="pj-msc-end-label" x="${num(x - 12)}" y="${num(y + 20)}">done</text>`;
  }
  if (snapshot.status === 'error') return `<text class="pj-msc-error" x="${num(x - 30)}" y="${num(y + 4)}">⚠ error</text>`;
  if (snapshot.status === 'diverging') return `<text class="pj-msc-note" x="${num(x - 30)}" y="${num(y + 4)}">diverges</text>`;
  return '';
}
