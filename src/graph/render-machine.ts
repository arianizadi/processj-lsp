/**
 * A procedure's communication state machine (src/csp/machine.ts), laid out
 * with ELK and drawn for the viewer: one box per state of the CSP model, with
 * what a process there does next over the definition's own name, and one
 * arrow per transition with what happens on the way (dashed when a condition
 * the model leaves to FDR decides it). A process's trail through the machine,
 * FDR's states along a counterexample, is resolved here against the same
 * model, so the page only has to number the states and mark where it ends.
 */
import type { CspMachine, CspMachineState, CspMachineTransition } from '../csp/machine';
import { machineOfState } from '../csp/machine';
import { parseState } from '../csp/fdr';
import { spanKey } from '../csp/model';
import type { SourceRef } from '../verification';
import { runElk, textWidth, type Box, type ElkNode, type Point } from './layout';
import { LIGHT_THEME, type ThemeColor } from './render-svg';
import { escapeXml, num, roundedPath } from './svg';

/** What the page asks for: one machine of one model, and optionally a process's trail through it. */
export interface MachineRequest {
  /** The model: `program`, or `proc:<name>:<line of its name>` for a procedure checked on its own. */
  target: string;
  /** The machine (machineRef). */
  ref: string;
  /** With a result: the check, as the published report names it, and the process (pathKey) whose trail to resolve. */
  check?: string;
  process?: string;
}

export interface ViewerMachineState {
  id: string;
  label: string;
  kind: string;
  /** A definition of the model (the two ends, `return` and `STOP`, are not). */
  definition: boolean;
  passing: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
  at?: { uri: string; line: number; col: number };
  text?: string;
}

/** One state of a process's trail, placed in this machine when it is one of its states, or inside one of its calls. */
export interface ViewerMachineTrail {
  /** The process is in this state from just before this step (0-based; steps.length: at the end). */
  step: number;
  /** FDR's name of the state, with its arguments. */
  state: string;
  /** The state of this machine it is, when it is one. */
  id?: string;
  /** Inside a call this machine makes: that call transition (an index of `transitions`); the process is in the callee, not yet back. */
  call?: number;
  /** Inside a call: where the process is in the callee, described. */
  inside?: string;
  /** What the state is, in words. */
  label: string;
}

export interface ViewerMachine {
  /** The request this answers, as a key (machineRequestKey). */
  key: string;
  target: string;
  ref: string;
  label: string;
  procedure: string;
  /** `the model of the whole program`, `the model of succ on its own`. */
  model: string;
  width: number;
  height: number;
  /** States and transitions in machine coordinates. */
  svg: string;
  states: ViewerMachineState[];
  /** With `callRef`: the ref of the callee's machine, which says what happens inside the call; `line`: the call statement's (0-based). */
  transitions: Array<Pick<CspMachineTransition, 'from' | 'to' | 'label' | 'conditional' | 'call' | 'guard' | 'error'> & { callRef?: string; line?: number }>;
  initial: string;
  /** With a check and a process: where the process went, and how it ends. */
  trail?: ViewerMachineTrail[];
  process?: { label: string; status: string; description: string; waits: string[] };
  notes: string[];
}

/** A machine the page could not get, and why. */
export interface ViewerMachineError {
  key: string;
  error: string;
}

/** The key of a request (and of a machine embedded in a page). */
export function machineRequestKey(request: MachineRequest): string {
  return [request.target, request.ref, request.check ?? '', request.process ?? ''].join('\u0001');
}

/**
 * Which machine a process runs, in terms both the network and the model know:
 * the procedure, its declaration, and the par branch or par for body when the
 * process is one (its region; absent for the procedure's own thread).
 */
export function machineRef(procedure: string, declaration: SourceRef | undefined, region?: { kind: 'branch' | 'par-for'; site: SourceRef; index?: number }): string {
  const at = declaration ? `@${declaration.uri}#${declaration.span.start.line}:${declaration.span.start.col}` : '';
  return `${procedure}${at}${region ? `|${region.kind}@${spanKey(region.site.span)}${region.index !== undefined ? `#${region.index}` : ''}` : ''}`;
}

/** The ref of a machine of the model. */
export function refOfMachine(machine: CspMachine): string {
  return machineRef(machine.procedure, machine.declaration, machine.region);
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const STATE = { label: 12.5, def: 10.5, line: 10, edge: 11, height: 46, endHeight: 30, padding: 12, maxWidth: 300 } as const;

export interface MachineLayout {
  width: number;
  height: number;
  states: Record<string, Box>;
  /** By transition index; `start` is the arrow from the start marker. */
  edges: Record<string, { points: Point[]; label?: Box }>;
  start?: Box;
}

function lineChip(state: CspMachineState): string {
  return state.at ? `L${state.at.span.start.line + 1}` : '';
}

function stateSize(state: CspMachineState): { width: number; height: number } {
  if (state.kind === 'return' || state.kind === 'stop') return { width: Math.ceil(textWidth(state.kind === 'stop' ? 'STOP' : 'returns', STATE.label) + 2 * STATE.padding + 8), height: STATE.endHeight };
  const chip = lineChip(state);
  const first = (chip ? textWidth(chip, STATE.line) + 12 + 6 : 0) + textWidth(state.label, STATE.label);
  const second = textWidth(state.id, STATE.def);
  return { width: Math.min(STATE.maxWidth, Math.ceil(Math.max(first, second, 96) + 2 * STATE.padding)), height: STATE.height };
}

/**
 * The label a transition is drawn with: none when it only says what its state
 * already does (a write state's transition writes), so the words that remain
 * are the ones that add something: guards, conditions, calls, errors.
 */
export function shownLabel(machine: Pick<CspMachine, 'states'>, t: Pick<CspMachineTransition, 'from' | 'label'>): string {
  const source = machine.states.find((state) => state.id === t.from);
  if (!source || !t.label) return t.label;
  const implied = t.label === source.label || (t.label === 'start' && /^start the par/.test(source.label));
  return implied ? '' : t.label;
}

function edgeLabelBox(label: string): { width: number; height: number } {
  return { width: Math.ceil(textWidth(label, STATE.edge) + 12), height: 18 };
}

const MACHINE_LAYOUT: Readonly<Record<string, string>> = Object.freeze({
  'elk.algorithm': 'layered',
  'elk.direction': 'RIGHT',
  'elk.edgeRouting': 'ORTHOGONAL',
  'elk.json.edgeCoords': 'ROOT',
  'elk.json.shapeCoords': 'ROOT',
  'elk.randomSeed': '1',
  'elk.layered.spacing.nodeNodeBetweenLayers': '56',
  'elk.spacing.nodeNode': '26',
  'elk.spacing.edgeNode': '18',
  'elk.spacing.edgeEdge': '12',
  'elk.spacing.edgeLabel': '3',
  'elk.layered.spacing.edgeNodeBetweenLayers': '16',
  'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  'elk.padding': '[top=18,left=18,bottom=18,right=18]',
});

export async function layoutMachine(machine: CspMachine): Promise<MachineLayout> {
  const children: ElkNode[] = machine.states.map((state) => ({ id: state.id, ...stateSize(state) }));
  if (machine.initial) children.unshift({ id: '\u0000start', width: 12, height: 12, layoutOptions: { 'elk.layered.layering.layerConstraint': 'FIRST' } });
  const edges = machine.transitions.map((t, index) => {
    const label = shownLabel(machine, t);
    return {
      id: `t${index}`,
      sources: [t.from],
      targets: [t.to],
      labels: label ? [{ id: `t${index}:label`, text: label, ...edgeLabelBox(label), layoutOptions: { 'elk.edgeLabels.inline': 'false', 'elk.edgeLabels.placement': 'CENTER' } }] : undefined,
    };
  });
  if (machine.initial) edges.unshift({ id: 'start', sources: ['\u0000start'], targets: [machine.initial], labels: undefined });
  const result = await runElk({ id: `machine:${machine.key}`, layoutOptions: { ...MACHINE_LAYOUT }, children, edges });
  const round = (value: number | undefined): number => Math.round((value ?? 0) * 10) / 10;
  const box = (node: { x?: number; y?: number; width?: number; height?: number }): Box => ({ x: round(node.x), y: round(node.y), width: round(node.width), height: round(node.height) });
  const layout: MachineLayout = { width: Math.ceil(result.width ?? 0), height: Math.ceil(result.height ?? 0), states: {}, edges: {} };
  for (const node of result.children ?? []) {
    if (node.id === '\u0000start') layout.start = box(node);
    else layout.states[node.id] = box(node);
  }
  for (const edge of result.edges ?? []) {
    const points: Point[] = [];
    for (const section of edge.sections ?? []) {
      for (const point of [section.startPoint, ...(section.bendPoints ?? []), section.endPoint]) {
        const p = { x: round(point.x), y: round(point.y) };
        const last = points[points.length - 1];
        if (!last || last.x !== p.x || last.y !== p.y) points.push(p);
      }
    }
    const label = edge.labels?.[0];
    layout.edges[edge.id === 'start' ? 'start' : edge.id.slice(1)] = { points, ...(label ? { label: box(label) } : {}) };
  }
  return layout;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

/** States and transitions in machine coordinates, with `data-state`, `data-from`/`data-to` for the page's marks. */
export function renderMachineBody(machine: CspMachine, layout: MachineLayout, prefix = 'pj'): string {
  const out: string[] = ['<g class="pj-sm-edges">'];
  const start = layout.edges.start;
  if (layout.start) out.push(`<circle class="pj-sm-start" cx="${num(layout.start.x + layout.start.width / 2)}" cy="${num(layout.start.y + layout.start.height / 2)}" r="6"/>`);
  if (start && start.points.length > 1) out.push(`<path class="pj-sm-line pj-sm-start-line" d="${roundedPath(start.points)}" marker-end="url(#${prefix}-sm-arrow)"/>`);
  machine.transitions.forEach((t, index) => {
    const laid = layout.edges[String(index)];
    if (!laid || laid.points.length < 2) return;
    const classes = ['pj-sm-edge', t.conditional ? 'pj-sm-conditional' : '', t.call ? 'pj-sm-call' : '', t.error ? 'pj-sm-error' : ''].filter(Boolean).join(' ');
    out.push(`<g class="${classes}" data-index="${index}" data-from="${escapeXml(t.from)}" data-to="${escapeXml(t.to)}"><title>${escapeXml(`${t.label || 'no event'}${t.conditional ? ' (only when its condition holds)' : ''}`)}</title><path class="pj-sm-line" d="${roundedPath(laid.points)}" marker-end="url(#${prefix}-sm-arrow)"/></g>`);
  });
  out.push('</g><g class="pj-sm-states">');
  for (const state of machine.states) {
    const box = layout.states[state.id];
    if (box) out.push(renderState(state, box));
  }
  out.push('</g><g class="pj-sm-labels">');
  machine.transitions.forEach((t, index) => {
    const laid = layout.edges[String(index)];
    const label = shownLabel(machine, t);
    if (!laid?.label || !label) return;
    const { x, y, width, height } = laid.label;
    out.push(`<g class="pj-sm-edge-label${t.call ? ' pj-sm-call' : ''}${t.error ? ' pj-sm-error' : ''}" data-index="${index}"><rect x="${num(x)}" y="${num(y)}" width="${num(width)}" height="${num(height)}" rx="9"/><text x="${num(x + 6)}" y="${num(y + 12.6)}">${escapeXml(label)}</text></g>`);
  });
  out.push('</g><g class="pj-sm-marks"></g>');
  return out.join('');
}

function renderState(state: CspMachineState, box: Box): string {
  const kind = `pj-sm-${state.kind}`;
  const title = `${state.id}: ${state.label}${state.text ? `\n${state.text}` : ''}`;
  if (state.kind === 'return' || state.kind === 'stop') {
    const text = state.kind === 'stop' ? 'STOP' : 'returns';
    return `<g class="pj-sm-state ${kind}" data-state="${escapeXml(state.id)}"><title>${escapeXml(title)}</title><rect class="pj-sm-box" x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" rx="${num(box.height / 2)}"/>${state.kind === 'return' ? `<rect class="pj-sm-ring" x="${num(box.x + 3)}" y="${num(box.y + 3)}" width="${num(box.width - 6)}" height="${num(box.height - 6)}" rx="${num(box.height / 2 - 3)}"/>` : ''}<text class="pj-sm-end-label" x="${num(box.x + box.width / 2)}" y="${num(box.y + box.height / 2 + 4.4)}" text-anchor="middle">${escapeXml(text)}</text></g>`;
  }
  const chip = lineChip(state);
  const chipWidth = chip ? textWidth(chip, STATE.line) + 12 : 0;
  const x = box.x + STATE.padding;
  const room = Math.max(4, Math.floor((box.width - 2 * STATE.padding - (chip ? chipWidth + 6 : 0)) / (STATE.label * 0.6)));
  const label = state.label.length > room ? `${state.label.slice(0, room - 1)}…` : state.label;
  const defRoom = Math.max(4, Math.floor((box.width - 2 * STATE.padding) / (STATE.def * 0.6)));
  const def = state.id.length > defRoom ? `${state.id.slice(0, defRoom - 1)}…` : state.id;
  return `<g class="pj-sm-state ${kind}${state.passing ? ' pj-sm-passing' : ''}" data-state="${escapeXml(state.id)}"><title>${escapeXml(title)}</title>`
    + `<rect class="pj-sm-box" x="${num(box.x)}" y="${num(box.y)}" width="${num(box.width)}" height="${num(box.height)}" rx="9"/>`
    + (chip ? `<rect class="pj-sm-chip" x="${num(x)}" y="${num(box.y + 7)}" width="${num(chipWidth)}" height="16" rx="8"/><text class="pj-sm-chip-text" x="${num(x + 6)}" y="${num(box.y + 18.6)}">${escapeXml(chip)}</text>` : '')
    + `<text class="pj-sm-label" x="${num(x + (chip ? chipWidth + 6 : 0))}" y="${num(box.y + 19.5)}">${escapeXml(label)}</text>`
    + `<text class="pj-sm-def" x="${num(x)}" y="${num(box.y + 37)}">${escapeXml(def)}</text></g>`;
}

/** The arrowhead of the machine's transitions, for the page's and an exported file's <defs>. */
export function machineMarkers(prefix = 'pj'): string {
  return `<marker id="${prefix}-sm-arrow" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto"><path class="pj-sm-arrow" d="M0,0.8 L10,5 L0,9.2 Z"/></marker>`;
}

/** The machine's stylesheet, light colours as fallbacks of the page's `--pj-*` properties (or plain). */
export function machineStyle(mode: 'plain' | 'themed' = 'themed'): string {
  const c = (name: ThemeColor): string => mode === 'plain' ? LIGHT_THEME[name] : `var(--pj-${name}, ${LIGHT_THEME[name]})`;
  return `
.pj-sm-box { fill: ${c('process-fill')}; stroke: ${c('process-stroke')}; stroke-width: 1.3; }
.pj-sm-passing .pj-sm-box, .pj-sm-slot .pj-sm-box, .pj-sm-branch-end .pj-sm-box { fill: ${c('root-fill')}; stroke: ${c('faint')}; stroke-dasharray: 4 3; }
.pj-sm-join .pj-sm-box { fill: ${c('par-fill')}; stroke: ${c('par-stroke')}; }
.pj-sm-return .pj-sm-box { fill: ${c('ok-fill')}; stroke: ${c('ok')}; }
.pj-sm-ring { fill: none; stroke: ${c('ok')}; stroke-width: 1; }
.pj-sm-stop .pj-sm-box { fill: ${c('text')}; stroke: ${c('text')}; }
.pj-sm-end-label { font-size: ${STATE.label}px; font-weight: 700; fill: ${c('ok')}; }
.pj-sm-stop .pj-sm-end-label { fill: ${c('bg')}; }
.pj-sm-chip { fill: ${c('badge-fill')}; }
.pj-sm-chip-text { font-size: ${STATE.line}px; font-weight: 700; fill: ${c('badge-text')}; }
.pj-sm-label { font-size: ${STATE.label}px; font-weight: 600; fill: ${c('text')}; }
.pj-sm-passing .pj-sm-label { font-weight: 500; fill: ${c('muted')}; }
.pj-sm-def { font-size: ${STATE.def}px; fill: ${c('muted')}; }
.pj-sm-start { fill: ${c('text')}; }
.pj-sm-line { fill: none; stroke: ${c('edge')}; stroke-width: 1.4; }
.pj-sm-arrow { fill: ${c('edge')}; }
.pj-sm-conditional .pj-sm-line { stroke-dasharray: 6 4; }
.pj-sm-call .pj-sm-line { stroke: ${c('call-badge-text')}; }
.pj-sm-error .pj-sm-line { stroke: ${c('warn')}; stroke-dasharray: 2 3; }
.pj-sm-edge-label rect { fill: ${c('label-fill')}; stroke: ${c('label-stroke')}; }
.pj-sm-edge-label text { font-size: ${STATE.edge}px; fill: ${c('text')}; }
.pj-sm-edge-label.pj-sm-call rect { fill: ${c('call-badge-fill')}; stroke: ${c('call-stroke')}; }
.pj-sm-edge-label.pj-sm-call text { fill: ${c('call-badge-text')}; font-weight: 600; }
.pj-sm-edge-label.pj-sm-error text { fill: ${c('warn')}; }
.pj-sm-visited .pj-sm-box { stroke: ${c('info')}; stroke-width: 2; }
.pj-sm-taken .pj-sm-line { stroke: ${c('info')}; stroke-width: 2.2; }
.pj-sm-current .pj-sm-box { stroke: ${c('info')}; stroke-width: 3; }
.pj-sm-stuck .pj-sm-box { stroke: ${c('danger')}; stroke-width: 2.8; fill: ${c('danger-fill')}; }
.pj-sm-edge.pj-sm-current .pj-sm-line { stroke: ${c('info')}; stroke-width: 3; }
.pj-sm-edge.pj-sm-stuck .pj-sm-line { stroke: ${c('danger')}; stroke-width: 3; }
.pj-sm-edge-label.pj-sm-taken rect, .pj-sm-edge-label.pj-sm-current rect { stroke: ${c('info')}; stroke-width: 2; }
.pj-sm-edge-label.pj-sm-stuck rect { stroke: ${c('danger')}; stroke-width: 2.4; fill: ${c('danger-fill')}; }
.pj-sm-halo { fill: none; stroke: ${c('danger-soft')}; stroke-width: 8; }
.pj-sm-order circle { fill: ${c('info')}; stroke: ${c('bg')}; stroke-width: 1.5; }
.pj-sm-order text { font-size: 10px; font-weight: 700; fill: #ffffff; }
.pj-sm-order.pj-sm-order-last circle { fill: ${c('danger-strong')}; }
.pj-sm-callout rect { fill: ${c('danger-strong')}; }
.pj-sm-callout.pj-sm-callout-info rect { fill: ${c('info')}; }
.pj-sm-callout text { font-size: 11px; font-weight: 700; fill: #ffffff; }
`;
}

// ---------------------------------------------------------------------------
// Viewer data
// ---------------------------------------------------------------------------

/** What a state is, in words, with the machine it belongs to when that is not `machine`. */
function describeState(name: string, machine: CspMachine, machines: readonly CspMachine[]): string {
  const own = machine.states.find((s) => s.id === name);
  if (own) return stateWords(own);
  const found = machineOfState(machines, name);
  const state = found?.machine.states.find((s) => s.id === found.state);
  if (!found || !state) return name === 'STOP' ? 'STOP: does nothing ever again' : name === 'SKIP' ? 'terminated' : 'a state of another part of the model';
  return `${found.machine.label}: ${stateWords(state)}`;
}

function stateWords(state: CspMachineState): string {
  // A branch's slot and end are at its statement, which the machine's own label already says.
  const line = state.at && !['return', 'stop', 'slot', 'branch-end'].includes(state.kind);
  return `${state.label}${line ? ` (line ${state.at!.span.start.line + 1})` : ''}`;
}

/**
 * Where an FDR state is in `machine`: one of its states, or inside one of
 * its calls. A process inside a call is in a state of the callee, which FDR
 * names with the caller's continuation as an argument:
 * `syncronize__152(a, b, elf__196(1, a, b))` is in elf's call of syncronize
 * that goes on at elf__196, at syncronize__152. A call at the end of the
 * procedure goes on with the caller's own continuation, which is not a state
 * of this machine: it is placed when this machine makes only one call of that
 * callee there.
 */
export function placeInMachine(state: string, machine: CspMachine, machines: readonly CspMachine[] = []): { id: string } | { call: number; inside: string[] } | undefined {
  const ids = new Set(machine.states.filter((s) => s.kind !== 'return' && s.kind !== 'stop').map((s) => s.id));
  // The callee states around the continuation, innermost (where the process waits) first.
  const visit = (term: string, depth: number, inside: string[]): { id: string; inside: string[] } | undefined => {
    if (depth > 12) return undefined;
    const body = term.replace(/^\\\s*[\w']+\s*@\s*/, '').trim();
    const { name, args } = parseState(body);
    if (ids.has(name)) return { id: name, inside };
    for (const arg of args) {
      if (!/^\\|^[A-Za-z_][\w']*(\(|$)/.test(arg)) continue;
      const found = visit(arg, depth + 1, [...inside, name]);
      if (found) return found;
    }
    return undefined;
  };
  const found = visit(state, 0, []);
  const procedureOf = (name: string | undefined): string | undefined => (name ? machineOfState(machines, name)?.machine.procedure : undefined);
  if (found && !found.inside.length) return { id: found.id };
  if (found) {
    // The call that goes on there; of several, the one of the procedure the process is in.
    const direct = procedureOf(found.inside[found.inside.length - 1]);
    const calls = machine.transitions.map((t, index) => ({ t, index })).filter(({ t }) => t.to === found.id && t.call);
    const call = calls.find(({ t }) => direct && t.call === direct) ?? calls[0];
    return call ? { call: call.index, inside: found.inside } : { id: found.id };
  }
  const name = parseState(state.replace(/^\\\s*[\w']+\s*@\s*/, '')).name;
  const callee = procedureOf(name);
  const tails = callee && callee !== machine.procedure ? machine.transitions.map((t, index) => ({ t, index })).filter(({ t }) => t.call === callee && t.to === 'return') : [];
  return tails.length === 1 && machine.transitions.filter((t) => t.call === callee).length === 1 ? { call: tails[0].index, inside: [name] } : undefined;
}

/** A process's trail through `machine`, each FDR state placed and described. */
export function resolveTrail(trail: ReadonlyArray<{ step: number; state: string }>, machine: CspMachine, machines: readonly CspMachine[]): ViewerMachineTrail[] {
  let ran = false;
  return trail.map((entry) => {
    const placed = placeInMachine(entry.state, machine, machines);
    const name = parseState(entry.state.replace(/^\\\s*[\w']+\s*@\s*/, '')).name;
    // A branch back in its slot after it ran has finished, and its par has collected it.
    const slot = machineOfState(machines, name)?.machine.states.find((s) => s.id === name)?.kind === 'slot';
    const words = slot && ran ? 'finished, and collected by its par' : undefined;
    if (!slot) ran = true;
    if (placed && 'call' in placed) {
      const t = machine.transitions[placed.call];
      const via = placed.inside.slice(1).map((inner) => machineOfState(machines, inner)?.machine.procedure).filter((entry): entry is string => !!entry);
      const inside = `${describeState(placed.inside[0], machine, machines)}${via.length ? ` (called from ${via.join(', from ')})` : ''}`;
      return { step: entry.step, state: entry.state, call: placed.call, inside, label: `inside the call of ${t.call ?? 'a procedure'}${t.at ? ` at line ${t.at.span.start.line + 1}` : ''}: ${inside}` };
    }
    if (!placed) return { step: entry.step, state: entry.state, label: words ? `${machineOfState(machines, name)?.machine.label ?? name}: ${words}` : describeState(name, machine, machines) };
    const own = machine.states.find((s) => s.id === placed.id)!;
    return { step: entry.step, state: entry.state, id: placed.id, label: words ?? stateWords(own) };
  });
}

export interface ViewerMachineInput {
  request: MachineRequest;
  machine: CspMachine;
  /** Every machine of the same model (for the trail's states elsewhere). */
  machines: readonly CspMachine[];
  layout: MachineLayout;
  /** `the model of the whole program`. */
  model: string;
  trail?: ReadonlyArray<{ step: number; state: string }>;
  process?: ViewerMachine['process'];
  notes?: string[];
}

export function buildViewerMachine(input: ViewerMachineInput): ViewerMachine {
  const { machine, layout } = input;
  const location = (ref: SourceRef | undefined): ViewerMachineState['at'] => ref ? { uri: ref.uri, line: ref.span.start.line, col: ref.span.start.col } : undefined;
  return {
    key: machineRequestKey(input.request),
    target: input.request.target,
    ref: input.request.ref,
    label: machine.label,
    procedure: machine.procedure,
    model: input.model,
    width: layout.width,
    height: layout.height,
    svg: renderMachineBody(machine, layout),
    states: machine.states.filter((state) => layout.states[state.id]).map((state) => ({
      id: state.id,
      label: state.label,
      kind: state.kind,
      definition: state.kind !== 'return' && state.kind !== 'stop',
      passing: !!state.passing,
      ...layout.states[state.id],
      ...(state.at ? { at: location(state.at) } : {}),
      ...(state.text ? { text: state.text } : {}),
    })),
    transitions: machine.transitions.map(({ from, to, label, conditional, call, callee, guard, error, at }) => {
      const inside = callee ? input.machines.find((m) => !m.region && m.states.some((state) => state.id === callee)) : undefined;
      return { from, to, label, conditional, ...(call ? { call } : {}), ...(inside ? { callRef: refOfMachine(inside) } : {}), ...(guard !== undefined ? { guard } : {}), ...(error ? { error } : {}), ...(at ? { line: at.span.start.line } : {}) };
    }),
    initial: machine.initial,
    ...(input.trail ? { trail: resolveTrail(input.trail, machine, input.machines) } : {}),
    ...(input.process ? { process: input.process } : {}),
    notes: input.notes ?? [],
  };
}
