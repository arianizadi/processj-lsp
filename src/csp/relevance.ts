/**
 * Integers that never decide anything: saturated instead of range-checked.
 *
 * The model's integers are a small range, and a value stored or sent outside
 * it is a modelled error. That error is the model's limit, not the program's:
 * Java has no such error. For a value that can never influence what the
 * program does (no condition, loop bound, alt precondition, switch, array
 * index, divisor or par for bound depends on it, and nothing outside the
 * program observes it) the exact number cannot change any verdict: deadlock,
 * divergence and termination depend only on control flow (data independence).
 * Such values are kept as they are while they fit and become one extra value,
 * `PJ_SAT` (one past the top of the range, shown as "a value outside lo..hi"),
 * when they do not; anything computed from `PJ_SAT` stays `PJ_SAT`. A
 * pipeline that adds up or squares what it passes on, or a server counting
 * forever, then checks without a spurious range error.
 *
 * Relevance is a backward closure over value flow in the lowered graphs:
 * assignments, channel writes to reads (channels that values can flow
 * between share a group), call arguments to parameters, returns to the
 * callers' results. Sinks are the expressions control flow and the modelled
 * Java errors depend on, records, protocols and arrays (their fields keep the
 * exact domain, so every value stored in one stays checked), channels the
 * environment of a checked procedure or a user's specification observes, and
 * a checked procedure's result.
 */
import type { ChanSource, Node, ProcIR } from './lower';
import { E, freeVars, type Ex } from './cspm';
import type { DType } from './data';

export interface RelevanceInput {
  procs: Iterable<ProcIR>;
  /** The group of channels a channel operand of `proc` belongs to (values flow only within a group). */
  group(proc: ProcIR, source: ChanSource): string;
  /** Channel groups whose values matter outside the network: a checked procedure's channels, channels a user's specification names. */
  observed: ReadonlySet<string>;
  /** Procedures whose returned value is observed (a checked value-returning procedure). */
  observedReturns: ReadonlySet<ProcIR>;
  lo: number;
  hi: number;
}

export interface Saturation {
  /** Integer variables that never decide anything, per procedure (CSPm names). */
  vars: Map<ProcIR, Set<string>>;
  /** Channel groups whose integer values never decide anything. */
  groups: Set<string>;
  /** Stores and sends that saturate instead of being range-checked. */
  sites: number;
}

/** The integer type of a variable or channel whose values are saturated (`Int_s`). */
export const SAT_INT: DType = { k: 'int', sat: true };

export function saturate(input: RelevanceInput): Saturation {
  const procs = [...input.procs];
  const sources = new Map<string, Set<string>>();
  const sinks = new Set<string>();
  const v = (p: ProcIR, name: string): string => `v|${p.name}|${name}`;
  const c = (key: string): string => `c|${key}`;
  const r = (p: ProcIR): string => `r|${p.name}`;
  const flow = (to: string, from: Iterable<string>): void => {
    const set = sources.get(to) ?? new Set<string>();
    for (const f of from) set.add(f);
    sources.set(to, set);
  };
  const vars = (p: ProcIR, e: Ex | undefined): string[] => (e ? [...freeVars(e)].map((x) => v(p, x)) : []);
  const sink = (keys: Iterable<string>): void => {
    for (const k of keys) sinks.add(k);
  };
  const byDecl = new Map(procs.map((p) => [p.decl, p]));
  const errorKind = new Map<string, string>();

  for (const p of procs) {
    for (const e of p.errors) errorKind.set(e.ctor, e.kind);
    for (const [name, info] of p.vars) {
      if (info.type.k === 'record' || info.type.k === 'protocol' || info.type.k === 'array') sinks.add(v(p, name));
    }
    for (const n of p.nodes) {
      switch (n.k) {
        case 'assign':
          flow(v(p, n.v), vars(p, n.e));
          break;
        case 'check':
          // A range check is what saturation replaces; every other check (a divisor, an index, null) decides an error.
          if (errorKind.get(n.err) !== 'range') sink(vars(p, n.ok));
          break;
        case 'branch':
          sink(vars(p, n.c));
          break;
        case 'write':
          flow(c(input.group(p, n.ch.source)), vars(p, n.e));
          break;
        case 'read':
          flow(v(p, n.v), [c(input.group(p, n.ch.source))]);
          break;
        case 'alt':
          for (const cs of n.cases) {
            sink(vars(p, cs.pre));
            if (cs.guard.k === 'read') flow(v(p, cs.guard.v), [c(input.group(p, cs.guard.ch.source))]);
          }
          if (n.replicated) {
            sink(vars(p, n.replicated.set));
            sinks.add(v(p, n.replicated.v));
          }
          break;
        case 'par':
          if (n.par.iter) sink([...vars(p, n.par.iter.lo), ...vars(p, n.par.iter.hi), v(p, n.par.iter.v)]);
          break;
        case 'call': {
          const callee = byDecl.get(n.call.callee);
          if (!callee) break;
          n.call.args.forEach((a, i) => {
            const param = callee.params[i];
            if (param && a.value) flow(v(callee, param.cspm), vars(p, a.value));
          });
          if (n.ret) flow(v(p, n.ret), [r(callee)]);
          break;
        }
        case 'return':
          flow(r(p), vars(p, n.e));
          break;
        default:
          break;
      }
    }
    if (input.observedReturns.has(p)) sinks.add(r(p));
  }
  for (const g of input.observed) sinks.add(c(g));

  // Everything a sink depends on, transitively.
  const relevant = new Set<string>(sinks);
  const work = [...sinks];
  while (work.length) {
    const k = work.pop()!;
    for (const s of sources.get(k) ?? []) {
      if (relevant.has(s)) continue;
      relevant.add(s);
      work.push(s);
    }
  }

  const out: Saturation = { vars: new Map(), groups: new Set(), sites: 0 };
  const free = (p: ProcIR): Set<string> => out.vars.get(p) ?? new Set();
  for (const p of procs) {
    const set = new Set<string>();
    for (const [name, info] of p.vars) {
      if (info.type.k === 'int' && info.role === 'value' && !relevant.has(v(p, name))) set.add(name);
    }
    if (set.size) out.vars.set(p, set);
  }
  const groupOf = (p: ProcIR, source: ChanSource): string => input.group(p, source);
  const satGroup = (p: ProcIR, source: ChanSource): boolean => !relevant.has(c(groupOf(p, source)));

  /** `e` stored where only its being some value matters. */
  const sat = (p: ProcIR, e: Ex): Ex => {
    if (e.k === 'int' && e.v >= input.lo && e.v <= input.hi) return e;
    out.sites++;
    const maybeSat = [...freeVars(e)].filter((x) => free(p).has(x));
    return E.sat(e, maybeSat.map((x) => E.v(x)), input.lo, input.hi);
  };

  for (const p of procs) {
    const mine = free(p);
    for (const n of p.nodes) {
      if (n.k === 'assign' && n.range && mine.has(n.v)) {
        n.e = sat(p, n.e);
        n.range = undefined;
      } else if (n.k === 'check' && errorKind.get(n.err) === 'range') {
        // A range check right before the send or return it protects.
        const next: Node | undefined = p.nodes[n.next];
        const checked = n.ok.k === 'call' && n.ok.fn === 'member' ? n.ok.args[0] : undefined;
        if (!next || !checked) continue;
        if (next.k === 'write' && next.e === checked && satGroup(p, next.ch.source)) {
          next.e = sat(p, next.e);
          n.ok = E.bool(true);
        } else if (next.k === 'return' && next.e === checked && !relevant.has(r(p))) {
          next.e = sat(p, next.e);
          n.ok = E.bool(true);
        }
      } else if (n.k === 'call') {
        const callee = byDecl.get(n.call.callee);
        if (!callee) continue;
        n.call.args.forEach((a, i) => {
          const param = callee.params[i];
          if (!param || !a.range || !a.value || !free(callee).has(param.cspm)) return;
          a.value = sat(p, a.value);
          a.range = undefined;
        });
      }
    }
    for (const name of mine) {
      const info = p.vars.get(name);
      if (info) info.type = SAT_INT;
    }
    for (const local of p.locals) {
      if (local.kind !== 'channel' || local.elem?.k !== 'int') continue;
      if (satGroup(p, { k: 'local', decl: local })) {
        local.elem = SAT_INT;
        out.groups.add(groupOf(p, { k: 'local', decl: local }));
      }
    }
  }
  return out;
}
