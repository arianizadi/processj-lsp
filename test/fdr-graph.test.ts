/**
 * FDR's real answers on the drawn network, and each process's state machine.
 *
 * The counterexamples are refines' own output, recorded for this repository's
 * examples (test/fixtures/fdr, see fdr-recordings.ts), explained and placed on
 * the views the viewer draws: every step and every process must land on a box
 * or an arrow, and what cannot must be listed. The state machines are checked
 * against the model they are read from: every state is one of its
 * definitions, every transition a reference its CSPm makes, and every state
 * FDR names in the recorded counterexamples is a state of some machine.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { explain, leafBehaviours, machineOfState, parseState, stateMachines, translateProcedure, translateProgram, type CspMachine, type CspModel, type FdrBehaviour, type FdrCounterexample, type FdrRun } from '../src/csp/index';
import { loadProgram } from '../src/csp/load';
import { buildOverlays, pathKey, preferredView, verdictChips } from '../src/graph/overlay';
import { buildViewerPayload, nodeMachine } from '../src/graph/payload';
import { buildViewerMachine, layoutMachine, placeInMachine, refOfMachine } from '../src/graph/render-machine';
import { formatConcurrencyMarkdown } from '../src/graph/render-markdown';
import { renderSequenceChart } from '../src/graph/render-msc';
import { renderNetworkSvg } from '../src/graph/render-svg';
import { layoutView } from '../src/graph/layout';
import type { VerificationReport } from '../src/verification';
import { IMPORTED, recordedRun } from './fdr-recordings';
import { analyzeFile, INCLUDE, programView, ROOT } from './graph-helpers';

const EXAMPLES = path.join(ROOT, 'examples');

async function checked(file: string, name: string, procedure?: string): Promise<{ analyzed: ReturnType<typeof analyzeFile>; model: CspModel; run: FdrRun; report: VerificationReport }> {
  const analyzed = analyzeFile(file);
  const loaded = loadProgram(file, INCLUDE);
  assert.deepEqual(loaded.syntaxErrors, []);
  const input = { units: loaded.units, index: loaded.index };
  const model = procedure ? translateProcedure(input, procedure) : translateProgram(input);
  assert.deepEqual(model.unsupported, [], `${name}: the model is complete`);
  const run = await recordedRun(name, model);
  return { analyzed, model, run, report: explain(model, run, { uri: analyzed.uri, documentVersion: 1 }) };
}

/**
 * A program of the explanation tests (fdr.test.ts), from its own text under
 * the same file name: the same model, so the same recording.
 */
function checkedSource(source: string, name: string, procedure?: string): ReturnType<typeof checked> {
  const dir = path.join(os.tmpdir(), 'processj-fdr-graph-test');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.pj`);
  fs.writeFileSync(file, source);
  return checked(file, name, procedure);
}

/** Every state a recorded counterexample names for any process (`--divide`), without FDR's wrappers. */
function namedStates(run: FdrRun, model: CspModel): string[] {
  const out = new Set<string>();
  for (const result of run.results) {
    for (const raw of result.counterexamples as FdrCounterexample[]) {
      for (const leaf of leafBehaviours(model, raw, run.eventMap) ?? []) for (const state of leaf.at) if (state) out.add(state);
      const walk = (b: FdrBehaviour | undefined): void => {
        if (!b) return;
        for (const state of b.states ?? []) if (!state.startsWith('<') && !state.startsWith('sbisim(')) out.add(state);
        for (const child of b.child_behaviours ?? []) walk(child);
      };
      walk(raw.implementation_behaviour);
    }
  }
  return [...out];
}

/** Placement of every failed check on its preferred view: nothing the report names may be dropped. */
function placeAll(analyzed: ReturnType<typeof analyzeFile>, report: VerificationReport): void {
  const overlays = buildOverlays(analyzed.model, [report], { documentVersion: 1 });
  for (const check of report.checks) {
    const cx = check.counterexample;
    if (!cx) continue;
    const viewId = preferredView(analyzed.model, check, overlays, 0);
    const overlay = overlays.find((entry) => entry.view === viewId && entry.check === check.id);
    assert.ok(overlay, `${check.id} is drawn`);
    assert.deepEqual(overlay.unplaced, [], `${check.id}: nothing left out`);
    assert.equal(overlay.processes.length, cx.final.length, `${check.id}: every process lands on a box`);
    assert.ok(overlay.processes.every((entry) => entry.exact), `${check.id}: on its own box`);
    for (const step of overlay.steps) {
      assert.ok(step.participants.every((part) => part.node), `${check.id} step ${step.index + 1}: every participant drawn`);
      if (step.kind === 'communication' || step.kind === 'barrier') assert.ok(step.channel, `${check.id} step ${step.index + 1}: its channel drawn`);
    }
    for (const cycle of overlay.cycles) assert.equal(cycle.nodes.length, cx.cycles![overlay.cycles.indexOf(cycle)].length);
  }
}

test('real FDR output lands on the drawn network: the crossed writes of par_deadlock', async () => {
  const { analyzed, report } = await checked(path.join(EXAMPLES, 'par_deadlock.pj'), 'par_deadlock');
  placeAll(analyzed, report);
  const overlays = buildOverlays(analyzed.model, [report], { documentVersion: 1 });
  const deadlock = overlays.find((entry) => entry.check === 'deadlock-free' && entry.view === programView(analyzed.model).id)!;
  assert.equal(deadlock.cycles.length, 1);
  assert.equal(deadlock.cycles[0].nodes.length, 2);
  assert.equal(deadlock.cycles[0].edges.length, 2, 'both arrows of the circle are drawn red');
  assert.deepEqual(deadlock.processes.map((entry) => [entry.label, entry.cause]), [['main', 'knock-on'], ['branch 1', 'root'], ['branch 2', 'root']]);
  // Real reports count steps from 0; the page labels them from 1.
  assert.deepEqual(deadlock.steps.map((step) => step.index), [0]);
});

test('real FDR output lands on the drawn network: the dining philosophers\' six-process circle', async () => {
  const { analyzed, report, model } = await checked(path.join(EXAMPLES, 'dining_philosophers.pj'), 'dining_philosophers');
  assert.deepEqual(report.checks.map((check) => [check.id, check.status]), [['deadlock-free', 'failed'], ['no-runtime-errors', 'passed'], ['terminates', 'failed']]);
  placeAll(analyzed, report);
  const cx = report.checks[0].counterexample!;
  // Three philosophers hold their left chopstick and wait to put the right one down... to pick it up;
  // each chopstick waits for its holder to put it down.
  assert.equal(cx.cycles?.length, 1);
  assert.equal(cx.cycles![0].length, 6);
  const waits = cx.final.filter((snap) => snap.process.label !== 'main').map((snap) => [snap.process.label.replace(/\(.*$/, ''), snap.waits?.[0].operation, snap.at?.span.start.line]);
  assert.deepEqual(waits, [['philosopher', 'write', 27], ['philosopher', 'write', 27], ['philosopher', 'write', 27], ['chopstick', 'read', 17], ['chopstick', 'read', 17], ['chopstick', 'read', 17]]);
  for (const snap of cx.final.filter((entry) => entry.process.label.startsWith('philosopher'))) assert.match(snap.description, /waits to write true on right/);
  for (const snap of cx.final.filter((entry) => entry.process.label.startsWith('chopstick'))) assert.match(snap.description, /waits to read left/);
  const overlays = buildOverlays(analyzed.model, [report], { documentVersion: 1 });
  const deadlock = overlays.find((entry) => entry.check === 'deadlock-free' && entry.view === programView(analyzed.model).id)!;
  assert.equal(deadlock.cycles[0].nodes.length, 6);
  assert.equal(deadlock.cycles[0].edges.length, 6, 'every arrow of the circle is drawn red');
  assert.ok(deadlock.processes.filter((entry) => entry.label !== 'main').every((entry) => entry.cause === 'root'));
  // The run that never ends (Terminates, informational) leaves nothing stuck for good: no circle, no red.
  const lasso = overlays.find((entry) => entry.check === 'terminates' && entry.view === programView(analyzed.model).id)!;
  assert.deepEqual(lasso.cycles, []);
  assert.ok(lasso.processes.every((entry) => entry.cause !== 'root'), 'a process the run only starves is not stuck for good');
  assert.ok(lasso.processes.filter((entry) => entry.status === 'blocked').every((entry) => entry.forGood === false));
  for (const sentence of lasso.story.filter((entry) => / at line /.test(entry))) assert.doesNotMatch(sentence, / is stuck /, sentence);
  // That check hides every event only to ask whether the program ends: its steps on the chopsticks'
  // channels were seen outside all the same, the start of the par was not.
  assert.deepEqual(lasso.steps.map((step) => [step.kind, step.visible]), report.checks[2].counterexample!.steps.map((step) => [step.kind, step.kind !== 'internal']));
  // main's par waits for all six of its branches, not only the one it collects first.
  assert.equal(cx.final.find((snap) => snap.process.label === 'main')?.waits?.[0].detail, 'waits at its par for philosopher(0, …), philosopher(1, …), philosopher(2, …) and 3 more to finish');
  // In the deadlock nothing can go on: every blocked process is stuck for good.
  assert.ok(deadlock.processes.filter((entry) => entry.status === 'blocked').every((entry) => entry.forGood === true));
  const payload = await buildViewerPayload({ model: analyzed.model, reports: [report], documentVersion: 1 });
  const drawn = payload.overlays.find((entry) => entry.check === 'deadlock-free')!;
  // Six red badges, and the circle as a band along the six arrows that join its processes.
  assert.equal((drawn.over.match(/pj-ov-blocked-badge/g) ?? []).length, 6);
  assert.equal((drawn.under.match(/class="pj-ov-cycle-route"/g) ?? []).length, 6);
  // Every process the model has, in the report: the snapshots carry FDR's states.
  assert.ok(cx.final.every((snap) => snap.trail && snap.trail.length >= 2));
  assert.equal(model.sourceMap.processes.filter((entry) => entry.process).length, cx.final.length);
});

test('state machines: every state is a definition of the model, every transition a reference its CSPm makes', async () => {
  for (const file of ['dining_philosophers.pj', 'par_deadlock.pj', 'clean_pipeline.pj', 'pri_alt_skip.pj']) {
    const loaded = loadProgram(path.join(EXAMPLES, file), INCLUDE);
    const model = translateProgram({ units: loaded.units, index: loaded.index });
    const machines = stateMachines(model);
    assert.ok(machines.length > 0, file);
    const lines = model.text.split('\n');
    // A definition is its line and the indented lines under it (an alt's other guards).
    const bodyOf = (name: string): string => {
      const start = lines.findIndex((line) => line.startsWith(`${name}(`) || line.startsWith(`${name} =`));
      if (start < 0) return '';
      let end = start + 1;
      while (end < lines.length && /^\s/.test(lines[end])) end++;
      return lines.slice(start, end).join('\n');
    };
    const seen = new Set<string>();
    for (const machine of machines) {
      assert.ok(machine.states.some((state) => state.id === machine.initial), `${file} ${machine.key}: starts in one of its states`);
      for (const state of machine.states) {
        if (state.kind === 'return' || state.kind === 'stop') continue;
        assert.ok(model.sourceMap.definitions[state.id], `${file}: ${state.id} is a definition of the model`);
        assert.ok(bodyOf(state.id), `${file}: ${state.id} is defined in the CSPm`);
        assert.ok(!seen.has(state.id), `${file}: ${state.id} is in one machine only`);
        seen.add(state.id);
      }
      for (const t of machine.transitions) {
        assert.ok(machine.states.some((state) => state.id === t.from) && machine.states.some((state) => state.id === t.to), `${file}: ${t.from} -> ${t.to} joins two states of ${machine.key}`);
        // The body of `from` names where it goes (an end is STOP or the continuation).
        if (t.to !== 'return' && t.to !== 'STOP') assert.match(bodyOf(t.from), new RegExp(`\\b${t.to.replace(/[$]/g, '\\$&')}\\b`), `${file}: ${t.from}'s body leads to ${t.to}`);
      }
    }
    // Every state a procedure's process can be in is in a machine.
    for (const d of Object.values(model.sourceMap.definitions)) {
      if (d.procedure && ['entry', 'point', 'join', 'slot', 'branch-end'].includes(d.kind)) assert.ok(seen.has(d.name), `${file}: ${d.name} has a machine`);
    }
  }
});

test('state machines: the philosophers and the chopsticks, as the generated CSPm says', () => {
  const loaded = loadProgram(path.join(EXAMPLES, 'dining_philosophers.pj'), INCLUDE);
  const machines = stateMachines(translateProgram({ units: loaded.units, index: loaded.index }));
  const of = (key: string): CspMachine => machines.find((machine) => machine.key === key)!;
  const philosopher = of('philosopher');
  assert.deepEqual(philosopher.states.map((state) => [state.id, state.label]), [
    ['philosopher__body', 'start'],
    ['philosopher__26', 'loop'],
    ['philosopher__27', 'write left'],
    ['philosopher__28', 'write right'],
    ['philosopher__30', 'write left'],
    ['philosopher__31', 'write right'],
  ]);
  assert.deepEqual(philosopher.transitions.map((t) => `${t.from} -${t.label}-> ${t.to}`), [
    'philosopher__body --> philosopher__26',
    'philosopher__26 --> philosopher__27',
    'philosopher__27 -write left-> philosopher__28',
    'philosopher__28 -write right-> philosopher__30',
    'philosopher__30 -write left-> philosopher__31',
    'philosopher__31 -write right-> philosopher__26',
  ]);
  // The chopstick's alt: one transition per guard.
  const chopstick = of('chopstick');
  assert.deepEqual(chopstick.transitions.filter((t) => t.guard !== undefined).map((t) => [t.label, t.guard]), [['read left', 0], ['read right', 1]]);
  // Each branch of main's par is a machine of its own: started by the par, it calls its procedure.
  const branch = machines.find((machine) => machine.procedure === 'main' && machine.region?.index === 1)!;
  assert.deepEqual(branch.transitions.map((t) => [t.label, t.call]), [['start, call philosopher', 'philosopher'], ['branch 1 ends', undefined]]);
  // A loop test the model leaves to FDR makes two conditional transitions.
  const pipeline = loadProgram(path.join(EXAMPLES, 'clean_pipeline.pj'), INCLUDE);
  const tests = stateMachines(translateProgram({ units: pipeline.units, index: pipeline.index })).flatMap((machine) => machine.transitions).filter((t) => /^\[/.test(t.label));
  assert.ok(tests.length >= 2 && tests.every((t) => t.conditional));
});

test('the states FDR names in a recorded counterexample are states of the machines, and a trail is placed on them', async () => {
  for (const [file, name] of [['dining_philosophers.pj', 'dining_philosophers'], ['par_deadlock.pj', 'par_deadlock']] as const) {
    const { analyzed, model, run, report } = await checked(path.join(EXAMPLES, file), name);
    const machines = stateMachines(model);
    for (const state of namedStates(run, model)) {
      const { name: definition } = parseState(state);
      if (definition === 'STOP' || definition === 'SKIP') continue;
      const info = model.sourceMap.definitions[definition];
      assert.ok(info, `${file}: FDR's state ${state} is a definition`);
      // The network's own definitions (MAIN, the barriers' counters) are not a procedure's states.
      if (info.kind === 'process' || info.kind === 'helper' || !info.procedure) continue;
      assert.ok(machineOfState(machines, state), `${file}: FDR's state ${state} is a state of a machine`);
    }
    // Each process's trail lands in the machine of the box that stands for it.
    const view = programView(analyzed.model);
    const overlays = buildOverlays(analyzed.model, [report], { documentVersion: 1 });
    const overlay = overlays.find((entry) => entry.check === 'deadlock-free' && entry.view === view.id)!;
    for (const placed of overlay.processes) {
      const node = view.nodes.find((entry) => entry.id === placed.node)!;
      const ref = nodeMachine(view, node);
      const machine = machines.find((entry) => refOfMachine(entry) === ref);
      assert.ok(machine, `${file}: ${placed.label} runs a machine of the model`);
      const last = placed.trail![placed.trail!.length - 1];
      assert.ok(placeInMachine(last.state, machine!), `${file}: ${placed.label} ends in a state of ${machine!.key}`);
    }
  }
});

test('a philosopher\'s machine with its run: the states in order, stuck where FDR says', async () => {
  const { analyzed, model, report } = await checked(path.join(EXAMPLES, 'dining_philosophers.pj'), 'dining_philosophers');
  const machines = stateMachines(model);
  const philosopher = machines.find((machine) => machine.key === 'philosopher')!;
  const snap = report.checks[0].counterexample!.final.find((entry) => entry.process.label.startsWith('philosopher(0'))!;
  const viewerMachine = buildViewerMachine({
    request: { target: 'program', ref: refOfMachine(philosopher), check: 'program/deadlock-free', process: pathKey(snap.process.path) },
    machine: philosopher,
    machines,
    layout: await layoutMachine(philosopher),
    model: 'the model FDR checked (the whole program)',
    trail: snap.trail,
    process: { label: snap.process.label, status: snap.status, description: snap.description, waits: (snap.waits ?? []).map((wait) => wait.detail) },
  });
  // Waiting to be started by main's par, then at its first write, then stuck at its second.
  assert.deepEqual(viewerMachine.trail!.map((entry) => [entry.step, entry.id, entry.label]), [
    [0, undefined, 'main: branch 1 of the par (line 38): not started: waits for its par'],
    [1, 'philosopher__27', 'write left (line 27)'],
    [3, 'philosopher__28', 'write right (line 28)'],
  ]);
  assert.equal(viewerMachine.process?.status, 'blocked');
  assert.match(viewerMachine.svg, /data-state="philosopher__28"/);
  assert.ok(viewerMachine.states.every((state) => state.width > 0 && state.height > 0));
  assert.ok(analyzed.model.views.length > 0);
});

test('a procedure checked on its own lands on its own view, its channel parameters as the ports', async () => {
  const { analyzed, report } = await checked(path.join(ROOT, 'test', 'fixtures', 'processj', 'commstime.pj'), 'commstime_succ', 'succ');
  const range = report.checks.find((check) => check.id === 'no-runtime-errors')!;
  assert.equal(range.status, 'failed');
  assert.equal(range.severity, 'warning', 'leaving the modelled integers is the model\'s limit, not an error of the program');
  placeAll(analyzed, report);
  const overlays = buildOverlays(analyzed.model, [report], { documentVersion: 1 });
  const view = analyzed.model.views.find((entry) => entry.id === preferredView(analyzed.model, range, overlays, 0))!;
  assert.equal(view.kind, 'procedure');
  assert.equal(view.procedure, 'succ');
  const overlay = overlays.find((entry) => entry.view === view.id && entry.check === range.id)!;
  assert.equal(overlay.relocated, undefined, 'on its own view, not on a call of it');
  assert.ok(overlay.error?.node, 'the runtime error is drawn on the process');
  // The steps go through succ's parameters: the ports of its view.
  const ports = view.nodes.filter((node) => node.kind === 'port').map((node) => node.label).sort();
  assert.deepEqual(ports, ['in', 'out']);
  assert.ok(overlay.steps.every((step) => !step.channel || view.channels.some((channel) => channel.id === step.channel && channel.port)));
});

test('a procedure checked on its own beside the program: both recorded for the server tests', async () => {
  // The philosopher on its own: its caller (FDR's environment) always takes what it writes, so it never deadlocks.
  const { report } = await checked(path.join(EXAMPLES, 'dining_philosophers.pj'), 'dining_philosophers_philosopher', 'philosopher');
  assert.equal(report.checks.find((check) => check.property === 'deadlock-free')?.status, 'passed');
  assert.ok(report.checks.every((check) => check.target.kind === 'procedure' && check.target.name === 'philosopher'));
});

test('a par for whose body has several statements: the iterations FDR reports land on its box, the processes they start on the boxes below', async () => {
  // The compiled program runs each statement of the body as a process of its own (the view draws that); the
  // model runs each iteration as one process, so its paths have no step for the statement.
  const local = await checkedSource([
    'public void main(string[] args) {',
    '    par for (int i = 0; i < 2; i++) {',
    '        chan<int> e, f;',
    '        par {',
    '            { e.write(1); int x = f.read(); }',
    '            { f.write(2); int y = e.read(); }',
    '        }',
    '    }',
    '}',
  ].join('\n'), 'par_for_local');
  placeAll(local.analyzed, local.report);
  const overlays = buildOverlays(local.analyzed.model, [local.report], { documentVersion: 1 });
  const deadlock = overlays.find((entry) => entry.check === 'deadlock-free')!;
  const stuck = deadlock.processes.filter((entry) => entry.cause === 'root');
  assert.equal(stuck.length, 4, 'both branches of both iterations, on the boxes of the par\'s branches');
  assert.deepEqual([...new Set(stuck.map((entry) => entry.at?.span.start.line))], [4, 5]);
  assert.ok(deadlock.cycles.every((cycle) => new Set(cycle.nodes).size === 2), 'each circle joins the two branch boxes');
  // Every iteration of a par for drawn on one box, waiting for each other in pairs: told on the box, not a crash.
  const fibonacci = await checkedSource(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'processj', 'fibonacci.pj'), 'utf8'), 'par_for_body');
  placeAll(fibonacci.analyzed, fibonacci.report);
  const payload = await buildViewerPayload({ model: fibonacci.analyzed.model, reports: [fibonacci.report], documentVersion: 1 });
  const drawn = payload.overlays.find((entry) => entry.check === 'deadlock-free' && entry.view === programView(fibonacci.analyzed.model).id)!;
  assert.match(drawn.over, /circular waits among the iterations of /);
  assert.doesNotMatch(drawn.over, /undefined/);
});

test('what a run relies on goes with it: the panel, the chip, the steps, and the picture\'s caption', async () => {
  const { analyzed, report } = await checkedSource(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'processj', 'alttest.pj'), 'utf8'), 'alt_skip');
  const overlays = buildOverlays(analyzed.model, [report], { documentVersion: 1 });
  const deadlock = overlays.find((entry) => entry.check === 'deadlock-free' && entry.view === programView(analyzed.model).id)!;
  assert.equal(deadlock.caveats.length, 1);
  assert.match(deadlock.caveats[0], /^reader takes the skip guard at line 18 \(step 2\): ProcessJ takes the first ready guard/);
  // The step the model decides: what the real program would need.
  assert.equal(deadlock.steps[1].caveat, 'the real program takes the skip guard only while in1 has no writer ready');
  const chips = verdictChips(analyzed.model, [report], overlays, { documentVersion: 1 });
  assert.deepEqual(chips.find((chip) => chip.check === 'deadlock-free')?.caveats, deadlock.caveats);
  const view = programView(analyzed.model);
  const svg = renderNetworkSvg(view, await layoutView(view), { overlay: deadlock });
  assert.match(svg, /Caveat: reader takes the skip guard/);
});

test('the story starts with the cause: the circle first, then who is in it, then the pars behind them', async () => {
  const dining = await checked(path.join(EXAMPLES, 'dining_philosophers.pj'), 'dining_philosophers');
  const view = programView(dining.analyzed.model);
  const overlays = buildOverlays(dining.analyzed.model, [dining.report], { documentVersion: 1 });
  const told = overlays.find((entry) => entry.check === 'deadlock-free' && entry.view === view.id)!.story;
  assert.match(told[0], /^A circular wait: philosopher\(0, …\) waits for chopstick\(/);
  assert.match(told[1], /^philosopher\(0, …\) is stuck at line 28 writing p0f1: chopstick\(/);
  // main only follows from the rest: its par, without every branch's wait again.
  assert.equal(told[told.length - 1], 'main is stuck at line 37 (waiting at its par for philosopher(0, …), philosopher(1, …), philosopher(2, …) and 3 more to finish).');
  // A wait nobody can answer comes before what keeps running and the par behind it.
  const partial = await checkedSource([
    'public void ticker(chan<int>.write out) { while (true) out.write(0); }',
    'public void sink(chan<int>.read in) { while (true) { int v = in.read(); } }',
    'public void main(string[] args) {',
    '    chan<int> a, c;',
    '    par {',
    '        ticker(a.write);',
    '        sink(a.read);',
    '        c.write(1);',
    '    }',
    '}',
  ].join('\n'), 'partial');
  const lasso = buildOverlays(partial.analyzed.model, [partial.report], { documentVersion: 1 }).find((entry) => entry.check === 'terminates')!;
  assert.deepEqual(lasso.story, [
    'branch 3 is stuck at line 8 writing c: nothing in the program reads c.',
    'ticker (line 1) and sink (line 2) keep running: they take part in the steps that repeat.',
    'main is stuck at line 5 (waiting at its par for ticker, sink and branch 3 to finish).',
  ]);
  // Two calls of one procedure in the same state are told once, by the names that tell them apart.
  const barrier = await checkedSource(['public void a(barrier b) {', '    b.sync();', '}', 'public void c() {', '}', 'public void main(string[] args) {', '    barrier b;', '    par enroll (b) {', '        a(b);', '        a(b);', '        c();', '    }', '}'].join('\n'), 'barrier_resign');
  const resigned = buildOverlays(barrier.analyzed.model, [barrier.report], { documentVersion: 1 }).find((entry) => entry.check === 'deadlock-free')!;
  assert.match(resigned.story[0], /^a \(line 9\) and a \(line 10\) are stuck at line 2 syncing on b: c has ended and resigned from b/);
  assert.deepEqual(resigned.processes.map((entry) => entry.name), ['main', 'a (line 9)', 'a (line 10)', 'c']);
});

test('the chips say how each run ends: stuck, forever, at an error, where the model stops, or which choice it turns on', async () => {
  const chipsOf = async (file: string, name: string, procedure?: string): Promise<Record<string, string>> => {
    const { analyzed, report } = await checked(file, name, procedure);
    const overlays = buildOverlays(analyzed.model, [report], { documentVersion: 1 });
    return Object.fromEntries(verdictChips(analyzed.model, [report], overlays, { documentVersion: 1 }).map((chip) => [chip.check, chip.text]));
  };
  // A program that deadlocks does not terminate because it gets stuck, not because it runs forever.
  assert.deepEqual(await chipsOf(path.join(EXAMPLES, 'par_deadlock.pj'), 'par_deadlock'), { 'deadlock-free': 'deadlock after 1 step', 'no-runtime-errors': 'holds', terminates: 'gets stuck after 1 step' });
  const succ = await chipsOf(path.join(ROOT, 'test', 'fixtures', 'processj', 'commstime.pj'), 'commstime_succ', 'succ');
  assert.match(succ['no-runtime-errors'], /^out of the modelled integers after \d+ steps?$/);
  // A choice is about what the outside sees: counted in visible steps.
  const race = await checkedSource([
    'public void race(chan<int>.write out) {',
    '    chan<int> a, b;',
    '    par {',
    '        a.write(1);',
    '        b.write(2);',
    '        {',
    '            int x = 0;',
    '            alt {',
    '                x = a.read() : { out.write(1); x = b.read(); }',
    '                x = b.read() : { out.write(2); x = a.read(); }',
    '            }',
    '        }',
    '    }',
    '}',
    'public void main(string[] args) { }',
  ].join('\n'), 'race', 'race');
  const overlays = buildOverlays(race.analyzed.model, [race.report], { documentVersion: 1 });
  const choice = overlays.find((entry) => entry.check === 'deterministic')!;
  assert.equal(verdictChips(race.analyzed.model, [race.report], overlays, { documentVersion: 1 }).find((chip) => chip.check === 'deterministic')?.text, 'nondeterministic at the start');
  // It is told by its summary, and the choice is marked where the alt takes it.
  assert.match(choice.story[0], /^Nondeterministic at the start: whether race can write [12] on out depends on an internal step/);
  assert.equal(choice.choice?.at?.span.start.line, 9);
  assert.ok(choice.choice?.node);
  // No process of the report says its last step was one the report does not have.
  for (const snapshot of race.report.checks.find((check) => check.id === 'deterministic')!.counterexample!.final) {
    const last = /its last step was (\d+)/.exec(snapshot.description)?.[1];
    if (last) assert.ok(Number(last) <= choice.steps.length, snapshot.description);
  }
});

test('the Markdown report says an FDR failure\'s summary once, with its caveats', async () => {
  const { analyzed, report } = await checkedSource(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'processj', 'alttest.pj'), 'utf8'), 'alt_skip');
  const text = formatConcurrencyMarkdown('alt_skip.pj', analyzed.model, [report]);
  const summary = report.checks[0].counterexample!.summary;
  assert.equal(text.split(summary).length - 1, 1, text);
  assert.match(text, /\n {2}- Caveat: reader takes the skip guard at line 18/);
});

test('the reasons on the canvas name the partner that never comes, and a value from the caller travels through its port', async () => {
  const barrier = await checkedSource([
    'public void main(string[] args) {',
    '    barrier b;',
    '    chan<int> c;',
    '    par enroll (b) {',
    '        b.sync();',
    '        b.sync();',
    '        { int x = c.read(); }',
    '    }',
    '}',
  ].join('\n'), 'barrier_never');
  const never = buildOverlays(barrier.analyzed.model, [barrier.report], { documentVersion: 1 }).find((entry) => entry.check === 'deadlock-free')!;
  assert.deepEqual(never.waits.filter((wait) => wait.operation === 'sync').map((wait) => wait.short), ['branch 3 never syncs on b', 'branch 3 never syncs on b']);
  const succ = await checked(path.join(ROOT, 'test', 'fixtures', 'processj', 'commstime.pj'), 'commstime_succ', 'succ');
  const overlays = buildOverlays(succ.analyzed.model, [succ.report], { documentVersion: 1 });
  const range = succ.report.checks.find((check) => check.id === 'no-runtime-errors')!;
  const overlay = overlays.find((entry) => entry.check === range.id && entry.view === preferredView(succ.analyzed.model, range, overlays, 0))!;
  const read = overlay.steps.find((step) => step.kind === 'communication' && step.participants.every((participant) => participant.role === 'reader'))!;
  assert.ok(read.route.length > 0, `${read.description}: the value comes in from the port`);
});

test('the sequence chart tells a run that repeats forever from a deadlock, fits its labels to the lanes, and ends a finished lifeline after its last step', async () => {
  const dining = await checked(path.join(EXAMPLES, 'dining_philosophers.pj'), 'dining_philosophers');
  // The Terminates run only leaves its waiting processes waiting: no red cross for them.
  const lasso = renderSequenceChart(dining.report.checks.find((check) => check.id === 'terminates')!.counterexample!);
  assert.doesNotMatch(lasso, /<g class="pj-msc-blocked"><path class="pj-msc-x"/);
  assert.match(lasso, /pj-msc-blocked pj-msc-left/);
  const stuck = renderSequenceChart(dining.report.checks[0].counterexample!);
  assert.match(stuck, /<g class="pj-msc-blocked"><path class="pj-msc-x"/);
  // main's par wait is long: its label under its lane is cut to the lane (11 px text, 0.6 em a character).
  const lane = Number(/<rect class="pj-msc-head" [^>]*width="([\d.]+)"/.exec(stuck)?.[1]) + 20;
  const labels = [...stuck.matchAll(/<text class="pj-msc-stuck"[^>]*>([^<]*)<\/text>/g)].map((match) => match[1]);
  assert.match(labels[0], /^waits at its par for .*…$/);
  assert.ok(labels.every((label) => label.length * 6.6 <= lane - 12), `${lane}: ${labels.join(' | ')}`);
  // consume ends after its last step, not at the bottom of the chart.
  const ended = await checkedSource(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'processj', 'commstime.pj'), 'utf8').replace(/1000000/g, '5').replace(/999999/g, '4').replace(/(public void consume[\s\S]*?while \(l < )5/, '$13'), 'reader_ended');
  const chart = renderSequenceChart(ended.report.checks[0].counterexample!);
  assert.match(chart, /<title>consume ends after step \d+<\/title>/);
});

test('a process inside a call is on that call\'s arrow of its machine, not at the state it goes on at', async () => {
  const { model, report } = await checkedSource([
    'public void send(chan<int>.write out, int v) {',
    '    out.write(v);',
    '}',
    '',
    'public void worker(chan<int>.write out, chan<int>.read ack) {',
    '    send(out, 1);',
    '    send(out, 2);',
    '    int x = ack.read();',
    '}',
    '',
    'public void boss(chan<int>.read in, chan<int>.write ack) {',
    '    int a = in.read();',
    '    ack.write(a);',
    '}',
    '',
    'public void main(string[] args) {',
    '    chan<int> c, d;',
    '    par {',
    '        worker(c.write, d.read);',
    '        boss(c.read, d.write);',
    '    }',
    '}',
  ].join('\n'), 'call_inside');
  const machines = stateMachines(model);
  const worker = machines.find((machine) => machine.key === 'worker')!;
  const snap = report.checks[0].counterexample!.final.find((entry) => entry.process.procedure === 'worker')!;
  const viewer = buildViewerMachine({ request: { target: 'program', ref: refOfMachine(worker), check: 'program/deadlock-free', process: pathKey(snap.process.path) }, machine: worker, machines, layout: await layoutMachine(worker), model: 'the model FDR checked', trail: snap.trail, process: { label: 'worker', status: snap.status, description: snap.description, waits: [] } });
  const last = viewer.trail![viewer.trail!.length - 1];
  // Stuck writing in the second send (line 7), not at the read of ack (line 8) it goes on to.
  assert.equal(last.id, undefined);
  assert.equal(viewer.transitions[last.call!].label, 'call send');
  assert.equal(viewer.transitions[last.call!].line, 6);
  assert.match(last.label, /^inside the call of send at line 7: send: write out \(line 2\)$/);
  // Before that, inside the first send: on the first call's arrow.
  assert.deepEqual(viewer.trail!.map((entry) => entry.call === undefined ? entry.id ?? null : `call at line ${viewer.transitions[entry.call].line! + 1}`), [null, 'call at line 6', 'call at line 7']);
});

test('a branch that ran and was collected by its par is said to have finished, not to wait to be started', async () => {
  // The reader reads five of the six values and ends; main's par collects it and waits for the writer left over.
  const writers = await checkedSource([
    'public void reader(chan<int>.read in) {',
    '    for (int k = 0; k < 5; k++) {',
    '        int v = in.read();',
    '    }',
    '}',
    'public void writer(int id, shared chan<int>.write out) {',
    '    for (int i = 0; i < 2; i++) out.write(id);',
    '}',
    'public void main(string[] args) {',
    '    shared write chan<int> c;',
    '    par {',
    '        reader(c.read);',
    '        writer(1, c.write);',
    '        writer(2, c.write);',
    '        writer(3, c.write);',
    '    }',
    '}',
  ].join('\n'), 'shared_writers');
  const machines = stateMachines(writers.model);
  const reader = machines.find((machine) => machine.key === 'reader')!;
  const snap = writers.report.checks[0].counterexample!.final.find((entry) => entry.process.procedure === 'reader')!;
  assert.equal(snap.status, 'terminated');
  const viewer = buildViewerMachine({ request: { target: 'program', ref: refOfMachine(reader) }, machine: reader, machines, layout: await layoutMachine(reader), model: 'the model FDR checked', trail: snap.trail });
  assert.match(viewer.trail![0].label, /: not started: waits for its par$/);
  assert.match(viewer.trail![viewer.trail!.length - 1].label, /: finished, and collected by its par$/);
});

test('a model translated from an imported file too: recorded for the server tests', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'processj-fdr-imported-'));
  try {
    for (const [name, text] of Object.entries(IMPORTED)) {
      fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      fs.writeFileSync(path.join(dir, name), text);
    }
    const loaded = loadProgram(path.join(dir, 'uses_lib.pj'), INCLUDE, undefined, [dir]);
    assert.equal(loaded.units.length, 2, 'the importing file and lib/workers.pj');
    const model = translateProgram({ units: loaded.units, index: loaded.index });
    const report = explain(model, await recordedRun('imported', model), { uri: loaded.units[0].uri });
    // writer2's second write, in the imported file, has no reader left.
    const stuck = report.checks[0].counterexample!.final.find((snap) => snap.process.procedure === 'writer2')!;
    assert.equal(stuck.at?.uri, loaded.units[1].uri);
    assert.equal(stuck.at?.span.start.line, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('how the dining philosophers lock up: each process in the order it got stuck, then the circle closing link by link', async () => {
  const { analyzed, report } = await checked(path.join(EXAMPLES, 'dining_philosophers.pj'), 'dining_philosophers');
  const view = programView(analyzed.model);
  const overlays = buildOverlays(analyzed.model, [report], { documentVersion: 1 });
  const deadlock = overlays.find((entry) => entry.check === 'deadlock-free' && entry.view === view.id)!;
  const cx = report.checks[0].counterexample!;
  const name = (key: string): string => cx.final.find((snap) => pathKey(snap.process.path) === key)!.process.name ?? '';
  // Each stuck process after the last step it took part in, ties in the report's order (main's par started them all).
  assert.deepEqual(deadlock.formation.map((step) => [step.kind, step.keys.map(name).join('+'), step.after]), [
    ['stuck', 'main', 0],
    ['stuck', 'philosopher(1, …)', 1],
    ['stuck', 'chopstick(p1f1.read, …)', 1],
    ['stuck', 'philosopher(0, …)', 2],
    ['stuck', 'chopstick(p0f0.read, …)', 2],
    ['stuck', 'philosopher(2, …)', 3],
    ['stuck', 'chopstick(p2f2.read, …)', 3],
    ['cycle', 'philosopher(0, …)+chopstick(p1f1.read, …)', undefined],
    ['cycle', 'chopstick(p1f1.read, …)+philosopher(1, …)', undefined],
    ['cycle', 'philosopher(1, …)+chopstick(p2f2.read, …)', undefined],
    ['cycle', 'chopstick(p2f2.read, …)+philosopher(2, …)', undefined],
    ['cycle', 'philosopher(2, …)+chopstick(p0f0.read, …)', undefined],
    ['cycle', 'chopstick(p0f0.read, …)+philosopher(0, …)', undefined],
  ]);
  // Who, what it waits for, where, and whom that depends on: only what the report says.
  assert.equal(deadlock.formation[0].caption, 'main is stuck at line 37 after step 1: it waits at its par for philosopher(0, …), philosopher(1, …), philosopher(2, …) and 3 more to finish.');
  assert.equal(deadlock.formation[1].caption, 'philosopher(1, …) is stuck at line 28 after step 2: it waits to write true on right (p1f2), whose reader chopstick(p2f2.read, …) is itself waiting to read left (p2f2) for philosopher(2, …).');
  assert.equal(deadlock.formation[2].caption, 'chopstick(p1f1.read, …) is stuck at line 18 after step 2: it waits to read left (p1f1), whose writer philosopher(1, …) is itself waiting to write true on right (p1f2) for chopstick(p2f2.read, …).');
  assert.equal(deadlock.formation[1].title, 'philosopher(1, …) stuck at line 28');
  assert.ok(deadlock.formation.every((step) => !/\bholds?\b/.test(step.caption)), 'nothing the report does not say');
  assert.equal(deadlock.formation[7].caption, 'Closing the circle, link 1 of 6: philosopher(0, …) waits for chopstick(p1f1.read, …) on p0f1.');
  assert.equal(deadlock.formation[12].caption, 'Circular wait: philosopher(0, …) → chopstick(p1f1.read, …) → philosopher(1, …) → chopstick(p2f2.read, …) → philosopher(2, …) → chopstick(p0f0.read, …) → philosopher(0, …). main is stuck behind it. Nobody can move.');
  // Each step lands on the drawing: a stuck process on its box with the arrow it waits on and its partner's box;
  // a link on the arrow of the circle that joins its two boxes.
  const placed = (key: string): string => deadlock.processes.find((process) => process.key === key)!.node;
  for (const step of deadlock.formation.filter((entry) => entry.kind === 'stuck')) {
    assert.deepEqual(step.nodes, step.keys.map(placed));
    const waits = deadlock.waits.filter((wait) => step.nodes.includes(wait.node));
    assert.deepEqual(step.edges, waits.map((wait) => wait.edge).filter(Boolean));
    // A par's partner is only the first of its branches: no partner is ringed for it.
    assert.deepEqual(step.partners, waits.filter((wait) => wait.operation !== 'other').map((wait) => wait.partnerNode).filter(Boolean));
  }
  const links = deadlock.formation.filter((entry) => entry.kind === 'cycle');
  assert.deepEqual(links.flatMap((step) => step.edges).sort(), [...deadlock.cycles[0].edges].sort(), 'the links cover the circle, each arrow once');
  assert.ok(links.every((step) => step.edges.length === 1 && step.nodes.length === 2));
  // The termination check repeats forever: nothing locks up there, and the checker's results are no runs.
  assert.deepEqual(overlays.find((entry) => entry.check === 'terminates' && entry.view === view.id)!.formation, []);
});

test('how a run without a circle locks up: the processes in order, then the dead end the others wait behind', async () => {
  const read = await checkedSource(fs.readFileSync(path.join(EXAMPLES, 'deadlock_read.pj'), 'utf8'), 'no_writer');
  const lonely = buildOverlays(read.analyzed.model, [read.report], { documentVersion: 1 }).find((entry) => entry.check === 'deadlock-free')!;
  // No trace at all: stuck from the start, which the caption then does not say.
  assert.deepEqual(lonely.formation.map((step) => [step.kind, step.caption]), [
    ['stuck', 'main is stuck at line 8: it waits to read c; nothing in the program writes c.'],
    ['dead-end', 'Dead end: main can never read c at line 8: nothing in the program writes c. Nobody can move.'],
  ]);
  assert.equal(lonely.formation[0].edges.length, 1, 'the read, on its arrow from the missing writer');
  const ended = await checkedSource(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'processj', 'commstime.pj'), 'utf8').replace(/1000000/g, '5').replace(/999999/g, '4').replace(/(public void consume[\s\S]*?while \(l < )5/, '$13'), 'reader_ended');
  const view = programView(ended.analyzed.model);
  const overlay = buildOverlays(ended.analyzed.model, [ended.report], { documentVersion: 1 }).find((entry) => entry.check === 'deadlock-free' && entry.view === view.id)!;
  assert.deepEqual(overlay.formation.map((step) => [step.kind, step.title, step.after]), [
    ['stuck', 'main stuck at line 42', 0],
    ['stuck', 'delta stuck at line 24', 30],
    ['stuck', 'branch 1 of delta stuck at line 25', 30],
    ['stuck', 'prefix stuck at line 8', 32],
    ['dead-end', 'dead end', undefined],
  ]);
  assert.equal(overlay.formation[3].caption, 'prefix is stuck at line 8 after step 33: it waits to write 5 on out (d), whose reader delta is itself waiting at its par for branch 1 to finish.');
  assert.equal(overlay.formation[4].caption, 'Dead end: branch 1 of delta can never write 4 on out1 (a) at line 25: consume, the only reader of a (line 35), has already terminated (its last step was 27). main, delta and prefix are stuck behind it. Nobody can move.');
  // The dead end is drawn where it is: the write's arrow, and the reader that finished.
  const consume = overlay.processes.find((process) => process.name === 'consume')!.node;
  assert.deepEqual(overlay.formation[4].partners, [consume]);
  assert.deepEqual(overlay.formation[4].edges, overlay.formation[2].edges);
});

test('the sequence chart marks where each lane gets stuck, after the last step it takes part in', async () => {
  const dining = await checked(path.join(EXAMPLES, 'dining_philosophers.pj'), 'dining_philosophers');
  const cx = dining.report.checks[0].counterexample!;
  const chart = renderSequenceChart(cx);
  const marks = [...chart.matchAll(/<g class="pj-msc-from" data-stuck="([^"]*)">.*?<title>([^<]*)<\/title><\/g>/g)];
  assert.equal(marks.length, 7, 'one per process stuck for good');
  const titles = new Map(marks.map((match) => [match[1].replace(/&amp;/g, '&'), match[2]]));
  const keyOf = (label: string): string => pathKey(cx.final.find((snap) => snap.process.label.startsWith(label))!.process.path);
  assert.equal(titles.get(keyOf('main')), 'main is stuck from here: it takes part in no step after step 1');
  assert.equal(titles.get(keyOf('philosopher(1')), 'philosopher(1, …) is stuck from here: it takes part in no step after step 2');
  assert.equal(titles.get(keyOf('chopstick(p2f2')), 'chopstick(p2f2.read, …) is stuck from here: it takes part in no step after step 4');
  // Its own group, outside the end state's, so the viewer can light each one up alone.
  assert.ok(chart.indexOf('class="pj-msc-from-marks"') < chart.indexOf('data-step="final"'));
  // A run that repeats forever leaves processes waiting, not stuck: nothing is marked.
  assert.doesNotMatch(renderSequenceChart(dining.report.checks[2].counterexample!), /pj-msc-from"/);
});
