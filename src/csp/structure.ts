/**
 * Which data parameters of a procedure decide the shape of its network.
 *
 * Elaboration (network.ts) lays out every process and channel before FDR
 * runs, so a value it needs must be known statically: the length of a
 * channel array, the bounds of a par for, the arguments of a recursion
 * through par, a condition that decides whether a par (or a call that runs
 * one) happens, the index of a channel-array element. A procedure checked on
 * its own is given these parameters from its call sites (translate.ts), and
 * every other data parameter keeps "any modelled value".
 */
import { freeVars, type Ex } from './cspm';
import { nodeSuccessors, type ChanUse, type Node, type ProcIR } from './lower';

/** Parameters no statement of the procedure assigns: their value is the call's argument throughout (CSPm names; a channel array's length too). */
export function fixedParams(proc: ProcIR): Set<string> {
  const assigned = new Set<string>();
  for (const n of proc.nodes) {
    if (n.k === 'assign' || n.k === 'read') assigned.add(n.v);
    if (n.k === 'call' && n.ret) assigned.add(n.ret);
    if (n.k === 'alt') {
      for (const c of n.cases) if (c.guard.k === 'read') assigned.add(c.guard.v);
      if (n.replicated) assigned.add(n.replicated.v);
    }
  }
  const out = new Set<string>();
  for (const p of proc.params) {
    if (p.role === 'value' && !assigned.has(p.cspm)) out.add(p.cspm);
    if (p.len) out.add(p.len);
  }
  return out;
}

/** The index of a channel-array element operand (`cs.(i - 1)`), when the operand is one. */
function elementIndex(ch: Ex | undefined): Ex | undefined {
  if (!ch || ch.k !== 'dot' || !ch.fields.length) return undefined;
  const last = ch.fields[ch.fields.length - 1];
  return last.k === 'var' && last.name === 'pj_h' ? undefined : last;
}

/**
 * The parameters of each procedure (CSPm names: data parameters no statement
 * assigns, and channel-array lengths) whose values elaboration needs: they
 * flow into a channel-array length, a par for bound, a recursion through par,
 * a channel-array index, or a condition that decides which of those run; or
 * into such a parameter of a callee. `leadsToPar` and `recursive` are the
 * translator's (instanceAnalysis, findRecursion).
 */
export function structuralParams(procs: Iterable<ProcIR>, procOf: (decl: ProcIR['decl']) => ProcIR | undefined, leadsToPar: (p: ProcIR) => boolean, recursive: (p: ProcIR) => boolean): Map<ProcIR, Set<string>> {
  const all = [...procs];
  const own = new Map<ProcIR, Set<string>>();
  const fixed = new Map(all.map((p) => [p, fixedParams(p)]));
  const add = (p: ProcIR, e: Ex | undefined, into: Set<string>): void => {
    if (!e) return;
    const params = fixed.get(p)!;
    for (const v of freeVars(e)) if (params.has(v)) into.add(v);
  };
  const chanUses = (n: Node): ChanUse[] => {
    switch (n.k) {
      case 'read':
      case 'write':
      case 'ack':
        return [n.ch];
      case 'alt':
        return n.cases.flatMap((c) => (c.guard.k === 'read' ? [c.guard.ch] : []));
      case 'call':
        return n.call.args.flatMap((a) => (a.chan ? [a.chan] : []));
      default:
        return [];
    }
  };
  for (const p of all) {
    const s = new Set<string>();
    for (const local of p.locals) if (local.array) add(p, local.array.size, s);
    for (const par of p.pars) {
      add(p, par.iter?.lo, s);
      add(p, par.iter?.hi, s);
    }
    // A recursion through par is unfolded only when every integer and boolean argument is known.
    if (recursive(p) && leadsToPar(p)) for (const x of p.params) if (x.role === 'value' && (x.type.k === 'int' || x.type.k === 'bool') && fixed.get(p)!.has(x.cspm)) s.add(x.cspm);
    // What a node does to the network: a par, a call that runs one, an element of a channel array.
    const relevant = (n: Node): boolean => {
      if (n.k === 'par') return true;
      if (n.k === 'call') {
        const callee = procOf(n.call.callee);
        if (callee && leadsToPar(callee)) return true;
      }
      return chanUses(n).some((c) => !!elementIndex(c.ch));
    };
    for (const n of p.nodes) for (const c of chanUses(n)) add(p, elementIndex(c.ch), s);
    // A condition that decides which of those happen: its two sides reach different ones.
    const reach = (from: number): Set<number> => {
      const seen = new Set<number>();
      const found = new Set<number>();
      const work = [from];
      while (work.length) {
        const id = work.pop()!;
        if (id < 0 || seen.has(id)) continue;
        seen.add(id);
        const n = p.nodes[id];
        if (!n) continue;
        if (relevant(n)) found.add(id);
        work.push(...nodeSuccessors(n));
      }
      return found;
    };
    for (const n of p.nodes) {
      if (n.k !== 'branch') continue;
      const t = reach(n.t);
      const f = reach(n.f);
      if (t.size !== f.size || [...t].some((x) => !f.has(x))) add(p, n.c, s);
    }
    own.set(p, s);
  }
  // Through calls: an argument that becomes a callee's structural parameter.
  const out = new Map(all.map((p) => [p, new Set(own.get(p))]));
  for (let changed = true; changed;) {
    changed = false;
    for (const p of all) {
      const s = out.get(p)!;
      const before = s.size;
      for (const call of p.calls) {
        const callee = procOf(call.callee);
        const theirs = callee ? out.get(callee) : undefined;
        if (!callee || !theirs?.size) continue;
        callee.params.forEach((q, i) => {
          const a = call.args[i];
          if (!a) return;
          if (q.role === 'value' && theirs.has(q.cspm)) add(p, a.value, s);
          if (q.len && theirs.has(q.len)) add(p, a.chan?.len, s);
        });
      }
      if (s.size !== before) changed = true;
    }
  }
  return out;
}
