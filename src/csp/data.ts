/**
 * Data domains: how ProcessJ values become CSPm values.
 *
 * - byte, short, char, int and long share one integer range `Int_t`, small
 *   enough for FDR to enumerate. A value is checked where it is stored or
 *   communicated; leaving the range is a modelled error, never a silent wrap.
 * - boolean is `Bool`.
 * - string, float, double and anything read from a timer are one abstract
 *   value, `pj_any`. A decision that depends on one becomes an internal choice.
 * - A record family (a record and everything extending it) is one datatype
 *   with a null constructor and one constructor per record; a protocol family
 *   (protocols linked by `extends`) is one datatype with one constructor per case.
 * - Arrays are sequences.
 */
import type * as A from '../parser/ast';
import type { DeclIndex } from '../checker/index';
import type { Type } from '../checker/types';
import { mangle, rangeText, type NameTable } from './cspm';

export type DType =
  /** `sat`: values that never decide anything, saturated rather than range-checked (relevance.ts). */
  | { k: 'int'; sat?: boolean }
  | { k: 'bool' }
  | { k: 'any' }
  | { k: 'record'; family: string; name: string }
  | { k: 'protocol'; family: string; name: string }
  | { k: 'array'; elem: DType }
  | { k: 'chan'; elem: DType; end?: 'read' | 'write' }
  | { k: 'barrier' }
  | { k: 'timer' }
  | { k: 'void' };

export const D = {
  int: { k: 'int' } as DType,
  bool: { k: 'bool' } as DType,
  any: { k: 'any' } as DType,
  void: { k: 'void' } as DType,
};

/** One generated datatype for a record or protocol family. */
export interface Family {
  kind: 'record' | 'protocol';
  /** Datatype name (`PJR_Point`, `PJP_Message`). */
  type: string;
  /** Null constructor (`Point_null`). */
  nullCtor: string;
  /** Record types or protocol cases: constructor name and fields in order. */
  ctors: Array<{ owner: string; tag?: string; ctor: string; fields: Array<{ name: string; type: DType; source: Type }> }>;
  /** Protocols or records belonging to the family. */
  members: Set<string>;
}

/** Records, protocols and the integer range, shared by the whole translation. */
export class DataModel {
  readonly families = new Map<string, Family>();
  private readonly familyOf = new Map<string, string>();
  readonly unsupported: string[] = [];
  /** Some integers are saturated (relevance.ts): declare `PJ_SAT`, `Int_s` and the saturating functions. */
  saturated = false;

  constructor(
    readonly index: DeclIndex,
    readonly lo: number,
    readonly hi: number,
    private readonly names: NameTable,
  ) {}

  type(t: Type): DType {
    switch (t.k) {
      case 'prim':
        switch (t.name) {
          case 'boolean':
            return D.bool;
          case 'byte':
          case 'short':
          case 'char':
          case 'int':
          case 'long':
            return D.int;
          case 'barrier':
            return { k: 'barrier' };
          case 'timer':
            return { k: 'timer' };
          case 'void':
            return D.void;
          default:
            return D.any;
        }
      case 'record':
        return { k: 'record', family: this.family('record', t.name).type, name: t.name };
      case 'protocol':
        return { k: 'protocol', family: this.family('protocol', t.name).type, name: t.name };
      case 'array': {
        const elem = t.dims > 1 ? this.type({ k: 'array', elem: t.elem, dims: t.dims - 1 }) : this.type(t.elem);
        return { k: 'array', elem };
      }
      case 'chan':
        return { k: 'chan', elem: this.type(t.elem), end: t.end };
      default:
        return D.any;
    }
  }

  /** The CSPm set of values of a type, for channel declarations and internal choices. */
  domain(t: DType): string | undefined {
    switch (t.k) {
      case 'int':
        return t.sat ? 'Int_s' : 'Int_t';
      case 'bool':
        return 'Bool';
      case 'any':
        return 'PJ_Any';
      case 'record':
        return t.family;
      case 'protocol': {
        const fam = this.families.get(t.family);
        if (!fam) return t.family;
        // A protocol is the union of its own cases and its parents' (`protocol Message extends A, B`).
        const ctors = new Set<string>();
        for (const tag of this.index.protocolCases(t.name).keys()) {
          const ctor = this.protocolCtor(t.name, tag);
          if (ctor) ctors.add(ctor.ctor);
        }
        if (ctors.size === fam.ctors.length) return t.family;
        return `{| ${[...ctors].join(', ')} |}`;
      }
      default:
        return undefined;
    }
  }

  /** The value an uninitialised variable or field holds (ProcessJ locals are Java fields). */
  defaultValue(t: DType): string {
    switch (t.k) {
      case 'int':
        return '0';
      case 'bool':
        return 'false';
      case 'record':
      case 'protocol':
        return this.families.get(t.family)?.nullCtor ?? 'pj_any';
      case 'array':
        return '<>';
      default:
        return 'pj_any';
    }
  }

  /** The family datatype a record or protocol belongs to, created on first use. */
  family(kind: 'record' | 'protocol', name: string): Family {
    const known = this.familyOf.get(`${kind}:${name}`);
    if (known) return this.families.get(known)!;
    // Collect the connected component of `extends` edges.
    const members = new Set<string>();
    const all = kind === 'record' ? this.index.records : this.index.protocols;
    const stack = [name];
    while (stack.length) {
      const n = stack.pop()!;
      if (members.has(n)) continue;
      members.add(n);
      const info = all.get(n);
      for (const parent of info?.extends ?? []) stack.push(parent);
      for (const [other, otherInfo] of all) if (otherInfo.extends.includes(n)) stack.push(other);
    }
    const ordered = [...members].sort((a, b) => declOrder(all.get(a)?.decl) - declOrder(all.get(b)?.decl) || a.localeCompare(b));
    const root = ordered.find((m) => (all.get(m)?.extends.length ?? 0) === 0) ?? ordered[0];
    const fam: Family = {
      kind,
      type: this.names.fresh(`${kind === 'record' ? 'PJR' : 'PJP'}_${mangle(root)}`),
      nullCtor: '',
      ctors: [],
      members,
    };
    for (const m of members) this.familyOf.set(`${kind}:${m}`, fam.type);
    this.families.set(fam.type, fam);
    fam.nullCtor = this.names.fresh(`${mangle(root)}_null`);
    if (kind === 'record') {
      for (const m of ordered) {
        const fields = [...this.index.recordFields(m)].map(([fname, ftype]) => ({ name: fname, type: this.type(ftype), source: ftype }));
        fam.ctors.push({ owner: m, ctor: this.names.fresh(mangle(m)), fields });
      }
    } else {
      for (const m of ordered) {
        for (const [tag, fields] of this.index.protocols.get(m)?.cases ?? []) {
          fam.ctors.push({ owner: m, tag, ctor: this.names.fresh(`${mangle(m)}_${mangle(tag)}`), fields: [...fields].map(([fname, ftype]) => ({ name: fname, type: this.type(ftype), source: ftype })) });
        }
      }
    }
    return fam;
  }

  /** The constructor of a record type. */
  recordCtor(name: string): Family['ctors'][number] | undefined {
    const fam = this.family('record', name);
    return fam.ctors.find((c) => c.owner === name);
  }

  /** The constructor of a protocol case, looking through the protocol's parents for inherited cases. */
  protocolCtor(protocol: string, tag: string): Family['ctors'][number] | undefined {
    const fam = this.family('protocol', protocol);
    const own = fam.ctors.find((c) => c.owner === protocol && c.tag === tag);
    if (own) return own;
    return fam.ctors.find((c) => c.tag === tag && this.index.extendsName(protocol, c.owner)) ?? fam.ctors.find((c) => c.tag === tag);
  }

  /** Whether values of family `from` can contain values of family `to` (through fields, transitively). */
  private reaches(from: string, to: string, seen = new Set<string>()): boolean {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    const fam = this.families.get(from);
    return !!fam && fam.ctors.some((c) => c.fields.some((f) => (f.type.k === 'record' || f.type.k === 'protocol') && this.reaches(f.type.family, to, seen)));
  }

  familyByType(type: string): Family | undefined {
    return this.families.get(type);
  }

  /** CSPm declarations: integer range, abstract value, family datatypes and their field functions. */
  declarations(): string[] {
    const out: string[] = [];
    out.push(`Int_t = ${rangeText(this.lo, this.hi)}`);
    if (this.saturated) {
      out.push('-- Integers that never decide anything are kept while they fit and become PJ_SAT when they do not;');
      out.push('-- anything computed from PJ_SAT stays PJ_SAT (pj_satv lists the operands that may hold it).');
      out.push(`PJ_SAT = ${this.hi + 1}`);
      out.push(`Int_s = ${rangeText(this.lo, this.hi + 1)}`);
      out.push('pj_sat(pj_x) = if member(pj_x, Int_t) then pj_x else PJ_SAT');
      out.push('pj_satv(pj_x, pj_vs) = if member(PJ_SAT, pj_vs) then PJ_SAT else pj_sat(pj_x)');
    }
    out.push('datatype PJ_AnyT = pj_any');
    out.push('PJ_Any = {pj_any}');
    for (const fam of this.families.values()) {
      const fieldSet = (t: DType): string => {
        if ((t.k === 'record' || t.k === 'protocol') && this.reaches(t.family, fam.type)) {
          // A family that contains itself is an infinite datatype FDR cannot enumerate (and the compiler overflows on it).
          this.unsupported.push(`${fam.kind}s that contain themselves (${[...fam.members].join(', ')})`);
          return 'PJ_Any';
        }
        if (t.k === 'array' || t.k === 'chan' || t.k === 'barrier' || t.k === 'timer') {
          this.unsupported.push(`${fam.kind} fields of type ${describe(t)} (in ${[...fam.members].join(', ')})`);
          return 'PJ_Any';
        }
        const d = this.domain(t);
        if (d) return d;
        this.unsupported.push(`${fam.kind} fields of type ${describe(t)} (in ${[...fam.members].join(', ')})`);
        return 'PJ_Any';
      };
      const alts = [fam.nullCtor, ...fam.ctors.map((c) => [c.ctor, ...c.fields.map((f) => {
        const set = fieldSet(f.type);
        // A field the model cannot hold becomes the abstract value everywhere (getters, defaults).
        if (set === 'PJ_Any') f.type = D.any;
        return set;
      })].join('.'))];
      out.push(`datatype ${fam.type} = ${alts.join(' | ')}`);
      for (const c of fam.ctors) {
        if (!c.fields.length) continue;
        const names = c.fields.map((_, i) => `pj_f${i}`);
        out.push(`pj_new_${c.ctor}(${names.join(', ')}) = ${[c.ctor, ...names].join('.')}`);
      }
      // Field getters and setters by field name across the family; a fallback
      // clause keeps FDR from failing a pattern match on null or another case.
      const byField = new Map<string, Array<{ ctor: string; index: number; arity: number; type: DType }>>();
      for (const c of fam.ctors) {
        c.fields.forEach((f, i) => {
          const list = byField.get(f.name) ?? [];
          list.push({ ctor: c.ctor, index: i, arity: c.fields.length, type: f.type });
          byField.set(f.name, list);
        });
      }
      for (const [field, uses] of byField) {
        const getter = `${fam.type}_get_${mangle(field)}`;
        const setter = `${fam.type}_set_${mangle(field)}`;
        const fallback = this.defaultValue(uses[0].type);
        for (const u of uses) {
          const pattern = [u.ctor, ...Array.from({ length: u.arity }, (_, i) => (i === u.index ? 'pj_x' : '_'))].join('.');
          out.push(`${getter}(${pattern}) = pj_x`);
        }
        out.push(`${getter}(_) = ${fallback}`);
        for (const u of uses) {
          const names = Array.from({ length: u.arity }, (_, i) => `pj_f${i}`);
          const pattern = [u.ctor, ...names].join('.');
          const rebuilt = [u.ctor, ...names.map((n, i) => (i === u.index ? 'pj_v' : n))].join('.');
          out.push(`${setter}(${pattern}, pj_v) = ${rebuilt}`);
        }
        out.push(`${setter}(pj_r, _) = pj_r`);
      }
      if (fam.kind === 'protocol') {
        for (const c of fam.ctors) {
          const pattern = [c.ctor, ...c.fields.map(() => '_')].join('.');
          out.push(`${fam.type}_is_${c.ctor}(${pattern}) = true`);
          out.push(`${fam.type}_is_${c.ctor}(_) = false`);
        }
      }
    }
    return out;
  }
}

function declOrder(decl: A.RecordDecl | A.ProtocolDecl | undefined): number {
  return decl ? decl.span.start.line * 10000 + decl.span.start.col : Number.MAX_SAFE_INTEGER;
}

export function describe(t: DType): string {
  switch (t.k) {
    case 'array':
      return `${describe(t.elem)}[]`;
    case 'chan':
      return `chan<${describe(t.elem)}>`;
    case 'record':
    case 'protocol':
      return t.name;
    default:
      return t.k;
  }
}

// Helper parameters all start with pj_: in CSPm a parameter named like a
// channel or constructor is a pattern, not a variable.

/** Java's narrowing conversions, exactly: the value a cast leaves for an in-range integer. */
export const CAST_HELPERS = [
  'pj_wrap(pj_x, pj_m, pj_lo) = ((pj_x - pj_lo) % pj_m) + pj_lo',
  'pj_to_byte(pj_x) = pj_wrap(pj_x, 256, -128)',
  'pj_to_short(pj_x) = pj_wrap(pj_x, 65536, -32768)',
  'pj_to_char(pj_x) = pj_wrap(pj_x, 65536, 0)',
  // int and long casts leave every value of a small modelled range unchanged.
  'pj_to_int(pj_x) = pj_x',
];

/** Integer helpers with Java semantics (CSPm's `/` and `%` round toward minus infinity). */
export const INT_HELPERS = [
  'pj_abs(pj_x) = if pj_x < 0 then -pj_x else pj_x',
  'pj_div(pj_a, pj_b) = let pj_q = pj_abs(pj_a) / pj_abs(pj_b) within if (pj_a < 0) == (pj_b < 0) then pj_q else -pj_q',
  'pj_mod(pj_a, pj_b) = pj_a - pj_b * pj_div(pj_a, pj_b)',
  'pj_pow2(pj_n) = if pj_n <= 0 then 1 else 2 * pj_pow2(pj_n - 1)',
  'pj_shl(pj_a, pj_n) = pj_a * pj_pow2(pj_n)',
  'pj_shr(pj_a, pj_n) = pj_a / pj_pow2(pj_n)',
  'pj_bit(pj_a) = pj_a % 2',
  'pj_band(pj_a, pj_b) = if pj_a == 0 or pj_b == 0 then 0 else if pj_a == -1 then pj_b else if pj_b == -1 then pj_a else 2 * pj_band(pj_a / 2, pj_b / 2) + (if pj_bit(pj_a) == 1 and pj_bit(pj_b) == 1 then 1 else 0)',
  'pj_bor(pj_a, pj_b) = if pj_a == -1 or pj_b == -1 then -1 else if pj_a == 0 then pj_b else if pj_b == 0 then pj_a else 2 * pj_bor(pj_a / 2, pj_b / 2) + (if pj_bit(pj_a) == 1 or pj_bit(pj_b) == 1 then 1 else 0)',
  'pj_bxor(pj_a, pj_b) = if pj_a == 0 then pj_b else if pj_b == 0 then pj_a else if pj_a == -1 then -1 - pj_b else if pj_b == -1 then -1 - pj_a else 2 * pj_bxor(pj_a / 2, pj_b / 2) + (if pj_bit(pj_a) != pj_bit(pj_b) then 1 else 0)',
  'pj_bnot(pj_a) = -1 - pj_a',
  // A par for's computed bounds, held to the iterations the model has slots for.
  'pj_clamp(pj_x, pj_a, pj_b) = if pj_x < pj_a then pj_a else if pj_x > pj_b then pj_b else pj_x',
  ...CAST_HELPERS,
];

/** Sequence helpers for arrays. */
export const ARRAY_HELPERS = [
  'pj_new_array(pj_n, pj_d) = if pj_n <= 0 then <> else <pj_d> ^ pj_new_array(pj_n - 1, pj_d)',
  'pj_nth(pj_s, pj_i) = if pj_i == 0 then head(pj_s) else pj_nth(tail(pj_s), pj_i - 1)',
  'pj_update(pj_s, pj_i, pj_v) = if pj_i == 0 then <pj_v> ^ tail(pj_s) else <head(pj_s)> ^ pj_update(tail(pj_s), pj_i - 1, pj_v)',
];

/** The integer literal values used in a range, for messages. */
export function inferRange(literals: number[], maxValues: number): { lo: number; hi: number; dropped: number[] } {
  // One past each extreme: a loop that ends at `i <= n` or `k > n` stores n + 1.
  const margin = literals.flatMap((v) => (v > 0 ? [v, v + 1] : v < 0 ? [v, v - 1] : [v]));
  const values = [...new Set([0, 1, ...margin])].sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
  let lo = 0;
  let hi = 1;
  const dropped: number[] = [];
  for (const v of values) {
    const nlo = Math.min(lo, v);
    const nhi = Math.max(hi, v);
    if (nhi - nlo + 1 <= maxValues) {
      lo = nlo;
      hi = nhi;
    } else dropped.push(v);
  }
  const literalSet = new Set(literals);
  return { lo, hi, dropped: dropped.filter((v) => literalSet.has(v)).sort((a, b) => a - b) };
}
