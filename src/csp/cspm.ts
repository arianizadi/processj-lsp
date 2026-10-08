/**
 * CSPm names, a small expression tree and its printer.
 *
 * Expressions are kept as trees until a definition is printed so variables
 * can be substituted (straight-line code folds into the arguments of the next
 * definition) and every value can be range-checked where it is stored. The
 * printer parenthesises every compound operand: CSPm's unary minus binds
 * looser than `/` (`-7/2` is `-(7/2)`), `{-` opens a block comment, and
 * explicit parentheses are cheaper than remembering which corner case bites.
 */

/** Keywords, builtins and library names a ProcessJ identifier must not shadow. */
const RESERVED = new Set([
  // keywords
  'and', 'assert', 'channel', 'datatype', 'else', 'endmodule', 'exports', 'external', 'false', 'if', 'include', 'instance',
  'let', 'module', 'nametype', 'not', 'of', 'or', 'print', 'subtype', 'then', 'timed', 'transparent', 'true', 'within', 'Timed',
  // processes, sets and types
  'STOP', 'SKIP', 'CHAOS', 'RUN', 'DIV', 'WAIT', 'TSTOP', 'TSKIP', 'Events', 'Bool', 'Int', 'Char', 'Proc', 'Set', 'Seq', 'Seq1', 'Map',
  // functions
  'union', 'inter', 'diff', 'Union', 'Inter', 'member', 'card', 'empty', 'set', 'seq', 'length', 'null', 'head', 'tail', 'concat',
  'elem', 'error', 'show', 'extensions', 'productions', 'normal', 'normalise', 'normalize', 'sbisim', 'tau_loop_factor', 'diamond',
  'model_compress', 'explicate', 'wbisim', 'dbisim', 'chase', 'chase_nocache', 'prioritise', 'prioritise_nocache', 'prioritisepo',
  'lazyenumerate', 'deter', 'failure_watchdog', 'trace_watchdog', 'relational_image', 'relational_inverse_image', 'transpose',
  'mtransclose', 'emptyMap', 'mapFromList', 'mapLookup', 'mapMember', 'mapToList', 'mapUpdate', 'mapUpdateMultiple', 'mapDelete',
  'loop', 'timed_priority', 'fst', 'snd', 'xor', 'Inter', 'emptySet',
]);

/**
 * A ProcessJ identifier as a CSPm identifier. Reserved words get a trailing
 * `_`; names in the translator's own namespaces (`pj_`, `PJ`, anything with
 * `__`) are prefixed so they can never meet a generated name.
 */
export function mangle(name: string): string {
  let out = name.replace(/\$/g, '_S_');
  if (/^(pj_|PJ)/i.test(out) || out.includes('__')) out = `u_${out.replace(/__+/g, '_')}`;
  if (RESERVED.has(out)) out += '_';
  return out;
}

/** Hands out unique global names; the first request for a base name gets it unchanged. */
export class NameTable {
  private readonly used = new Set<string>();

  constructor(reserved: Iterable<string> = []) {
    for (const r of reserved) this.used.add(r);
  }

  /** `base`, or `base_2`, `base_3`, ... for later requests. */
  fresh(base: string): string {
    if (!this.used.has(base)) {
      this.used.add(base);
      return base;
    }
    for (let i = 2; ; i++) {
      const candidate = `${base}_${i}`;
      if (!this.used.has(candidate)) {
        this.used.add(candidate);
        return candidate;
      }
    }
  }

  has(name: string): boolean {
    return this.used.has(name);
  }

  reserve(name: string): void {
    this.used.add(name);
  }
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type Ex =
  | { k: 'int'; v: number }
  | { k: 'bool'; v: boolean }
  /** A CSPm variable: a definition parameter or an input binding. */
  | { k: 'var'; name: string }
  /** A global CSPm name used as a value: a channel, constructor, set or constant. */
  | { k: 'name'; name: string }
  | { k: 'not'; e: Ex }
  | { k: 'neg'; e: Ex }
  | { k: 'bin'; op: BinOp; l: Ex; r: Ex }
  | { k: 'call'; fn: string; args: Ex[] }
  | { k: 'if'; c: Ex; t: Ex; e: Ex }
  /** `C.a.b`: a constructor or event applied to fields. */
  | { k: 'dot'; head: Ex; fields: Ex[] }
  | { k: 'seq'; items: Ex[] }
  | { k: 'set'; items: Ex[] }
  | { k: 'range'; lo: Ex; hi: Ex }
  /** `{| c, d |}` */
  | { k: 'prod'; items: Ex[] }
  | { k: 'tuple'; items: Ex[] }
  /** A value nothing can know (a timer reading, a string, a double): one abstract value. */
  | { k: 'any' }
  /** A value chosen nondeterministically from a domain; bound by an internal choice where it is used. */
  | { k: 'choose'; id: number; domain: Ex }
  /**
   * An integer that never decides anything (relevance.ts): `e` while it is in
   * lo..hi, PJ_SAT (hi + 1) otherwise, and PJ_SAT when one of `vs` holds it already.
   */
  | { k: 'sat'; e: Ex; vs: Ex[]; lo: number; hi: number };

/** CSPm's own `/` and `%` round toward minus infinity; Java division goes through `pj_div` and `pj_mod`. */
export type BinOp = '+' | '-' | '*' | '==' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or';

export const E = {
  int: (v: number): Ex => ({ k: 'int', v }),
  bool: (v: boolean): Ex => ({ k: 'bool', v }),
  v: (name: string): Ex => ({ k: 'var', name }),
  n: (name: string): Ex => ({ k: 'name', name }),
  not: (e: Ex): Ex => (e.k === 'bool' ? { k: 'bool', v: !e.v } : e.k === 'not' ? e.e : { k: 'not', e }),
  bin: (op: BinOp, l: Ex, r: Ex): Ex => fold({ k: 'bin', op, l, r }),
  call: (fn: string, ...args: Ex[]): Ex => ({ k: 'call', fn, args }),
  dot: (head: Ex, ...fields: Ex[]): Ex => (fields.length ? { k: 'dot', head, fields } : head),
  and: (l: Ex, r: Ex): Ex => fold({ k: 'bin', op: 'and', l, r }),
  or: (l: Ex, r: Ex): Ex => fold({ k: 'bin', op: 'or', l, r }),
  if: (c: Ex, t: Ex, e: Ex): Ex => (c.k === 'bool' ? (c.v ? t : e) : { k: 'if', c, t, e }),
  any: { k: 'any' } as Ex,
  sat: (e: Ex, vs: Ex[], lo: number, hi: number): Ex => foldSat({ k: 'sat', e, vs, lo, hi }),
};

/** A saturation of constants is a constant: `pj_sat(2)` is 2, `pj_satv(x + 1, {PJ_SAT})` is PJ_SAT. */
function foldSat(s: Extract<Ex, { k: 'sat' }>): Ex {
  const sat = s.hi + 1;
  if (s.vs.some((v) => v.k === 'int' && v.v === sat)) return E.int(sat);
  const vs = s.vs.filter((v) => v.k !== 'int');
  if (vs.length === 0 && s.e.k === 'int') return s.e.v >= s.lo && s.e.v <= s.hi ? s.e : E.int(sat);
  return { ...s, vs };
}

/** Fold constant arithmetic and comparisons, with Java's truncating division. */
function fold(e: Extract<Ex, { k: 'bin' }>): Ex {
  const { op, l, r } = e;
  if (op === 'and') {
    if (l.k === 'bool') return l.v ? r : l;
    if (r.k === 'bool' && r.v) return l;
    return e;
  }
  if (op === 'or') {
    if (l.k === 'bool') return l.v ? l : r;
    if (r.k === 'bool' && !r.v) return l;
    return e;
  }
  if (l.k === 'int' && r.k === 'int') {
    switch (op) {
      case '+': return E.int(l.v + r.v);
      case '-': return E.int(l.v - r.v);
      case '*': return E.int(l.v * r.v);
      case '==': return E.bool(l.v === r.v);
      case '!=': return E.bool(l.v !== r.v);
      case '<': return E.bool(l.v < r.v);
      case '<=': return E.bool(l.v <= r.v);
      case '>': return E.bool(l.v > r.v);
      case '>=': return E.bool(l.v >= r.v);
    }
  }
  if (l.k === 'bool' && r.k === 'bool' && (op === '==' || op === '!=')) return E.bool((l.v === r.v) === (op === '=='));
  return e;
}

/** Variables an expression mentions. */
export function freeVars(e: Ex, out = new Set<string>()): Set<string> {
  switch (e.k) {
    case 'var':
      out.add(e.name);
      break;
    case 'not':
    case 'neg':
      freeVars(e.e, out);
      break;
    case 'bin':
      freeVars(e.l, out);
      freeVars(e.r, out);
      break;
    case 'call':
      for (const a of e.args) freeVars(a, out);
      break;
    case 'if':
      freeVars(e.c, out);
      freeVars(e.t, out);
      freeVars(e.e, out);
      break;
    case 'dot':
      freeVars(e.head, out);
      for (const f of e.fields) freeVars(f, out);
      break;
    case 'seq':
    case 'set':
    case 'prod':
    case 'tuple':
      for (const x of e.items) freeVars(x, out);
      break;
    case 'range':
      freeVars(e.lo, out);
      freeVars(e.hi, out);
      break;
    case 'choose':
      freeVars(e.domain, out);
      break;
    case 'sat':
      freeVars(e.e, out);
      for (const v of e.vs) freeVars(v, out);
      break;
    default:
      break;
  }
  return out;
}

/** Replace variables by expressions. */
export function substitute(e: Ex, env: ReadonlyMap<string, Ex>): Ex {
  switch (e.k) {
    case 'var':
      return env.get(e.name) ?? e;
    case 'not':
      return E.not(substitute(e.e, env));
    case 'neg': {
      const inner = substitute(e.e, env);
      return inner.k === 'int' ? E.int(-inner.v) : { k: 'neg', e: inner };
    }
    case 'bin':
      return E.bin(e.op, substitute(e.l, env), substitute(e.r, env));
    case 'call':
      return { k: 'call', fn: e.fn, args: e.args.map((a) => substitute(a, env)) };
    case 'if':
      return E.if(substitute(e.c, env), substitute(e.t, env), substitute(e.e, env));
    case 'dot':
      return { k: 'dot', head: substitute(e.head, env), fields: e.fields.map((f) => substitute(f, env)) };
    case 'seq':
    case 'set':
    case 'prod':
    case 'tuple':
      return { k: e.k, items: e.items.map((x) => substitute(x, env)) };
    case 'range':
      return { k: 'range', lo: substitute(e.lo, env), hi: substitute(e.hi, env) };
    case 'choose':
      return { k: 'choose', id: e.id, domain: substitute(e.domain, env) };
    case 'sat':
      return E.sat(substitute(e.e, env), e.vs.map((v) => substitute(v, env)), e.lo, e.hi);
    default:
      return e;
  }
}

/** The `choose` nodes of an expression, outermost first. */
export function chooses(e: Ex, out: Array<Extract<Ex, { k: 'choose' }>> = []): Array<Extract<Ex, { k: 'choose' }>> {
  const visit = (x: Ex): void => {
    switch (x.k) {
      case 'choose':
        if (!out.some((c) => c.id === x.id)) out.push(x);
        visit(x.domain);
        break;
      case 'not':
      case 'neg':
        visit(x.e);
        break;
      case 'bin':
        visit(x.l);
        visit(x.r);
        break;
      case 'call':
        x.args.forEach(visit);
        break;
      case 'if':
        visit(x.c);
        visit(x.t);
        visit(x.e);
        break;
      case 'dot':
        visit(x.head);
        x.fields.forEach(visit);
        break;
      case 'seq':
      case 'set':
      case 'prod':
      case 'tuple':
        x.items.forEach(visit);
        break;
      case 'range':
        visit(x.lo);
        visit(x.hi);
        break;
      case 'sat':
        visit(x.e);
        x.vs.forEach(visit);
        break;
      default:
        break;
    }
  };
  visit(e);
  return out;
}

/** Whether the expression contains the abstract value (anything derived from a timer, a string, a double). */
export function isAbstract(e: Ex): boolean {
  switch (e.k) {
    case 'any':
      return true;
    case 'not':
    case 'neg':
      return isAbstract(e.e);
    case 'bin':
      return isAbstract(e.l) || isAbstract(e.r);
    case 'call':
      return e.args.some(isAbstract);
    case 'if':
      return isAbstract(e.c) || isAbstract(e.t) || isAbstract(e.e);
    case 'dot':
      return isAbstract(e.head) || e.fields.some(isAbstract);
    case 'seq':
    case 'set':
    case 'prod':
    case 'tuple':
      return e.items.some(isAbstract);
    case 'range':
      return isAbstract(e.lo) || isAbstract(e.hi);
    case 'sat':
      return isAbstract(e.e) || e.vs.some(isAbstract);
    default:
      return false;
  }
}

/** CSPm text for an expression. */
export function show(e: Ex): string {
  switch (e.k) {
    case 'int':
      return e.v < 0 ? `(${e.v})` : String(e.v);
    case 'bool':
      return e.v ? 'true' : 'false';
    case 'var':
    case 'name':
      return e.name;
    case 'any':
      return 'pj_any';
    case 'not':
      return `not ${operand(e.e)}`;
    case 'neg':
      return `(-${operand(e.e)})`;
    case 'bin':
      return `${operand(e.l)} ${e.op} ${operand(e.r)}`;
    case 'call':
      return `${e.fn}(${e.args.map(show).join(', ')})`;
    case 'if':
      return `if ${show(e.c)} then ${operand(e.t)} else ${operand(e.e)}`;
    case 'dot':
      return [atom(e.head), ...e.fields.map(atom)].join('.');
    case 'seq':
      return `<${e.items.map(show).join(', ')}>`;
    case 'set':
      return braces('{', e.items.map(show).join(', '), '}');
    case 'range':
      return braces('{', `${show(e.lo)}..${show(e.hi)}`, '}');
    case 'prod':
      return `{| ${e.items.map(show).join(', ')} |}`;
    case 'tuple':
      return `(${e.items.map(show).join(', ')})`;
    case 'choose':
      return `pj_c${e.id}`;
    case 'sat':
      return e.vs.length ? `pj_satv(${show(e.e)}, ${braces('{', e.vs.map(show).join(', '), '}')})` : `pj_sat(${show(e.e)})`;
  }
}

/** A compound sub-expression in parentheses. */
function operand(e: Ex): string {
  return isAtomic(e) ? show(e) : `(${show(e)})`;
}

/** Fields after a `.`, `!` or `?` must be atoms. */
export function atom(e: Ex): string {
  return isAtomic(e) && !(e.k === 'int' && e.v < 0) ? show(e) : e.k === 'int' ? `(${e.v})` : `(${show(e)})`;
}

function isAtomic(e: Ex): boolean {
  return e.k === 'int' || e.k === 'bool' || e.k === 'var' || e.k === 'name' || e.k === 'any' || e.k === 'call' || e.k === 'seq'
    || e.k === 'set' || e.k === 'range' || e.k === 'prod' || e.k === 'tuple' || e.k === 'choose' || e.k === 'sat';
}

/** `{` followed by `-` opens a CSPm block comment; keep them apart. */
export function braces(open: string, inner: string, close: string): string {
  return inner.startsWith('-') ? `${open} ${inner}${close}` : `${open}${inner}${close}`;
}

/** `{lo..hi}` as text, safe for negative bounds. */
export function rangeText(lo: number, hi: number): string {
  return braces('{', `${lo}..${hi}`, '}');
}

/** Source text made safe for a CSPm `--` comment (no block-comment delimiters, one line). */
export function commentText(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\{-/g, '{ -').replace(/-\}/g, '- }').trim();
}
