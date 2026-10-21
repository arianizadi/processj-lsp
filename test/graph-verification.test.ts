import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { findProcess } from '../src/graph/network';
import { buildOverlays, formationSteps, pathKey, preferredView, shortReason, story, verdictChips } from '../src/graph/overlay';
import { staticVerificationReport } from '../src/graph/static-verification';
import type { Counterexample, ProcessRef, ProcessSnapshot, VerificationReport } from '../src/verification';
import { analyzeFile, analyzeSource, at, programView, ROOT } from './graph-helpers';

const EXAMPLES = path.join(ROOT, 'examples');
const VERIFICATION = path.join(ROOT, 'test', 'fixtures', 'verification');
const FIXTURE_URI = 'file:///fixtures/verification/commstime_bounded.pj';

function staticFor(file: string) {
  const analyzed = analyzeFile(file);
  return { ...analyzed, report: staticVerificationReport(analyzed.program, analyzed.checked, { uri: analyzed.uri, documentVersion: 3, model: analyzed.model }) };
}

test('a proven par deadlock becomes a failed deadlock check with every branch, its wait and the cycle', () => {
  const { report, model } = staticFor(path.join(EXAMPLES, 'par_deadlock.pj'));
  assert.equal(report.producer, 'checker');
  assert.equal(report.documentVersion, 3);
  assert.ok(report.assumptions.some((line) => /not a proof of deadlock freedom/.test(line)));
  assert.equal(report.checks.length, 1);
  const [check] = report.checks;
  assert.equal(check.property, 'deadlock-free');
  assert.equal(check.status, 'failed');
  assert.deepEqual(check.target, { kind: 'program', name: 'main', at: { uri: model.uri, span: check.target.at!.span } });
  const counterexample = check.counterexample!;
  assert.equal(counterexample.kind, 'deadlock');
  assert.deepEqual(counterexample.steps, [], 'static analysis has no trace');
  assert.equal(counterexample.summary, "deadlock when the par at line 10 runs: branch 1 waits to write 'c' while branch 2 waits to write 'd'; neither can reach the operation the other needs");
  assert.deepEqual(counterexample.final.map((snapshot) => [snapshot.process.label, snapshot.status, at(snapshot.at!.span), snapshot.waits?.[0].detail, snapshot.waits?.[0].partner?.state, snapshot.waits?.[0].partner?.process?.label]), [
    ['branch 1', 'blocked', '12:13', "waits to write 'c'", 'blocked-elsewhere', 'branch 2'],
    ['branch 2', 'blocked', '17:13', "waits to write 'd'", 'blocked-elsewhere', 'branch 1'],
  ]);
  assert.match(counterexample.final[0].waits![0].partner!.detail, /branch 2 would read 'c' later, but is waiting to write 'd' first/);
  assert.deepEqual(counterexample.cycles?.map((cycle) => cycle.map((entry) => `${entry.process.label}/${entry.channel?.name}`)), [['branch 1/c', 'branch 2/d']]);
  // The paths are the drawn branches of main's par.
  const view = programView(model);
  for (const snapshot of counterexample.final) assert.equal(findProcess(view, snapshot.process.path)?.exact, true);
  assert.equal(counterexample.final[0].waits![0].channel?.declaration?.uri, model.uri);
});

test('channel hazards become "this read/write waits forever" checks with their reason', () => {
  const read = staticFor(path.join(EXAMPLES, 'deadlock_read.pj')).report.checks;
  assert.equal(read.length, 1);
  assert.equal(read[0].label, "Read of 'c' completes");
  assert.equal(read[0].severity, 'warning');
  assert.equal(read[0].counterexample?.summary, "c.read() at line 8 waits forever: nothing in main ever writes 'c' or passes it to another process");
  assert.deepEqual(read[0].counterexample?.final.map((snapshot) => [snapshot.process.label, snapshot.waits?.[0].operation, snapshot.waits?.[0].partner?.state]), [['main', 'read', 'missing']]);

  const self = staticFor(path.join(EXAMPLES, 'self_deadlock.pj')).report.checks;
  assert.equal(self.length, 1);
  assert.equal(self[0].label, "'c' has a partner process");
  const wait = self[0].counterexample!.final[0].waits![0];
  assert.equal(wait.operation, 'write');
  assert.equal(at(wait.at!.span), '10:5');
  assert.match(wait.partner!.detail, /the only reader of 'c' is this same process \(line 11\)/);
});

test('a clean program gets no static results, and never a "passed" deadlock claim', () => {
  for (const file of ['clean_pipeline.pj', 'bug_lookalikes.pj']) {
    const { report } = staticFor(path.join(EXAMPLES, file));
    assert.deepEqual(report.checks, [], file);
  }
});

test('a deadlock inside a procedure is placed on its own view and on each expanded instance', () => {
  const source = [
    'void crossed() {',
    '    chan<int> left, right;',
    '    par {',
    '        { left.write(1); int x = right.read(); }',
    '        { right.write(2); int y = left.read(); }',
    '    }',
    '}',
    'public void main(string[] args) {',
    '    par { crossed(); crossed(); }',
    '}',
  ].join('\n');
  const analyzed = analyzeSource(source, '/virtual/crossed.pj');
  const report = staticVerificationReport(analyzed.program, analyzed.checked, { uri: analyzed.uri, model: analyzed.model });
  assert.deepEqual(report.checks.map((check) => check.target.kind + ':' + check.target.name), ['procedure:crossed']);
  const overlays = buildOverlays(analyzed.model, [report]);
  const byView = new Map(overlays.map((overlay) => [analyzed.model.views.find((view) => view.id === overlay.view)!.label, overlay]));
  assert.deepEqual([...byView.keys()].sort(), ['crossed()', 'main (whole program)']);
  assert.equal(byView.get('crossed()')!.processes.length, 2);
  // Two instances of crossed in main: both are stuck once their par runs.
  const program = byView.get('main (whole program)')!;
  assert.equal(program.processes.length, 4);
  assert.ok(program.relocated);
  assert.equal(program.processes.every((process) => process.exact), true);
  // The checker's proof holds for every instance, so the whole program is the view to open.
  assert.equal(preferredView(analyzed.model, report.checks[0], overlays, 0), programView(analyzed.model).id);
});

test('the FDR-style fixture: every snapshot, wait and step lands on a drawn element', () => {
  const analyzed = analyzeFile(path.join(VERIFICATION, 'commstime_bounded.pj'), FIXTURE_URI);
  const report = JSON.parse(fs.readFileSync(path.join(VERIFICATION, 'commstime_bounded.fdr.json'), 'utf8')) as VerificationReport;
  assert.equal(report.uri, FIXTURE_URI);
  const overlays = buildOverlays(analyzed.model, [report], { documentVersion: 1 });
  assert.equal(overlays.length, 1, 'only the program view shows a whole-program result');
  const [overlay] = overlays;
  const view = programView(analyzed.model);
  assert.equal(overlay.view, view.id);
  assert.deepEqual(overlay.unplaced, []);
  assert.equal(overlay.stale, false);
  const check = report.checks[0];
  const counterexample = check.counterexample!;
  // Every process in the end state is a box of its own.
  assert.equal(overlay.processes.length, counterexample.final.length);
  assert.ok(overlay.processes.every((process) => process.exact));
  const name = (id: string): string => view.nodes.find((node) => node.id === id)!.name;
  assert.deepEqual(overlay.processes.map((process) => `${name(process.node)}: ${process.status} (${process.badge})`), [
    'branch 1 of delta: blocked (write a)',
    'branch 2 of delta: terminated (done)',
    'delta(d, a, b): blocked (waits for its par to finish)',
    'succ(b, c): blocked (read b)',
    'prefix(0, c, d): blocked (write d)',
    'consume(a): terminated (done)',
  ]);
  // Stuck operations sit on the right arrow end.
  const edgeName = (id?: string): string => {
    const edge = view.edges.find((entry) => entry.id === id);
    return edge ? `${name(edge.from)} -> ${name(edge.to)}` : '(none)';
  };
  assert.deepEqual(overlay.waits.map((wait) => `${name(wait.node)} on ${edgeName(wait.edge)} at its ${wait.end}: ${wait.short}`), [
    'branch 1 of delta on branch 1 of delta -> consume(a) at its source: consume has terminated',
    'delta(d, a, b) on (none) at its undefined: branch 1 of delta is stuck writing a',
    'succ(b, c) on branch 2 of delta -> succ(b, c) at its target: delta waits for its par to finish',
    'prefix(0, c, d) on prefix(0, c, d) -> delta(d, a, b) at its source: delta waits for its par to finish',
  ]);
  // Every step's participants are drawn, and each communication travels along its channel's arrow.
  assert.equal(overlay.steps.length, 18);
  for (const step of overlay.steps) {
    for (const participant of step.participants) assert.ok(participant.node, `step ${step.index} ${participant.label}`);
    if (step.kind === 'communication') assert.equal(step.route.length, 1, `step ${step.index} ${step.event}`);
  }
  assert.deepEqual(overlay.steps.filter((step) => !step.visible).map((step) => step.index), [4, 9, 13]);
  // The producer's own words for why the partner never comes; nothing is added to them.
  assert.equal(overlay.story[0], 'branch 1 of delta is stuck at line 29 writing a: consume read its three values and finished.');
  const chips = verdictChips(analyzed.model, [report], overlays, { documentVersion: 1 });
  assert.deepEqual(chips.map((chip) => `${chip.label}: ${chip.text}`), ['Deadlock freedom: deadlock after 18 steps', 'Divergence freedom: holds', 'No runtime errors: holds']);
  assert.equal(chips[0].preferredView, view.id);
  // A newer buffer makes the result stale, never silently current.
  assert.equal(buildOverlays(analyzed.model, [report], { documentVersion: 2 })[0].stale, true);
});

test('a result naming something this view does not draw is listed, not dropped', () => {
  const analyzed = analyzeFile(path.join(VERIFICATION, 'commstime_bounded.pj'), FIXTURE_URI);
  const report = JSON.parse(fs.readFileSync(path.join(VERIFICATION, 'commstime_bounded.fdr.json'), 'utf8')) as VerificationReport;
  const ghost: ProcessRef = { path: [{ kind: 'branch', site: { uri: FIXTURE_URI, span: { start: { line: 0, col: 0 }, end: { line: 0, col: 1 } } }, index: 9 }], label: 'ghost' };
  const counterexample = report.checks[0].counterexample!;
  counterexample.final.push({ process: ghost, status: 'blocked', description: 'ghost waits' });
  counterexample.steps[0].participants.push({ process: ghost, role: 'actor' });
  const [overlay] = buildOverlays(analyzed.model, [report]);
  assert.ok(overlay.unplaced.includes('ghost: ghost waits'));
  assert.ok(overlay.unplaced.includes('step 1: ghost'));
});

test('a missing-peer deadlock blames only the waits nothing can meet, and names a finished partner only on the right side', () => {
  const source = [
    'public void main(string[] args) {',
    '    shared write chan<int> c;',
    '    chan<int> d, e;',
    '    par {',
    '        { c.write(1); e.write(0); }',
    '        { int x = c.read(); int y = d.read(); }',
    '        { int z = e.read(); c.write(2); d.write(3); }',
    '    }',
    '}',
  ].join('\n');
  const analyzed = analyzeSource(source, '/virtual/wrong-side.pj');
  const [check] = staticVerificationReport(analyzed.program, analyzed.checked, { uri: analyzed.uri, model: analyzed.model }).checks;
  const counterexample = check.counterexample!;
  // Branch 2 still has d.write(3) coming from branch 3: only the write of 'c' has no reader left.
  assert.equal(counterexample.summary, "deadlock when the par at line 4 runs: branch 2 waits to read 'd' while branch 3 waits to write 'c'; branch 1 finished; nothing can still read 'c'; branch 2 waits on branch 3");
  const partners = counterexample.final.filter((snapshot) => snapshot.waits).map((snapshot) => `${snapshot.process.label}: ${snapshot.waits![0].partner!.state} ${snapshot.waits![0].partner!.process?.label ?? '-'}`);
  // Branch 1 only wrote 'c': it is no reader of it, finished or not.
  assert.deepEqual(partners, ['branch 2: blocked-elsewhere branch 3', 'branch 3: missing -']);
  const [overlay] = buildOverlays(analyzed.model, [{ version: 1, producer: 'checker', uri: analyzed.uri, assumptions: [], checks: [check] }]);
  assert.deepEqual(overlay.waits.map((wait) => `${wait.short} (${wait.cause})`), ["branch 3 waits on c instead (knock-on)", "no unfinished branch can still read 'c' (root)"]);
  // A finished branch that did read the channel is named, in the checker's own words.
  const finished = analyzeSource(source.replace('{ c.write(1); e.write(0); }', '{ int w = c.read(); e.write(0); }').replace('{ int x = c.read(); int y = d.read(); }', '{ c.write(5); int y = d.read(); }'), '/virtual/finished-reader.pj');
  const [late] = staticVerificationReport(finished.program, finished.checked, { uri: finished.uri, model: finished.model }).checks;
  const stuckWriter = late.counterexample!.final.find((snapshot) => snapshot.waits?.[0].operation === 'write')!;
  assert.deepEqual([stuckWriter.waits![0].partner!.state, stuckWriter.waits![0].partner!.detail], ['terminated', "branch 1, which read 'c', has finished; no unfinished branch can still read 'c'"]);
});

test('a circular wait beside a missing peer is reported as both', () => {
  const source = [
    'public void main(string[] args) {',
    '    chan<int> a, b, e;',
    '    par {',
    '        { a.write(1); int x = b.read(); }',
    '        { b.write(2); int y = a.read(); }',
    '        { int z = e.read(); e.write(5); }',
    '        { e.write(4); e.write(6); }',
    '    }',
    '}',
  ].join('\n');
  const analyzed = analyzeSource(source, '/virtual/mixed.pj');
  const counterexample = staticVerificationReport(analyzed.program, analyzed.checked, { uri: analyzed.uri, model: analyzed.model }).checks[0].counterexample!;
  assert.match(counterexample.summary, /nothing can still read 'e'; branch 1 waits on branch 2; branch 2 waits on branch 1$/);
  assert.deepEqual(counterexample.cycles?.map((cycle) => cycle.map((entry) => entry.process.label)), [['branch 1', 'branch 2']]);
});

test('the story keeps to the producer\'s words, tells processes apart by path, and tells par for iterations once', () => {
  const ref = (label: string, index?: number): ProcessRef => ({ path: [{ kind: 'branch', site: { uri: 'file:///x.pj', span: { start: { line: 4, col: 8 }, end: { line: 4, col: 20 } } }, index: index ?? 1 }], label });
  const barrier = { name: 'b', kind: 'barrier' as const, owner: [] };
  const check = { id: 'x', property: 'deadlock-free' as const, label: 'Deadlock freedom', target: { kind: 'program' as const, name: 'main' }, status: 'failed' as const, severity: 'error' as const };
  const sync = story({ kind: 'deadlock', steps: [], summary: 's', final: [{ process: ref('worker(2)', 2), status: 'blocked', description: 'd', waits: [{ operation: 'sync', channel: barrier, detail: 'waits to sync b', partner: { state: 'missing', detail: '' } }] }] }, check);
  assert.deepEqual(sync, ['worker(2) is stuck syncing on b: no other enrolled process can still sync on it.']);
  // Same label, different process: the partner is not "this same process".
  const inner = ref('branch 2', 2);
  const outer: ProcessRef = { path: [{ ...inner.path[0], site: { uri: 'file:///x.pj', span: { start: { line: 9, col: 8 }, end: { line: 9, col: 20 } } } }], label: 'branch 2' };
  const channel = { name: 'c', kind: 'channel' as const, owner: [] };
  const counterexample: Counterexample = { kind: 'deadlock', steps: [], summary: 's', final: [
    { process: outer, status: 'blocked', description: 'o', waits: [{ operation: 'read', channel, detail: 'waits to read c', partner: { process: inner, state: 'blocked-elsewhere', detail: '' } }] },
    { process: inner, status: 'blocked', description: 'i', waits: [{ operation: 'write', channel: { ...channel, name: 'd' }, detail: 'waits to write d' }] },
  ] };
  assert.equal(shortReason(counterexample.final[0].waits![0], counterexample, outer), 'branch 2 waits on d instead');
  // Four iterations of one par for in the same state: one sentence.
  const site = { uri: 'file:///x.pj', span: { start: { line: 6, col: 4 }, end: { line: 8, col: 5 } } };
  const iteration = (i: number): ProcessSnapshot => ({ process: { path: [{ kind: 'par-for', site, index: i }], label: `worker(${i})` }, status: 'blocked', at: { uri: 'file:///x.pj', span: { start: { line: 7, col: 8 }, end: { line: 7, col: 20 } } }, description: 'w', waits: [{ operation: 'write', channel, detail: 'waits to write c', partner: { state: 'not-ready', detail: 'main waits for its par for to finish' } }] });
  assert.deepEqual(story({ kind: 'deadlock', steps: [], summary: 's', final: [0, 1, 2, 3].map(iteration) }, check), ['worker(0), worker(1), worker(2) and worker(3) are stuck at line 8 writing c: main waits for its par for to finish.']);
});

test('a channel hazard is one operation that waits forever, not a whole-program deadlock', () => {
  const { report, model } = staticFor(path.join(EXAMPLES, 'deadlock_read.pj'));
  const chips = verdictChips(model, [report], buildOverlays(model, [report]));
  assert.deepEqual(chips.map((chip) => `${chip.label}: ${chip.text}`), ["Read of 'c' completes: waits forever"]);
});

test('a procedure checked on its own keeps its environment wording when placed on a call', () => {
  const analyzed = analyzeFile(path.join(VERIFICATION, 'commstime_bounded.pj'), FIXTURE_URI);
  const delta = analyzed.model.views.find((view) => view.procedure === 'delta')!;
  const out1 = delta.channels.find((channel) => channel.name === 'out1')!;
  const branch = delta.nodes.find((node) => node.name === 'branch 1')!;
  const report: VerificationReport = { version: 1, producer: 'fdr', uri: FIXTURE_URI, assumptions: [], checks: [{
    id: 'delta', property: 'deadlock-free', label: 'Deadlock freedom', target: { kind: 'procedure', name: 'delta', at: delta.source }, status: 'failed', severity: 'error',
    counterexample: { kind: 'deadlock', steps: [], summary: 'delta deadlocks', final: [{ process: { path: branch.path!, label: 'branch 1' }, status: 'blocked', description: 'b', waits: [{ operation: 'write', channel: out1.ref, detail: 'waits to write out1', partner: { state: 'not-ready', detail: '' } }] }] },
  }] };
  const overlays = buildOverlays(analyzed.model, [report]);
  const own = overlays.find((overlay) => overlay.view === delta.id)!;
  const program = overlays.find((overlay) => overlay.view === programView(analyzed.model).id)!;
  assert.equal(own.waits[0].short, 'its reader is not ready');
  // In main, out1 is the channel a that consume(a) reads: the result is about FDR's stand-in caller, not consume.
  assert.equal(program.relocated, 'delta as called here');
  assert.equal(program.waits[0].short, 'as checked alone: nothing reads out1');
  assert.equal(preferredView(analyzed.model, report.checks[0], overlays, 0), delta.id);
  // How it locked says the same: on its own view the producer's words, on a call the check's environment.
  assert.deepEqual(own.formation.map((step) => step.caption), ['branch 1 is stuck: it waits to write out1; its reader is not ready.', 'Dead end: branch 1 can never write out1: its reader is not ready. Nobody can move.']);
  assert.deepEqual(program.formation.map((step) => step.caption), ["branch 1 is stuck: it waits to write out1; in FDR's check of delta on its own, nothing reads out1 there.", "Dead end: branch 1 can never write out1: in FDR's check of delta on its own, nothing reads out1 there. Nobody can move."]);
});

test('how it locked: who got stuck first, processes on one box together, and only what the report says', () => {
  const site = (line: number): { uri: string; span: { start: { line: number; col: number }; end: { line: number; col: number } } } => ({ uri: 'file:///x.pj', span: { start: { line, col: 4 }, end: { line, col: 20 } } });
  const ref = (label: string, line: number): ProcessRef => ({ path: [{ kind: 'branch', site: site(line), index: line }], label });
  const [a, b, c, d] = [ref('a', 1), ref('b', 2), ref('c', 3), ref('d', 4)];
  const channel = (name: string) => ({ name, kind: 'channel' as const, owner: [] });
  const step = (index: number, ...who: ProcessRef[]) => ({ index, event: `e${index}`, kind: 'internal' as const, participants: who.map((process) => ({ process, role: 'actor' as const })), description: `step ${index}` });
  // a acted last, c before it, b and d never: b and d first (in the report's order), then c, then a.
  const counterexample: Counterexample = { kind: 'deadlock', summary: 's', steps: [step(0, c), step(1, a)], final: [
    { process: a, status: 'blocked', at: site(10), description: 'a', waits: [{ operation: 'read', channel: channel('x'), at: site(10), detail: 'waits to read x', partner: { process: b, state: 'terminated', detail: '' } }] },
    { process: b, status: 'blocked', at: site(11), description: 'b', waits: [{ operation: 'alt-guard', channel: channel('y'), detail: 'waits in an alt for y', partner: { state: 'missing', detail: 'nothing in the program writes y' } }, { operation: 'alt-guard', channel: channel('z'), detail: 'waits in an alt for z', partner: { process: a, state: 'blocked-elsewhere', detail: '' } }] },
    { process: c, status: 'blocked', at: site(12), description: 'c', waits: [{ operation: 'write', channel: channel('w'), at: site(12), detail: 'waits to write 1 on w', partner: { process: d, state: 'blocked-elsewhere', detail: '' } }] },
    { process: d, status: 'blocked', at: site(13), description: 'd', waits: [{ operation: 'write', channel: channel('v'), at: site(13), detail: 'waits to write 2 on v' }] },
  ] };
  const steps = formationSteps(counterexample);
  assert.deepEqual(steps.map((entry) => [entry.kind, entry.keys.map((key) => [a, b, c, d].find((process) => pathKey(process.path) === key)!.label).join('+'), entry.after]), [
    ['stuck', 'b', undefined], ['stuck', 'd', undefined], ['stuck', 'c', 0], ['stuck', 'a', 1], ['dead-end', 'a+b+d', undefined],
  ]);
  assert.deepEqual(steps.map((entry) => entry.caption), [
    'b is stuck at line 12 from the start: it waits in an alt for read y or read z (read y: nothing in the program writes y; read z: a waits on x instead).',
    'd is stuck at line 14 from the start: it waits to write 2 on v, and no reader can come.',
    'c is stuck at line 13 after step 1: it waits to write 1 on w, whose reader d is itself waiting to write 2 on v.',
    'a is stuck at line 11 after step 2: it waits to read x; b has finished.',
    'Dead ends: a can never read x at line 11: b has finished; b can never complete its alt at line 12: read y: nothing in the program writes y; d can never write 2 on v at line 14: no reader can come. c is stuck behind them. Nobody can move.',
  ]);
  // Two processes drawn on one box that got stuck after the same step are one step; the drawing cannot tell them apart.
  const pair: Counterexample = { ...counterexample, steps: [step(0, a, b)], final: counterexample.final.slice(0, 2) };
  const drawn = new Map(pair.final.map((snapshot) => [snapshot, { nodes: ['box'], edges: [], partners: [] }]));
  const together = formationSteps(pair, drawn);
  assert.equal(together.length, 2);
  assert.deepEqual([together[0].nodes, together[0].keys.length, together[0].title], [['box'], 2, 'a and 1 more stuck at line 11']);
  assert.match(together[0].caption, / On the same box, b is stuck too\.$/);
  // Very many: one step per trace step they follow.
  const many: Counterexample = { kind: 'deadlock', summary: 's', steps: [step(0, ...Array.from({ length: 30 }, (_, i) => ref(`p${i}`, 100 + i)))], final: Array.from({ length: 50 }, (_, i) => ({ process: ref(`p${i}`, 100 + i), status: 'blocked' as const, description: 'p', waits: [{ operation: 'read' as const, channel: channel('q'), detail: 'waits to read q', partner: { state: 'missing' as const, detail: '' } }] })) };
  const crowd = formationSteps(many, new Map(many.final.map((snapshot, i) => [snapshot, { nodes: [`n${i}`], edges: [], partners: [] }])));
  assert.deepEqual(crowd.filter((entry) => entry.kind === 'stuck').map((entry) => [entry.keys.length, entry.title]), [[20, '20 processes stuck'], [30, '30 processes stuck']]);
  assert.match(crowd[1].caption, /^30 processes are stuck after step 1: p0, p1, p2, p3, p4 and 25 more\.$/);
  // Nothing blocked, nothing to tell; and the checker's proofs are no runs.
  assert.deepEqual(formationSteps({ ...counterexample, final: counterexample.final.map((snapshot) => ({ ...snapshot, status: 'terminated' as const })) }), []);
  const { report, model } = staticFor(path.join(EXAMPLES, 'par_deadlock.pj'));
  assert.ok(buildOverlays(model, [report]).every((overlay) => overlay.formation.length === 0));
});
