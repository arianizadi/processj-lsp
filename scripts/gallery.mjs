// The example gallery of the browser build: every ProcessJ and CSPm program in
// this repository (the standard library headers aside) as a project a web IDE
// can open, written by scripts/build-browser.mjs to dist/browser/gallery.json.
//
//   {
//     format: 1, version,
//     categories: [{ id, title, description }],   in the order to show them
//     tags: [string],                              every tag used, in the order to show them
//     featured: [id],                              a small set to start with
//     entries: [{ id, title, description, category, tags, dir, files, open, entry }],
//     sources: { "<repository path>": text }       each file once
//   }
//
// An entry's `files` are project paths (relative to `dir`, the entry's own
// folder in this repository, where its source is sources[`${dir}/${path}`]):
// the program, the project files it imports (`import lib.geometry;` is
// lib/geometry.pj beside it) or includes (`include "x.csp"`), and for a .pj
// file its CSPm model of the same name, if there is one. `open` is the file
// to show and `entry` the one Run starts from (null for CSPm). The title and
// description come from the file (its name, its leading comment) unless
// NOTES below has better ones; `// expect:` and `// outcome:` lines become tags
// (a note's `outcome` stands in for the file's where the IDE's runner differs).
import fs from 'node:fs';
import path from 'node:path';

export const GALLERY_FORMAT = 1;

const CATEGORIES = [
  { id: 'start', title: 'Start here', description: 'Short programs that each show one thing the checker, the compiler or FDR finds.' },
  { id: 'classic', title: 'Classic programs', description: 'ProcessJ programs from the compiler\'s own repository: CommsTime, the full adder, Santa Claus and more.' },
  { id: 'corners', title: 'Language corner cases', description: 'Small programs on the edges of the language, each with what this compiler really did with it.' },
  { id: 'fifo', title: 'Channel arrays and FIFOs', description: 'Pipelines of stages built with par for over channel arrays, working and broken.' },
  { id: 'cspm', title: 'CSPm models', description: 'Models for the FDR refinement checker, written by hand or generated from ProcessJ.' },
  { id: 'other', title: 'Other fixtures', description: 'Programs the test suite keeps for one purpose of its own.' },
];

/** Where each category's programs are: the first directory that holds a file wins (CSPm by extension). */
const PLACES = [
  { dir: 'examples', category: 'start', recursive: false },
  { dir: 'test/fixtures/processj', category: 'classic', recursive: true },
  { dir: 'test/differential', category: 'corners', recursive: true },
  { dir: 'test/fixtures/fifo', category: 'fifo', recursive: true },
  { dir: 'test/fixtures/verification', category: 'other', recursive: true },
  { dir: 'test/fixtures/showtree', category: 'other', recursive: true },
  { dir: 'test/fixtures/cspm', category: 'cspm', recursive: true },
];

/** The standard library headers: the compiler's, never an example. */
const EXCLUDED_DIRS = ['test/fixtures/include', 'node_modules', 'dist'];

const FEATURED = [
  'examples/dining_philosophers.pj',
  'examples/dining_philosophers_fixed.pj',
  'examples/clean_pipeline.pj',
  'examples/par_deadlock.pj',
  'examples/use_import.pj',
  'examples/channel_array_pipeline.pj',
];

/** The order of the Start here entries: the featured ones first, then by title. */
const START_ORDER = FEATURED;

/** Five classic programs are in ProcessJ's old syntax, which the runner's compiler does not parse. */
const OLD_SYNTAX = 'It is written for an older ProcessJ, with `proc` before its procedures: this compiler stops at the first one with a syntax error.';

/** Titles, descriptions, tags and outcomes better than the file's own (the classic programs have no comments). */
const NOTES = {
  'examples/dining_philosophers.pj': { title: 'Dining philosophers' },
  'examples/dining_philosophers_fixed.pj': { title: 'Dining philosophers, fixed' },
  'examples/clean_pipeline.pj': { tags: ['runs'] },
  'examples/channel_array_pipeline.pj': { tags: ['runs'] },
  'examples/dining_philosophers.csp': { title: 'Dining philosophers (CSPm)', tags: ['deadlock'] },
  'examples/dining_philosophers_fixed.csp': { title: 'Dining philosophers, fixed (CSPm)' },
  'test/fixtures/cspm/copy.csp': { title: 'Two-place buffer (CSPm)' },
  'test/fixtures/cspm/dining.csp': { title: 'Dining philosophers in plain CSPm', tags: ['deadlock'] },
  'test/fixtures/cspm/forms.csp': { title: 'Assertion forms (CSPm)' },
  'test/fixtures/cspm/interleave.csp': { title: 'Clients of one server (CSPm)' },
  'test/fixtures/cspm/nested.csp': { title: 'A chain of parallels (CSPm)' },
  'test/fixtures/cspm/par_deadlock.csp': { tags: ['deadlock'] },
  'test/fixtures/cspm/ring.csp': { title: 'Token ring (CSPm)' },
  'test/fixtures/cspm/vending.csp': { title: 'Vending machine (CSPm)' },
  'test/fixtures/fifo/blocks_alt.pj': { title: 'FIFO, broken: a stage that never forwards', tags: ['deadlock'] },
  'test/fixtures/fifo/blocks_oob.pj': { title: 'FIFO, broken: one past the end' },
  'test/fixtures/fifo/blocks_skip.pj': { title: 'FIFO, broken: one stage short', tags: ['deadlock'] },
  // `pj/par-for-body` says how this compiler runs a par for body, not that it cannot build it: this one builds
  // and runs, and prints x=0 twice (as test/differential/par_for_body_statements.pj, the same program, says).
  'examples/par_for_body.pj': { outcome: 'runs-wrong' },
  // The file's comment says what stock ProcessJ does; the runtime of the IDE's runner waits without spinning.
  'examples/deadlock_read.pj': { description: 'Nothing in `main` ever writes `c` or passes it to another process, so this read blocks forever. On the IDE\'s runner the program waits, idle, until the time limit; on ProcessJ\'s unpatched runtime its scheduler also keeps a core busy all that time.' },
  'examples/compiler_limits.pj': { description: 'Valid ProcessJ that this compiler cannot build: a record that contains itself, assigning null, a break inside a par branch, and channel reads where the compiler does not take them. The comment on each line says why.' },
  'examples/use_import.pj': { title: 'Importing a project file', tags: ['runs'] },
  'examples/yield_through_calls.pj': { title: 'Yield through calls' },
  'examples/bug_lookalikes.pj': { title: 'Compiler bug look-alikes' },
  'examples/pri_alt_skip.pj': { title: 'Pri alt with skip first' },
  'test/fixtures/fifo/blocks.pj': { title: 'FIFO of stages', description: 'A FIFO of forwarding stages joined by a channel array and started with par for, next to one built by recursion (altFIFO): the working version of the three broken ones beside it.' },
  'test/fixtures/fifo/unbound.pj': { title: 'Networks set by arguments', outcome: 'compiler-limit', description: 'Procedures whose arguments decide their network, and no call from main fixes them: checked on their own with every modelled value that elaborates, or with what a //@csp check names. This compiler cannot build it: javac rejects the Java it writes for the read that opens the par for body in stages ("illegal start of expression").' },
  'test/fixtures/verification/commstime_bounded.pj': { title: 'CommsTime, bounded', description: 'CommsTime with a consumer that stops after three values: the ring keeps going, delta\'s next write finds no reader, and everything stops. Check it with FDR to see the deadlock form.' },
  'test/fixtures/showtree/shapes.pj': { title: 'A tour of the syntax', description: 'Declarations, statements and expressions of nearly every form ProcessJ has, in a few lines (the parser\'s test program; it has no main).' },
  'test/fixtures/processj/alttest.pj': { title: 'Alt with skip', description: 'An alt that takes a value from a writer or, when none is ready, skips.' },
  'test/fixtures/processj/arr.pj': { title: 'Array over a channel', description: 'A writer fills an int array with squares and sends the whole array over a channel; the reader prints it.' },
  'test/fixtures/processj/array.pj': { title: 'Array literals', description: 'Array literals in one, two and three dimensions, their .size, and a string\'s .length.' },
  'test/fixtures/processj/barrierEx.pj': { title: 'Barrier', outcome: 'error', description: `Two processes enrolled on a barrier with par enroll meet at b.sync(). ${OLD_SYNTAX}` },
  'test/fixtures/processj/bartest.pj': { title: 'Barrier, channel and timer', description: 'Two processes sync on a barrier, then one reads a channel while waiting on a timer in a par.' },
  'test/fixtures/processj/binexpr.pj': { title: 'One expression', outcome: 'error', description: `An arithmetic expression in main: the smallest program here. ${OLD_SYNTAX}` },
  'test/fixtures/processj/bytecode.pj': { title: 'Prefix process', description: 'A prefix process: it writes a first value, then copies its input to its output forever. It has no main.' },
  'test/fixtures/processj/car.pj': { title: 'Car record', description: 'A record with two string fields, made with a record literal and printed.' },
  'test/fixtures/processj/channelWR.pj': { title: 'Write and read', description: 'One process writes 4 on a channel, the other reads it and prints it: the basic rendezvous.' },
  'test/fixtures/processj/commstime.pj': { title: 'CommsTime', description: 'The CommsTime benchmark: prefix, delta, succ and consume pass a million numbers around a ring of channels.' },
  'test/fixtures/processj/Demo_matt.pj': { title: 'Read inside an expression', description: 'A par whose branches write and read one channel, the read inside an addition.' },
  'test/fixtures/processj/Demo.pj': { title: 'Records, protocols and barriers', outcome: 'error', description: `A larger demo: records, protocols that extend each other, channels that carry them, and two barriers. ${OLD_SYNTAX}` },
  'test/fixtures/processj/Demo2.pj': { title: 'Nested pars', description: 'Pars inside pars and procedures that start pars of their own: many processes print, in any order.' },
  'test/fixtures/processj/enrolledtest.pj': { title: 'Nested barrier enrolment', description: 'Three processes enrolled on one barrier through nested par enroll blocks sync, then print.' },
  'test/fixtures/processj/fibonacci.pj': { title: 'Fibonacci', description: 'A par for that starts ten writer and reader pairs on one channel (the Fibonacci step itself is commented out).' },
  'test/fixtures/processj/fortest.pj': { title: 'For loops', description: 'for loops with several variables, empty parts and break, and a par inside a loop body.' },
  'test/fixtures/processj/fullAdder.pj': { title: 'Full adder', outcome: 'compiler-limit', description: 'Logic gates as processes on boolean channels, wired into one-, four- and eight-bit adders that add two numbers. This compiler cannot build it: javac rejects the Java it writes ("unreachable statement").' },
  'test/fixtures/processj/Hello.pj': { title: 'Hello', description: 'Hello world from a par, next to two empty procedures.' },
  'test/fixtures/processj/iftest.pj': { title: 'If and else', description: 'Nested if and else if, and a for loop whose increment is in its condition.' },
  'test/fixtures/processj/integrate.pj': { title: 'Integrator', outcome: 'error', description: 'A running-sum integrator built from delta, plus and prefix processes, in a sequential and a parallel version. It prints with prlongln, which this standard library does not have, so the compiler rejects it ("Procedure \'prlongln\' not found").' },
  'test/fixtures/processj/localDecl.pj': { title: 'Local declaration', description: 'A local declaration and an empty endless loop, in a procedure without main.' },
  'test/fixtures/processj/mandelbrot.pj': { title: 'Mandelbrot set', description: 'The Mandelbrot set with nested par for loops, one process per pixel, written to a PGM image with image.pgm.' },
  'test/fixtures/processj/mandelbrot2.pj': { title: 'Mandelbrot set, large', description: 'The Mandelbrot set at 4000 by 3000 pixels, one process per pixel: twelve million processes, more than a sandbox has room for.' },
  'test/fixtures/processj/Matt.pj': { title: 'Two reads in one expression', description: 'A par whose first branch adds what it reads from two channels the other branches write.' },
  'test/fixtures/processj/NetworkProc.pj': { title: 'Network with a kill switch', description: 'A producer, an integrator and a consumer that a killer process stops through kill channels and alts.' },
  'test/fixtures/processj/parExp.pj': { title: 'Par of calls', description: 'A par of two calls to empty procedures.' },
  'test/fixtures/processj/protocols.pj': { title: 'Protocol inheritance', description: 'A protocol that extends another with a case of its own, and a literal of that case.' },
  'test/fixtures/processj/protocolSwitch.pj': { title: 'Switch on a protocol', outcome: 'error', description: `A switch on a protocol value's case, reading the fields of the case it holds. ${OLD_SYNTAX}` },
  'test/fixtures/processj/readEx.pj': { title: 'Read into a variable', description: 'A writer sends 6 and the reader reads it into a variable declared before, then prints it.' },
  'test/fixtures/processj/recordchan.pj': { title: 'Record over a channel', description: 'A record sent over a channel; the reader prints its fields.' },
  'test/fixtures/processj/santa.pj': { title: 'Santa Claus problem', description: 'Santa, his reindeer and his elves, synchronised with barriers, shared channels and protocols, each process started by hand in main.' },
  'test/fixtures/processj/santapar.pj': { title: 'Santa Claus problem, par for', description: 'The Santa Claus problem with the reindeer and the elves started by par for loops with enroll.' },
  'test/fixtures/processj/santatest.pj': { title: 'Santa\'s protocols', description: 'A protocol that extends another without new cases, and a shared write channel that carries it.' },
  'test/fixtures/processj/sharedchan.pj': { title: 'Shared channel', outcome: 'compiler-limit', description: 'Three readers and two writers on one channel shared at both ends. This compiler crashes on it while writing the Java ("no such attribute: type"), so it cannot build it.' },
  'test/fixtures/processj/sharedread.pj': { title: 'Shared read end', outcome: 'compiler-limit', description: 'Three readers on the shared read end of a channel, one writer. This compiler crashes on it while writing the Java ("no such attribute: type"), so it cannot build it.' },
  'test/fixtures/processj/sharedwrite.pj': { title: 'Shared write end', description: 'Three writers on the shared write end of a channel, one reader.' },
  'test/fixtures/processj/silly.pj': { title: 'Reads in a loop condition', description: 'A for loop whose condition reads two channels, in a procedure without main.' },
  'test/fixtures/processj/simple.pj': { title: 'Simple', outcome: 'deadlocks', description: 'A procedure that reads a channel, with most of the program commented out. main hands it a channel that nothing writes, so the read waits for good: it builds, but never finishes.' },
  'test/fixtures/processj/simplepj.pj': { title: 'Simple rendezvous', outcome: 'error', description: `The basic rendezvous between two processes. ${OLD_SYNTAX}` },
  'test/fixtures/processj/SwitchDemo.pj': { title: 'Switch', description: 'Nested switch statements with empty cases, break and default.' },
  'test/fixtures/processj/test22.pj': { title: 'Protocols and records', description: 'Protocols with record fields and a record with a protocol field.' },
  'test/fixtures/processj/timer.pj': { title: 'Timer', description: 'A timeout on a timer, then the time read and printed.' },
  'test/fixtures/processj/verySimple.pj': { title: 'Straight-line code', description: 'Many boolean and int variables declared and assigned in turn, as generated code might be.' },
  // `// outcome: runs` in these two is for ProcessJ's alt_timer_update branch, which this checker follows. The
  // runner the web IDE uses builds with ProcessJ's main branch (65cfe7e), where javac rejects both.
  // The classic programs above that carry an outcome do not build on the runner either (the first message the
  // compiler or javac gives is in each description).
  'test/differential/alt_timeout_guard.pj': { outcome: 'compiler-limit', description: 'A timer read inside an alt timeout guard. ProcessJ\'s alt_timer_update branch builds and runs it and prints "read 1" (since commit 179847f, "Fix: Timer reads in channel guards"); on its main branch, which the IDE\'s runner builds with, javac rejects the generated Java ("illegal start of expression").' },
  // `// outcome: runs-wrong` is what ProcessJ's own runtime did: a garbage collection could end the par early.
  // On the patched runtime the IDE's runner uses, the program deadlocks as its code says.
  'test/differential/par_ends_early_gc.pj': { outcome: 'deadlocks', description: 'The par\'s second branch reads a channel that main writes only after the par. On the IDE\'s runner the program prints "quick done" and then waits for good, as the code says; on ProcessJ\'s unpatched runtime a garbage collection could end the par early, and it went on to print "after par" and "read 1".' },
  'test/differential/two_alts_one_process.pj': { outcome: 'compiler-limit', description: 'Two alts one after another in one process. ProcessJ\'s alt_timer_update branch builds and runs it; on its main branch, which the IDE\'s runner builds with, javac rejects the second alt ("variable __booleanGuards1 is already defined in method run()"). A second replicated alt in one process fails on both (pj/multiple-alts).' },
};

/**
 * What `// outcome:` says the compiler and the runtime did (test/differential.test.ts), or a note's `outcome`
 * where the IDE's runner does otherwise. The sentence goes after a description from the file unless `stated`
 * finds it says so already; a note's description is whole as it is.
 */
const OUTCOMES = {
  runs: { tag: 'runs', sentence: 'It builds and runs as written.', stated: /\b(builds?|compiles?) and runs?\b/i },
  'runs-wrong': { tag: 'runs wrong', sentence: 'It builds and runs, but does not do what the code says.', stated: /\bbuilds? and runs?, but\b/i },
  error: { tag: 'build error', sentence: 'The compiler rejects it, and the checker says why.', stated: /\bcompiler rejects it\b/i },
  'compiler-limit': { tag: 'compiler limit', sentence: 'It is valid ProcessJ that this compiler cannot build; the checker says so.', stated: /\bcannot build\b/i },
  deadlocks: { tag: 'deadlock', sentence: 'It builds, but never finishes.', stated: /\bbuilds?, but never\b/i },
};

/** Tags from the diagnostics a program is meant to show (`// expect:`). */
const EXPECT_TAGS = [
  [/^pj\/(par-deadlock|channel-self-deadlock|channel-no-writer|channel-no-reader|starving-loop|shared-unlocked-end)$/, 'deadlock'],
  [/^pj\/(type\/|channel-write-type$|channel-direction$)/, 'type error'],
  [/^pj\/(compiler-limit|read-placement|call-as-condition)$/, 'compiler limit'],
  [/^pj\/parallel-usage$/, 'data race'],
  [/^pj\/needs-yield-annotation$/, 'yield'],
];

/** Tags for what a program uses, from its code (comments and strings removed). */
const FEATURE_TAGS = [
  [/\bpar\s+for\b/, 'par for'],
  [/\balt\b/, 'alt'],
  [/\bbarrier\b/, 'barrier'],
  [/\btimer\b/, 'timer'],
  [/\bprotocol\b/, 'protocol'],
  [/\brecord\b/, 'record'],
  [/\bshared\b/, 'shared channel'],
  [/\bchan\s*<[^;=(){}]*>\s*(?:\[\s*\]|\w+\s*\[\s*\])/, 'channel array'],
];

/** The order of tags in the filter: verdicts first, then language features. */
const TAG_ORDER = ['runs', 'no warnings', 'deadlock', 'type error', 'build error', 'compiler limit', 'runs wrong', 'data race', 'yield', 'FDR', 'quick fix', 'imports', 'par for', 'alt', 'barrier', 'timer', 'protocol', 'record', 'shared channel', 'channel array'];

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const posix = (p) => p.split(path.sep).join('/');

/** Every .pj and .csp file under `dir` (relative to the repository), sorted. */
function walk(root, dir, recursive) {
  const out = [];
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) return out;
  for (const entry of fs.readdirSync(full, { withFileTypes: true }).sort((a, b) => compare(a.name, b.name))) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (recursive && !EXCLUDED_DIRS.some((x) => rel === x || rel.startsWith(`${x}/`))) out.push(...walk(root, rel, true));
    } else if (/\.(pj|csp)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

/** "dining_philosophers_fixed" → "Dining philosophers fixed"; "fullAdder" → "Full adder"; "test22" → "Test 22". */
export function prettify(stem) {
  const words = stem
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .map((word, i) => (/^[A-Z]{2,}$/.test(word) ? word : i === 0 ? word[0].toUpperCase() + word.slice(1).toLowerCase() : word.toLowerCase()));
  return words.join(' ');
}

/** The code of a ProcessJ program without its comments and string literals (for the feature tags). */
function codeOnly(text) {
  return text.replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '');
}

/** Comment text that is code someone commented out rather than prose. */
function looksLikeCode(line) {
  return /[;{}]\s*$/.test(line) || /^(import|package|public|private|void|proc|int|long|boolean|string|record|protocol|chan|par|for|while|if|else|switch|case|const|barrier|timer)\b[^.!?]*$/.test(line) || /^[A-Za-z_][\w.]*\s*\(.*\)\s*;?$/.test(line);
}

/**
 * The prose a program opens with: the first block of whole-line comments,
 * before its first declaration, or (`anywhere`) at the top level anywhere in
 * the file. `// expect:`, `// outcome:` and `//@` pragmas are not prose.
 */
function leadingComment(text, { anywhere, csp }) {
  const lines = text.split(/\r?\n/);
  const marker = csp ? /^--\s?(.*)$/ : /^\/\/\s?(.*)$/;
  let block = [];
  for (const raw of lines) {
    const m = marker.exec(raw);
    const body = m?.[1]?.trim();
    const skip = body !== undefined && (/^(expect|outcome):/.test(body) || /^@/.test(body) || (!csp && body.startsWith('/')));
    if (m && !skip) {
      if (body === '' && !block.length) continue;
      if (body === '') {
        if (block.length) break;
        continue;
      }
      block.push(body);
      continue;
    }
    if (m && skip) continue;
    if (block.length) {
      if (!block.every(looksLikeCode)) break;
      block = [];
    }
    const code = raw.trim();
    if (!code) continue;
    if (!anywhere && !/^(import|package)\b/.test(code)) return '';
  }
  if (block.length && block.every(looksLikeCode)) return '';
  return block.filter((line) => !looksLikeCode(line)).join(' ').replace(/\s+/g, ' ').trim();
}

/** At most two sentences and about 260 characters. */
function shorten(text) {
  const sentences = text.split(/(?<=[.!?])\s+(?=[A-Z`(])/);
  let out = sentences.slice(0, 2).join(' ');
  if (out.length > 260) out = sentences[0];
  if (out.length > 260) out = `${out.slice(0, 257).replace(/\s+\S*$/, '')}…`;
  return out;
}

/** `import a.b;` → a/b.pj, `import a.*;` → every .pj in a/, relative to the importing file's folder, when they exist. */
function projectImports(root, file, text) {
  const out = [];
  const dir = path.posix.dirname(file);
  for (const m of codeOnly(text).matchAll(/^\s*import\s+([\w.]+?)(\.\*)?\s*;/gm)) {
    const parts = m[1].split('.');
    if (m[2]) {
      const folder = path.posix.join(dir, ...parts);
      if (fs.existsSync(path.join(root, folder)) && fs.statSync(path.join(root, folder)).isDirectory()) {
        for (const name of fs.readdirSync(path.join(root, folder)).sort(compare)) if (name.endsWith('.pj')) out.push(`${folder}/${name}`);
      }
    } else {
      const target = `${path.posix.join(dir, ...parts)}.pj`;
      if (fs.existsSync(path.join(root, target))) out.push(target);
    }
  }
  return out;
}

/** The .csp files an `include "x.csp"` names, relative to the including file. */
function cspIncludes(root, file, text) {
  const out = [];
  for (const m of text.matchAll(/\binclude\s*"([^"\n]+)"/g)) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]));
    if (!target.startsWith('../') && fs.existsSync(path.join(root, target))) out.push(target);
  }
  return out;
}

/** The program and every file it reaches, as repository paths, the program first. */
function reach(root, file, read) {
  const seen = new Set([file]);
  const queue = [file];
  for (let next = queue.shift(); next; next = queue.shift()) {
    const text = read(next);
    for (const dep of next.endsWith('.csp') ? cspIncludes(root, next, text) : projectImports(root, next, text)) {
      if (!seen.has(dep)) {
        seen.add(dep);
        queue.push(dep);
      }
    }
  }
  return [...seen];
}

/** The gallery of the repository at `root`. */
export function buildGallery(root, { version } = {}) {
  const cache = new Map();
  const read = (file) => {
    if (!cache.has(file)) cache.set(file, fs.readFileSync(path.join(root, file), 'utf8'));
    return cache.get(file);
  };
  const candidates = [];
  const placed = new Set();
  for (const place of PLACES) {
    for (const file of walk(root, place.dir, place.recursive)) {
      if (placed.has(file)) continue;
      placed.add(file);
      candidates.push({ file, category: file.endsWith('.csp') ? 'cspm' : place.category, place });
    }
  }
  // A library that another program imports, with no main of its own, goes with that program (examples/lib/).
  const imported = new Set(candidates.flatMap(({ file }) => reach(root, file, read).slice(1)));

  const entries = [];
  const sources = {};
  for (const { file, category, place } of candidates) {
    if (imported.has(file) && !/\bvoid\s+main\s*\(/.test(codeOnly(read(file)))) continue;
    const text = read(file);
    const csp = file.endsWith('.csp');
    const dir = path.posix.dirname(file);
    const stem = path.posix.basename(file).replace(/\.(pj|csp)$/, '');
    const reached = reach(root, file, read);
    // A .pj program's CSPm model of the same name goes with it (the models in examples/).
    const model = `${dir}/${stem}.csp`;
    if (!csp && fs.existsSync(path.join(root, model)) && !reached.includes(model)) reached.push(model);
    const files = reached.map((f) => path.posix.relative(dir, f));
    for (const f of reached) sources[f] = read(f);

    const note = NOTES[file] ?? {};
    const lines = text.split(/\r?\n/);
    const expect = /^\/\/ expect:\s*(.*)$/m.exec(lines.slice(0, 3).join('\n'))?.[1]?.trim();
    const outcome = note.outcome ?? /^\/\/ outcome:\s*(\S+)/m.exec(lines.slice(0, 3).join('\n'))?.[1];
    const generated = csp ? /^-- Generated by processj-lsp from (\S+?\.pj)\b/m.exec(text)?.[1] : undefined;

    let description = note.description ?? '';
    if (!description) {
      if (generated) description = `The CSPm model processj-lsp made from ${generated} (Convert to CSP): open it and check it with FDR.`;
      else description = shorten(leadingComment(text, { anywhere: place.category !== 'corners', csp }));
    }
    if (!note.description && outcome && OUTCOMES[outcome] && !OUTCOMES[outcome].stated.test(description)) description = description ? `${description} ${OUTCOMES[outcome].sentence}` : OUTCOMES[outcome].sentence;
    if (!description) description = csp ? 'A CSPm model: check its assertions with FDR.' : 'A ProcessJ program.';

    const tags = new Set(note.tags ?? []);
    if (outcome && OUTCOMES[outcome]) tags.add(OUTCOMES[outcome].tag);
    if (expect !== undefined) {
      const codes = expect === 'none' ? [] : expect.split(/,\s*/);
      if (!codes.length) tags.add('no warnings');
      for (const code of codes) for (const [re, tag] of EXPECT_TAGS) if (re.test(code)) tags.add(tag);
    }
    const prose = `${description} ${leadingComment(text, { anywhere: true, csp })}`;
    if (/\bdeadlock(s|ed)?\b|waits? forever|never finishes/i.test(prose) && !/deadlock[ -]free/i.test(prose)) tags.add('deadlock');
    if (csp || /\bFDR\b/.test(prose) || reached.some((f) => f.endsWith('.csp')) || /^\s*\/\/@csp\b/m.test(text)) tags.add('FDR');
    if (/quick fix/i.test(prose)) tags.add('quick fix');
    if (!csp && reached.some((f) => f.endsWith('.pj') && f !== file)) tags.add('imports');
    if (!csp) for (const [re, tag] of FEATURE_TAGS) if (re.test(codeOnly(text))) tags.add(tag);

    const isMain = !csp && /\bvoid\s+main\s*\(/.test(codeOnly(text));
    entries.push({
      id: file,
      title: note.title ?? (csp ? `${prettify(stem)} (CSPm)` : prettify(stem)),
      description,
      category,
      tags: [...tags].sort((a, b) => TAG_ORDER.indexOf(a) - TAG_ORDER.indexOf(b) || compare(a, b)),
      dir,
      files,
      open: files[0],
      entry: isMain ? files[0] : null,
    });
  }

  const categoryOrder = CATEGORIES.map((c) => c.id);
  const startRank = (id) => (START_ORDER.includes(id) ? START_ORDER.indexOf(id) : START_ORDER.length);
  entries.sort((a, b) => categoryOrder.indexOf(a.category) - categoryOrder.indexOf(b.category) || (a.category === 'start' ? startRank(a.id) - startRank(b.id) : 0) || compare(a.title.toLowerCase(), b.title.toLowerCase()) || compare(a.id, b.id));
  const used = new Set(entries.flatMap((e) => e.tags));
  const categories = CATEGORIES.filter((c) => entries.some((e) => e.category === c.id));
  return {
    format: GALLERY_FORMAT,
    version: version ?? null,
    categories,
    tags: TAG_ORDER.filter((t) => used.has(t)),
    featured: FEATURED.filter((id) => entries.some((e) => e.id === id)),
    entries,
    sources: Object.fromEntries(Object.entries(sources).sort(([a], [b]) => compare(a, b))),
  };
}

/** Repository paths of every program the gallery must hold: each .pj and .csp file outside the standard library headers. */
export function galleryCandidates(root) {
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(path.join(root, dir || '.'), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.name.startsWith('.') || EXCLUDED_DIRS.some((x) => rel === x || rel.startsWith(`${x}/`))) continue;
      if (entry.isDirectory()) visit(rel);
      else if (/\.(pj|csp)$/.test(entry.name)) out.push(posix(rel));
    }
  };
  visit('');
  return out.sort(compare);
}
