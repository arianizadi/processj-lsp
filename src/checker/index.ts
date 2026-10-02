/**
 * Declaration index: what the checker knows about procedures, records, protocols
 * and constants, built from parsed programs (the current file, the workspace, and
 * the standard-library headers) and merged with the nearest definition winning.
 */
import type * as A from '../parser/ast';
import { identToString } from '../parser/ast';
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
  private readonly _procs = new Map<string, ProcSig[]>();
  private readonly _records = new Map<string, RecordInfo>();
  private readonly _protocols = new Map<string, ProtocolInfo>();
  private readonly _consts = new Map<string, ConstInfo>();
  readonly externs = new Set<string>();
  /**
   * Programs whose member types still have to be resolved. Names are registered
   * as soon as a program is added, but a parameter, field, case or constant type
   * may name a record from a program added later (the current file is added
   * before its imports), so resolution waits until something reads the index.
   */
  private readonly pending: Array<{ program: A.Program; file?: string }> = [];
  private readonly recordFieldCache = new Map<string, Map<string, Type>>();
  private readonly protocolCaseCache = new Map<string, Map<string, Map<string, Type>>>();
  private readonly extendsCache = new Map<string, boolean>();

  get procs(): Map<string, ProcSig[]> {
    this.finalize();
    return this._procs;
  }

  get records(): Map<string, RecordInfo> {
    this.finalize();
    return this._records;
  }

  get protocols(): Map<string, ProtocolInfo> {
    this.finalize();
    return this._protocols;
  }

  get consts(): Map<string, ConstInfo> {
    this.finalize();
    return this._consts;
  }

  /** Add every declaration of a parsed program. Existing entries win over later ones (nearest scope first). */
  addProgram(p: A.Program, file?: string): void {
    this.invalidateDerived();
    // Names first, so member types can refer to records declared later in this
    // file or in a program that is added after it.
    for (const d of p.decls) {
      if (d.kind === 'RecordDecl' && !this._records.has(d.name.name)) this._records.set(d.name.name, { name: d.name.name, fields: new Map(), extends: d.extends.map(identToString), decl: d, file });
      else if (d.kind === 'ProtocolDecl' && !this._protocols.has(d.name.name)) this._protocols.set(d.name.name, { name: d.name.name, cases: new Map(), extends: d.extends.map(identToString), decl: d, file });
      else if (d.kind === 'ExternDecl') this.externs.add(d.name.name);
    }
    this.pending.push({ program: p, file });
  }

  /** Resolve the member types of every program added since the last read, in the order they were added. */
  private finalize(): void {
    if (this.pending.length === 0) return;
    const batch = this.pending.splice(0);
    for (const { program: p, file } of batch) {
      for (const d of p.decls) {
        switch (d.kind) {
          case 'RecordDecl': {
            const info = this._records.get(d.name.name)!;
            if (info.decl !== d) break;
            for (const m of d.members) info.fields.set(m.name.name, this.resolve(m.type));
            break;
          }
          case 'ProtocolDecl': {
            const info = this._protocols.get(d.name.name)!;
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
            const list = this._procs.get(d.name.name);
            if (!list) this._procs.set(d.name.name, [sig]);
            else if (!list.some((s) => sameSignature(s, sig))) list.push(sig);
            break;
          }
          case 'ConstDecl':
            for (const v of d.declarators) {
              if (this._consts.has(v.name.name)) continue;
              const base = this.resolve(d.type);
              const type: Type = v.dims > 0 ? { k: 'array', elem: base.k === 'array' ? base.elem : base, dims: (base.k === 'array' ? base.dims : 0) + v.dims } : base;
              this._consts.set(v.name.name, { name: v.name.name, type, decl: d, file });
            }
            break;
          default:
            break;
        }
      }
    }
  }

  /** Merge another index underneath this one (this one's definitions win). */
  addIndex(other: DeclIndex): void {
    this.invalidateDerived();
    // Type names first, so this index's still-pending member types can name a
    // record or protocol the other index declares; existing entries still win.
    for (const [n, r] of other.records) if (!this._records.has(n)) this._records.set(n, r);
    for (const [n, p] of other.protocols) if (!this._protocols.has(n)) this._protocols.set(n, p);
    for (const e of other.externs) this.externs.add(e);
    this.finalize();
    for (const [name, list] of other.procs) {
      const mine = this._procs.get(name);
      if (!mine) this._procs.set(name, [...list]);
      else for (const s of list) if (!mine.some((m) => sameSignature(m, s))) mine.push(s);
    }
    for (const [n, c] of other.consts) if (!this._consts.has(n)) this._consts.set(n, c);
  }

  resolve(node: A.TypeNode): Type {
    // Package-qualified names need a package-aware declaration index. Preserve
    // their full spelling as a lenient unknown instead of accidentally binding
    // `a::Thing` to an imported/local `Thing` from some other package.
    return fromNode(node, (id) => id.qualifier?.length ? { k: 'unknown', name: identToString(id) } : this.named(id.name));
  }

  named(name: string): Type {
    // Names only: this runs inside finalize(), and a type is known as soon as
    // its declaration has been added.
    if (this._records.has(name)) return { k: 'record', name };
    if (this._protocols.has(name)) return { k: 'protocol', name };
    if (this.externs.has(name)) return { k: 'unknown', name };
    return { k: 'unknown', name };
  }

  isKnownType(name: string): boolean {
    return this._records.has(name) || this._protocols.has(name) || this.externs.has(name);
  }

  /** All fields of a record including inherited ones (cycle safe). */
  recordFields(name: string): Map<string, Type> {
    const cached = this.recordFieldCache.get(name);
    if (cached) return cached;
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
    this.recordFieldCache.set(name, out);
    return out;
  }

  /** All cases of a protocol including inherited ones (cycle safe). */
  protocolCases(name: string): Map<string, Map<string, Type>> {
    const cached = this.protocolCaseCache.get(name);
    if (cached) return cached;
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
    this.protocolCaseCache.set(name, out);
    return out;
  }

  /** Does `sub` extend `sup` transitively (records or protocols)? */
  extendsName(sub: string, sup: string): boolean {
    const key = `${sub}\0${sup}`;
    const cached = this.extendsCache.get(key);
    if (cached !== undefined) return cached;
    const seen = new Set<string>();
    const visit = (n: string): boolean => {
      if (n === sup) return true;
      if (seen.has(n)) return false;
      seen.add(n);
      const parents = this.records.get(n)?.extends ?? this.protocols.get(n)?.extends ?? [];
      return parents.some(visit);
    };
    const result = visit(sub);
    this.extendsCache.set(key, result);
    return result;
  }

  /** Every name that could be suggested for a typo. */
  allNames(): string[] {
    return [...this.procs.keys(), ...this.records.keys(), ...this.protocols.keys(), ...this.consts.keys()];
  }

  private invalidateDerived(): void {
    this.recordFieldCache.clear();
    this.protocolCaseCache.clear();
    this.extendsCache.clear();
  }
}

export function sameSignature(a: ProcSig, b: ProcSig): boolean {
  return a.params.length === b.params.length && a.params.every((p, i) => typeStr(p) === typeStr(b.params[i]));
}

export function signatureStr(s: ProcSig): string {
  return `${typeStr(s.ret ?? T.void)} ${s.name}(${s.params.map((p, i) => `${typeStr(p)} ${s.paramNames[i]}`).join(', ')})`;
}
