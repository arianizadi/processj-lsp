/**
 * Type model for the checker. Mirrors the compiler's `ast/Type` hierarchy but with
 * Java's widening rules, which is what the generated code ends up obeying anyway.
 */
import type * as A from '../parser/ast';

export type PrimName = 'boolean' | 'byte' | 'short' | 'char' | 'int' | 'long' | 'float' | 'double' | 'string' | 'void' | 'barrier' | 'timer';

export type Type =
  | { k: 'prim'; name: PrimName }
  | { k: 'record'; name: string }
  | { k: 'protocol'; name: string }
  | { k: 'array'; elem: Type; dims: number }
  /**
   * A channel (`end` undefined) or one of its ends. `shared` says the side in
   * question can be held by several processes: for a whole channel `sharedSide`
   * tells which side(s) (`shared chan<T>` = both, `shared read chan<T>` = readers).
   */
  | { k: 'chan'; elem: Type; shared: boolean; sharedSide?: 'read' | 'write'; end?: 'read' | 'write' }
  | { k: 'null' }
  /** A type we could not resolve (declared in a file we cannot see). Compatible with everything. */
  | { k: 'unknown'; name?: string }
  /** An expression that already produced an error. Compatible with everything, never reported again. */
  | { k: 'error' };

export const T = {
  boolean: { k: 'prim', name: 'boolean' } as Type,
  byte: { k: 'prim', name: 'byte' } as Type,
  short: { k: 'prim', name: 'short' } as Type,
  char: { k: 'prim', name: 'char' } as Type,
  int: { k: 'prim', name: 'int' } as Type,
  long: { k: 'prim', name: 'long' } as Type,
  float: { k: 'prim', name: 'float' } as Type,
  double: { k: 'prim', name: 'double' } as Type,
  string: { k: 'prim', name: 'string' } as Type,
  void: { k: 'prim', name: 'void' } as Type,
  barrier: { k: 'prim', name: 'barrier' } as Type,
  timer: { k: 'prim', name: 'timer' } as Type,
  null: { k: 'null' } as Type,
  unknown: { k: 'unknown' } as Type,
  error: { k: 'error' } as Type,
};

export function prim(name: string): Type {
  return { k: 'prim', name: name as PrimName };
}

export function isPrim(t: Type, ...names: PrimName[]): boolean {
  return t.k === 'prim' && names.includes(t.name);
}

export function isNumeric(t: Type): boolean {
  return isPrim(t, 'byte', 'short', 'char', 'int', 'long', 'float', 'double');
}

export function isIntegral(t: Type): boolean {
  return isPrim(t, 'byte', 'short', 'char', 'int', 'long');
}

/** Types that behave like references: `null` can be assigned to them and they compare by identity. */
export function isReference(t: Type): boolean {
  return t.k === 'record' || t.k === 'protocol' || t.k === 'array' || t.k === 'chan' || isPrim(t, 'string');
}

/** `unknown` or `error`: never complain about these. */
export function isLenient(t: Type): boolean {
  return t.k === 'unknown' || t.k === 'error';
}

const WIDENS: Record<string, PrimName[]> = {
  byte: ['byte', 'short', 'int', 'long', 'float', 'double'],
  short: ['short', 'int', 'long', 'float', 'double'],
  char: ['char', 'int', 'long', 'float', 'double'],
  int: ['int', 'long', 'float', 'double'],
  long: ['long', 'float', 'double'],
  float: ['float', 'double'],
  double: ['double'],
};

const RANK: Record<string, number> = { byte: 1, short: 2, char: 2, int: 3, long: 4, float: 5, double: 6 };

/** Result type of arithmetic on two numeric operands (binary numeric promotion). */
export function promote(a: Type, b: Type): Type {
  if (a.k !== 'prim' || b.k !== 'prim') return T.int;
  const r = Math.max(RANK[a.name] ?? 0, RANK[b.name] ?? 0);
  if (r >= 6) return T.double;
  if (r === 5) return T.float;
  if (r === 4) return T.long;
  return T.int;
}

export function sameType(a: Type, b: Type): boolean {
  if (isLenient(a) || isLenient(b)) return true;
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'prim':
      return a.name === (b as typeof a).name;
    case 'record':
    case 'protocol':
      return a.name === (b as typeof a).name;
    case 'array': {
      const bb = b as typeof a;
      return a.dims === bb.dims && sameType(a.elem, bb.elem);
    }
    case 'chan': {
      const bb = b as typeof a;
      return a.end === bb.end && a.shared === bb.shared && a.sharedSide === bb.sharedSide && sameType(a.elem, bb.elem);
    }
    default:
      return true;
  }
}

export interface Subtyping {
  /** Does record/protocol `sub` extend `sup` (transitively)? */
  extendsName(sub: string, sup: string): boolean;
}

/**
 * Is `sub` a subtype of `sup`? Records narrow when they extend (a Point3 is a Point).
 * Protocols widen when they extend: `protocol Message extends Santa_msg, Elf_msg`
 * is the union of its parents, so a Santa_msg value is a Message.
 */
export function isSubtype(sub: Type, sup: Type, rel: Subtyping): boolean {
  if (sub.k === 'record' && sup.k === 'record') return sub.name === sup.name || rel.extendsName(sub.name, sup.name);
  if (sub.k === 'protocol' && sup.k === 'protocol') return sub.name === sup.name || rel.extendsName(sup.name, sub.name);
  return false;
}

/** Can a value of type `from` be stored in a slot of type `to`? */
export function assignable(to: Type, from: Type, sub: Subtyping): boolean {
  if (isLenient(to) || isLenient(from)) return true;
  if (from.k === 'null') return isReference(to);
  if (to.k === 'prim' && from.k === 'prim') {
    if (to.name === from.name) return true;
    return (WIDENS[from.name] ?? []).includes(to.name);
  }
  if ((to.k === 'record' && from.k === 'record') || (to.k === 'protocol' && from.k === 'protocol')) return isSubtype(from, to, sub);
  if (to.k === 'array' && from.k === 'array') return to.dims === from.dims && sameType(to.elem, from.elem);
  if (to.k === 'chan' && from.k === 'chan') {
    if (to.end !== from.end) return false; // a full channel is not an end and vice versa
    // Whole channels are synchronization objects, not assignable values. Pass a
    // read/write end to a procedure instead of aliasing the channel itself.
    if (!to.end) return false;
    if (!elemCompatible(to, from, sub)) return false;
    if (to.shared && !from.shared) return false; // a shared slot needs a shared channel
    return true;
  }
  return false;
}

/**
 * Channel element compatibility. Primitive elements must match exactly (the generated
 * Java boxes them, so chan<int> and chan<long> are different classes at runtime).
 * Record and protocol elements follow the direction of the end: a write end may be
 * narrowed to a subtype (writing a Santa_msg into a chan<Message> is fine) and a
 * read end may be widened to a supertype.
 */
function elemCompatible(to: Extract<Type, { k: 'chan' }>, from: Extract<Type, { k: 'chan' }>, sub: Subtyping): boolean {
  if (sameType(to.elem, from.elem)) return true;
  if (to.end === 'write') return isSubtype(to.elem, from.elem, sub); // what we will write must fit what the channel carries
  if (to.end === 'read') return isSubtype(from.elem, to.elem, sub); // what the channel carries must fit what we expect to read
  return false;
}

/** The `.read` or `.write` end of a whole channel; only the shared side stays shared. */
export function endOf(chan: Extract<Type, { k: 'chan' }>, end: 'read' | 'write'): Type {
  return { k: 'chan', elem: chan.elem, shared: chan.shared && (!chan.sharedSide || chan.sharedSide === end), end };
}

/** Why `assignable` said no, for the message. */
export function whyNotAssignable(to: Type, from: Type): string | undefined {
  if (to.k === 'chan' && from.k === 'chan') {
    if (to.end && !from.end) return `pass an end of the channel: '.${to.end}'`;
    if (!sameType(to.elem, from.elem) && to.end === from.end) return `the channel carries ${typeStr(from.elem)}, not ${typeStr(to.elem)}`;
    if (!to.end && from.end) return 'a channel end was given where a whole channel is needed';
    if (to.end !== from.end) return `a ${from.end} end was given where a ${to.end} end is needed`;
    if (!to.end && !from.end) return 'whole channels cannot be assigned or passed; pass the required .read or .write end';
    if (to.shared && !from.shared) return `declare the channel 'shared chan<${typeStr(to.elem)}>'`;
  }
  if (isNumeric(to) && isNumeric(from) && !sameType(to, from)) return `${typeStr(from)} does not fit in ${typeStr(to)} without a cast`;
  return undefined;
}

export function typeStr(t: Type): string {
  switch (t.k) {
    case 'prim':
      return t.name;
    case 'record':
    case 'protocol':
      return t.name;
    case 'array':
      return typeStr(t.elem) + '[]'.repeat(t.dims);
    case 'chan':
      return `${t.shared ? 'shared ' : ''}${t.shared && t.sharedSide && !t.end ? t.sharedSide + ' ' : ''}chan<${typeStr(t.elem)}>${t.end ? '.' + t.end : ''}`;
    case 'null':
      return 'null';
    case 'unknown':
      return t.name ?? '?';
    case 'error':
      return '<error>';
  }
}

/** Convert a syntactic type to a semantic one; `resolveNamed` decides what an identifier type means. */
export function fromNode(n: A.TypeNode, resolveNamed: (name: A.Ident) => Type): Type {
  switch (n.kind) {
    case 'PrimitiveType':
      return prim(n.name);
    case 'NamedType':
      return resolveNamed(n.name);
    case 'ArrayType': {
      const elem = fromNode(n.elem, resolveNamed);
      if (elem.k === 'array') return { k: 'array', elem: elem.elem, dims: elem.dims + n.dims };
      return { k: 'array', elem, dims: n.dims };
    }
    case 'ChanType':
      return { k: 'chan', elem: fromNode(n.elem, resolveNamed), shared: n.shared, sharedSide: n.sharedEnd, end: n.end };
  }
}
