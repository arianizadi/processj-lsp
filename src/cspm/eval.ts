/**
 * A small evaluator for the values of a CSPm file: integers, booleans,
 * dotted values (events and datatype values), tuples, finite sets and
 * sequences, sets of events (`{| c |}`, `Events`), and the common library
 * functions. It exists to draw the process network: to know the members of a
 * replicated composition, the arguments a process is called with, and which
 * events a synchronisation set holds.
 *
 * It never guesses. Whatever it cannot compute (an unbounded or huge set, a
 * library function it does not know, a value that depends on an input) is
 * `unknown`, with the reason; callers say so instead of drawing more than
 * the file establishes. Evaluation is bounded (sets of at most MAX_SET
 * values, a step budget), so a recursive definition cannot hang the server.
 */
import type { Decl, Definition, Ex, Stmt } from './ast';

export interface EventPat {
  channel: string;
  /** Field values from the left; undefined is any value. */
  fields: Array<Value | undefined>;
  /** Also every event that extends the fields (`{| c.1 |}`). */
  open: boolean;
}

export type Value =
  | { t: 'int'; v: number }
  | { t: 'bool'; v: boolean }
  | { t: 'str'; v: string }
  /** A channel or a constructor with its fields, flattened: `c.req.1` is c with [req, 1]. */
  | { t: 'dot'; head: string; args: Value[] }
  | { t: 'tuple'; items: Value[] }
  | { t: 'set'; items: Value[] }
  | { t: 'seq'; items: Value[] }
  /** A set of events given by patterns: `{| c |}` is every event on c; `all` is Events. */
  | { t: 'events'; pats: EventPat[]; all: boolean; minus: EventPat[] }
  /** A process: the term and the environment it is evaluated in. */
  | { t: 'proc'; expr: Ex; env: Env; name?: string }
  | { t: 'fn'; name: string; clauses: Clause[]; env: Env; applied: Value[][] }
  | { t: 'builtin'; name: string }
  | { t: 'unknown'; why: string };

export interface Clause {
  params: Ex[][];
  body: Ex;
  def?: Definition;
}

/** Largest set the evaluator enumerates. */
export const MAX_SET = 4096;

const UNKNOWN = (why: string): Value => ({ t: 'unknown', why });

export interface ChannelInfo {
  name: string;
  /** The declarator, for ChannelRef.declaration. */
  span: Definition['span'];
  /** Field types as written (`PHILS.PHILS`), for labels. */
  type?: Ex;
  typeText?: string;
}

/** Everything declared at the top level of a file. */
export class Globals {
  readonly defs = new Map<string, Clause[]>();
  readonly definitions = new Map<string, Definition[]>();
  readonly channels = new Map<string, ChannelInfo>();
  /** Constructor name -> its datatype and field types. */
  readonly constructors = new Map<string, { type: string; fields: Ex[] }>();
  /** Datatype name -> constructor names. */
  readonly datatypes = new Map<string, string[]>();
  readonly nametypes = new Map<string, Ex>();
  readonly env: Env;
  private readonly memo = new Map<string, Value>();
  private readonly computing = new Set<string>();
  /** Evaluation steps left (shared by every evaluation of one build). */
  budget = 200_000;

  constructor(decls: readonly Decl[], private readonly text?: string) {
    this.env = new Env(this);
    for (const decl of decls) this.add(decl);
  }

  add(decl: Decl): void {
    switch (decl.kind) {
      case 'def': {
        const clauses = this.defs.get(decl.name.name) ?? [];
        clauses.push({ params: decl.params, body: decl.body, def: decl });
        this.defs.set(decl.name.name, clauses);
        const list = this.definitions.get(decl.name.name) ?? [];
        list.push(decl);
        this.definitions.set(decl.name.name, list);
        return;
      }
      case 'channel':
        for (const name of decl.names) this.channels.set(name.name, { name: name.name, span: name.span, type: decl.type, typeText: decl.type && this.text ? textOf(this.text, decl.type.span) : undefined });
        return;
      case 'datatype':
        this.datatypes.set(decl.name.name, decl.constructors.map((ctor) => ctor.name.name));
        for (const ctor of decl.constructors) this.constructors.set(ctor.name.name, { type: decl.name.name, fields: ctor.fields });
        return;
      case 'nametype':
        this.nametypes.set(decl.name.name, decl.value);
        return;
      default:
        return;
    }
  }

  /** A top-level name's value (memoized for definitions without parameters). */
  lookup(name: string): Value | undefined {
    const memo = this.memo.get(name);
    if (memo) return memo;
    const clauses = this.defs.get(name);
    if (clauses) {
      if (clauses.some((clause) => clause.params.length > 0)) return { t: 'fn', name, clauses, env: this.env, applied: [] };
      if (this.computing.has(name)) return UNKNOWN(`${name} is defined in terms of itself`);
      this.computing.add(name);
      try {
        const body = clauses[0].body;
        const value = isProcessExpr(body, this) ? { t: 'proc' as const, expr: body, env: this.env, name } : evaluate(body, this.env);
        this.memo.set(name, value);
        return value;
      } finally {
        this.computing.delete(name);
      }
    }
    if (this.channels.has(name) || this.constructors.has(name)) return { t: 'dot', head: name, args: [] };
    if (this.datatypes.has(name)) {
      const value = this.typeValues(name);
      this.memo.set(name, value);
      return value;
    }
    const nametype = this.nametypes.get(name);
    if (nametype) {
      if (this.computing.has(name)) return UNKNOWN(`${name} is defined in terms of itself`);
      this.computing.add(name);
      try {
        const value = typeSet(evaluate(nametype, this.env), this);
        this.memo.set(name, value);
        return value;
      } finally {
        this.computing.delete(name);
      }
    }
    if (name === 'Events') return { t: 'events', pats: [], all: true, minus: [] };
    return BUILTINS.has(name) ? { t: 'builtin', name } : undefined;
  }

  /** Every value of a datatype, when there are few enough. */
  private typeValues(name: string): Value {
    if (this.computing.has(name)) return UNKNOWN(`the datatype ${name} is recursive`);
    this.computing.add(name);
    try {
      const out: Value[] = [];
      for (const ctor of this.datatypes.get(name) ?? []) {
        const fields = this.constructors.get(ctor)?.fields ?? [];
        let rows: Value[][] = [[]];
        for (const field of fields) {
          const set = typeSet(evaluate(field, this.env), this);
          if (set.t !== 'set') return UNKNOWN(`the values of ${name} (${set.t === 'unknown' ? set.why : 'not a finite set'})`);
          rows = rows.flatMap((row) => set.items.map((item) => [...row, item]));
          if (rows.length > MAX_SET) return UNKNOWN(`${name} has too many values`);
        }
        for (const row of rows) out.push(dotOf(ctor, row));
      }
      return setOf(out);
    } finally {
      this.computing.delete(name);
    }
  }

  /** Whether a name is a constructor or channel (so a pattern of that name matches it rather than binding). */
  isConstant(name: string): boolean {
    return this.constructors.has(name) || this.channels.has(name);
  }

  /** Field type sets of a channel, when they can be computed. */
  channelFields(name: string): Value[] | undefined {
    const type = this.channels.get(name)?.type;
    if (!type) return [];
    const parts = type.k === 'dot' ? type.parts : [type];
    const out: Value[] = [];
    for (const part of parts) {
      const set = typeSet(evaluate(part, this.env), this);
      if (set.t !== 'set') return undefined;
      out.push(set);
    }
    return out;
  }
}

/** Local bindings over the globals. */
export class Env {
  private readonly vars = new Map<string, Value>();

  constructor(readonly globals: Globals, private readonly parent?: Env) {}

  child(bindings?: ReadonlyMap<string, Value>): Env {
    const env = new Env(this.globals, this);
    if (bindings) for (const [name, value] of bindings) env.vars.set(name, value);
    return env;
  }

  set(name: string, value: Value): void {
    this.vars.set(name, value);
  }

  get(name: string): Value | undefined {
    for (let env: Env | undefined = this; env; env = env.parent) {
      const value = env.vars.get(name);
      if (value) return value;
    }
    return this.globals.lookup(name);
  }

  /** Names bound locally (not globals), innermost first. */
  locals(): Map<string, Value> {
    const out = new Map<string, Value>();
    for (let env: Env | undefined = this; env; env = env.parent) for (const [name, value] of env.vars) if (!out.has(name)) out.set(name, value);
    return out;
  }
}

const BUILTINS = new Set([
  'union', 'inter', 'diff', 'Union', 'Inter', 'member', 'card', 'empty', 'set', 'seq', 'Set', 'Seq', 'head', 'tail', 'length', 'null', 'concat', 'elem',
  'productions', 'extensions', 'Events', 'Int', 'Bool', 'Char', 'STOP', 'SKIP', 'DIV', 'div', 'CHAOS', 'RUN', 'WAIT', 'error', 'show', 'normal', 'sbisim', 'diamond',
  'explicate', 'chase', 'chase_nocache', 'wbisim', 'tau_loop_factor', 'prioritise', 'prioritize', 'mtransclose', 'relational_image', 'relational_inverse_image', 'lazyenumerate',
  'deter', 'failure_watchdog', 'trace_watchdog', 'timed_priority', 'loop',
]);

/** Library processes the network treats as a leaf with a known behaviour. */
export const BUILTIN_PROCESSES = new Set(['STOP', 'SKIP', 'DIV', 'div', 'CHAOS', 'RUN', 'WAIT']);

/** Compression and other functions FDR applies to a process without changing its behaviour. */
export const TRANSPARENT_FUNCTIONS = new Set(['normal', 'sbisim', 'diamond', 'explicate', 'wbisim', 'chase', 'chase_nocache', 'tau_loop_factor', 'deter', 'lazyenumerate']);

/** Whether an expression is a process (an operator, STOP, or a reference to a process). */
export function isProcessExpr(e: Ex, globals: Globals, seen = new Set<string>()): boolean {
  switch (e.k) {
    case 'prefix': case 'guard': case 'op': case 'hide': case 'par': case 'apar': case 'link': case 'exception': case 'rename':
      return true;
    case 'repl':
      return true;
    case 'name':
      if (BUILTIN_PROCESSES.has(e.name)) return true;
      return refersToProcess(e.name, globals, seen);
    case 'app':
      if (e.fn.k === 'name') {
        if (e.fn.name === 'CHAOS' || e.fn.name === 'RUN' || e.fn.name === 'WAIT') return true;
        if (TRANSPARENT_FUNCTIONS.has(e.fn.name)) return true;
        return refersToProcess(e.fn.name, globals, seen);
      }
      return false;
    case 'if':
      return isProcessExpr(e.then, globals, seen) || isProcessExpr(e.else, globals, seen);
    case 'let':
      return isProcessExpr(e.body, globals, seen);
    default:
      return false;
  }
}

function refersToProcess(name: string, globals: Globals, seen: Set<string>): boolean {
  if (seen.has(name)) return false;
  seen.add(name);
  const clauses = globals.defs.get(name);
  return !!clauses?.some((clause) => isProcessExpr(clause.body, globals, seen));
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export function dotOf(head: string, args: Value[]): Value {
  return { t: 'dot', head, args };
}

/** A canonical text of a value: equality is equality of keys. */
export function show(v: Value): string {
  switch (v.t) {
    case 'int': return String(v.v);
    case 'bool': return v.v ? 'true' : 'false';
    case 'str': return JSON.stringify(v.v);
    case 'dot': return [v.head, ...v.args.map((arg) => (arg.t === 'dot' && arg.args.length ? `(${show(arg)})` : show(arg)))].join('.');
    case 'tuple': return `(${v.items.map(show).join(', ')})`;
    case 'set': return `{${v.items.map(show).join(', ')}}`;
    case 'seq': return `<${v.items.map(show).join(', ')}>`;
    case 'events': return v.all ? (v.minus.length ? `diff(Events, {|${v.minus.map(showPat).join(', ')}|})` : 'Events') : `{|${v.pats.map(showPat).join(', ')}|}`;
    case 'proc': return v.name ?? 'a process';
    case 'fn': return v.applied.length ? `${v.name}${v.applied.map((args) => `(${args.map(show).join(', ')})`).join('')}` : v.name;
    case 'builtin': return v.name;
    case 'unknown': return '?';
  }
}

export function showPat(p: EventPat): string {
  return [p.channel, ...p.fields.map((field) => (field ? show(field) : '_'))].join('.');
}

export function sameValue(a: Value, b: Value): boolean {
  return show(a) === show(b);
}

function setOf(items: Value[]): Value {
  const seen = new Map<string, Value>();
  for (const item of items) seen.set(show(item), item);
  return { t: 'set', items: [...seen.values()].sort(compareValues) };
}

function compareValues(a: Value, b: Value): number {
  if (a.t === 'int' && b.t === 'int') return a.v - b.v;
  const x = show(a);
  const y = show(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Atoms of a dotted value: `c.req.1` -> [c, req, 1] as values (the head first). */
export function flatten(v: Value): Value[] {
  if (v.t !== 'dot') return [v];
  return [dotOf(v.head, []), ...v.args.flatMap((arg) => (arg.t === 'dot' ? flatten(arg) : [arg]))];
}

/** `a.b`: the fields of b appended to a. */
function dotJoin(left: Value, right: Value, globals: Globals): Value {
  if (left.t === 'unknown') return left;
  if (left.t === 'dot' && (globals.channels.has(left.head) || globals.constructors.has(left.head))) return dotOf(left.head, [...left.args, ...(right.t === 'dot' ? flatten(right) : [right])]);
  return UNKNOWN('a dotted value that does not start with a channel or a constructor');
}

/** A type expression as a set of values: `{0..2}`, a datatype, `A.B` (every dotted pair), Bool. */
export function typeSet(v: Value, globals: Globals): Value {
  if (v.t === 'set' || v.t === 'unknown') return v;
  if (v.t === 'builtin' && v.name === 'Bool') return setOf([{ t: 'bool', v: false }, { t: 'bool', v: true }]);
  if (v.t === 'builtin' && (v.name === 'Int' || v.name === 'Char')) return UNKNOWN(`${v.name} is infinite`);
  if (v.t === 'tuple') {
    let rows: Value[][] = [[]];
    for (const item of v.items) {
      const set = typeSet(item, globals);
      if (set.t !== 'set') return UNKNOWN('a tuple type with a part that is not a finite set');
      rows = rows.flatMap((row) => set.items.map((value) => [...row, value]));
      if (rows.length > MAX_SET) return UNKNOWN('too many values');
    }
    return setOf(rows.map((items) => ({ t: 'tuple', items })));
  }
  return UNKNOWN('not a set of values');
}

// ---------------------------------------------------------------------------
// Event sets
// ---------------------------------------------------------------------------

/** A value as a set of events (`{| c |}`, `{c.1, d}`, a set of channel names, Events). */
export function toEvents(v: Value, globals: Globals): Extract<Value, { t: 'events' }> | undefined {
  if (v.t === 'events') return v;
  if (v.t === 'set') {
    const pats: EventPat[] = [];
    for (const item of v.items) {
      const pat = eventPatOf(item, globals, false);
      if (!pat) return undefined;
      pats.push(pat);
    }
    return { t: 'events', pats, all: false, minus: [] };
  }
  return undefined;
}

/** `c.1` as the pattern of that event (or, `open`, of every event that extends it). */
export function eventPatOf(v: Value, globals: Globals, open: boolean): EventPat | undefined {
  if (v.t !== 'dot' || !globals.channels.has(v.head)) return undefined;
  const atoms = flatten(v).slice(1);
  return { channel: v.head, fields: atoms, open };
}

/** Whether a set of events holds an event, as far as is known: `yes`, `no`, or `maybe` (the event has unknown fields). */
export function covers(set: Extract<Value, { t: 'events' }>, event: EventPat): 'yes' | 'no' | 'maybe' {
  const inside = (pats: readonly EventPat[]): 'yes' | 'no' | 'maybe' => {
    let best: 'yes' | 'no' | 'maybe' = 'no';
    for (const pat of pats) {
      const m = patCovers(pat, event);
      if (m === 'yes') return 'yes';
      if (m === 'maybe') best = 'maybe';
    }
    return best;
  };
  const base = set.all ? 'yes' : inside(set.pats);
  if (base === 'no') return 'no';
  const out = inside(set.minus);
  if (out === 'yes') return 'no';
  if (out === 'maybe') return 'maybe';
  return base;
}

function patCovers(pat: EventPat, event: EventPat): 'yes' | 'no' | 'maybe' {
  if (pat.channel !== event.channel) return 'no';
  let result: 'yes' | 'maybe' = 'yes';
  for (let i = 0; i < pat.fields.length; i++) {
    const want = pat.fields[i];
    if (!want) continue;
    if (i >= event.fields.length) {
      // The event's last field may be a compound value (an input of a datatype) that holds this one.
      if (event.open) result = 'maybe';
      else return 'no';
      continue;
    }
    const have = event.fields[i];
    if (!have || have.t === 'unknown') result = 'maybe';
    else if (!sameValue(have, want)) return 'no';
  }
  if (!pat.open && event.fields.length > pat.fields.length && !event.open) return 'no';
  return result;
}

function unionEvents(a: Extract<Value, { t: 'events' }>, b: Extract<Value, { t: 'events' }>): Value {
  if (a.all || b.all) {
    // Events minus what neither adds back: keep only exclusions both sides make.
    const minus = a.all && b.all ? a.minus.filter((pat) => b.minus.some((other) => showPat(other) === showPat(pat))) : (a.all ? a.minus : b.minus).filter((pat) => covers(a.all ? b : a, pat) !== 'yes');
    return { t: 'events', pats: [], all: true, minus };
  }
  return { t: 'events', pats: [...a.pats, ...b.pats], all: false, minus: [] };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Evaluate a value expression. Process terms evaluate to closures. Never throws. */
export function evaluate(e: Ex, env: Env): Value {
  const globals = env.globals;
  if (--globals.budget < 0) return UNKNOWN('the evaluation budget ran out');
  switch (e.k) {
    case 'num': return { t: 'int', v: e.value };
    case 'bool': return { t: 'bool', v: e.value };
    case 'str': return { t: 'str', v: e.value };
    case 'name': return env.get(e.name) ?? UNKNOWN(e.name.includes('::') ? `${e.name} is exported by a module, which the graph does not read` : `${e.name} is not defined in this file`);
    case 'dot': {
      let value = evaluate(e.parts[0], env);
      for (const part of e.parts.slice(1)) value = dotJoin(value, evaluate(part, env), globals);
      return value;
    }
    case 'tuple': return tupleOf(e.items.map((item) => evaluate(item, env)));
    case 'un': {
      const arg = evaluate(e.arg, env);
      if (e.op === '-') return arg.t === 'int' ? { t: 'int', v: -arg.v } : unknownOf(arg, 'a negated value that is not an integer');
      if (e.op === 'not') return arg.t === 'bool' ? { t: 'bool', v: !arg.v } : unknownOf(arg, 'a negated condition that is not a boolean');
      return arg.t === 'seq' ? { t: 'int', v: arg.items.length } : arg.t === 'set' ? { t: 'int', v: arg.items.length } : unknownOf(arg, 'the length of something that is not a sequence');
    }
    case 'bin': return binary(e.op, e.left, e.right, env);
    case 'set': {
      const items = e.items.map((item) => evaluate(item, env));
      const missing = items.find((item) => item.t === 'unknown');
      if (missing) return missing;
      return setOf(items);
    }
    case 'range': {
      const from = evaluate(e.from, env);
      const to = e.to ? evaluate(e.to, env) : undefined;
      if (from.t !== 'int') return unknownOf(from, 'a range that does not start at an integer');
      if (!to) return UNKNOWN(`the infinite range ${from.v}..`);
      if (to.t !== 'int') return unknownOf(to, 'a range that does not end at an integer');
      if (to.v - from.v + 1 > MAX_SET) return UNKNOWN(`the range ${from.v}..${to.v} has too many values`);
      const items: Value[] = [];
      for (let n = from.v; n <= to.v; n++) items.push({ t: 'int', v: n });
      return e.seq ? { t: 'seq', items } : { t: 'set', items };
    }
    case 'seq': return { t: 'seq', items: e.items.map((item) => evaluate(item, env)) };
    case 'comp': {
      const out: Value[] = [];
      const ok = comprehend(e.stmts, env, (inner) => {
        for (const item of e.items) out.push(evaluate(item, inner));
        return out.length <= MAX_SET;
      });
      if (ok !== true) return UNKNOWN(ok);
      const missing = out.find((item) => item.t === 'unknown');
      if (missing) return missing;
      return e.seq ? { t: 'seq', items: out } : setOf(out);
    }
    case 'enum': {
      const pats: EventPat[] = [];
      const add = (inner: Env): boolean => {
        for (const item of e.items) {
          const value = evaluate(item, inner);
          if (value.t === 'set') {
            for (const member of value.items) {
              const pat = eventPatOf(member, globals, true);
              if (pat) pats.push(pat);
            }
            continue;
          }
          const pat = eventPatOf(value, globals, true);
          if (!pat) {
            failed = value.t === 'unknown' ? value.why : `${show(value)} is not an event or a channel`;
            return false;
          }
          pats.push(pat);
        }
        return pats.length <= MAX_SET;
      };
      let failed: string | undefined;
      const ok = e.stmts ? comprehend(e.stmts, env, add) : add(env) || failed || 'too many events';
      if (ok !== true) return UNKNOWN(failed ?? (typeof ok === 'string' ? ok : 'a set of events'));
      return { t: 'events', pats, all: false, minus: [] };
    }
    case 'if': {
      const cond = evaluate(e.cond, env);
      if (cond.t !== 'bool') return unknownOf(cond, 'a condition that is not a boolean');
      return evaluate(cond.v ? e.then : e.else, env);
    }
    case 'let': return evaluate(e.body, letEnv(e.decls, env));
    case 'lambda': return { t: 'fn', name: 'a lambda', clauses: [{ params: [e.params], body: e.body }], env, applied: [] };
    case 'app': return apply(e, env);
    case 'opaque': return UNKNOWN(`syntax the graph does not read (${e.reason})`);
    default:
      // A process operator: a process.
      return { t: 'proc', expr: e, env };
  }
}

function unknownOf(v: Value, why: string): Value {
  return v.t === 'unknown' ? v : UNKNOWN(why);
}

function tupleOf(items: Value[]): Value {
  return items.find((item) => item.t === 'unknown') ?? { t: 'tuple', items };
}

/** The environment of a let's body: its definitions see each other. */
export function letEnv(decls: readonly Decl[], env: Env): Env {
  const inner = env.child();
  const groups = new Map<string, Clause[]>();
  for (const decl of decls) {
    if (decl.kind !== 'def') continue;
    const list = groups.get(decl.name.name) ?? [];
    list.push({ params: decl.params, body: decl.body, def: decl });
    groups.set(decl.name.name, list);
  }
  for (const [name, clauses] of groups) {
    if (clauses.some((clause) => clause.params.length)) inner.set(name, { t: 'fn', name, clauses, env: inner, applied: [] });
    else {
      const body = clauses[0].body;
      inner.set(name, isProcessExpr(body, env.globals) ? { t: 'proc', expr: body, env: inner, name } : lazyValue(body, inner));
    }
  }
  return inner;
}

/** A let value, evaluated now (lets are small; a cycle evaluates to unknown through the budget). */
function lazyValue(body: Ex, env: Env): Value {
  return evaluate(body, env);
}

function binary(op: string, l: Ex, r: Ex, env: Env): Value {
  const left = evaluate(l, env);
  if (op === 'and' && left.t === 'bool' && !left.v) return left;
  if (op === 'or' && left.t === 'bool' && left.v) return left;
  const right = evaluate(r, env);
  if (left.t === 'unknown') return left;
  if (right.t === 'unknown') return right;
  switch (op) {
    case '+': case '-': case '*': case '/': case '%': {
      if (left.t !== 'int' || right.t !== 'int') return UNKNOWN(`arithmetic on something that is not an integer`);
      if ((op === '/' || op === '%') && right.v === 0) return UNKNOWN('division by zero');
      const v = op === '+' ? left.v + right.v : op === '-' ? left.v - right.v : op === '*' ? left.v * right.v : op === '/' ? Math.trunc(left.v / right.v) : ((left.v % right.v) + Math.abs(right.v)) % Math.abs(right.v);
      return { t: 'int', v };
    }
    case '==': return { t: 'bool', v: sameValue(left, right) };
    case '!=': return { t: 'bool', v: !sameValue(left, right) };
    case '<': case '>': case '<=': case '>=': {
      if (left.t === 'int' && right.t === 'int') {
        const v = op === '<' ? left.v < right.v : op === '>' ? left.v > right.v : op === '<=' ? left.v <= right.v : left.v >= right.v;
        return { t: 'bool', v };
      }
      if (left.t === 'set' && right.t === 'set') {
        // Subset comparisons.
        const sub = (a: Value[], b: Value[]): boolean => a.every((x) => b.some((y) => sameValue(x, y)));
        const v = op === '<=' ? sub(left.items, right.items) : op === '>=' ? sub(right.items, left.items) : op === '<' ? sub(left.items, right.items) && left.items.length < right.items.length : sub(right.items, left.items) && right.items.length < left.items.length;
        return { t: 'bool', v };
      }
      return UNKNOWN('a comparison the graph cannot evaluate');
    }
    case 'and': case 'or':
      if (left.t !== 'bool' || right.t !== 'bool') return UNKNOWN('a condition that is not a boolean');
      return { t: 'bool', v: op === 'and' ? left.v && right.v : left.v || right.v };
    case '^':
      if (left.t !== 'seq' || right.t !== 'seq') return UNKNOWN('concatenation of something that is not a sequence');
      return { t: 'seq', items: [...left.items, ...right.items] };
    default:
      return UNKNOWN(`the operator ${op}`);
  }
}

/** Run comprehension statements, calling `body` with each binding; true, or why it could not. */
export function comprehend(stmts: readonly Stmt[], env: Env, body: (env: Env) => boolean): true | string {
  let count = 0;
  const step = (index: number, current: Env): true | string => {
    if (index === stmts.length) {
      if (++count > MAX_SET) return 'too many values';
      return body(current) ? true : 'too many values';
    }
    const stmt = stmts[index];
    if (stmt.kind === 'cond') {
      const cond = evaluate(stmt.expr, current);
      if (cond.t !== 'bool') return cond.t === 'unknown' ? cond.why : 'a condition that is not a boolean';
      return cond.v ? step(index + 1, current) : true;
    }
    const source = typeSet(evaluate(stmt.source, current), current.globals);
    const items = source.t === 'set' || source.t === 'seq' ? source.items : undefined;
    if (!items) return source.t === 'unknown' ? source.why : `${show(source)} is not a finite set`;
    for (const item of items) {
      const bound = new Map<string, Value>();
      if (match(stmt.pattern, item, current.globals, bound) !== 'yes') continue;
      const result = step(index + 1, current.child(bound));
      if (result !== true) return result;
    }
    return true;
  };
  return step(0, env);
}

/** Apply a function or library function. */
function apply(e: Extract<Ex, { k: 'app' }>, env: Env): Value {
  const fn = evaluate(e.fn, env);
  const args = e.args.map((arg) => evaluate(arg, env));
  return applyValue(fn, args, e, env);
}

export function applyValue(fn: Value, args: Value[], e: Ex | undefined, env: Env): Value {
  const globals = env.globals;
  if (fn.t === 'builtin') return library(fn.name, args, e, env, globals);
  if (fn.t === 'fn') {
    const applied = [...fn.applied, args];
    const arity = fn.clauses[0]?.params.length ?? 1;
    if (applied.length < arity) return { ...fn, applied };
    const chosen = chooseClause(fn, applied, globals);
    if (typeof chosen === 'string') return UNKNOWN(chosen);
    const value = isProcessExpr(chosen.clause.body, globals) ? { t: 'proc' as const, expr: chosen.clause.body, env: chosen.env, name: `${fn.name}${applied.map((group) => `(${group.map(show).join(', ')})`).join('')}` } : evaluate(chosen.clause.body, chosen.env);
    return value;
  }
  if (fn.t === 'dot') {
    // `c(x)` is not CSPm; a constructor or channel applied: unknown.
    return UNKNOWN(`${fn.head} applied to arguments`);
  }
  if (fn.t === 'unknown') return fn;
  return UNKNOWN(`${show(fn)} is not a function`);
}

/** The clause of a definition that matches these arguments, with its parameters bound. */
export function chooseClause(fn: Extract<Value, { t: 'fn' }>, applied: Value[][], globals: Globals): { clause: Clause; env: Env } | string {
  for (const clause of fn.clauses) {
    const bound = new Map<string, Value>();
    let result: 'yes' | 'no' | 'maybe' = 'yes';
    clause.params.forEach((group, g) => {
      group.forEach((pattern, p) => {
        if (result === 'no') return;
        const value = applied[g]?.[p] ?? UNKNOWN('a missing argument');
        const m = match(pattern, value, globals, bound);
        if (m === 'no') result = 'no';
        else if (m === 'maybe') result = 'maybe';
      });
    });
    if (result === 'yes') return { clause, env: fn.env.child(bound) };
    if (result === 'maybe') return `which clause of ${fn.name} applies depends on a value the graph does not know`;
  }
  return `no clause of ${fn.name} matches (${applied.map((group) => group.map(show).join(', ')).join('; ')})`;
}

/** Match a pattern against a value, binding its variables. `maybe`: the value is unknown where it matters. */
export function match(pattern: Ex, value: Value, globals: Globals, bound: Map<string, Value>): 'yes' | 'no' | 'maybe' {
  switch (pattern.k) {
    case 'name':
      if (pattern.name === '_') return 'yes';
      if (globals.isConstant(pattern.name)) {
        if (value.t === 'unknown') return 'maybe';
        return value.t === 'dot' && value.head === pattern.name && value.args.length === 0 ? 'yes' : 'no';
      }
      bound.set(pattern.name, value);
      return 'yes';
    case 'num':
    case 'bool':
    case 'str': {
      if (value.t === 'unknown') return 'maybe';
      const literal: Value = pattern.k === 'num' ? { t: 'int', v: pattern.value } : pattern.k === 'bool' ? { t: 'bool', v: pattern.value } : { t: 'str', v: pattern.value };
      return sameValue(literal, value) ? 'yes' : 'no';
    }
    case 'un':
      if (pattern.op === '-' && pattern.arg.k === 'num') return match({ k: 'num', value: -pattern.arg.value, span: pattern.span }, value, globals, bound);
      return 'maybe';
    case 'tuple': {
      if (value.t === 'unknown') {
        for (const item of pattern.items) match(item, value, globals, bound);
        return 'yes';
      }
      if (value.t !== 'tuple' || value.items.length !== pattern.items.length) return 'no';
      return all(pattern.items.map((item, i) => match(item, value.items[i], globals, bound)));
    }
    case 'dot': {
      if (value.t === 'unknown') {
        for (const part of pattern.parts) match(part, value, globals, bound);
        return pattern.parts.some((part) => part.k !== 'name' || globals.isConstant(part.name)) ? 'maybe' : 'yes';
      }
      const atoms = flatten(value);
      const results: Array<'yes' | 'no' | 'maybe'> = [];
      for (let i = 0; i < pattern.parts.length; i++) {
        const last = i === pattern.parts.length - 1;
        if (i >= atoms.length) return 'no';
        // The last part takes what is left: `c.x` against c.1.2 binds x to 1.2.
        const rest = last && atoms.length > pattern.parts.length ? restOf(atoms.slice(i)) : atoms[i];
        results.push(match(pattern.parts[i], rest, globals, bound));
      }
      if (atoms.length < pattern.parts.length) return 'no';
      return all(results);
    }
    case 'seq': {
      if (value.t === 'unknown') {
        for (const item of pattern.items) match(item, value, globals, bound);
        return 'maybe';
      }
      if (value.t !== 'seq' || value.items.length !== pattern.items.length) return 'no';
      return all(pattern.items.map((item, i) => match(item, value.items[i], globals, bound)));
    }
    case 'bin':
      if (pattern.op === '^' && value.t === 'seq') {
        // `<x>^xs` and `xs^<x>`.
        if (pattern.left.k === 'seq') {
          const n = pattern.left.items.length;
          if (value.items.length < n) return 'no';
          return all([match(pattern.left, { t: 'seq', items: value.items.slice(0, n) }, globals, bound), match(pattern.right, { t: 'seq', items: value.items.slice(n) }, globals, bound)]);
        }
        if (pattern.right.k === 'seq') {
          const n = pattern.right.items.length;
          if (value.items.length < n) return 'no';
          return all([match(pattern.left, { t: 'seq', items: value.items.slice(0, value.items.length - n) }, globals, bound), match(pattern.right, { t: 'seq', items: value.items.slice(value.items.length - n) }, globals, bound)]);
        }
      }
      return 'maybe';
    case 'set': {
      if (value.t === 'unknown') return 'maybe';
      if (value.t !== 'set') return 'no';
      if (pattern.items.length === 0) return value.items.length === 0 ? 'yes' : 'no';
      if (pattern.items.length === 1 && value.items.length === 1) return match(pattern.items[0], value.items[0], globals, bound);
      return 'no';
    }
    default:
      return 'maybe';
  }
}

function restOf(atoms: Value[]): Value {
  const [first, ...rest] = atoms;
  if (!rest.length) return first;
  return first.t === 'dot' ? dotOf(first.head, rest) : { t: 'unknown', why: 'a compound value' };
}

function all(results: Array<'yes' | 'no' | 'maybe'>): 'yes' | 'no' | 'maybe' {
  if (results.includes('no')) return 'no';
  return results.includes('maybe') ? 'maybe' : 'yes';
}

function library(name: string, args: Value[], e: Ex | undefined, env: Env, globals: Globals): Value {
  const missing = args.find((arg) => arg.t === 'unknown');
  const sets = (): Value[][] | undefined => {
    const out: Value[][] = [];
    for (const arg of args) {
      const set = typeSet(arg, globals);
      if (set.t !== 'set') return undefined;
      out.push(set.items);
    }
    return out;
  };
  switch (name) {
    case 'union': case 'inter': case 'diff': {
      if (missing) return missing;
      const ev = args.map((arg) => (arg.t === 'events' ? arg : undefined));
      if (ev.some((x) => x)) {
        const [a, b] = args.map((arg) => toEvents(arg, globals));
        if (!a || !b) return UNKNOWN(`${name} of a set of events and something else`);
        if (name === 'union') return unionEvents(a, b);
        if (name === 'diff') return a.all ? { t: 'events', pats: [], all: true, minus: [...a.minus, ...b.pats] } : { t: 'events', pats: a.pats.filter((pat) => covers(b, pat) !== 'yes'), all: false, minus: b.all ? [] : b.pats };
        // inter: the patterns of one side the other holds.
        if (a.all) return b;
        if (b.all) return a;
        return { t: 'events', pats: [...a.pats.filter((pat) => covers(b, pat) !== 'no'), ...b.pats.filter((pat) => covers(a, pat) !== 'no')], all: false, minus: [] };
      }
      const s = sets();
      if (!s || s.length !== 2) return UNKNOWN(`${name} of something that is not a finite set`);
      const [a, b] = s;
      const has = (list: Value[], v: Value): boolean => list.some((x) => sameValue(x, v));
      return setOf(name === 'union' ? [...a, ...b] : name === 'inter' ? a.filter((v) => has(b, v)) : a.filter((v) => !has(b, v)));
    }
    case 'Union': case 'Inter': {
      if (missing) return missing;
      const outer = args[0];
      if (outer?.t !== 'set') return UNKNOWN(`${name} of something that is not a finite set`);
      if (!outer.items.length) return name === 'Union' ? { t: 'set', items: [] } : UNKNOWN('Inter of no sets');
      let acc = outer.items[0];
      for (const item of outer.items.slice(1)) acc = library(name === 'Union' ? 'union' : 'inter', [acc, item], e, env, globals);
      return acc;
    }
    case 'member': {
      if (missing) return missing;
      const [v, s] = args;
      if (s.t === 'events') {
        const pat = eventPatOf(v, globals, false);
        const c = pat ? covers(s, pat) : 'maybe';
        return c === 'maybe' ? UNKNOWN('membership of an event the graph cannot decide') : { t: 'bool', v: c === 'yes' };
      }
      const set = typeSet(s, globals);
      if (set.t !== 'set' && s.t !== 'seq') return UNKNOWN('member of something that is not a finite set');
      const items = s.t === 'seq' ? s.items : (set as Extract<Value, { t: 'set' }>).items;
      return { t: 'bool', v: items.some((x) => sameValue(x, v)) };
    }
    case 'elem': {
      if (missing) return missing;
      const [v, s] = args;
      return s.t === 'seq' ? { t: 'bool', v: s.items.some((x) => sameValue(x, v)) } : UNKNOWN('elem of something that is not a sequence');
    }
    case 'card': case 'length': case '#': {
      if (missing) return missing;
      const v = args[0];
      return v.t === 'set' || v.t === 'seq' ? { t: 'int', v: v.items.length } : UNKNOWN(`${name} of something that is not finite`);
    }
    case 'empty': case 'null': {
      if (missing) return missing;
      const v = args[0];
      return v.t === 'set' || v.t === 'seq' ? { t: 'bool', v: v.items.length === 0 } : UNKNOWN(`${name} of something that is not finite`);
    }
    case 'set': return missing ?? (args[0]?.t === 'seq' ? setOf(args[0].items) : UNKNOWN('set of something that is not a sequence'));
    case 'seq': return missing ?? (args[0]?.t === 'set' ? { t: 'seq', items: args[0].items } : UNKNOWN('seq of something that is not a set'));
    case 'head': return missing ?? (args[0]?.t === 'seq' && args[0].items.length ? args[0].items[0] : UNKNOWN('head of an empty or unknown sequence'));
    case 'tail': return missing ?? (args[0]?.t === 'seq' && args[0].items.length ? { t: 'seq', items: args[0].items.slice(1) } : UNKNOWN('tail of an empty or unknown sequence'));
    case 'concat': {
      if (missing) return missing;
      const v = args[0];
      if (v.t !== 'seq' || !v.items.every((item) => item.t === 'seq')) return UNKNOWN('concat of something that is not a sequence of sequences');
      return { t: 'seq', items: v.items.flatMap((item) => (item as Extract<Value, { t: 'seq' }>).items) };
    }
    case 'productions': {
      if (missing) return missing;
      const pat = eventPatOf(args[0], globals, true);
      return pat ? { t: 'events', pats: [pat], all: false, minus: [] } : UNKNOWN('productions of something that is not an event');
    }
    case 'Set': {
      if (missing) return missing;
      const set = typeSet(args[0], globals);
      if (set.t !== 'set' || set.items.length > 12) return UNKNOWN('the subsets of a large or unknown set');
      const subsets: Value[] = [];
      for (let mask = 0; mask < 1 << set.items.length; mask++) subsets.push({ t: 'set', items: set.items.filter((_, i) => mask & (1 << i)) });
      return { t: 'set', items: subsets };
    }
    case 'Events': return { t: 'events', pats: [], all: true, minus: [] };
    default:
      // A process-valued library function (CHAOS, RUN, normal, ...): a process.
      if (e && (BUILTIN_PROCESSES.has(name) || TRANSPARENT_FUNCTIONS.has(name))) return { t: 'proc', expr: e, env };
      return UNKNOWN(`the library function ${name}`);
  }
}

function textOf(text: string, span: Definition['span']): string {
  const lines = text.split('\n');
  if (span.start.line === span.end.line) return (lines[span.start.line] ?? '').slice(span.start.col, span.end.col).trim();
  return [(lines[span.start.line] ?? '').slice(span.start.col), ...lines.slice(span.start.line + 1, span.end.line), (lines[span.end.line] ?? '').slice(0, span.end.col)].join(' ').replace(/\s+/g, ' ').trim();
}
