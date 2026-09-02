/**
 * Declaration index: what the checker knows about procedures, records, protocols
 * and constants, built from parsed programs (the current file, the workspace, and
 * the standard-library headers) and merged with the nearest definition winning.
 */
import type * as A from '../parser/ast';
import { fromNode, T, typeStr, type Type } from './types';

export interface ProcSig {
  name: string;
  params: Type[];
  paramNames: string[];
  ret: Type;
  decl: A.ProcDecl;
  file?: string;
}

export interface RecordInfo {
  name: string;
  /** Own fields only; use `DeclIndex.recordFields` for inherited ones. */
  fields: Map<string, Type>;
  extends: string[];
  decl: A.RecordDecl;
  file?: string;
}

export interface ProtocolInfo {
  name: string;
  /** Own cases only; use `DeclIndex.protocolCases` for inherited ones. */
  cases: Map<string, Map<string, Type>>;
  extends: string[];
  decl: A.ProtocolDecl;
  file?: string;
}

export interface ConstInfo {
  name: string;
  type: Type;
  decl: A.ConstDecl;
  file?: string;
}

export class DeclIndex {
  readonly procs = new Map<string, ProcSig[]>();
  readonly records = new Map<string, RecordInfo>();
  readonly protocols = new Map<string, ProtocolInfo>();
  readonly consts = new Map<string, ConstInfo>();
  readonly externs = new Set<string>();

  /** Add every declaration of a parsed program. Existing entries win over later ones (nearest scope first). */
  addProgram(p: A.Program, file?: string): void {
    // Two passes: names first so field/param types can refer to records declared later in the file.
    for (const d of p.decls) {
      if (d.kind === 'RecordDecl' && !this.records.has(d.name.name)) this.records.set(d.name.name, { name: d.name.name, fields: new Map(), extends: d.extends.map((e) => e.name), decl: d, file });
      else if (d.kind === 'ProtocolDecl' && !this.protocols.has(d.name.name)) this.protocols.set(d.name.name, { name: d.name.name, cases: new Map(), extends: d.extends.map((e) => e.name), decl: d, file });
      else if (d.kind === 'ExternDecl') this.externs.add(d.name.name);
    }
    for (const d of p.decls) {
      switch (d.kind) {
        case 'RecordDecl': {
          const info = this.records.get(d.name.name)!;
          if (info.decl !== d) break;
          for (const m of d.members) info.fields.set(m.name.name, this.resolve(m.type));
          break;
        }
        case 'ProtocolDecl': {
          const info = this.protocols.get(d.name.name)!;
          if (info.decl !== d) break;
          for (const c of d.cases ?? []) {
            const fields = new Map<string, Type>();
            for (const m of c.members) fields.set(m.name.name, this.resolve(m.type));
            info.cases.set(c.name.name, fields);
          }
          break;
        }
        case 'ProcDecl': {
          const sig: ProcSig = {
            name: d.name.name,
            params: d.params.map((x) => this.resolve(x.type)),
            paramNames: d.params.map((x) => x.name.name),
            ret: this.resolve(d.returnType),
            decl: d,
            file,
          };
          const list = this.procs.get(d.name.name);
          if (!list) this.procs.set(d.name.name, [sig]);
          else if (!list.some((s) => sameSignature(s, sig))) list.push(sig);
          break;
        }
        case 'ConstDecl':
          for (const v of d.declarators) {
            if (this.consts.has(v.name.name)) continue;
            const base = this.resolve(d.type);
            const type: Type = v.dims > 0 ? { k: 'array', elem: base.k === 'array' ? base.elem : base, dims: (base.k === 'array' ? base.dims : 0) + v.dims } : base;
            this.consts.set(v.name.name, { name: v.name.name, type, decl: d, file });
          }
          break;
        default:
          break;
      }
    }
  }

  /** Merge another index underneath this one (this one's definitions win). */
  addIndex(other: DeclIndex): void {
    for (const [name, list] of other.procs) {
      const mine = this.procs.get(name);
      if (!mine) this.procs.set(name, [...list]);
      else for (const s of list) if (!mine.some((m) => sameSignature(m, s))) mine.push(s);
    }
    for (const [n, r] of other.records) if (!this.records.has(n)) this.records.set(n, r);
    for (const [n, p] of other.protocols) if (!this.protocols.has(n)) this.protocols.set(n, p);
    for (const [n, c] of other.consts) if (!this.consts.has(n)) this.consts.set(n, c);
    for (const e of other.externs) this.externs.add(e);
  }

  resolve(node: A.TypeNode): Type {
    return fromNode(node, (id) => this.named(id.name));
  }

  named(name: string): Type {
    if (this.records.has(name)) return { k: 'record', name };
    if (this.protocols.has(name)) return { k: 'protocol', name };
    if (this.externs.has(name)) return { k: 'unknown', name };
    return { k: 'unknown', name };
  }

  isKnownType(name: string): boolean {
    return this.records.has(name) || this.protocols.has(name) || this.externs.has(name);
  }

  /** All fields of a record including inherited ones (cycle safe). */
  recordFields(name: string): Map<string, Type> {
    const out = new Map<string, Type>();
    const seen = new Set<string>();
    const visit = (n: string) => {
      if (seen.has(n)) return;
      seen.add(n);
      const r = this.records.get(n);
      if (!r) return;
      for (const [f, t] of r.fields) if (!out.has(f)) out.set(f, t);
      for (const e of r.extends) visit(e);
    };
    visit(name);
    return out;
  }

  /** All cases of a protocol including inherited ones (cycle safe). */
  protocolCases(name: string): Map<string, Map<string, Type>> {
    const out = new Map<string, Map<string, Type>>();
    const seen = new Set<string>();
    const visit = (n: string) => {
      if (seen.has(n)) return;
      seen.add(n);
      const p = this.protocols.get(n);
      if (!p) return;
      for (const [c, fields] of p.cases) if (!out.has(c)) out.set(c, fields);
      for (const e of p.extends) visit(e);
    };
    visit(name);
    return out;
  }

  /** Does `sub` extend `sup` transitively (records or protocols)? */
  extendsName(sub: string, sup: string): boolean {
    const seen = new Set<string>();
    const visit = (n: string): boolean => {
      if (n === sup) return true;
      if (seen.has(n)) return false;
      seen.add(n);
      const parents = this.records.get(n)?.extends ?? this.protocols.get(n)?.extends ?? [];
      return parents.some(visit);
    };
    return visit(sub);
  }

  /** Every name that could be suggested for a typo. */
  allNames(): string[] {
    return [...this.procs.keys(), ...this.records.keys(), ...this.protocols.keys(), ...this.consts.keys()];
  }
}

export function sameSignature(a: ProcSig, b: ProcSig): boolean {
  return a.params.length === b.params.length && a.params.every((p, i) => typeStr(p) === typeStr(b.params[i]));
}

export function signatureStr(s: ProcSig): string {
  return `${typeStr(s.ret ?? T.void)} ${s.name}(${s.params.map((p, i) => `${typeStr(p)} ${s.paramNames[i]}`).join(', ')})`;
}
