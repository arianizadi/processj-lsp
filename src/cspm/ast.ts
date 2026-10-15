/**
 * Syntax of the CSPm that people write for FDR in coursework, as the tolerant
 * parser (src/cspm/parser.ts) reads it. One expression language covers values
 * and processes, as in CSPm itself; every node carries the span of its text
 * (0-based, half-open, the same Span the ProcessJ parser uses). Anything the
 * parser does not understand becomes an `opaque` node with its span, so a
 * file with unfamiliar syntax still yields every declaration around it.
 */
import type { Span } from '../parser/ast';

export type { Pos, Span } from '../parser/ast';

export interface Ident {
  name: string;
  span: Span;
}

/** One field of a prefix event: `.e`, `?pattern`, `?pattern : set`, `!e`, `$pattern`. */
export interface Field {
  kind: '.' | '?' | '!' | '$';
  /** The value (`.`, `!`) or the pattern (`?`, `$`). */
  expr: Ex;
  /** `?x : S`: the values the input may take. */
  restrict?: Ex;
  span: Span;
}

/** A statement of a comprehension or replicated operator: `x <- S`, `x : S`, or a condition. */
export type Stmt =
  | { kind: 'gen'; pattern: Ex; source: Ex; span: Span }
  | { kind: 'cond'; expr: Ex; span: Span };

export type BinOp = '+' | '-' | '*' | '/' | '%' | '==' | '!=' | '<' | '>' | '<=' | '>=' | 'and' | 'or' | '^';

/** Binary process operators whose operands are both processes. */
export type ProcOp = '[]' | '|~|' | ';' | '[>' | '/\\' | '|||';

/** Replicated (indexed) process operators. */
export type ReplOp = '[]' | '|~|' | ';' | '|||' | '[|' | '||' | '/\\';

export type Ex =
  | { k: 'num'; value: number; span: Span }
  | { k: 'bool'; value: boolean; span: Span }
  | { k: 'str'; value: string; span: Span }
  | { k: 'name'; name: string; span: Span }
  | { k: 'app'; fn: Ex; args: Ex[]; span: Span }
  /** `a.b.c`: dotted values and events. */
  | { k: 'dot'; parts: Ex[]; span: Span }
  | { k: 'bin'; op: BinOp; left: Ex; right: Ex; span: Span }
  | { k: 'un'; op: '-' | 'not' | '#'; arg: Ex; span: Span }
  | { k: 'tuple'; items: Ex[]; span: Span }
  | { k: 'set'; items: Ex[]; span: Span }
  | { k: 'range'; seq: boolean; from: Ex; to?: Ex; span: Span }
  | { k: 'comp'; seq: boolean; items: Ex[]; stmts: Stmt[]; span: Span }
  /** `{| a, b.1 |}`: every event that starts with one of the items. */
  | { k: 'enum'; items: Ex[]; stmts?: Stmt[]; span: Span }
  | { k: 'seq'; items: Ex[]; span: Span }
  | { k: 'if'; cond: Ex; then: Ex; else: Ex; span: Span }
  | { k: 'let'; decls: Decl[]; body: Ex; span: Span }
  | { k: 'lambda'; params: Ex[]; body: Ex; span: Span }
  /** `c.e?x!v -> P`; `head` is the channel (or any expression naming the event's first part). */
  | { k: 'prefix'; head: Ex; fields: Field[]; body: Ex; eventSpan: Span; span: Span }
  | { k: 'guard'; cond: Ex; body: Ex; span: Span }
  | { k: 'op'; op: ProcOp; left: Ex; right: Ex; span: Span }
  | { k: 'hide'; proc: Ex; set: Ex; span: Span }
  /** `P [| X |] Q`. */
  | { k: 'par'; left: Ex; right: Ex; sync: Ex; span: Span }
  /** `P [ A || B ] Q`. */
  | { k: 'apar'; left: Ex; right: Ex; alphaLeft: Ex; alphaRight: Ex; span: Span }
  /** `P [ a <-> b, ... ] Q`. */
  | { k: 'link'; left: Ex; right: Ex; pairs: Array<[Ex, Ex]>; span: Span }
  /** `P [| X |> Q`. */
  | { k: 'exception'; left: Ex; right: Ex; set: Ex; span: Span }
  /** `P [[ a <- b, ... ]]`. */
  | { k: 'rename'; proc: Ex; pairs: Array<[Ex, Ex]>; stmts?: Stmt[]; span: Span }
  /**
   * `||| i : S @ P`, `[] x : S @ P`, `[| X |] i : S @ P`, `|| i : S @ [A(i)] P`:
   * `sync` is the set of `[| X |]`, `alpha` the per-operand alphabet of `||`.
   */
  | { k: 'repl'; op: ReplOp; stmts: Stmt[]; body: Ex; sync?: Ex; alpha?: Ex; span: Span }
  /** Text the parser did not understand. */
  | { k: 'opaque'; text: string; reason: string; span: Span };

/** One clause of a definition: `f(p1, p2) = body`, or `x = body` (no parameter groups). */
export interface Definition {
  kind: 'def';
  name: Ident;
  /** Parameter groups as patterns: `f(a, b)(c)` has two groups. Empty for `x = ...`. */
  params: Ex[][];
  body: Ex;
  span: Span;
  /** The comment lines right above the definition, without the dashes. */
  comment?: string;
}

export interface Constructor {
  name: Ident;
  /** The field types of `c.T.U`. */
  fields: Ex[];
}

export type AssertProperty = 'deadlock free' | 'divergence free' | 'livelock free' | 'deterministic' | 'has trace';

export interface Assertion {
  kind: 'assert';
  negated: boolean;
  /** `P [T= Q`: spec P, impl Q. */
  refinement?: { model: string; spec: Ex };
  /** `P :[deadlock free [F]]`. */
  property?: { name: AssertProperty | string; model?: string; trace?: Ex };
  /** The process the assertion is about: the implementation of a refinement, the subject of a property. */
  impl: Ex;
  /** `:[tau priority]: {...}` and other options after the assertion, as written. */
  options?: string;
  /** The assertion as written (without `assert`), on one line. */
  text: string;
  span: Span;
}

export type Decl =
  | Definition
  | Assertion
  | { kind: 'channel'; names: Ident[]; type?: Ex; span: Span }
  | { kind: 'datatype'; subtype: boolean; name: Ident; constructors: Constructor[]; span: Span }
  | { kind: 'nametype'; name: Ident; value: Ex; span: Span }
  | { kind: 'include'; file: string; span: Span }
  | { kind: 'external' | 'transparent'; names: Ident[]; span: Span }
  | { kind: 'print'; expr: Ex; span: Span }
  /** `f :: (Int) -> Int`. */
  | { kind: 'signature'; names: Ident[]; span: Span }
  /** A Timed section, a module, an instance: read past, not understood. */
  | { kind: 'skipped'; what: string; span: Span }
  /** A declaration the parser could not read. */
  | { kind: 'opaque'; text: string; reason: string; span: Span };

export interface CspmDiagnostic {
  message: string;
  span: Span;
  severity: 'error' | 'warning' | 'info';
}

export interface CspmFile {
  decls: Decl[];
  /** Syntax the parser could not read, and constructs it read past. */
  diagnostics: CspmDiagnostic[];
  /** The ProcessJ file a model generated by Convert to CSP was translated from (its header names it). */
  generatedFrom?: string;
}
