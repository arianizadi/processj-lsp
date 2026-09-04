/** Keywords from src/scanner/ProcessJ.flex in the compiler. */
export const KEYWORDS: readonly string[] = [
  'alt', 'barrier', 'break', 'case', 'chan', 'claim', 'const', 'continue', 'default', 'do',
  'else', 'enroll', 'extends', 'extern', 'for', 'fork', 'if', 'implements', 'import', 'is',
  'mobile', 'native', 'new', 'package', 'par', 'pri', 'private', 'proc', 'protected',
  'protocol', 'public', 'read', 'record', 'resume', 'return', 'seq', 'shared', 'skip',
  'stop', 'suspend', 'switch', 'sync', 'timeout', 'timer', 'while', 'with', 'write',
];

export const PRIMITIVE_TYPES: readonly string[] = [
  'boolean', 'byte', 'char', 'short', 'int', 'long', 'float', 'double', 'string', 'void',
  'timer', 'barrier',
];

export const LITERALS: readonly string[] = ['true', 'false', 'null'];

/** Words that can appear where a type would, but are control flow, not declarations. */
export const NOT_A_TYPE = new Set<string>([
  'if', 'else', 'while', 'for', 'do', 'switch', 'case', 'default', 'return', 'break', 'continue',
  'par', 'alt', 'pri', 'seq', 'new', 'import', 'package', 'skip', 'stop', 'suspend', 'resume',
  'sync', 'claim', 'fork', 'with', 'is', 'extends', 'implements', 'record', 'protocol', 'const',
  'enroll',
]);

/** Short explanations shown on hover over a keyword. */
export const KEYWORD_DOCS: Record<string, string> = {
  par: 'Runs each statement in the block as a separate process and waits for all of them to finish.\n\n```processj\npar {\n    producer(c.write);\n    consumer(c.read);\n}\n```',
  alt: 'Waits on several guards at once and runs the branch of the first one that becomes ready. Guards are channel reads, `skip`, or `timer.timeout(...)`. `pri alt` picks the first ready guard in textual order.\n\n```processj\nalt {\n    v = in.read() : { println(v); }\n    t.timeout(t.read() + 1000) : { println("timed out"); }\n}\n```',
  pri: 'Prefix for `alt`: when several guards are ready, take the earliest one in textual order.',
  chan: 'A synchronous channel. `chan<int> c;` declares one; `c.read` and `c.write` are its two ends. Add `shared` to allow several readers or writers.',
  read: 'The reading end of a channel (`c.read`) or the read operation (`c.read()`), which blocks until a writer arrives.',
  write: 'The writing end of a channel (`c.write`) or the write operation (`c.write(v)`), which blocks until a reader arrives.',
  shared: 'Marks a channel end as usable by more than one process at a time. Readers or writers then queue on a claim.',
  claim: 'Takes exclusive use of a shared channel end for the duration of the block.',
  timer: 'A timer value. `t.read()` gives the current time in milliseconds and `t.timeout(when)` waits until that absolute millisecond, so a delay is written `t.timeout(t.read() + 1000)`.',
  timeout: 'Waits until the given absolute time in milliseconds, or serves as an `alt` guard that becomes ready then. The argument is a deadline, not a delay: `t.timeout(1000)` has already passed and returns at once, while `t.timeout(t.read() + 1000)` waits a second.',
  barrier: 'A barrier. Processes enrolled on it block on `sync()` until every enrolled process has called `sync()`.',
  sync: 'Waits on a barrier until all enrolled processes have synced.',
  enroll: 'Enrolls the processes of a `par` on a barrier: `par enroll(b) { ... }`.',
  skip: 'An `alt` guard that is always ready, or a statement that does nothing.',
  stop: 'A statement that never terminates (the process blocks forever).',
  record: 'A named aggregate of fields, similar to a struct. Records can `extends` other records.\n\n```processj\nrecord Point { int x; int y; }\n```',
  protocol: 'A tagged union. Each case names the fields that variant carries; use `switch` on a protocol value to branch on its tag.\n\n```processj\nprotocol Msg {\n    move : { int dx; int dy; }\n    quit : { }\n}\n```',
  is: 'Tests which case a protocol value holds: `if (m is move) { ... }`.',
  mobile: 'A mobile process: one that can be suspended, sent over a channel, and resumed elsewhere.',
  suspend: 'Suspends a mobile process so it can be passed along a channel.',
  resume: 'Resumes a suspended mobile process.',
  const: 'A compile-time constant. Only literals may appear on the right-hand side.',
  native: 'Declares a procedure implemented in the target language (Java) rather than in ProcessJ.',
  proc: 'Declares a procedure. The current compiler accepts `public void name(...)` without `proc`.',
  import: 'Imports a library: `import std.*;` gives access to `println`, `math`, `random`, and `strings`.',
  fork: 'Reserved keyword; not implemented by the current compiler.',
  seq: 'Reserved keyword; not implemented by the current compiler.',
  with: 'Reserved keyword; not implemented by the current compiler.',
};
