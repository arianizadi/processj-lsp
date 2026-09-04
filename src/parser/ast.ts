/**
 * AST for ProcessJ, mirroring src/parser/ProcessJ.cup in the compiler.
 * Every node carries a half-open source span (0-based line/col).
 */

export interface Pos {
  line: number;
  col: number;
}

export interface Span {
  start: Pos;
  end: Pos;
}

export interface Ident {
  kind: 'Ident';
  name: string;
  /** Package path before `::`, for grammar positions that use `type_name`. */
  qualifier?: Ident[];
  span: Span;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TypeNode = PrimitiveType | NamedType | ArrayType | ChanType;

export interface PrimitiveType {
  kind: 'PrimitiveType';
  name: string; // boolean byte char short int long float double string void barrier timer
  span: Span;
}

export interface NamedType {
  kind: 'NamedType';
  name: Ident;
  span: Span;
}

export interface ArrayType {
  kind: 'ArrayType';
  elem: TypeNode;
  dims: number;
  span: Span;
}

export interface ChanType {
  kind: 'ChanType';
  elem: TypeNode;
  shared: boolean;
  /** `shared read chan<T>` / `shared write chan<T>` (a shared channel restricted to one end). */
  sharedEnd?: 'read' | 'write';
  /** `chan<T>.read` / `chan<T>.write` end types. */
  end?: 'read' | 'write';
  span: Span;
}

// ---------------------------------------------------------------------------
// Declarations
// ---------------------------------------------------------------------------

export interface Program {
  kind: 'Program';
  pragmas: Pragma[];
  pkg?: Ident[];
  imports: Import[];
  decls: Decl[];
  span: Span;
}

export interface Pragma {
  kind: 'Pragma';
  name: Ident;
  value?: string;
  span: Span;
}

export interface Import {
  kind: 'Import';
  path: Ident[];
  wildcard: boolean;
  span: Span;
}

export type Decl = ProcDecl | RecordDecl | ProtocolDecl | ConstDecl | ExternDecl;

export interface Annotation {
  name: string;
  value: string;
  /** Exact token span of the value, retained so code actions can replace it. */
  span: Span;
}

export interface Param {
  kind: 'Param';
  isConst: boolean;
  type: TypeNode;
  name: Ident;
  span: Span;
}

export interface ProcDecl {
  kind: 'ProcDecl';
  modifiers: string[];
  returnType: TypeNode;
  name: Ident;
  params: Param[];
  annotations: Annotation[];
  /** The `[...]` annotation list, when one was written. */
  annotationsSpan?: Span;
  implements: Ident[];
  body?: Block;
  /** Just after the `)` closing the parameter list: where an annotation list may be inserted. */
  headerEnd: Pos;
  span: Span;
}

export interface Field {
  kind: 'Field';
  type: TypeNode;
  name: Ident;
  span: Span;
}

export interface RecordDecl {
  kind: 'RecordDecl';
  modifiers: string[];
  name: Ident;
  extends: Ident[];
  annotations: Annotation[];
  members: Field[];
  span: Span;
}

export interface ProtocolCase {
  kind: 'ProtocolCase';
  name: Ident;
  members: Field[];
  span: Span;
}

export interface ProtocolDecl {
  kind: 'ProtocolDecl';
  modifiers: string[];
  name: Ident;
  extends: Ident[];
  annotations: Annotation[];
  /** Undefined for a forward declaration `protocol P;`. */
  cases?: ProtocolCase[];
  span: Span;
}

export interface Declarator {
  kind: 'Declarator';
  name: Ident;
  /** Extra `[]` written after the name (`int x[]`). */
  dims: number;
  init?: Expr;
  span: Span;
}

export interface ConstDecl {
  kind: 'ConstDecl';
  modifiers: string[];
  type: TypeNode;
  declarators: Declarator[];
  span: Span;
}

export interface ExternDecl {
  kind: 'ExternDecl';
  externType: string;
  name: Ident;
  span: Span;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export type Stmt =
  | Block
  | LocalDecl
  | ExprStmt
  | IfStmt
  | WhileStmt
  | DoStmt
  | ForStmt
  | ParBlock
  | SeqBlock
  | ClaimStmt
  | SwitchStmt
  | AltStmt
  | ReturnStmt
  | BreakStmt
  | ContinueStmt
  | SkipStmt
  | StopStmt
  | SuspendStmt
  | LabeledStmt
  | EmptyStmt;

export interface Block {
  kind: 'Block';
  stmts: Stmt[];
  span: Span;
}

export interface LocalDecl {
  kind: 'LocalDecl';
  isConst: boolean;
  isMobile: boolean;
  type: TypeNode;
  declarators: Declarator[];
  span: Span;
}

/** Expression used as a statement: assignment, ++/--, invocation, channel read/write, sync, timeout. */
export interface ExprStmt {
  kind: 'ExprStmt';
  expr: Expr;
  span: Span;
}

export interface IfStmt {
  kind: 'IfStmt';
  cond: Expr;
  then: Stmt;
  else?: Stmt;
  span: Span;
}

export interface WhileStmt {
  kind: 'WhileStmt';
  cond: Expr;
  body: Stmt;
  span: Span;
}

export interface DoStmt {
  kind: 'DoStmt';
  body: Stmt;
  cond: Expr;
  span: Span;
}

export interface ForStmt {
  kind: 'ForStmt';
  isPar: boolean;
  init: LocalDecl | Expr[] | undefined;
  cond?: Expr;
  update: Expr[];
  enroll: Expr[];
  body: Stmt;
  span: Span;
}

export interface ParBlock {
  kind: 'ParBlock';
  barriers: Expr[];
  /** Whether the barriers were written with parentheses: `par enroll (b)`. */
  barrierParens: boolean;
  body: Block;
  span: Span;
}

export interface SeqBlock {
  kind: 'SeqBlock';
  body: Block;
  span: Span;
}

export interface ClaimStmt {
  kind: 'ClaimStmt';
  channels: Array<Expr | LocalDecl>;
  body: Stmt;
  span: Span;
}

export interface SwitchGroup {
  kind: 'SwitchGroup';
  /** `undefined` entry means `default`. */
  labels: Array<Expr | undefined>;
  stmts: Stmt[];
  span: Span;
}

export interface SwitchStmt {
  kind: 'SwitchStmt';
  expr: Expr;
  groups: SwitchGroup[];
  span: Span;
}

export type Guard =
  | { kind: 'ReadGuard'; target: Expr; read: ChanRead; span: Span }
  | { kind: 'SkipGuard'; span: Span }
  | { kind: 'TimeoutGuard'; timeout: Timeout; span: Span };

export interface AltCase {
  kind: 'AltCase';
  precondition?: Expr;
  guard?: Guard;
  /** A nested alt used as a case. */
  nested?: AltStmt;
  body?: Stmt;
  span: Span;
}

export interface AltStmt {
  kind: 'AltStmt';
  isPri: boolean;
  replicated?: { init: LocalDecl | Expr[] | undefined; cond?: Expr; update: Expr[] };
  cases: AltCase[];
  span: Span;
}

export interface ReturnStmt {
  kind: 'ReturnStmt';
  expr?: Expr;
  span: Span;
}

export interface BreakStmt {
  kind: 'BreakStmt';
  label?: Ident;
  span: Span;
}

export interface ContinueStmt {
  kind: 'ContinueStmt';
  label?: Ident;
  span: Span;
}

export interface SkipStmt {
  kind: 'SkipStmt';
  span: Span;
}

export interface StopStmt {
  kind: 'StopStmt';
  span: Span;
}

export interface SuspendStmt {
  kind: 'SuspendStmt';
  span: Span;
}

export interface LabeledStmt {
  kind: 'LabeledStmt';
  label: Ident;
  stmt: Stmt;
  span: Span;
}

export interface EmptyStmt {
  kind: 'EmptyStmt';
  span: Span;
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export type Expr =
  | Literal
  | NameExpr
  | ParenExpr
  | BinaryExpr
  | UnaryExpr
  | AssignExpr
  | TernaryExpr
  | CastExpr
  | IsExpr
  | Invocation
  | RecordAccess
  | ArrayAccess
  | ChanEnd
  | ChanRead
  | ChanWrite
  | Sync
  | Timeout
  | NewArray
  | ArrayLiteral
  | RecordLiteral
  | ProtocolLiteral
  | NewMobile
  | ErrorExpr;

export interface Literal {
  kind: 'Literal';
  litKind: 'int' | 'long' | 'float' | 'double' | 'boolean' | 'string' | 'char' | 'null';
  text: string;
  span: Span;
}

export interface NameExpr {
  kind: 'NameExpr';
  /** Package qualifier for `pkg::name`. */
  qualifier?: Ident[];
  name: Ident;
  span: Span;
}

export interface ParenExpr {
  kind: 'ParenExpr';
  expr: Expr;
  span: Span;
}

export interface BinaryExpr {
  kind: 'BinaryExpr';
  op: string;
  left: Expr;
  right: Expr;
  span: Span;
}

export interface UnaryExpr {
  kind: 'UnaryExpr';
  op: string;
  prefix: boolean;
  operand: Expr;
  span: Span;
}

export interface AssignExpr {
  kind: 'AssignExpr';
  op: string;
  target: Expr;
  value: Expr;
  span: Span;
}

export interface TernaryExpr {
  kind: 'TernaryExpr';
  cond: Expr;
  then: Expr;
  else: Expr;
  span: Span;
}

export interface CastExpr {
  kind: 'CastExpr';
  type: TypeNode;
  expr: Expr;
  span: Span;
}

export interface IsExpr {
  kind: 'IsExpr';
  expr: Expr;
  typeName: Ident;
  span: Span;
}

export interface Invocation {
  kind: 'Invocation';
  target?: Expr;
  qualifier?: Ident[];
  name: Ident;
  args: Expr[];
  span: Span;
}

export interface RecordAccess {
  kind: 'RecordAccess';
  target: Expr;
  member: Ident;
  span: Span;
}

export interface ArrayAccess {
  kind: 'ArrayAccess';
  target: Expr;
  index: Expr;
  span: Span;
}

export interface ChanEnd {
  kind: 'ChanEnd';
  target: Expr;
  end: 'read' | 'write';
  span: Span;
}

export interface ChanRead {
  kind: 'ChanRead';
  target: Expr;
  /** Extended rendezvous block: `c.read({ ... })`. */
  extended?: Block;
  span: Span;
}

export interface ChanWrite {
  kind: 'ChanWrite';
  target: Expr;
  value: Expr;
  span: Span;
}

export interface Sync {
  kind: 'Sync';
  target: Expr;
  span: Span;
}

export interface Timeout {
  kind: 'Timeout';
  target: Expr;
  delay: Expr;
  span: Span;
}

export interface NewArray {
  kind: 'NewArray';
  elem: TypeNode;
  dimExprs: Expr[];
  extraDims: number;
  init?: ArrayLiteral;
  span: Span;
}

export interface ArrayLiteral {
  kind: 'ArrayLiteral';
  elements: Expr[];
  span: Span;
}

export interface RecordLiteral {
  kind: 'RecordLiteral';
  typeName: Ident;
  fields: Array<{ name: Ident; value: Expr }>;
  span: Span;
}

export interface ProtocolLiteral {
  kind: 'ProtocolLiteral';
  typeName: Ident;
  tag: Ident;
  fields: Array<{ name: Ident; value: Expr }>;
  span: Span;
}

export interface NewMobile {
  kind: 'NewMobile';
  typeName: Ident;
  span: Span;
}

/** Placeholder produced during error recovery so the tree stays well-formed. */
export interface ErrorExpr {
  kind: 'ErrorExpr';
  span: Span;
}

export interface ParseFix {
  title: string;
  line: number;
  col: number;
  endCol: number;
  text: string;
}

export interface ParseError {
  line: number;
  col: number;
  endCol: number;
  message: string;
  /** A single-range edit that resolves the error (a replaced typo, an inserted token). */
  fix?: ParseFix;
}

/** The `pkg.path::` prefix of a qualified name, or '' when there is none. */
export function qualifierToString(qualifier: Ident[] | undefined): string {
  return qualifier?.length ? `${qualifier.map((q) => q.name).join('.')}::` : '';
}

/** Render a possibly package-qualified identifier back to source form. */
export function identToString(id: Ident): string {
  return qualifierToString(id.qualifier) + id.name;
}

/** Render a type back to source form (used in hover text and symbols). */
export function typeToString(t: TypeNode): string {
  switch (t.kind) {
    case 'PrimitiveType':
      return t.name;
    case 'NamedType':
      return identToString(t.name);
    case 'ArrayType':
      return typeToString(t.elem) + '[]'.repeat(t.dims);
    case 'ChanType': {
      const head = t.shared ? `shared ${t.sharedEnd ? t.sharedEnd + ' ' : ''}` : '';
      return `${head}chan<${typeToString(t.elem)}>${t.end ? '.' + t.end : ''}`;
    }
  }
}
