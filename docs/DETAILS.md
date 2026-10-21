# processj-lsp in detail

The long version of the [README](../README.md): what every feature does, how it works, and the numbers.

A language server for [ProcessJ](https://github.com/mattunlv/ProcessJ), the CSP-style
concurrent language from UNLV. It has its own full parser and formatter, drives the
real compiler for type errors, and adds static analysis for the concurrency rules the
compiler does not check.

## What you get

**A real parser with real error messages.** `src/parser` is a recursive-descent
parser written from the compiler's CUP grammar. It recovers from errors, so every
problem in a file is reported at once, and each message says what was expected,
what was found, and what was probably meant:

```
Unknown statement 'pa'; did you mean 'par'?
Missing ';' after the variable declaration
Missing '}' to close the block opened at line 12
'else' without a matching 'if'
Unknown statement 'retrun'; did you mean 'return'?
An alt guard must store the value: write 'v = c.read()'
'c.read' names a channel end; to read use '.read()' and to write use '.write(value)'
'proc' is not accepted by the current compiler; write the return type and name directly
```

Each of these carries a quick fix (code action): change `pa` to `par`, insert the
missing `;`, remove `proc`, add `v = ` before a bare read guard. The compiler's own
"Syntax error" line is suppressed when the parser has a better message for the
same problem.

The parser is tested against the compiler's own. The compiler's `-showTree` flag
prints the tree its CUP parser built, before any checking, and
`scripts/parse-diff.js` compares that tree with ours item by item and reports any
file that only one side rejects. `node scripts/parse-diff.js <files or dirs>` runs
it on real programs (the compiler's tests and every example and fixture here
agree), and `--fuzz=N --seed=S` adds seeded generated programs that stress
precedence, casts, member chains, channel operations and every statement and
declaration form, plus one-token near misses that both parsers must reject.

**A formatter.** `textDocument/formatting` prints the parse tree back in a
canonical layout: 4-space indent, braces on the header line, spaces around
operators, `chan<int>` without inner spaces, one field per line in records,
protocol cases on one line, short alt bodies inline. Comments are kept, blank lines
are preserved up to one (only where the source really had one), and user parentheses are never added or removed. A file
with syntax or lexer errors is left alone (you get a message saying which error to fix
first; printing a tree that skipped an illegal character would delete it). The formatter is idempotent and never changes the parse tree; both are
checked over the compiler's example corpus in `test/format.test.ts`.

**A type checker.** `src/checker` resolves every name to its declaration and
types every expression, using the declarations of the file, its imports, and the
standard-library headers (all parsed with the same parser). It reports what the
compiler's own checker misses or gets wrong, with messages that name the
problem and, where possible, carry a quick fix:

```
Cannot find 'cuont'; did you mean 'count'?
Cannot initialise 'j' (int) with a value of type long (long does not fit in int without a cast)
No version of 'show' accepts (string, string): argument 2 ('n') needs int. Available: void show(string s, int n)
No version of 'reader' accepts (chan<int>) (pass an end of the channel: '.read')
No version of 'sharedReader' accepts (chan<int>.read) (declare the channel 'shared chan<int>')
'in' is a read end (chan<int>.read); it cannot write
Writing string to 'c', which carries int
'reason' belongs to case quit of Msg, but here 'm' is known to be case 'move' (fields: dx, dy)
'mvoe' is not a case of protocol Msg (cases: move, quit); did you mean 'move'?
'main' must return a value of type int
A constant can only be initialised with literals and other constants; this ProcessJ build computes it before the procedure runs, so the value would be 0 (or the build fails in a non-suspending procedure)
```

Rules follow what the generated Java actually does: Java widening (`byte` to
`int` to `long` to `double`, with int literals allowed into `byte`/`short`/`char`),
records narrow when they `extends`, protocols widen when they `extends`
(`protocol Message extends Santa_msg` is the union), channel elements are
invariant for primitives and follow the end's direction for records and
protocols, `shared read chan<T>` shares only its read side, overloads pick the
most specific applicable procedure, and a protocol variable is narrowed to its
case inside `switch` and `if (m is tag)`. Hover shows the type of any expression.

Run over the compiler's own example programs, the checker finds two genuine bugs
in them (`fullAdder.pj` writes to an end declared as read-only and hands one read
end to two processes; `integrate.pj` calls a misspelled `prlongln`); the test
suite pins exactly those.

**Diagnostics from the real compiler.** On open and save (or on every edit with
`checkOnChange`), the file is run through `ProcessJc` in an isolated temp
directory. Name errors get token columns, type errors get the line and are
narrowed to the quoted identifier, and a compiler crash becomes a diagnostic
carrying the exception. Compiler messages are hidden on lines where the checker
already reported something more specific.

**Concurrency lints, computed from real scopes and types in the same walk.** Each
recreates a check the compiler is missing, has disabled, or gets wrong, and says
why:

| code                       | what it catches                                                                 |
| -------------------------- | ------------------------------------------------------------------------------- |
| `pj/parallel-usage`        | a variable written in one `par` branch and read or written in another (the compiler's ParallelUsageCheck pass is switched off) |
| `pj/shared-channel-end`    | a non-`shared` channel end used in two branches of a `par`, per side (`shared write chan<T>` still leaves one reader); quick fix adds `shared` and propagates it to the parameters the end is passed to |
| `pj/shared-unlocked-end`   | a `shared` channel operated by two processes without the runtime's lock. The generated code claims `claimRead`/`claimWrite` only for a parameter declared `shared chan<T>.read/.write`, never for an operation written on the channel variable, so the processes share the runtime's single reader/writer slot and the program can hang |
| `pj/channel-direction`     | `in.write(..)` on a `chan<T>.read` end, or chains like `c.read.write(..)`          |
| `pj/channel-write-type`    | `c.write("hi")` on a `chan<int>` (the compiler never type-checks writes)           |
| `pj/channel-no-writer`     | a channel read in a proc that never writes it or passes it on: blocks forever      |
| `pj/channel-no-reader`     | a channel write in a proc that never reaches a reader or passes the channel on     |
| `pj/channel-self-deadlock` | both ends of a channel used by the same sequential process: the first use blocks forever |
| `pj/par-deadlock`          | straight-line par branches for which every legal channel-pairing order gets stuck (crossed order, missing peer): bounded rendezvous proof. Any call to a procedure with a body makes its branch opaque, since the callee may diverge, so the proof is deliberately narrower than the branches it can see |
| `pj/par-for-body`          | a `par for` body with several statements: each one becomes its own process, so they run in parallel rather than in sequence and a local declared in one is not visible to the others. Wrapping the body in an inner block makes each iteration one process |
| `pj/timeout-deadline`      | `t.timeout(1000)` with a constant: the argument is the absolute millisecond to wake up, not a delay, so it returns immediately. Quick fix rewrites it to `t.read() + 1000`, in an `alt` guard too (this compiler builds a timer read there) |
| `pj/starving-loop`         | an infinite loop with no communication, sync, timeout, alt or par: the cooperative scheduler never runs anyone else |
| `pj/pri-alt-skip`          | `skip` before other guards in a `pri alt`: those guards can never be chosen |
| `pj/barrier-not-enrolled`  | `sync()` on a local barrier nothing enrolled on: returns immediately              |
| `pj/assign-in-condition`   | `if (b = true)`: assignment where a comparison was meant                            |
| `pj/unreachable`           | code after `return`, `break`, `continue` or `stop` in the same block               |
| `pj/trivial-par`, `pj/trivial-alt` | a `par` with one branch, an `alt` with one guard: nothing concurrent happens   |
| `pj/multiple-alts`         | a second replicated `alt` (`alt (int i = 0; ...)`) in the same generated process cannot be built (its guard lists are declared twice); any number of plain alts, with one replicated alt among them, builds, and so does one replicated alt per par branch |
| `pj/read-placement`        | a channel read inside `?:` or inside a write's value; it must be its own statement (quick fix hoists it) |
| `pj/call-as-condition`     | a bare call as the whole `if`/`while` condition; compare its result (quick fix adds `== true`) |
| `pj/compiler-limit`        | a feature this ProcessJ build cannot compile, at the point of use: a read of a channel-array element anywhere but `x = cs[i].read();` or an `alt` guard (arrays of channels themselves build and run: `new chan<T>[n]` in a declaration, element ends passed as arguments, `chan<T>[]` parameters, direct writes), a channel array created by an assignment after its declaration (it builds, but every element stays null and the first use throws), variables holding a channel end, `claim`, `chan<string>`, nested record literals, record/protocol literals anywhere but a declaration initialiser, protocol parameters, `is`, assigning `null`, `break`/`continue` anywhere inside a par branch, a loop with `break` inside a switch case, records/protocols that refer to themselves through fields, reading through a `shared chan<T>.read` parameter, a value-returning procedure that can suspend, `!` as a whole condition, a channel read inside an `alt` timeout guard (a timer read there, `t.timeout(t.read() + 100)`, builds and runs), and a second `par for` in one process. The program is fine; it just will not build with this compiler |
| `pj/needs-yield-annotation` | a procedure that suspends through calls or a `par for` scheduler boundary that the compiler's own yield walkers overlook (the compiler does mark ordinary communication in the body, a channel-end, barrier or timer parameter, `suspend`, or `main`); quick fix adds `[yield=true]` right after the parameter list. The server also adds it in its private copy before every compiler run, so Run works regardless |
| `pj/shadows-parameter`     | a local with the same name as a parameter (silently accepted)                      |
| `pj/unused`                | unused locals and parameters                                                        |
| `pj/missing-import`        | `println` without `import std.*;`; quick fix adds the import                       |

Yield propagation follows the exact overload selected by the checker, treats
`new mobile(...)` and `par for` as suspending, and follows imported callees in
each callee file's own import scope. That traversal is iterative, call-driven,
cycle-safe and capped at 128 body-bearing imported files per snapshot; an
unreadable or budget-truncated body is treated as potentially yielding instead
of guessed from a same-named root overload. The quick fix replaces an existing
`[yield=false]` value instead of creating a duplicate;
when several local callers need the annotation, a second action repairs the
whole call chain. Compiler checks and Run apply the same augmentation only to
their private temporary copy—the editor buffer and imported sources are never
silently rewritten.

**Causal deadlock explanations and a concurrency model.** The checker keeps a
source-mapped model instead of throwing its analysis away after producing a
message. A confirmed straight-line rendezvous deadlock names every blocked
branch and attaches each wait as related diagnostic information, so an editor
can jump through the whole causal chain. The model contains procedures, mobile
processes, `par` spawn/join points, `alt` choices, channels, barriers and timers,
plus call/read/write/pass/sync/timeout edges. Every node and edge is labelled
`exact`, `conditional`, or `unknown`; uncertainty is displayed rather than
silently upgraded into a claim about runtime behavior.

When several peers are ready on one channel, the proof explores alternative
rendezvous choices instead of depending on source branch order. It emits the
exact deadlock only if every explored legal schedule is stuck; exceeding the
bounded state budget produces no claim. Missing peers and genuine circular
waits are classified separately.

This topology stays available as the `processj/concurrencyGraph` request. What
the editors show is the process network built from it, below.

**The process network, and where it gets stuck.** `src/graph` draws the program
the way CSP and occam users draw one by hand: a process is a box, a channel is an
arrow from the process that writes it to the process that reads it (labelled
`name : type`), a `par` is a container of its branches, a `par for` is one box
standing for ×N processes (the count when the bound is a constant, a `const`, or
a local assigned a literal just before; N otherwise), and a barrier is a node
joined by dashed links to the processes enrolled on it. A branch that calls a
procedure with a `par` of its own is drawn as that procedure's network, its
channel parameters bound to the caller's channels, so in `commstime.pj` the
arrows read `delta -a-> consume`, `delta -b-> succ -c-> prefix -d-> delta`, with
delta's two branches inside its box writing `a` and `b`. A callee without a
`par` stays one box; what it reads and writes comes from its transitive
parameter uses. Expansion stops at four levels, at a recursive call (drawn once,
marked recursive), and when a view would exceed about a hundred processes; a
collapsed call's own network is one view-switch away.

Two cases go further, as the translation does. An array of channels whose
length is known where it is declared (`new chan<int>[size - 1]` in `FIFO(6,
...)`) is drawn one channel per element, labelled `chans[0]`, `chans[1]`, and a
`par for` whose body uses its own elements of an array is drawn one box per
iteration (`i = 2` on the box's second line), not as one ×N box, so each
element is the arrow between the iterations that use it. An element picked by
an index only the run knows (`cs[k]`) is a dashed arrow to every element it
could be. A recursion through `par` whose arguments are known (`altFIFO(6,
...)` calling `altFIFO(size - 1, ...)` down to 1) is unfolded into nested
stages, each named by its known arguments (`size = 5`), its local channels too
(`middle (size = 5)`), so FDR's account of one stage lands on that stage. The
drawing unfolds at most eight stages below the first call; deeper ones are one
box (the model still checks every stage). A recursion whose arguments are not
known, or repeat, is drawn once, as above.

There is one view for the whole program (rooted at `main`) and one per
procedure, with its channel and barrier parameters as boundary ports, in
parameter order (a port's arrow carries the type; the port names the
parameter). Several writers or readers of one channel meet in a junction dot;
when every process in a box uses a channel the same way, one arrow leaves the
box's border instead of one per process. A process drawn as a container (it runs
a `par`) whose own code also communicates, before, between or after its pars,
gets a small `own code` box inside it for those operations, so delta's read of
`d` arrives at delta's own code and an arrow on a border always means every
process inside. A side with no partner drawn ends in a `no writer` / `no reader`
stub, red when the checker proved it. Branches are named after their owner when
numbers repeat: `branch 1 of delta`, `branch 2 of branch 1`, `branch 1 of par at
line 7`. Counts are of processes, not boxes: a `par for` box counts each
iteration.

Arrows use the repository's certainty vocabulary. Solid is exact: it runs
whenever its process gets there (a loop whose first test is a known `true`
counts). Dashed is conditional: under an `if`, a loop or `par for` that may not
run (a count of 0, or an unknown first test), a `switch`, an `alt` guard, the
right of `&&`, after a statement that may leave its block early (`if (k > 3)
return;`, a `break` or `continue` under a condition), after a loop that only a
`break` ends (`while (true)`), and everything inside a callee that is called
under such a condition. Dotted is unknown: through an unresolved or bodiless
call. Inline branches show their code (`c.write(1)`, `then d.read()`); a `par
for` body with several statements is drawn as one process per statement,
because that is what the code generator makes of it. An end kept in a local
(`chan<int>.write w = c.write;`, which the compiler rejects) is drawn as that
channel's end.

Barrier links follow the runtime, which counts enrolled processes rather than
recording them: the process that declares a barrier is enrolled from the start,
and a `par enroll` enrolls each of its branches (a branch that runs a `par` of
its own counts once, as the container). A process that syncs without being
enrolled (no `par enroll`, or a nested `par` that does not enroll its branches)
gets an amber dotted `not enrolled` link and a note in the barrier's details: its
syncs do not wait for the enrolled ones as the code suggests, and with nothing
enrolled each returns at once. Through a barrier parameter, the caller decides,
so a procedure's own view marks nothing.

Every box carries the spawn-site path of `src/verification.ts`, every arrow its
channel's declarator and owner, and every operation its statement span. That is
how verification results land on the drawing: the checker's own proofs, and
FDR's counterexamples (below).

*The verification overlay.* Results arrive as `VerificationReport`s. The
checker's report is built from what it has proved, and says so: every
straight-line par deadlock (`pj/par-deadlock`) becomes a failed deadlock check
listing each branch, the operation it waits on, why its partner never comes
(finished, waiting on something else, or missing) and every circular wait among
the branches; its summary blames only the waits nothing can meet any more
(`nothing can still read 'c'; branch 2 waits on branch 3`), and a finished
branch is named as the partner only when it did the other side of that channel.
Every `pj/channel-no-writer`, `-no-reader` and `-self-deadlock` becomes a "this
read (or write) waits forever" check, shown as `waits forever`: it proves one
operation stuck, not the whole program. Static analysis has no trace, and never
reports deadlock freedom: no result is not a proof. A model checker publishes
its report through `publishVerification(uri, report)` (`src/graph/live.ts`): the
report is copied (a producer may keep adding to its own object and publish it
again), its `uri` must be the document's, and results are dropped when the
document closes. When both exist, FDR's comes first. The words on screen are the
producer's: a partner's `detail` is shown as given, and nothing it did not say
is added (no "its only reader"). In the viewer:

- the **verdict strip** has a chip per check (`✕ Deadlock freedom  deadlock
  after 18 steps  FDR · 28 states · 190 ms`), red for errors, amber for
  warnings, green when it holds; a procedure FDR checked on its own is named
  on its chip (`succ on its own`), a run that never ends while something waits
  for good reads `partial deadlock` (red, although termination itself is
  informational), and a value outside the modelled integers `out of the
  modelled integers`; **Terminates** says how the run fails to end: `runs
  forever` only for a run that repeats, else `gets stuck after 2 steps` or
  `runtime error after 4 steps`; a nondeterminism counts the steps the outside
  sees (`nondeterministic at the start`); a check that holds with something it
  does not cover is amber and says what (`holds, only in runs within 0..3`,
  `holds, the compiled program may differ`), and a click shows its note; a
  result whose run relies on what the model abstracts has a dashed amber ring,
  and when it is shown a banner says so and the panel opens with **What this
  run relies on**, the caveats in full; a chip opens its result on the view it is about (a
  procedure checked on its own opens on its own view); the page opens on the
  first error or warning, never on a result that only informs (a program
  meant to run forever does not terminate: its chip shows the run), and a
  failure published while the page is open opens itself, or pulses its chip
  when another result is on screen;
- at the end state, a process whose wait can never be met (its partner
  finished, is missing or is not ready) or that is part of a circular wait is
  the **root cause**: red outline, pulsing halo, red badge (`write a`, `alt: read
  x | read y`), a red arrow with a red arrowhead and a **stop marker** at the
  waiting end, and the reason beside it (`consume has terminated`, `no
  unfinished branch can still read 'c'`); a process only **waiting behind**
  another stuck one is amber, without the pulse, its badge and marker without
  words (the reason is the marker's tooltip), and a dashed `waits for` link
  joins it to the process it waits on when no arrow does; clicking a reason
  replays to the last step its partner took; a **finished** process fades with
  a check mark; a **circular wait** is a red band along the arrows that join
  its processes (a loop of its own where no arrow joins two of them, through a
  barrier or a shared side), with a callout naming it (`circular wait: branch 1
  → branch 2 → branch 1`; a long circle names calls by their first argument,
  `philosopher(0, …)`, or only counts its processes, and one process in a circle
  with each of several others is one callout); a **divergence** draws the arrows
  of its repeating steps in purple with `repeats forever: …`; a runtime error
  puts its message by the process in red (amber, led by the range, when it is
  a value leaving the modelled integers); a nondeterminism's internal choice
  is a blue badge on the process that makes it (`the choice (step 2)`); a
  reason names the process that never comes when there is one (`branch 3 never
  syncs on b`); in a run that repeats forever (the termination check), a
  process left waiting whose partner could still answer it is amber, not red:
  the run starves it, and the words say `left waiting`; `stuck` is kept for a
  process that can never go on (its partner finished or is missing, its par
  waits for such a branch, or it is in a circular wait);
- several instances on one box (the iterations of a `par for`, the processes of
  a collapsed call) are told once with a count (`3 of 4 stuck · write c`, `1 of 4
  done`, a reason `×3 · main waits for its par for to finish`), and a box is
  faded only when every instance it stands for has finished; the story groups
  them too (`worker(1), worker(2) and worker(3) are stuck at line 9 …`); a
  circle whose processes are all on one box is told on it (`3 circular waits
  among the iterations of par for …`);
- a result computed for an older version of the buffer is drawn faded and
  dashed, without motion, under a `Stale` banner;
- the **timeline** has a tick per step (internal τ steps dimmer, the steps of a
  divergence loop marked and replayed, a step the model's abstraction decides
  underlined in amber, its caveat in the step's text) and one more for the end
  state, named as the chip says (`stuck`, `loops`, `error`, `stops`), so the
  last step can be seen before the end; play, pause, step, start, end and
  speed (1.2 s a step at 1×); a value bubble travels along the arrow from
  writer to reader (from a port when the caller writes), the participants
  flash, and each process shows the line it last executed; the step's account
  is cut at two lines (a click shows it all);
- when FDR's run ends stuck, the timeline goes on after the trace with **how it
  locked** (red ticks after a `how it locked` mark), so a deadlock no longer
  appears all at once: one tick per stuck process, in the order each entered
  the wait it never leaves (just after the last step it took part in; one that
  took part in none first; ties in the report's order; processes drawn on one
  box that got stuck after the same step together). Each such step adds that
  process's red (or amber) outline, badge, stuck arrow, marker and reason to
  the ones before, draws its waiting arrow in, rings its box and, dashed, the
  partner it waits for, puts its line chip on the line it is stuck at, and
  says it in words, from the report only: `philosopher(1, …) is stuck at line
  28 after step 2: it waits to write true on right (p1f2), whose reader
  chopstick(p2f2.read, …) is itself waiting to read left (p2f2) for
  philosopher(2, …)`. Then a circular wait closes link by link (`↻1` … `↻6`,
  `Closing the circle, link 1 of 6: philosopher(0, …) waits for
  chopstick(p1f1.read, …) on p0f1`), its band growing along the arrows and its
  callout coming with the last link (`Circular wait: philosopher(0, …) → … →
  philosopher(0, …). main is stuck behind it. Nobody can move.`); where waits
  end at a partner that finished or never comes, a last step (`⊘`) tells that
  dead end (`Dead end: main can never read c at line 8: nothing in the program
  writes c. Nobody can move.`). A banner over the network names the step; the
  code pane marks the lines of the processes stuck so far, this step's first;
  the sequence chart lights up the lane's `stuck from here`; the state machine
  shows its process stuck once the replay has said so; an export at such a
  step carries its caption. A long circle closes a circle per step, and very
  many stuck processes are told one trace step at a time. The checker's
  results are proofs, not runs, and keep their end state alone;
- the **sequence chart** tab draws the counterexample as a message sequence
  chart, a lifeline per process (named so that two `branch 1` differ), its
  heads kept in view as it scrolls, `channel.value` arrows, barrier bars,
  internal steps as a dot with what they do (`starts branch 1 and branch 2`),
  `done` marks, a lifeline cut after the last step of a process that ended
  without one of its own (`ends`), `stuck from here` on the lifeline of each
  process stuck for good after the last step it takes part in (red from there
  on; a click replays how it locked to that process), each stuck process's wait as a dashed arrow
  toward the partner that never comes, and at the end a red cross where a
  process is stuck for good, an amber pause where a run that repeats forever
  only leaves it waiting, each label cut to its lane, following the timeline;
- the **code** pane highlights the current step's statements and, at the end,
  puts each line a process can never go on from in red with its explanation
  beside it, a line where one waits behind another (or is only left waiting)
  in amber, a line where the run relies on what the model abstracts dashed in
  amber (`assumed at step 2: the real program takes the skip guard only while
  in1 has no writer ready`), and a nondeterminism's choice in blue, showing
  first the line of a process stuck for good; clicking a line finds its
  process, clicking a process scrolls to its line;
- the **state machine** tab (below) shows the selected process's states;
- the side panel tells the story in sentences, the cause first: a runtime
  error or a loop, a wait nobody can answer (`branch 1 of delta is stuck at
  line 25 writing a: consume, the only reader of a (line 35), has already
  terminated`), a circle (`A circular wait: …`) and then who is in it, the
  processes stuck behind those, what keeps running, and last, a sentence each,
  the pars waiting for their branches and what has finished; a nondeterminism
  or a refused event starts with the producer's summary; processes are named
  as the producer names them (`a (line 9)`, `branch 1 of crossed(r1.write)`),
  and the same state is told once for all who are in it. It lists every
  process, channel or step the result names that this view does not draw, and
  shows the assumptions the producer made; a timeout, an error or a skipped
  check says that there is no counterexample to show.

*FDR on the graph.* After Check with FDR the server publishes what FDR found
about the document's current text as one report: every target's latest check of
this version (the program, and each procedure checked on its own), each check's
id prefixed with its target (`program/deadlock-free`, `proc:succ:11/no-runtime-errors`),
so checking a procedure never hides the program's result or the other way
round. Assumptions every target shares are listed once, the others under their
target (`succ on its own: ...`). An edit takes the report back (the results
describe text that is gone), and so does a change to a file its model was
translated from (an import, edited in the editor or on disk); closing the
document drops it. A check whose file changes while FDR runs is not shown as
current at all: no lens, diagnostic or graph; its message says the result is
about the text before the edit, and its report says so at its top and is not
opened. When a check finishes
(`fdrShowGraph: always`, the default; `onFailure` opens it only for a defect, a
partial deadlock or a runtime error) the graph opens on that check: a page already open for the document is
refreshed and moved to it (no second tab, and a message says so; a page in a
background tab or behind another window shows it when you switch to it, and
the message says that), otherwise a new page opens (live, or the file when the
client cannot open URLs or the live viewer is off), and VS Code opens or
reveals its panel. `always` shows the graph after every check, `never` never;
the text report (`.pjreport`) is always written, and opened whenever the graph
is not. Afterwards the procedure's lens shows the verdict (`FDR: deadlock (4
steps)`, `FDR: no deadlock, 28 states`, with what a proof does not cover:
`FDR: no deadlock, 11 states; the compiled program may differ`) and opens the
graph on the check it names; a verdict with nothing to show (`FDR: timed out ·
check again`, `FDR: not modelled · check again`) runs the check again, and an
edit brings back the lens that runs the check. Every `fdr/*`
diagnostic about a check has a code action, **Show in graph**, that opens the
graph on that check with the process it is about selected and its state
machine open (in a narrow window the details drawer stays shut), and hovering
a stuck statement says what FDR found there in a sentence or two, with the
caveats of the run and the last steps the process took (`How it gets here (4
steps in all): 2. philosopher(1, …) writes true on p1f1 (line 27); …`). The
hover is about the process whose own statement is under the cursor: a par
waiting for its branches is told on the par's first line, not on every
statement of its branches, and a statement nobody is stuck at has none. Real
reports count steps from 0 and the page labels them from 1. All of this is in
`test/graph-fdr-lsp.test.ts`, with refines replayed from recordings, and in
`test/fdr-graph.test.ts`, where recorded counterexamples of
`examples/par_deadlock.pj`, `examples/dining_philosophers.pj`, commstime's
`succ` and `par for` bodies of several statements must land on drawn boxes and
arrows with nothing left unplaced.

*A process's state machine.* Double-click a process (or **State machine** in its
details) for its communication state machine, read off the CSP model
(`src/csp/machine.ts`): one state per definition the translator generates for
the code that process runs (the procedure's own thread, or a par branch or par
for body, which run as processes of their own), so every state is a name FDR's
`--divide` answer can give; a box shows what the process does next there
(`write right`, `alt: read left | read right`, `wait for branch 2`), its line,
and the definition's name. The transitions are the references the generated
CSPm makes from one definition to the next, recorded as the bodies are
generated: what happens on the way (a guard, `[l < 1000000]`, `call
philosopher`, a runtime error), dashed when a condition the model leaves to FDR
decides it (it may never be taken); a transition that only repeats what its
state does is drawn without words. Points a process passes without waiting (an
entry, a loop head, a place two paths meet) are dashed boxes; `returns` and
`STOP` are the ends. A call is one transition of the caller (click its label
for the callee's machine). With an FDR result on screen the machine is the one
of the model FDR checked, and the states the process went through are numbered
in order, the way it came is marked, and at the timeline's cursor the state it
is in is outlined (at the end, the state it is stuck in, in red, with what it
waits for). A process inside a call is on that call's arrow, not at the state
the call returns to: the arrow is outlined (in red at the end), with where the
process is in the callee (`in send: waits to write 2 on out (c)`), and a click
on the call shows the callee's machine with the same run, the callee's state
FDR names marked. A branch that ran and was collected by its par reads
`finished, and collected by its par`. Without a result the machine comes from a
translation of the view's program or procedure; a program with more than 400
processes is not translated just for this (it would hold up the server): a
procedure's own machine then comes from a model of that procedure on its own,
which it says, and a branch's machine waits for Check with FDR. The machine
opens fitted to the dock while that keeps its words readable, else at its own
size scrolled to where the run is; **Fit** and **Actual size** choose. A `par
for` box picks its iteration from a list. **Export SVG** saves the machine as
on screen, with the run as a caption.

*Opening it.* From Neovim, `:ProcessJGraph` opens the viewer in your browser
(through `vim.ui.open`); `:ProcessJGraph markdown`, `svg` or `excalidraw` give
the other forms, and `:ProcessJGraphExport [all|svg|excalidraw|html|json]
[directory]` writes files (a relative directory is taken from Neovim's `:pwd`).
From Emacs, `C-c C-g` (`processj-show-graph`, with a prefix argument to choose
the form) and `C-c C-e` (`processj-export-graph`) do the same through eglot or
lsp-mode. In VS Code, **ProcessJ: Show Concurrency Graph** (or the
**Concurrency graph** lens) opens the viewer in a panel that refreshes on save
and when new results arrive, and **ProcessJ: Export Concurrency Graph** writes
files; the panel's own exports go through a save dialog. The panel learns of
new results from a `processj/verificationChanged {uri}` notification, which the
server sends only to a client that passes `verificationNotifications: true` in
its initialization options; a client that passes `graphPanel: true` gets
`processj/showGraph {uri, focus}` instead of a browser page whenever the graph
should open on a result (`focus`: `{ check, process? }`). The command
`processj.showConcurrencyReport` takes such a focus as its third argument
(`[uri, 'viewer', focus]`), and `processj/processNetwork` takes `focus` (the
page opens on it) and `machine` (one state machine: `{ target, ref, check?,
process? }`).

*The live view.* For editors without a webview, the server serves the viewer
itself: `node:http` on `127.0.0.1` and a random port, every path under an
unguessable token, requests with any other `Host` refused, no CORS headers, and
only content it generated. It starts on first use, closes with the server (or
as soon as `liveViewer` is turned off), and the page follows the buffer: it
refreshes over Server-Sent Events after edits and when a result is published,
keeping pan, zoom and selection; an update can carry a focus, which the page
then shows (the URL's `?check=...&process=...` does the same when it opens). A
browser keeps at most six connections to one
server and every open graph page shares this one, so a page lets go of its
event stream while it is hidden (another tab, a minimised or covered window),
checks in every 30 seconds instead (`ping`; a page that closes says so,
`gone`), and catches up when it is shown again, with any result it was asked to
show meanwhile; running `:ProcessJGraph` again opens another tab. A page whose
document is closed in the editor says so (a banner, a grey dot), keeps showing
how it was, and follows the file again when it is reopened. A
state machine is laid out when the page asks for it (`machine?target=...&ref=...`). A
source link asks the server to reveal the location in the editor
(`window/showDocument` with a selection), only for files the page was given
(including files a view laid out later links to). When the client cannot open
URLs, or with `liveViewer: false`, the viewer is written as a self-contained
HTML file in the report directory and opened as a file (its path is logged);
such a file carries the state machines it can show (those of the processes in
FDR's results and of the views it opens on, up to forty). A
file with no procedure with a body yet opens on a page that says so and
follows the buffer until there is one.

*The viewer.* Drag, or scroll on a trackpad, to pan; pinch or turn a mouse wheel
to zoom about the pointer. Keys: `+` `-` zoom, `0` fits, `1` is actual size, `/`
searches (it highlights the matches and zooms to them; Enter steps through them),
arrows pan, Tab and Enter move between boxes, space plays the timeline, `[` `]`
and the left and right arrows step it (while a replay is shown, Shift with
those arrows pans), Home and End jump to its ends, and Escape closes the details drawer,
then clears the selection, then the result. Hovering a box dims everything it
does not touch, the result's marks included; clicking one shows its kind,
source, call, parameters, the channels it uses with their partners and lines,
and its effects. The toolbar switches views and toggles channel labels, element
types and conditional arrows; a minimap appears when part of the network is off
screen. Below 90 % zoom the result's badges and reasons grow so they stay
readable. In a narrow window (a VS Code panel beside the editor) the details
panel becomes a drawer (**Details**), and the timeline dock can be resized by
its top edge or folded away. Opening a result frames the stuck processes with
what explains them (the arrows they wait on, their partners, stubs and ports),
or the whole view when that is readable. Exports: SVG of the current view at the
timeline's cursor, with the title, the verdict, the account and a legend; PNG at
2×; an Excalidraw scene; JSON; the sequence chart as SVG; and the state machine
shown as SVG. The page is one
file with inline CSS and script, makes no request except to its own live
server, follows the system or VS Code theme, honours reduced motion, and runs
only scripts carrying its nonce.

*Formats.* `<stem>.graph.svg` is a standalone light-themed SVG (no CSS custom
properties, so any SVG tool reads it) of the most important failure's view and
end state, with the plain-words account (and every caveat of the run) as a
caption and a legend of what it draws: a "where it deadlocks" figure for a
paper. `.graph.excalidraw` is the
same drawing as an Excalidraw scene: arrows bound to the shapes they join, each
container grouped with its contents so it drags as one, the verdict and the
caveats in its title, and the result's notes where the SVG puts them (Excalidraw centres each
channel's name on its arrow, so a name can sit elsewhere than in the SVG).
`.graph.html` is the viewer; `.graph.json` holds the
model, its layouts and the results, written compactly (it is large on a big
program) and only when asked for by name: `all` writes the SVG, the scene and
the page. `:ProcessJGraph excalidraw` writes the scene next to the source too,
since it is for editing. Exports go next to the source file (a relative
directory is relative to its folder; an unsaved buffer needs an absolute one)
and never replace a file that processj-lsp did not write (each format carries a
generator marker); with nothing to draw yet, the pictures are skipped and the
page is still written. The Markdown report describes the network in words
(processes, a table of channels from writers to readers, barriers with who is
not enrolled, effects, results) with a Mermaid flowchart (unknown arrows dotted
and faint). The `processj/processNetwork` request returns the viewer's data (and
page) for other clients.

*Layout.* The Eclipse Layout Kernel's layered algorithm, through
[elkjs](https://github.com/kieler/elkjs) (EPL-2.0 or GPL-3.0-or-later), run in the
server process from its bundled build: left to right, nested pars laid out with
their parents so arrows between containers route well, orthogonal routing,
channel names as inline edge labels. Labels use a monospace stack, so their
width is known without a browser; they never overflow their box (a long one is
shortened with an ellipsis). Cycles are broken in source order before layout (so
a crossed pair reads branch 1, then branch 2), and boxes keep their source order
within a column (ports in parameter order); on the example corpus this
costs one arrow crossing in all. The same view always gets the same coordinates.
Views are built when they are needed: the program view, the views a result is
about, and the first procedures in source order up to the page's budget of 40
(a saved HTML file carries up to 200); any other one when it is opened. The
20,000-line program of the performance test has 1,293 views, all built in about
half a second; after an edit, an open page's refresh builds and lays out 40 of
them in about 0.2 s.

**Procedure effect summaries.** Each procedure gets direct and transitive
conservative “may” effects: channel read/write, possible suspension, `par`,
`alt`, barrier, timer and mobile-process behavior. Calls use the exact overload
chosen by the checker; channel parameter effects are substituted through call
sites and graph labels retain their one-based parameter positions; recursive
call components are solved to a fixed point without recursive
JavaScript traversal. An unresolved, native or unavailable callee makes the
summary partial rather than falsely pure. The compact summary is a code lens and
appears in hover; running the lens opens the evidence-oriented report.

**Protocol intelligence.** Protocol declarations are modeled as tagged unions
including inherited cases, declaration identity and ambiguous inherited tags.
Protocol switches are checked for missing cases and duplicate defaults. A
non-exhaustive switch has a quick fix that generates only the missing case
stubs. The server also records observed construction, send, receive, `switch`
match and `is` test sites. VS Code's **ProcessJ: Show Protocol Flow** visualizes
that structure and observed flow; the declaration code lens opens a portable
report in other clients. “Inferred transitions” are explicitly observations in
one procedure, not a session-type guarantee.

**Channel role hints.** One inlay per channel declaration or parameter summarizes
read/write direction, direct traffic, branch count, sharing, escape/unknown state
and proven hazards. The detailed tooltip explains what evidence is direct versus
transitive. Semantic tokens separately mark read targets, write targets, shared
ends, blocking operations and passed/escaped ends, allowing themes to distinguish
concurrency roles without recoloring ordinary variables.

**Concurrency-aware refactors.** Code actions validate a complete candidate by
parsing and checking it before offering the edit. They can extract selected
statements into a procedure with inferred parameters and channel-end direction;
wrap independent straight-line statements in `par` only after dependency and
rendezvous proofs; correct private channel-end signatures and exact in-file
callers; propagate the minimum required shared side through private callees; and
replace a narrowly proven one-producer/one-consumer `par` data race with a
rendezvous channel. When a proof is missing, the disabled action explains why
instead of guessing. Clients that support versioned workspace edits get the
document version on every action; pre-CodeAction-literal clients receive a
compatible command carrying the legacy edit shape, and stale diagnostic
requests are still rejected before an action is made. Refused actions are shown
with their reason when the client advertises disabled-action support.

**Run from the editor.** Code lenses above `main` offer **▶ Run** and
**Build** (Neovim also has `:ProcessJRun` and `:ProcessJBuild`; the graph viewer opens with `:ProcessJGraph` and the analysis reports with
`:ProcessJEffects` and `:ProcessJProtocols`). Run performs the whole `pjc` pipeline
(ProcessJc, `javac --release 8`, the two ASM rewrites, `java`) in a temp
directory, judged by exit codes rather than by grepping output, then opens a
report with the program's output. A program that never finishes is killed after
30 s and flagged as a probable deadlock.

**Convert to CSP and check with FDR.** A whole program (from `main`) or a single
procedure is translated into CSPm for the [FDR](https://cocotec.io/fdr/)
refinement checker, which checks deadlock freedom, runtime errors and
termination over every interleaving. FDR's answer comes back in ProcessJ terms:
each stuck statement gets a diagnostic saying why it can never complete ("this
write waits forever: consume, the only reader of a (line 35), has already
terminated"), also when the rest of the program keeps running ("this write
waits forever while ticker and sink keep running: nothing in the program reads
c"), the code lens above the checked procedure shows the verdict, and a report
tells the counterexample step by step, with where every process ended up and
any circular wait. See [Convert to CSP and check with FDR](#convert-to-csp-and-check-with-fdr).

**Semantic highlighting.** The server sends semantic tokens for every identifier,
classified from the parse tree and the checker's resolutions: procedure names,
records, protocols and their cases, fields, parameters, locals, constants
(`readonly`), standard-library calls (`defaultLibrary`), package names, and the
channel-role modifiers described above.
Keywords, literals and comments stay with the bundled syntax file. Neovim applies
the tokens on top of syntax highlighting automatically.

**Cross-file imports.** `import geom.*;` and `import lib.shapes;` resolve to files
next to the importing file, under the workspace roots, or under the install's
include directory (which is how `import std.*;` finds the standard library). A
wildcard import takes every `.pj` file under the package directory, sub-directories
included, exactly as the compiler's `ResolveImports` does. When an import was
found under a workspace root rather than next to the file, the compiler sandbox
links that package root in, so compiler diagnostics and Run see the same files
the checker did.
Imported declarations are typed, completed, hovered and navigable; an import that
resolves nowhere gets a warning saying where it looked. Only what a file imports
is visible to its checker; the workspace index is used for navigation and
auto-import candidates. Selecting an unimported workspace or standard-library
declaration from completion inserts the narrow import without disturbing the
existing package, pragma, or import header. Effect and yield analysis checks only
body-bearing files reached by exact calls, rather than eagerly checking the whole
workspace or standard library. Its transitive dependency set ensures an edit or
open-buffer overlay in a reached file invalidates every affected open importer.

**Navigation.** Completion is scope- and declaration-order-aware: an inner local
shadows the outer one, declarations below the cursor are not offered, and locals
from another overload never leak in. It also includes imported procedures,
records, protocols and constants; keywords with explanations; snippets for
`par`, `alt`, `chan`, ...; and type-directed members (`p.` gets record/protocol
fields while a channel end gets only the operations its direction allows).
Unimported workspace candidates are prefix-filtered and capped at 200 per
response; an incomplete result asks the editor to narrow/requery instead of
allocating the entire workspace on every keystroke.

Hover shows expression types, signature help presents overloads, and go to
definition reaches workspace and standard-library declarations. References,
rename, and document highlights follow checker identities for shadowed locals
and the exact selected procedure overload rather than text-matching equal names;
ambiguous fields, cases, recovery-only symbols, and qualified-name cases fail
closed instead of risking an unrelated rename. Fuzzy workspace-symbol search,
document outline, and folding complete the navigation surface.
Local and parameter renames reject duplicate declarations and changes that would
make either renamed references or existing references bind to another variable;
renaming a procedure, record, protocol or constant is refused when the new name
is already declared in an affected file or a local in a procedure that uses it
would capture a reference.

**Examples.** `examples/` holds one short program per diagnostic (and two clean
ones); each announces the codes it produces on its first line and
`test/examples.test.ts` checks that. They double as a tour of what the server
catches.

## Convert to CSP and check with FDR

`src/csp` translates ProcessJ into CSPm for [FDR4](https://cocotec.io/fdr/) and
reads FDR's answers back in ProcessJ terms.

| | Neovim | VS Code | Emacs |
| --- | --- | --- | --- |
| convert to CSP | `:ProcessJCsp` or `:ProcessJCsp delta` | **ProcessJ: Convert to CSP** (pick the program or a procedure) | `M-x processj-convert-to-csp` |
| check with FDR | `:ProcessJFdr` or `:ProcessJFdr delta`, or the **FDR: check & show graph** lens | **ProcessJ: Check with FDR**, or the lens | `M-x processj-check-with-fdr` |
| stop a running check | `:ProcessJFdrCancel` | **Cancel** on the check's notification, or **ProcessJ: Cancel FDR Check** | `M-x processj-cancel-fdr` |

The server commands are `processj.convertToCsp` and `processj.checkWithFdr`,
with arguments `[uri, procedure?, line?]`: the whole program (from `main`) when
no procedure is named, otherwise that procedure on its own (`line`, the
0-based line of its name, picks an overload). `main` named on its own is the
whole program. A file with syntax errors is refused. Neovim and Emacs complete
procedure names after the command (from the server's document symbols).
`processj.cancelFdr` (`[uri?]`) stops the check running for a document, or every
check without an argument.

**Convert to CSP** writes `<file>.csp` (or `<file>.<procedure>.csp`) next to the
source, so it can be opened in FDR's own window or handed in, and opens it. The
file is meant to be read: a header lists the integer range, every abstraction
and every warning; each definition is preceded by the statement it stands for.
A file of that name that processj-lsp did not generate (it does not start with
`-- Generated by processj-lsp from`) is never overwritten: the model then goes
to the server's private report directory, and a message says so. Neovim's
built-in `csp` filetype highlights the file, and the server attaches to it: its
graph and FDR's results on it are described in
[Graphs and FDR for .csp files](#graphs-and-fdr-for-csp-files).

**Check with FDR** converts (and so also regenerates the `.csp` next to the
source), runs FDR's `refines --divide` on a private copy of the model, and then:

- puts a diagnostic (source `fdr`) on every stuck statement: `fdr/deadlock`
  (Error) on each write, read, alt guard or barrier sync that waits forever,
  saying which process could have answered it and why it cannot, with related
  locations for the other processes of a circular wait and the last steps the
  stuck process took; `fdr/partial-deadlock` (Error) on an operation that waits
  forever while other processes keep running (a server loop, say), found in the
  run the termination check reports; `fdr/runtime-error` (Error) at the
  statement of a runtime error; `fdr/range` (Warning) where a value leaves the
  modelled integers (the model's limit, not an error of the program: the run
  is not followed past it); `fdr/divergence` (Warning) on a loop that runs
  forever without communicating; `fdr/nondeterminism` (Information) on the
  checked procedure; `fdr/assertion` on `main` when the program does not
  terminate (Information, only when nothing else failed) and on the `//@csp`
  comment of one of your own assertions that fails (Error); `fdr/spec-error`
  (Error) at the line of your own CSPm that FDR rejects; and `fdr/not-modelled`
  (Warning) where a construct the model cannot express is. A procedure checked
  on its own says so (`FDR (delta on its own): ...`), and the same message from
  two checks is shown once. A stuck statement in an imported file is shown at
  the branch or call of this document that leads to it, with the imported
  statement as related information. Each one about a check has the code action
  **Show in graph**, and hovering a stuck statement explains it (see *FDR on
  the graph* under [What you get](#what-you-get)). They are dropped as soon as
  the buffer changes;
- replaces the lens above the procedure with the verdict (`FDR: deadlock (6
  steps)`, `FDR: partial deadlock (2 steps)`, `FDR: no deadlock, 1,204
  states`), which opens the graph on that result; the lenses (above `main`
  **FDR: check program & show graph**, above other `void` procedures **FDR: check & show graph**) appear
  only when `refines` is installed, and `codeLens: false` hides them like the
  others;
- publishes the results to the graph and, when a check fails, opens the graph
  on it (`fdrShowGraph`, described under the graph above), refreshing a page
  already open for the document instead of opening another;
- writes a report (`.pjreport`) with a table of the checks (verdict, states,
  transitions, time) and, for each counterexample, where every process ended
  up, the circular waits and every step, and opens it when the graph is not
  shown; the same report as JSON (`src/verification.ts`) is written next to
  it;
- reports progress while FDR runs, one step per assertion, and stops `refines`
  (its whole process group) when the check is cancelled, when a newer check of
  the same file starts, after `fdrTimeoutMs`, once it uses more memory than
  `fdrMemoryMb` (a big model can take tens of gigabytes within seconds; the
  memory is not watched on Windows), or when the server shuts down. VS Code shows the check as a notification with a
  **Cancel** button (the lens too); Neovim and Emacs have the cancel commands
  above.

With `fdrWorkers` at its default of one, `refines` finds the same deadlock and
runtime-error counterexample every time a program is checked, so a check run
again tells the same story about them. The setting does not govern the
divergence search behind **Terminates** (`SKIP [FD= MAIN \ Events`) or the
determinism check: their counterexamples can differ from one check to the next
(five checks of `examples/dining_philosophers_fixed.pj` gave runs of 6, 9 and
14 steps that repeat forever, each a different set of processes looping). `0` uses every core, which is faster on big models.

The command returns `{ reportFile, jsonFile, cspFile, report }`, and the
request `processj/fdrReport` (`{ textDocument: { uri }, procedure?, line? }`)
returns the latest report of one target for the current text of a document
(`line` picks an overload); the graph shows every target's at once. The
notification `processj/fdrReportChanged` (`{ uri, target? }`) says that a report
was stored (`target`: `{ kind: 'program' }` or `{ kind: 'procedure', name, line }`)
or that a document's reports were dropped after an edit (no `target`), so an
open viewer can ask again. Programs use the same functions without an
editor: `checkWithFdr()` and the pure `explain()` in `src/csp/index.ts`, and
`node scripts/pj2csp.js file.pj [--proc name] --check [--json]` prints the
report in a terminal (`--out file.csp` keeps the model; it exits with 1 when a
check fails and with 2 when anything was not checked). `node
scripts/fdr-validate.js [dirs or files]` checks the whole corpus with FDR, builds
and runs every program with the real compiler, and compares the two (see
[Validated against the real runtime](#validated-against-the-real-runtime)).

**Finding FDR.** The `fdrPath` option when it is set (the `refines` executable,
a command name looked up on PATH, or FDR's install directory; it is then the
only place tried), otherwise `$FDR_REFINES`, `$FDR_HOME`, `refines` on PATH,
`/Applications/FDR4.app/Contents/MacOS/refines`,
`~/Applications/FDR4.app/Contents/MacOS/refines`, `/opt/fdr/bin/refines`,
`/usr/local/fdr/bin/refines` and, on Windows, `C:\Program Files\FDR4\bin\refines.exe`.
When none is found, Check with FDR says where to get FDR and how to set
`fdrPath`, no FDR lens is shown, and Convert to CSP still works.
`:checkhealth processj-lsp` reports which `refines` Neovim's server will use.

**What is checked.** For a program (`MAIN`):

| check | assertion | holds when |
| --- | --- | --- |
| Deadlock freedom | `PJ_NOERR(MAIN) :[deadlock free [F]]` | the program never reaches a state where nothing can happen before it has finished. `PJ_NOERR` turns termination and a runtime error into an endless `pj_done`, so neither counts as a deadlock |
| No runtime errors | `PJ_SAFE [T= MAIN` | no run raises a modelled error (`pj_error`): division by zero, an array index outside the array, a field read through `null`, an alt whose preconditions are all false, or an integer outside the modelled range. The last is the model's limit, not an error of the program: it is reported as a warning (`FDR: integers out of range`), and the other checks then cover only the runs that stay inside the range, which their verdicts say |
| Terminates (informational) | `SKIP [FD= MAIN \ Events` | every run finishes: it never gets stuck and never runs forever. A server fails this by design; when the run FDR reports leaves a process waiting forever beside the ones that keep running (a write nothing will ever read), that process is shown as blocked and its operation gets an `fdr/partial-deadlock` diagnostic |

For a procedure checked on its own (the process named after it), every channel
parameter gets a channel of its own that FDR's environment (standing for any
caller) may use freely, every barrier parameter a barrier nobody else is
enrolled on, and the data parameters are the first event (`pj_call.3`), so each
check covers every value of the modelled range and a counterexample starts
with the values it needs; a value-returning procedure ends with its result
(`pj_result.10`). Its checks are deadlock freedom and no runtime errors as
above, divergence freedom (`(P \ PJ_LOCAL) :[divergence free]`: it never loops
forever without communicating with its caller) and determinism
(`(P \ PJ_LOCAL) :[deterministic [F]]`, informational: after the same events
its caller sees, it always accepts and refuses the same things; an alt's choice
or an abstract value can make it nondeterministic). `PJ_LOCAL` holds the
procedure's own channels and barriers: what its branches say to each other is
not communication with the caller, so branches that talk to each other forever
are a divergence. They stay visible in the process itself, so a specification
can name them. A procedure that runs forever is deadlock-free as long as it
keeps talking.

**Procedures whose arguments decide their network.** Some data parameters
decide what the network of a procedure is, not just what it computes: the
length of a channel array (`new chan<int>[size - 1]`), the bounds of a par for
(`i < size`), the arguments of a recursion through par (`altFIFO(size - 1,
...)`), the index of a channel-array element (`chans[i]`), a condition that
decides which of those happen (`if (size <= 1)`), or an argument that becomes
such a parameter of a callee. The network must be laid out before FDR runs, so
"every value" cannot be given to these. A procedure checked on its own takes
them from its calls instead: the whole program is elaborated from `main`, and
every call of the procedure from outside it (not its own recursive calls) gives
the values elaboration knows there. Each distinct tuple is one instance with a
network of its own (`PJ_RUN_1`, `PJ_RUN_2`, ...), the instances are the
alternatives of the first event (`foo = (pj_call.0.6 -> PJ_RUN_1) [] (pj_call.1.6
-> PJ_RUN_2) [] ...`), so every check covers every instance and a
counterexample starts with the call it is about (`foo is called with i = 5,
size = 6`). A channel-array parameter is given fresh channels (a CSPm channel
named after it, `chans.k`) of the length its calls give, each a channel of its
own for the network, the explanation and the graph. The other data parameters
keep "every value". In `test/fixtures/fifo/blocks.pj`, `altFIFO` is checked with
`size = 6` (the call at line 75: six stages, unfolded), `FIFO` with `size = 6`
(the call at line 69), and `foo` six times, with `i = 0..5`, `chans` of length 5
and `size = 6` (the call in FIFO's par for); `id`, `producer` and `consumer`
have no such parameter and are checked as before. The integers are widened to
hold the arguments (`-2..6` for `altFIFO`), so a buffer's data ranges over
more values: `altFIFO(6)` and `FIFO(6)` take about 45 s with one FDR worker,
nearly all of it the determinism check.

The report, the lens, the diagnostics and the graph say which arguments were
used: the report's `Checked:` line and first assumption (`altFIFO checked
with size = 6 (the call at line 75)`), every check's `target.arguments` in the
VerificationReport (`size = 6`), the verdict lens (`FDR: no deadlock, 615,849
states · size = 6`), the editor message and each diagnostic (`FDR (altFIFO on
its own, size = 6): ...`). A procedure's own view in the graph is drawn with
the arguments every instance shares (a note says so: `Drawn with size = 6`),
so FDR's processes land on their own boxes (the six stages of `altFIFO(6)`)
and a channel-array parameter's channels are ports of their own
(`chans[0]` ... `chans[4]` for `foo`); an argument that differs between the
instances (`foo`'s `i`) is left open there.

Without a call that fixes them, these parameters take every modelled value for
which elaboration ends (the integers of the inferred range, a channel array
every length from 1 to the top of the range), each value an instance of its
own, and the report says so (`chain checked with size = 0..2 (3 instances, each
checked; no call in the program fixes size: ...)`). A procedure whose model
with every value is already complete (a par for whose bounds are computed at
run time covers every value by itself) is checked that way, as before. Only
when no value elaborates (a recursion that never stops) is it not modelled, with
the reason and what to do: call it from `main` with concrete arguments, or name
them with a directive above the procedure:

    //@csp check altFIFO(6)
    //@csp check foo(i = 0, chans = 5, size = 6)

The arguments are the data parameters in order (a channel-array parameter by
its length), or named (`name = value`); several directives give several
instances, and they take the place of the calls. A wrong argument is a warning
and the directive is ignored. A call or directive whose value lies outside a
range set with `//@csp int` or the settings is not checked, with a warning.

**The model, construct by construct.**

| ProcessJ | in the model | faithful? |
| --- | --- | --- |
| `c.write(e)`, `x = c.read()` | `c!e`, `c?x`: synchronous rendezvous; reads nested in expressions are lifted in Java's evaluation order, so `x > 5 && d.read() > 0` reads `d` only when `x > 5` | exact for the language; this ProcessJ build performs every read of an expression before evaluating it, `&&` and `\|\|` included, which is named where it matters (`compiler/short-circuit-read`, `test/differential/short_circuit_read.pj` hangs) |
| `x = c.read({ B })` | the reader runs `B` and then sends `c__ack`; the writer waits for it | exact |
| a channel with no possible partner anywhere | the operation blocks forever (it is synchronised with `STOP`), as at runtime | exact |
| `par { B1 ... Bn }` | every branch is a process of a fixed network, started together by one hidden fork event and collected by hidden join events; a `par` in a loop reuses its processes. The fork carries what the branches need from the parent, and a branch takes only the values its parent in that procedure instance can send (`pj_forkset_…`): what elaboration knows there, any value of the type otherwise. No process of the network ends in `SKIP`: the program ends when the root (`main`, or the checked procedure) ends (`[\| {pj_end} \|> SKIP` around the network; a network of one process just ends), which keeps FDR from paying 2^n for n processes that end | exact |
| `par for (int i = a; i < b; i++)` | one process per iteration value. Bounds that elaboration knows (constants, or arguments known where the procedure instance is created: `i < size` in `FIFO(6, ...)`) give exactly those iterations; bounds computed at run time give a process for every modelled integer, and those outside the bounds of a run take part in its fork and join only (the explanation leaves them out). An iteration whose value is outside the modelled integers is a range error | the language; this ProcessJ build runs each statement of the body as its own process (`pj/par-for-body`), and never ends a par for that runs no iteration (`compiler/empty-par-for`) |
| `chan<T> cs[] = new chan<T>[n]` (or `chan<T>[] cs`), `cs[i].write(v)`, `x = cs[i].read()`, `f(cs[i].read)`, `f(cs)` with a `chan<T>[]` parameter | one CSPm channel for the array, its first field the element (`FIFO_chans.2`). Each procedure instance's length must follow from constants and the call's arguments (static elaboration); each element is a channel of its own for the network, the source map (`chans[2]`, `ChannelRef.index`) and the graph. An index elaboration knows picks the element; one computed at run time is a CSPm expression, after Java's bounds check (an index outside the array is a runtime error, as the `ArrayIndexOutOfBoundsException` that stops the real process), and the process is a user of every element it may pick. Not modelled, each with its reason: arrays of more than one dimension, array literals of channels (`{ a, b }`), an array assigned after its declaration, a length only the run knows, an element with a run-time index handed to a par branch, and channels of an array that need an acknowledgement or a server. A channel-array parameter of a procedure checked on its own is given fresh channels of the length its calls give (see above) | exact; this ProcessJ build cannot compile a read of an element anywhere but `x = cs[i].read();` or an alt guard, and leaves the elements null when the array is assigned after its declaration (`pj/compiler-limit`) |
| conditions on known values | while the network is elaborated, a condition on parameters no statement changes and on par for iterations is decided per instance (`if (i == 0)` in iteration 0): the code on the other side is not a use of its channels there. The generated CSPm still tests it, with the same values | exact |
| recursion through `par` | unfolded into a finite network when every data argument of each recursive call is known during elaboration and the unfolding stops (`altFIFO(6)` is six stages); a recursive procedure's local channels carry its instance (`altFIFO_middle.3`), so the stages never share one. Unknown or repeated arguments (repeated arguments do not tell how deep it goes, even when data read at run time stops it), more than 200 levels or more processes than the budget (2,000) leave the program not modelled, with the reason. The stages are named by their known arguments in the explanation (`altFIFO (size = 3)`, `id of altFIFO (size = 3)`) | exact |
| channels and barriers declared in a `par for` body | one per iteration: iterations never synchronise on each other's, and the explanation keeps their partners, circles and barrier counts inside one iteration | exact |
| shared channel ends | several writers (or readers) interleave and meet the other side one at a time; when one process both writes and reads a channel others use too, a small server (`PJ_MED`) hands each value to one reader | the language (locked ends); `pj/shared-unlocked-end` is named when this build does not lock an end |
| `barrier b`, `par enroll (b)`, `b.sync()` | a counter per barrier (`PJ_BAR`) that follows the runtime's `PJBarrier`: declaring enrolls one process, `par enroll` hands the parent's enrollment to its branches, a branch that ends resigns, a sync completes when the last enrolled process arrives | exact, including that a resignation never completes a barrier: processes already waiting when the last other branch ends stay blocked (verified on the runtime) |
| `alt`, `pri alt` | a choice between the ready guards; `(cond) && g` is `cond & g`; `skip` and timeout guards are hidden events that may be taken at any moment; replicated alts are `[] i : S @` | an over-approximation: the runtime takes the first ready guard in source order, the model any ready one (every runtime choice is a model choice). A `skip` written first with no precondition is exact. All preconditions false is a runtime error, as in the runtime; a replicated alt's preconditions that use its index are evaluated per index, which this build does not do (`compiler/replicated-alt-precondition`: it evaluates them once, before the index loop) |
| timers | `t.read()` is an abstract value, `t.timeout(x)` a wait of any length | abstract: time is not modelled (`pj/timeout-deadline` is named) |
| `byte`, `short`, `char`, `int`, `long` | one range `Int_t`; a value stored or sent outside it is a range error. A value that never decides anything (below) is saturated instead | abstract range, never a silent wrap; `/`, `%`, shifts and casts follow Java |
| `boolean` | `Bool` | exact |
| records, protocols | one datatype per family linked by `extends`; a protocol case is a constructor | values: a change through one variable is not seen through another referring to the same record. Where that can matter it is named (`model/aliasing`): a field or element stored through a variable that may share its object (assigned from another variable, a field, an element or a read, put into another array or record, or sent on a channel), and a call to a procedure that changes its record or array parameter (itself or through a procedure it hands it to) |
| arrays | sequences with a checked index | values, as records |
| `string`, `float`, `double` | one abstract value; a decision that depends on one is an internal choice (`\|~\|`) | abstract |
| loops, `break`, `continue`, labels, `switch` (with fallthrough), `return` | recursion and continuations; a loop that can go round without any event gets a hidden tick; `break blk` out of a labelled block or `if` leaves that statement | exact; this ProcessJ build cannot compile a `break` out of a labelled statement that is not a loop (`compiler/labelled-break`) |
| procedures | one definition per place a process can stop, named `<procedure>__<line>`, with the live variables as parameters; a value-returning procedure is a computation that hands its result on | exact |
| `println`, `print` | nothing | — |
| `longRandom()` and friends | any value of `Int_t` | abstract |
| `stop` | `STOP` | the language; this compiler ignores `stop`, which the model's warnings say |

The integer range covers the program's integer literals (`-1` included) and one
past each, at most 64 values (literals that do not fit are dropped with a
warning); a `//@csp int lo..hi` comment sets it. A literal in arithmetic on an
abstract value (`t.read() + 100`) does not count: the result is abstract too.

An integer that never decides anything is not range-checked: when no
condition, loop, `switch`, alt precondition, array index or size, divisor or
`par for` bound depends on it, and neither a checked procedure's caller nor
one of your `//@csp` specifications can see it (it is only passed on, kept in
variables or printed), its exact value cannot change any verdict. Such values stay exact
while they fit and otherwise become one extra value, `PJ_SAT` (shown as "a
value outside lo..hi"); anything computed from it stays `PJ_SAT`. The analysis
follows values through assignments, channels (every channel a value can reach
through calls counts as one), call arguments and returns; records, protocols
and arrays always stay exact. A pipeline that squares and adds up what it
passes on, or a server counting forever (`sharedchan.pj`), then checks without
a range error; a loop counter still needs its range (`commstime.pj` counts to
1000000). The model's header and the report's assumptions list the saturated
variables and channels.

Where a lint says the compiled program differs from the language
(`pj/par-for-body`, `pj/shared-unlocked-end`, `pj/shared-channel-end`,
`pj/timeout-deadline`, `pj/parallel-usage`, `pj/compiler-limit`, ...), the
model follows the language and the lint is listed in the model's header and
the report's assumptions. The translator also names the miscompilations no
lint reports, each verified on the installed compiler: a `break` or
`continue` after a nested `for`, `par for` or `do` loop in the same loop body
of a procedure compiled as a process (`main`, or any that can suspend), which
this build turns into a jump to the inner loop's exit (`compiler/loop-labels`;
`test/differential/main_break_after_for.pj` and four more hang); a par
branch whose sequential loop calls procedures that suspend, which can end the
par early (`compiler/par-loop-calls`, `par_loop_of_calls.pj`); a channel read
in the right operand of `&&` or `||`, which this build performs even when the
left operand decides the result (`compiler/short-circuit-read`,
`short_circuit_read.pj` hangs); a replicated alt's precondition that uses its
index, evaluated once for every index (`compiler/replicated-alt-precondition`,
`replicated_alt_precondition.pj` stops with "One of the boolean pre-guards must
be true!"); `stop` (`compiler/stop-ignored`); a `break` out of a labelled
block (`compiler/labelled-break`); and a `par for` that runs no iteration,
which the language ends at once but this build never ends: it sets the par's
count to 0, starts nothing and waits for a process to finish
(`compiler/empty-par-for`, `par_for_empty.pj` hangs). That one is named where
elaboration knows the instance runs no iteration (literal bounds, or
`par for (int i = 1; i < n - 1; i++)` in `build(2)`); with bounds only the run
knows it is not named, and the model ends such a par for. When one of these is in the program, a
passing verdict adds "the compiled program may differ" with the place (in
short on its lens and chip, and the message is a warning:
`FDR: no deadlock, 11 states; the compiled program may differ`), and a
counterexample lists it among its caveats. Where the program may share an
array or record between references (`model/aliasing`, above), a passing
verdict adds "the program may differ where it shares an array or record", and
a counterexample lists it among its caveats. A passing verdict that covers only
the runs inside the modelled integers (another check found a value leaving
them) says that too (`holds, only in runs within 0..3`).

**How a counterexample is explained.** The model is built for `--divide`:
every process instance of the program (the root, every `par` branch, every
`par for` iteration) is one leaf of the network, and every state a leaf can
stop in is a named definition, so FDR's answer says for each process which
statement it is at and what it still offers. `src/csp/explain.ts` turns that
into a `VerificationReport`:

- each **step** of the trace says which processes took part, in which role
  (writer, reader, barrier sync), at which statement, with the value in
  ProcessJ terms (`3`, `true`, `Point { x = 1, y = 2 }`, `move { dx = 1, dy = 0 }`),
  and in words: "prefix writes 0 on d (line 4); delta reads it (line 23)".
  Starting and collecting `par` branches, alt guard choices and loop ticks are
  steps too, marked internal, and so is the acknowledgement the model adds after
  a plain read of a channel that is also read with an extended rendezvous: it
  only completes the write the read took ("branch 1's write on c completes:
  branch 2 has taken the value"); steps on channels nobody outside sees are marked
  not visible (in the termination check too, whose `\ Events` hides every
  event only to ask whether the program ends). The iterations of a `par for`
  whose bounds a run computes are only the ones inside those bounds;
- each **process** ends terminated, not started, blocked, stopped by a runtime
  error, or (for a divergence) looping; in a run that repeats forever, a
  process that takes no part in the repetition and stopped at an operation is
  blocked there too (a partial deadlock). A blocked process waits on exactly the
  events FDR says it offers: a write (with its value), a read, the enabled
  guards of an alt (a guard whose precondition is false is not waiting; with two
  guards on one channel, the one whose precondition holds is the one taken), a
  barrier (with how many of its enrolled processes are waiting), or its `par`'s
  branches. For each wait the processes that could complete it are named (the
  other users of that channel instance, the other processes enrolled on that
  barrier instance, every branch a `par` still waits for, the one that can never
  finish first; a channel or barrier declared in a `par for` body is one per
  iteration) with why they cannot: terminated (and when), blocked elsewhere (on
  what), not started, passed their last use of the channel ("never reads c
  again: its read is behind it"; at a barrier, an enrolled process that never
  syncs on it again keeps it from completing), or nobody at all. Whether a
  process can still get to an operation is decided from where it stopped, over
  every path of its code and the procedures it calls (an over-approximation,
  so "never again" is certain); a process inside a part
  compressed with `//@csp compress` is said to be so. The variables live at the
  stuck statement are shown (`l = 4`);
- waits that go round in a circle are listed as **circular waits**; a process
  that has passed its last use of a channel is no link in one, and neither is
  a partner in a run that repeats forever that waits on the same channel the
  other way (the two could meet; FDR's run, which needs no fairness, just
  never lets them), so such a run reports a partial deadlock only where
  something really waits for good;
- each process carries FDR's own names for the **states** it went through, in
  order (`philosopher__27(p0f0, p0f1)` from step 2): the definitions of its
  state machine;
- the **summary** picks the most telling account: a wait nobody can ever
  answer, then a circular wait, then the first stuck process. A user's
  `:[deadlock free]` that fails only because the program terminates says that
  FDR counts termination as a deadlock (`PJ_NOERR(MAIN)`, the generated check,
  tells the two apart) and is informational;
- **caveats** name what the run relies on that the model abstracts: an alt
  taking a skip guard while a guard written before it could be ready (the
  runtime takes the first ready guard), a timeout guard taken before its
  deadline, an abstract value deciding a branch; and every place where the
  compiled program differs from the language (a lint or a miscompilation
  above). Such a counterexample may happen only under some schedules or
  values, or not in the compiled program; its diagnostics say so. The step a
  caveat is about carries it in short (`the real program takes the skip guard
  only while in1 has no writer ready`), for the timeline and the code pane.

Processes and channels carry the identities of `src/verification.ts` (spawn
paths from the root; declaration plus owner instance), which the graph viewer
computes from the source independently; `test/csp-identity.ts` checks the
translator's against that rule on commstime, santa, `par for` and nested pars.
In sentences a process is called by the procedure it runs (`consume`), by the
argument that tells calls apart (`reindeer(1, …)`), or `branch 2 of delta`;
each process of the report carries that name (`name`), so the graph, the
sequence chart and the hover tell two `branch 1` apart.

**Limitations.** A program with more than 2,000 processes is not translated
(the model would be too large for FDR): its checks are each reported as not
checked, the lens reads `FDR: not modelled`, and the file written for it says
why, marked as generated, so the next translation replaces it. Not modelled,
so the program is not checked at all (each check
is reported as not checked, never as passed): mobile procedures, `suspend`,
`claim`, the forms of channel arrays listed in the table above (more than one
dimension, `{ a, b }` literals, lengths only the run knows), variables holding a channel
end, recursion through `par` that elaboration cannot unfold, records or protocols that contain themselves,
arrays passed into a `par` branch or sent over a channel (`arr.pj`,
`mandelbrot.pj`, `bug_lookalikes.pj`, `read_positions_that_work.pj`: the model
passes values to a branch in its start event, and a sequence of integers has too
many values for FDR to enumerate), and `par for` loops whose bounds are neither
constants nor `i < n` with a step of one. Big networks can take FDR a long time:
`fullAdder.pj` has dozens of one-shot gates whose steps interleave freely, so
neither the whole program nor the adders built from its gates finish in two
minutes (`xorGate` alone checks deadlock freedom, divergence and runtime errors
in under a second, 124,022 states, but not determinism); with `//@csp compress`
each adder procedure checks in about a second, but each compressed part is then
one process in counterexamples, without per-statement detail, and the whole
program still does not finish. A loop counter that leaves the inferred range is reported
where it does (`commstime.pj` counts to 1000000; in `fortest.pj` `j` reaches 15
while the literals give 0..11), with the rest of the verdicts covering the runs
before it. The alt over-approximation can report a deadlock that this runtime's
scheduler happens to avoid (`test/differential/alt_skip_no_writer.pj`). A
partial deadlock is found in the one run the termination check reports, so a
process that gets stuck only later, or in another run, is not shown. A stuck
statement in an imported file is reported at the branch or call of this
document that leads to it, naming the file and line.

**Your own specifications.** A block comment starting `/*@csp` is copied into
the model unchanged and a `//@csp assert ...` comment becomes an assertion;
both are checked and reported like the generated ones. An `assert` inside a
CSPm comment of the block (`-- ...` or `{- ... -}`) is not one, and FDR's
results are matched to the assertions by their text, so one FDR skips or one
an included file adds never gives another its answer. An `include "spec.csp"`
in a block is found next to the `.pj` file, wherever the model FDR runs is
written. An error FDR finds in your CSPm is reported at its line of the `.pj`
file (`fdr/spec-error`). `assert not ...` is explained the other way round: it
holds when the property after `not` fails, and the counterexample FDR found for
that property comes with it. Specifications can refer to `MAIN`
(the program) or the checked procedure's name, to `main`'s channels by their
ProcessJ names (`a.3`; other procedures' channels are hidden), to a checked
procedure's own channels and `PJ_LOCAL` (the set of them), and to `main`'s
barriers (`b.1.pj_sync`). Generated names start with `pj_` or `PJ` or contain
`__`; ProcessJ names that would clash are renamed (`length` becomes `length_`).
`//@csp assert sum :[has trace]: <pj_call.4, pj_result.10>` tests a function;
`//@csp check proc(args)` names the arguments a procedure checked on its own is
elaborated with (see "Procedures whose arguments decide their network");
`//@csp compress` compresses every sub-network (`sbisim(diamond(...))`). FDR
counts successful termination as a deadlock, so `//@csp assert MAIN :[deadlock
free [F]]` fails on a program that ends; write `PJ_NOERR(MAIN)` instead, as the
generated check does. FDR
reads `assert not` as a negated assertion even at the start of a name, so a
procedure called `notGate` is written `assert (notGate) :[deadlock free]` (the
generated assertions do this themselves). A channel your specification names
keeps exact values, as does everything that flows into it.

## Graphs and FDR for .csp files

The server also attaches to CSPm files: language id `cspm` (VS Code's
language for `*.csp`), `csp` (Neovim's filetype for `*.csp`), or any document
whose name ends in `.csp`. For them it runs no ProcessJ analysis at all: no
ProcessJ diagnostics, completion, hover, formatting, semantic tokens or code
actions. What it does instead (`src/cspm/`):

| | Neovim | VS Code | Emacs |
| --- | --- | --- | --- |
| the process network | `:ProcessJGraph` (and `markdown`, `svg`, `excalidraw`) | **ProcessJ: Show Concurrency Graph**, or the **Process network** lens | `C-c C-g` in `cspm-mode` |
| export it next to the file (`<file>.csp.graph.svg`, …) | `:ProcessJGraphExport [format] [dir]` | **ProcessJ: Export Concurrency Graph** | `C-c C-e` |
| FDR on the file's own assertions | `:ProcessJFdr` (no argument), or the **FDR: check & show graph** lens on an `assert` | **ProcessJ: Check with FDR** | `C-c C-f` |
| stop a running check | `:ProcessJFdrCancel` | **Cancel** on the notification | `M-x processj-cancel-fdr` |

Diagnostics come from the CSPm parser (what it cannot read, at its line) and
from FDR's own type check (`refines --typecheck`, run on open and on save when
FDR is installed; FDR reports one error at a time). The outline lists the
definitions, channels, datatypes and assertions. Without FDR the graph still
works: it is drawn from the file alone.

### The network

A view starts at a root process: each process an assertion is about (the
implementation of a refinement, the subject of `:[deadlock free]` and the
other properties), then `MAIN`, `SYSTEM` or `main`, then every process
defined without parameters. The viewer lists them under **Asserted** and
**Defined** and opens on `MAIN`/`SYSTEM`/`main` when one is a network, else on
the first asserted network.

From the root, references are unfolded while they lead to a composition
(`SYSTEM = PHILOSOPHERS [| X |] FORKS`, then `PHILOSOPHERS = ||| i : PHILS @
PHIL(i)`), through hiding, renaming, `[| A |>`, `;`, `[>`, `/\`, `let`, an
`if` whose condition is known, and FDR's compression functions (`sbisim`,
`normal`, `diamond`, ...), at most 8 references deep and never into a
reference already being unfolded. A composition left at that depth (a
recursive one such as `Q(n) = Q(n+1) ||| Q(n+2)`) is one box that says it
was not unfolded, and the view's notes say the drawing was cut there. Each
operand of a composition is a box;
a nested composition is a box around its operands, named after the reference
it was reached through. A chain of the same operator without a name of its
own (`(A [| X |] B) [| Y |] C`, as a translator writes) is drawn in one box,
its other synchronisation sets listed among the box's facts.
`||| i : S @ P(i)`, `[| X |] i : S @ P(i)` and `|| i : S @ [A(i)] P(i)` get
one box per member when the evaluator can list `S` and it has at most 16
members; otherwise one box stands for all of them (`×100`, or `×N` when the
set cannot be counted). A view stops unfolding at 160 boxes.

What an operand does is found by walking its definition and every definition
it refers to with its arguments (`PHIL(0)` follows `PHIL(i)` with `i = 0`):
each prefix is an event on a channel with the fields that can be computed
(`pickup.0.1`) and the inputs (`?x`) and outputs (`!v`) marked. Which
operands share an event follows CSP exactly: it synchronises at a generalized
parallel whose set holds it, at an alphabetized parallel whose two alphabets
hold it, never at an interleaving; a hiding makes it internal from there up;
a renaming around part of the network makes its events, outside it, the
events they are renamed to. An input `c?x` stands for every event of `c`:
where a set or an alphabet holds some of them and not others (`|| i : {0,1}
@ [{c.i}] P(i)` against a server's `c?x`), each event is worked out on its
own (`c.0` with P(0), `c.1` with P(1)) when the channel's type can be
listed. So a link joins the operands that must take part in the same events:

- an arrow from the operand that only outputs (`!`) to the one that only
  inputs (`?`) them; a plain line when the events carry no direction;
- a hub (the barrier shape) when three or more operands take part in each;
- a port for an event an operand performs with nobody in the network and
  that carries data (`left?x`): the environment's side; other events an
  operand performs alone are listed on its box (`also eats.0, thinks.0`);
- a dashed end, `never shared: coffee`, for an event a composition
  synchronises on that its other side never performs, so it can never happen;
- a faded link (`· hidden`) for events a hiding makes internal.

Links between the same operands are one arrow labelled with their events
(`pickup.0.1, putdown.0.1`). A link is drawn dashed (not certain) when the
walk of an operand stopped short or a synchronisation set could not be
worked out; the box then says why among its facts. Such an operand may take
part in any event it synchronises on: its partners are linked to it dashed,
rather than said to perform those events alone.

Identity follows `src/verification.ts`, with sites in the `.csp` file: an
operand's path adds `{ kind: 'branch', site: the composition, index }` per
composition, `{ kind: 'par-for', site: the replicated operator, index }` per
member (no index on a box drawn once for all), and `{ kind: 'call', site: the
reference }` for each reference unfolded on the way to a nested composition.

### FDR

Check with FDR runs `refines --format=framed_json --divide` on a private copy
of the buffer (unsaved edits included; an `include` is made absolute so it
still finds its file) and checks exactly the file's own assertions: nothing
is generated or added. Each assertion is one check: its verdict, FDR's state
count and time, and for a failure the counterexample, matched to the
assertion by its text as FDR prints it back (without comments, spaces and
parentheses, `:[livelock free]` and `:[divergence-free]` as `:[divergence
free]`, `i : S` as `i <- S`); when FDR reports as many results as the file
has assertions, an assertion whose text still matches none takes the result
at its position. `assert not` holds when the assertion without `not` fails;
its label keeps the `not`.

With `--divide`, FDR gives a behaviour for every component below the process
the assertion is about: its own trace, aligned with the whole one, the named
states it went through, and at the end what it still offers. These are
matched to the drawn operands by following the composition the view was
drawn from: through the hiding, `[| A |>` and named definitions around it
(each may or may not be a node of FDR's tree), then operand by operand, by
FDR's machine name where it agrees with the drawing (`PHIL(0)`), else by
position. A chain drawn as one composition (`A [| X |] (B [| X |] C)`)
stays binary in FDR's tree: it is followed in the shape it was written, so
each operand gets its own node, never a neighbour's.
FDR's members of a replicated composition drawn once are each placed on that
box. When the tree does not have the drawn shape, the check says so and the
processes it could not place are listed in the viewer; nothing is placed by
guesswork.

From that:

- each step of the run names who took part and in which role (output, input,
  synchronisation); a hidden event shows what happened inside (`COPY(left,
  mid) outputs 0 on mid; COPY(mid, right) inputs it (hidden)`); an internal
  choice is an internal step of the process that made it;
- for a deadlock, each process is blocked waiting for exactly the events FDR
  says it still offers, at the prefix that offers them, and each wait names
  the operands it must share the event with that do not offer it (with what
  they offer instead), or says that nobody ever can (`CUSTOMER never performs
  coffee, and [| {| coin, tea, coffee |} |] synchronises on it`); waits that
  go round are a circular wait; a process at `STOP` offers nothing; one at
  `SKIP` has terminated (FDR counts the end of the whole system as a deadlock,
  and says so);
- for a trace refinement, the process that can perform the event the
  specification refuses is marked (`can do left.1: refused`); for a failures
  refinement or `:[has trace]`, what each process offers at that point (what
  it may refuse is everything else), with what the specification needed. In
  the F and FD models `:[has trace]` fails when the process can refuse the
  next event of the trace, not only when the trace is impossible; the
  message says which (`:[has trace [T]]` asks only whether it is possible);
- for nondeterminism, the process that can both perform and refuse the
  event; for a divergence, the processes in the steps that repeat forever.

Results are diagnostics too: a failed assertion at its line, and one
information diagnostic per place where processes are stuck (`PHIL(0), PHIL(1)
and PHIL(2) are stuck here, waiting to sync on pickup.0.1, …`), and the lens
on each `assert` shows its verdict and opens the graph on it. The text report
(the step-by-step account) opens when the graph does not (`fdrShowGraph`). An
edit takes the results back.

### Generated models

A model Convert to CSP wrote is an ordinary CSPm file here, with two
differences: each box shows the ProcessJ line its definition's comment names
(`line 22: branch 1 of the par`), and the translator's own events
(`pj_fork_…`, `pj_join_…`, `pj_end`) are drawn without labels. Its header
names the `.pj` file it came from; the page links back to it (to its live
graph page when that file is open), and the graph command says once that the
ProcessJ graph is in that file.

### What is understood, and what is not

Read: `channel`, `datatype`, `subtype`, `nametype`; definitions with
parameters, several clauses and pattern parameters (literals, tuples, dotted
values, `<x>^xs`, `{x}`, `_`); every process operator of FDR's manual with its
precedence (`->`, `&`, `;`, `[>`, `/\`, `[| A |>`, `[]`, `|~|`, `[| A |]`,
`[A || B]`, `[a <-> b]`, `|||`, `\`, `[[ a <- b ]]`); the replicated forms of
`[]`, `|~|`, `;`, `|||`, `[| A |]`, `||` and `/\`; inputs `?x`, `?x : S`,
outputs `!v`, dotted fields; `if`/`then`/`else`, `let`/`within`, lambdas;
sets, ranges, `{| |}` and comprehensions of both, sequences and sequence
comprehensions; `include`, `external`, `transparent`, `print`, type
signatures (read past); every form of `assert`, with `[T=`, `[F=`, `[FD=`,
`:[deadlock free]`, `:[divergence free]`, `:[livelock free]`,
`:[deterministic]`, `:[has trace]: <...>`, their `[M]` models and options
such as `:[tau priority]:`; `--` and nested `{- -}` comments.

Evaluated (to draw): integers, booleans, dotted values and events, tuples,
finite sets and sequences up to 4096 values, datatypes' values, `union`,
`inter`, `diff`, `Union`, `Inter`, `member`, `card`, `empty`, `set`, `seq`,
`head`, `tail`, `length`, `null`, `concat`, `elem`, `productions`, `Set`, and
`Events`.

Not understood, and said so where it matters:

- Timed sections (`Timed(et) { ... }`) and modules are read past with an
  information diagnostic; nothing in them is drawn (FDR still checks them).
  A name a module exports (`M::Y`) is read as one name whose value is
  unknown;
- a linked parallel `[a <-> b]` is drawn with its two operands but not its
  links (they rename the channels they join);
- a renaming is followed when it maps whole channels to channels (one to
  one, or one to several: `[[ a <- b, a <- c ]]` does both b and c);
  otherwise (an event such as `d.0`, a comprehension) its events are drawn as
  written, marked uncertain, and the box says so;
- a value the evaluator cannot compute (an infinite set such as `Int`, a
  library function it does not know, a value that depends on an input) is
  unknown: an event with an unknown field matches any value there, a
  replicated composition over an unknown set is one box, and a
  synchronisation set that cannot be computed draws no links at that
  composition (the view's notes say which);
- the walk of an operand's definitions stops after 1,000 definition instances
  (a counter with a large range, a barrier's bookkeeping); its links are then
  dashed and the box says the walk stopped;
- syntax the parser does not know becomes an opaque declaration or term with
  a diagnostic at its line, and the rest of the file is still read; so does a
  declaration nested more than 100 expressions deep (a warning: FDR may well
  accept it).

FDR's type errors are diagnostics on open and save, one per error at its own
location (FDR can send several in one message). The summary after a check
counts what FDR decided: an assertion it did not finish, or a file it could
not load, is neither holding nor failing (`none of the 2 assertions was
decided`).

## Performance

Everything except the compiler run is synchronous on the keystroke path, so it
has to be fast. `npm run bench` times every in-memory layer separately. One run
on a laptop produced:

```
 lines   parse  symbols  check  effects  protocols  graph  inlays  semantic  format
 1.3k     1.7      0.2    1.7      1.0        1.6    0.8     0.2       1.1     2.6 ms
  10k    10.4      1.9    6.1      8.8        7.7    5.7     1.0       7.3    12.7 ms
  50k    50.9      9.3   36.2     31.7       35.6   30.9     6.2      32.2    63.0 ms
```

(Exact numbers vary by machine; these are warm, steady-state runs rather than
guarantees. `test/perf.test.ts` enforces generous CI budgets on a generated
20,000-line file, checks that parse time grows linearly, and guards a 750-level
protocol hierarchy against inherited-case duplication.)

A separate completion stress run indexed 1,500 files with 30,000 declarations.
The cold request, including the initial workspace walk, took 118 ms; warm
requests took 1.79–3.69 ms and returned 278 items / 55.8 KiB with
`isIncomplete: true`. Before prefix filtering and the 200 auto-import budget,
the same warm request took 109–123 ms and returned 30,078 items / 6.53 MiB.

Every recursive construct the parser accepts is bounded: statement, block,
expression and type nesting share one budget, and the depth of the expression
tree itself is tracked, so a hostile file produces a syntax error instead of a
stack overflow in a later pass. An analysis failure of any other kind is reported
as one diagnostic rather than taking the server down. On shutdown the server
disposes its compiler queue, kills every JVM it started (as a process group, so
nothing a wrapper spawned survives), and removes its report directory and every
compiler sandbox still on disk; a server that exits without a shutdown (its
input closed, SIGTERM, SIGINT, SIGHUP) does the same on its way out. After each
compiler run its sandbox is removed in the background, so typing never waits
for it.

The server caches parsing, checking, symbols and semantic inputs per document
version, computes effects/protocols once per version, builds the visual graph only
on request, keeps graph layouts by the shape of what is drawn (an edit that moves
no box, a keystroke above a procedure included, is not laid out again: ELK takes
tens to hundreds of milliseconds on a larger network, a kept layout well under one),
coalesces lint bursts into one pass, and routes real-compiler JVM work
through a latest-wins queue with two workers. A newer edit cancels stale work;
the queue bounds CPU/memory when many files open together without serializing
all compiler feedback.

**Disk and change detection.** Everything on the keystroke path runs in memory.
The only things that touch disk are compiler runs (a few kilobytes of temporary
files, which is why they default to open and save only) and the bounded workspace
index. Files are parsed once and cached by modification time, change time, and
size; name and occurrence indexes serve later completion/navigation requests.
Unsaved open buffers overlay their on-disk entries, including transitively reached
effect/yield dependencies.

When the editor supports dynamic file watching (Neovim and the bundled VS Code
extension do), the server registers one `**/*.pj` watcher and the editor pushes
changes; there is no polling or duplicate client-side watcher. A changed file
re-checks only open documents whose direct or analyzed transitive imports include
it. Watcher events for build output, hidden directories or anything else a root
walk would skip are not indexed. A created file re-checks every open document only
when one of them has a wildcard or unresolved import it could satisfy; a deleted or
changed file reaches exactly its dependents. A changed standard-library header is
re-read. For a simpler LSP client without watcher support, a background timer
re-walks the roots every 5 seconds; no hover, completion or lint request ever pays
for the directory scan itself. Changed files invalidate dependent analysis and
compiler diagnostics, including when the importing buffer has not been edited.
Unchanged polls do not schedule checks; the walk is depth, file and directory
bounded, never treats a home directory or filesystem root as a project, and keeps
import dependencies it loaded from outside the roots instead of mistaking them
for deleted files.

## Setup

### 1. Prerequisites

- **Node.js 20 or newer** with `npm` on PATH (`brew install node`, `apt install nodejs npm`, or nvm).
- **An editor**: Neovim 0.11+ (built-in `vim.lsp.config`), VS Code with the `code` command on PATH,
  or Emacs 29+ (built-in eglot; lsp-mode works too).
- **A JDK** on PATH or in `JAVA_HOME`; the compiler was built with JDK 11.
- **A ProcessJ install** for compiler diagnostics and the Run code lens: a
  checkout with a built `bin/` directory and `resources/jars`. Tell the server
  where it is with `installdir=/path/to/ProcessJ` in `~/processjrc` (the same
  file `pjc` reads), `export PROCESSJ_HOME=/path/to/ProcessJ`, or
  `init_options.installDir`. Without one, everything except compiler
  diagnostics and Run still works.
- **FDR4** (optional) for Check with FDR: install it from
  [cocotec.io/fdr](https://cocotec.io/fdr/); the server finds `refines` in the
  usual places or through `fdrPath` (see
  [Finding FDR](#convert-to-csp-and-check-with-fdr)).

### 2. One command per editor

```sh
git clone https://github.com/arianizadi/processj-lsp
cd processj-lsp
npm run setup -- nvim vscode emacs   # or any subset; no argument means every editor found
npm run remove -- nvim vscode emacs  # uninstall
```

`scripts/editors.js` builds the server if `dist/` is missing or older than `src/`,
then points each editor at this checkout, so `git pull && npm run setup` updates
everything. Add `--dry-run` to see what it would change. What it does per editor:

- **Neovim with lazy.nvim** (AstroNvim, LazyVim, kickstart with a `lua/plugins`
  directory): writes `lua/plugins/processj.lua` with `dir = "<checkout>"`. The
  plugin registers the `processj` filetype for `*.pj`, bundled syntax
  highlighting and indentation, and the language server. `:checkhealth
  processj-lsp` checks the Node version, server build, optional ProcessJ/JDK
  setup, and whether `processj_ls` attached. Uninstall deletes the spec file.
- **Plain Neovim**: links the checkout into `pack/processj/start/`, a native
  package, and `plugin/processj-lsp.lua` sets everything up at startup.
  Uninstall removes the link.
- **VS Code**: builds the bundled extension (`vscode/`), packages it as a VSIX
  and runs `code --install-extension ... --force`. Uninstall runs
  `code --uninstall-extension arianizadi.processj-lsp-vscode`.
- **Emacs**: appends a marked block to your init file (`~/.emacs.d/init.el`,
  `~/.emacs`, or `$XDG_CONFIG_HOME/emacs/init.el`, whichever exists) that loads
  `editor/emacs/processj-mode.el`: a major mode with comments, strings, keyword
  highlighting and a brace indenter, `.pj` in `auto-mode-alist`, and the server
  registered with eglot (`eglot-ensure` on open) or lsp-mode. Customise
  `processj-lsp-client` (`auto`, `eglot`, `lsp-mode`, `nil`) and
  `processj-lsp-server-command`. Uninstall removes the block.

### 3. Doing it by hand

The lazy.nvim spec the installer writes is equivalent to
`editor/nvim/lua/plugins/processj.lua`, which clones and builds from GitHub
instead; `opts` is merged into the server configuration:

```lua
return {
  {
    "arianizadi/processj-lsp",
    build = "npm ci && npm run build",
    ft = { "processj", "csp" },
    opts = { init_options = { installDir = "~/Documents/ProcessJ", checkOnChange = true } },
  },
}
```

Plain Neovim: see `editor/nvim/plain.lua` (`runtimepath` plus
`require("processj-lsp").setup {}`). VS Code: `cd vscode && npm run
install-extension`. Emacs: `(load "/path/to/processj-lsp/editor/emacs/processj-mode.el")`.
Any other editor: run `node <checkout>/bin/processj-lsp.js --stdio` for files of
language id `processj` (extension `.pj`) and pass the options below as
`initializationOptions`.

With AstroNvim the usual mappings apply: `K` hover, `gd` definition, `gr`
references, `<Leader>lf` format, `<Leader>la` code action (quick fixes),
`<Leader>lr` rename, `<Leader>ll` run a code lens (▶ Run, Build, FDR: check & show graph). The
`:ProcessJEffects` and `:ProcessJProtocols` commands open the complete analysis
reports without locating a lens first, `:ProcessJGraph` opens the graph viewer in
your browser (`:ProcessJGraph markdown` gives it as a report),
`:ProcessJGraphExport` writes it next to the file, and `:ProcessJCsp [procedure]`
and `:ProcessJFdr [procedure]` convert to CSP and check with FDR. Reports use the dedicated
`processjreport` filetype: they retain lightweight Markdown highlighting without
activating editor Markdown Tree-sitter integrations.

In VS Code the play button in the editor title and the code lens above `main` run the current file. Run, Build,
Convert to CSP, Check with FDR (both ask for the whole program or one procedure),
Restart Language Server, and Show Language Server Output are also available under **ProcessJ** in the
Command Palette. The language-status menu reports Starting, Ready, or Stopped and opens the server log.
All ProcessJ settings apply automatically; use `processj.trace.server = verbose` when protocol-level logs
are needed. An untitled editor also gets language features after changing its language mode to ProcessJ.

### 4. Developing

```sh
npm install
npm run build
npm run build:browser   # also the Web Worker build (dist/browser), see "The browser build"
npm test          # parser corpus, formatter, checker, semantic tokens, imports, examples, perf budgets, the worker
npm run smoke     # end-to-end against a real ProcessJ install, including a full program run
npm run bench     # timings for generated 1k / 10k / 50k-line files
node scripts/fdr-validate.js   # every corpus program through FDR and the real runtime, compared
```

Without FDR, `npm test` explains refines output recorded in `test/fixtures/fdr`
and skips the tests that run refines. Each recording names a hash of the model
it was made for, so after a change to what the translator generates the tests
say which to record again: `PJ_RECORD_FDR=1 npm test` (with FDR installed)
records them afresh, with one search worker so the counterexamples are the
ones a check finds every time.

`:LspLog` in Neovim shows the server log, including which install directory it
found and how long each compile took.

## Options

Pass these as `init_options` / `initializationOptions`. A client that pushes
settings instead (Neovim's `settings`, or a `processj` configuration section sent
with `workspace/didChangeConfiguration`) is honoured too, including a changed
install directory; only `codeLens` needs a restart because it is a capability.

| option          | default | meaning                                                   |
| --------------- | ------- | --------------------------------------------------------- |
| `installDir`    | from rc | ProcessJ install directory                                |
| `javaBin`       | `java`  | Java executable                                           |
| `debounceMs`    | `400`   | wait this long after the last keystroke before compiling  |
| `timeoutMs`     | `20000` | kill the compiler after this long                         |
| `runTimeoutMs`  | `30000` | kill a program started from Run after this long           |
| `checkOnChange` | `false` | `true` to also run the real compiler on every edit         |
| `lint`          | `true`  | `false` to turn the static analysis off                   |
| `codeLens`      | `true`  | `false` to hide all inline Run, Build, analysis, graph and FDR lenses |
| `liveViewer`    | `true`  | `false` to write the graph viewer to a file instead of serving it on a loopback-only page that follows edits |
| `fdrPath`       | found   | FDR's `refines` (or FDR's install directory) for Check with FDR |
| `fdrTimeoutMs`  | `120000` | stop an FDR check after this long                        |
| `fdrMemoryMb`   | `0`     | stop an FDR check once `refines` uses more memory than this (MB; not on Windows); `0` is half of the machine's memory, at most 8 GB |
| `fdrWorkers`    | `1`     | `refines`' search workers: `1` finds the same deadlock and runtime-error counterexamples on every check (a termination or determinism counterexample can still vary); `0` uses every core, faster on big models |
| `fdrShowGraph`  | `always` | after Check with FDR, open the graph on the result: `always`, `onFailure` (only a defect, a partial deadlock or a runtime error), or `never` (the text report opens instead, as it does whenever the graph is not shown) |

The compiler runs without being asked (on open, after `debounceMs`, and on
save; on every edit with `checkOnChange`) only for files inside a workspace
folder (`rootUri` or `workspaceFolders`, links resolved). A file opened from
elsewhere, such as a download or another project, gets the server's own
analysis but no compiler diagnostics, and the log says so once
(`not running the compiler on <file>: it is outside the workspace`). Run and
Build still compile it. An editor started with no workspace folder at all
(Neovim or Emacs on a single file) compiles every file, as before. Neovim's
setup takes the folder with `.git` above a file as its root (`root_markers`),
so a file in no repository has no root and is compiled as before.

## How diagnostics work

The compiler has no library API and no "check only" mode, so the server writes
the buffer to a temp directory, points the JVM's `user.home` at a private
`processjrc`, and runs the same command the `pjc` script does. Generated Java
lands in the temp directory and is deleted afterwards; your real `~/workingpj`
is never touched. The three output formats the compiler uses (CUP parser,
`PJBugManager`, legacy `utilities.Error`) are parsed in `src/diagnostics.ts`,
with unit tests pinning real captured output.

Limits inherited from the compiler:

- The compiler stops at its first syntax error; the server's own parser reports
  all of them, so you rarely see the compiler's.
- Some type errors are printed but do not stop the compiler, and some checks are
  silent. The server shows everything the compiler prints, and the lints cover
  the most damaging gaps.
- Imports of your own libraries resolve against the compiler's include directory,
  not the buffer's directory.

The lints run on the parse tree with real scopes and types. A whole channel
passed to a procedure counts as both of its ends being handed away, so aliasing
through calls is conservative rather than tracked; the rules are tuned to avoid
false positives rather than to be complete.

## The browser build

`npm run build:browser` builds the server a second time, as a Web Worker for the
browser IDE, into `dist/browser/`:

| file | what |
| --- | --- |
| `processj-lsp.worker.js` | the server as one classic worker script (minified, with a source map), LSP over the worker's `postMessage` |
| `elk.<hash>.js` | the layout engine (elkjs, about half of the code), which the worker loads with `importScripts` from beside itself when it first lays out a view (`src/browser/elk.ts`); the name carries a hash of its content |
| `graph-viewer.html` | the graph viewer page for `<iframe sandbox="allow-scripts">`: webview mode, fed by `postMessage` as VS Code's panel feeds it; a stand-in for `acquireVsCodeApi()` posts the page's messages to the parent as `{ pjViewer: message }`, starting with `{ type: 'ready' }`, and the parent's `{ type: 'theme', theme: 'light' \| 'dark' }` sets the page's theme (an iframe cannot see its embedder's) |
| `gallery.json` | every example program as a project to open (`scripts/gallery.mjs`): below |
| `manifest.json` | `{ version, commit, files }` |

The viewer page's script nonce is made from a hash of the page, so the same
source always builds the same files.

`npm install` builds it too (the `prepare` script runs `build:browser`), and
so does npm when it installs the package from git, where `prepare` is the only
script it runs: a site can depend on `github:arianizadi/processj-lsp#<branch>`
and serve `node_modules/processj-lsp/dist/browser`.

It is the same server. `scripts/build-browser.mjs` (esbuild) puts
`src/connection.browser.ts` in place of `src/connection.ts` and the modules in
`src/browser/` in place of Node's: an in-memory synchronous file system (the
analysis reads imports, the workspace and the standard library synchronously,
so the page puts the project there up front), file URLs, a synchronous SHA-256,
and `child_process` and `http` that say they are not available. The standard
library headers (`test/fixtures/include`, the compiler's `include/JVM`) are in
the bundle and installed at `/processj` with the files an install is
recognised by, so the server finds its library as it does on disk. ELK lays
out in the worker's own thread, once `elk.<hash>.js` is loaded; `src/graph/layout.ts` builds it so that it
does not take the worker's `onmessage` (the bundled elkjs would, thinking it is
running as ELK's own worker). The build type-checks `src/browser` against the
worker's library (`tsconfig.browser.json`) first.

Nothing can be started in a browser, so the compiler and FDR run on a runner
service the page talks to. A client offers it with
`initializationOptions.browser: { remoteFdr: true, remoteCompile: true }`, and
then answers two requests (`src/remote.ts`):

- `processj/runRefines { model, name, files, mode: 'check' | 'typecheck', timeoutMs }`
  → `{ exitCode, frames, error? }`: FDR on `model`, a file `name` at the top of
  a job whose `files` are the `.csp` files it includes, at their paths in the
  workspace (the model's includes are rewritten to those paths). `frames` are
  the lines `refines --format=framed_json` printed; the server reads them as it
  reads refines' own output, so the explanation, the report, the lenses and the
  graph are the same as after a local run. The includes are checked first as
  for a local run (`src/csp/includes.ts`): in the browser an include must be a
  relative path to a file of the workspace, and a refused one means the runner
  is not asked. Check with FDR and the FDR lenses
  are there without a local `refines`, for `.pj` and `.csp` files alike, and a
  `.csp` file is type-checked on open and save.
- `processj/compile { entry, files, mode: 'check' }` → `{ output, ok, error? }`:
  the compiler on `entry` (as the compiler should read it, with the yield
  annotations it needs) and the workspace files it imports, placed where the
  compiler resolves the imports from. The output is parsed as a local run's
  and published as compiler diagnostics. The server asks 1.5 s after a file is
  opened or last edited, and when it is saved, one request at a time per file
  (inside the workspace only, as above):
  an edit cancels a request (`$/cancelRequest`), and the next waits for its answer.
  The runner compiles a project with imports merged into one unit and maps
  each message back to its file and line; a message at a line past the end of
  the file is shown at its top, saying where the compiler put it.

Run and Build are the page's (the worker answers them with a message), as is
anything else that needs a process. What the page sends the runner for them
it asks the worker for: `processj/buildInputs { entry }` (a file URI, or a
path from the workspace folder) → `{ entry, files: [{ path, text }], augmented }`
is every file below the workspace folder, with the entry and the project
`.pj` files it imports (directly or through other files) as the compiler
should read them: each with the yield annotations of its own analysis, as
`processj/compile` sends a document (`src/yieldfix.ts`). No line changes.
`augmented` names the files that changed; the answer is null for an entry
that is not a `.pj` file of the workspace, and from the Node server, whose
files are the editor's disk.

`gallery.json` is every ProcessJ and CSPm program of this repository (the
standard library headers in `test/fixtures/include` aside) as a project an IDE
can open: `examples/` (Start here), `test/fixtures/processj` (Classic
programs), `test/differential` (Language corner cases), `test/fixtures/fifo`
(Channel arrays and FIFOs), every `.csp` file (CSPm models) and the rest of
`test/fixtures` (Other fixtures). An entry has an `id` (its path here), a
`title` (from the file name, or a better one from `scripts/gallery.mjs`), a
`description` (the leading comment, without `// expect:` and `// outcome:`,
which become tags such as `deadlock`, `runs`, `compiler limit`, `type error`
and `FDR`, next to the language features the code uses), a `category`, its
`files` (the program, the project files it imports or includes, and its CSPm
model, at their paths from the program's folder `dir`; the texts are in
`sources`, each once), the file to `open` and the `entry` Run starts from.
`featured` is a small set to start with. `test/gallery.test.ts` checks that
every program is there and that every entry is a project the runner takes.

A client whose files are in memory also uses three more messages:
`processj/writeFiles { files: [{ uri, text }] }` and
`processj/deleteFiles { uris }` write and delete files below the workspace
folders (the files are then analysed again, as after
`workspace/didChangeWatchedFiles`), `processj/readFile { uri }` → `{ text } | null`
reads one back, and the server sends `processj/fileWritten { uri, text }` for
every file it writes: a model from Convert to CSP or a check, a report, an
export. The Node server does not accept them: its files are the editor's disk.

`test/browser.test.ts` runs the built worker in a Node `vm` context with a Web
Worker's globals only and drives it as a page does: its diagnostics against the
Node server's over every example, ELK and the connection, the file messages,
FDR and the compiler through the two requests, answered from the
recorded refines output and with canned compiler output, and what
`processj/buildInputs` gives Run and Build.

## Layout

```
src/server.ts       LSP wiring: documents, caches, debounced compiles, every request handler
src/connection.ts   the connection to the editor and what the server may do where it runs (connection.browser.ts in a worker)
src/remote.ts       the compiler and FDR on a client's runner: the jobs sent, and their answers read as a local run's
src/browser/        the browser build: worker entry, in-memory file system and the other Node stand-ins, the bundled install
src/parser/ast.ts   AST node types with source spans
src/parser/parser.ts recursive-descent parser with recovery and "did you mean" suggestions
src/format.ts       AST printer used for textDocument/formatting
src/checker/        type model, declaration index, and the checker with the concurrency lints
src/checker/effects.ts binding-aware direct/transitive procedure effects and SCC fixed points
src/checker/reachable.ts bounded call-driven imported-body analysis and dependency tracking
src/checker/protocols.ts protocol inheritance, coverage, collisions and observed message flow
src/checker/controlflow.ts executable-prefix statement walking (a return or break ends its block)
src/checker/rendezvous.ts bounded state-space search for a legal straight-line rendezvous schedule
src/concurrency.ts  stable source-mapped concurrency topology (the processj/concurrencyGraph request)
src/verification.ts the VerificationReport contract shared by the checker, FDR and the graph viewer
src/graph/network.ts process network views: elaboration from a root, channel binding, spawn-site identity
src/graph/static-verification.ts the checker's proven deadlocks and channel hazards as a VerificationReport
src/graph/overlay.ts placement of verification results on a view, and their plain-words story
src/graph/layout.ts ELK (elkjs) layered layout, text metrics, cycle breaking in source order
src/graph/render-svg.ts standalone SVG of a view and its end-state overlay
src/graph/render-msc.ts message sequence chart of a counterexample
src/graph/render-excalidraw.ts Excalidraw scene with bound arrows and labels
src/graph/render-markdown.ts the network described in words, with a Mermaid flowchart
src/graph/render-html.ts, payload.ts, client/viewer.ts the self-contained viewer page and its data
src/graph/render-machine.ts a process's state machine laid out and drawn, with its trail placed
src/graph/live.ts   verification store (publishVerification) and the loopback live viewer server
src/graph/session.ts per-document network, static report, layout cache and export formats
src/inlays.ts       compact channel-role and topology hints
src/refactors.ts    conservative, validated concurrency refactoring plans
src/semantic.ts     semantic tokens from the parse tree and the checker's resolutions
src/imports.ts      import resolution (file's directory, workspace roots, include directory)
src/astsymbols.ts   symbols and scoped locals from the parse tree
src/navigation.ts   binding-aware local scopes, declaration/reference spans and type uses
src/analysis.ts     lexer-level diagnostics (escape sequences, non-ASCII, empty comments)
src/tokens.ts       tokenizer that also reports the lexer limits and keeps comments
src/compiler.ts     runs ProcessJc in an isolated temp home, cancellable
src/pipeline.ts     full build + run pipeline (ProcessJc, javac, ASM passes, java)
src/csp/            ProcessJ to CSPm for FDR and back: lowering (lower.ts), integers that never decide anything
                    (relevance.ts), miscompilations no lint reports (miscompile.ts), what a process may still do
                    (reach.ts), definitions (gen.ts), the process network (network.ts), the file and source map
                    (translate.ts), refines (fdr.ts), FDR's answers as a VerificationReport (explain.ts),
                    diagnostics and the text report (report.ts), check.ts, each procedure's state machine
                    (machine.ts)
src/cspm/           CSPm files: the tolerant parser (lexer.ts, parser.ts, ast.ts), the evaluator of values and event sets
                    (eval.ts), the process network of a root (network.ts), one document's roots, views and symbols
                    (document.ts), FDR's answers on the drawn network (explain.ts), refines on the file and its type check
                    (check.ts), the text report and diagnostics (report.ts), the graph session (session.ts), and what
                    the server does for a .csp document (features.ts)
src/verification.ts verification results shared with the graph viewer: process and channel identities, checks, counterexamples
src/diagnostics.ts  parses compiler output into structured diagnostics
src/symbols.ts      regex-based extractor, used to top up symbols while a file has syntax errors
src/library.ts      indexes include/JVM/**/*.pj for std completion and definitions
src/workspace.ts    bounded parsed/symbol/occurrence index, invalidated by editor file events
src/taskqueue.ts    debounced latest-wins compiler queue with bounded concurrency
src/settings.ts     defaults and validation for untrusted initialization options
src/keywords.ts     keyword list and hover docs
test/               node:test unit tests; test/fixtures holds the compiler's example corpus and std headers
test/differential/  programs whose real compiler and runtime outcome is recorded in their header
test/fixtures/verification/ an FDR-style report of a multi-step deadlock, for the viewer's timeline
test/fixtures/cspm/ hand-written CSPm models (dining philosophers, a COPY pipeline, a ring, clients and a server, a vending
                    machine) and a generated one, for the CSPm parser, network and FDR tests
test/fixtures/fdr/  refines output recorded for the explanation and graph tests (`PJ_RECORD_FDR=1 npm test` re-records);
                    test/fdr-recordings.ts reads them, and replays them as a stand-in refines for the server tests
examples/           one program per diagnostic, self-describing and tested; dining_philosophers.pj is for FDR
scripts/smoke.js    talks LSP over stdio to a real server, ends with a real program run
scripts/build-browser.mjs the Web Worker build (dist/browser): the worker, the viewer page, the example gallery and a manifest
scripts/gallery.mjs every example program as a project for the browser IDE (dist/browser/gallery.json)
scripts/bench.js    complete in-memory analysis timings on generated large files
scripts/validate.js builds and runs every program, comparing the checker's verdict against reality
scripts/parse-diff.js compares the parser's trees with the compiler's -showTree output, on files or generated programs
scripts/pj2csp.js   translates a file to CSPm and, with --check, runs FDR on it and explains the answers
scripts/fdr-validate.js checks a corpus with FDR, runs it with the real compiler and compares the two
scripts/editors.js  `npm run setup` / `npm run remove`: install or uninstall the Neovim, VS Code and Emacs integrations
lua/, plugin/, ftdetect/, syntax/, ftplugin/   the Neovim plugin
editor/nvim/        ready-made lazy.nvim/AstroNvim spec and a plugin-manager-free config
editor/emacs/       processj-mode.el: major modes for ProcessJ and CSPm, eglot/lsp-mode wiring, graph commands
vscode/             VS Code extension: `npm run install-extension` builds the server, bundles it, packages and installs
```

## License

Apache License 2.0 (see `LICENSE`). The example programs under
`test/fixtures/processj` come from the ProcessJ compiler repository, also Apache
2.0, University of Nevada, Las Vegas (see `NOTICE`).

## Validated against the real runtime

`npm run validate [dir]` builds every program with the real compiler and runs it with a timeout. A program the checker says will block must hang; a clean program must finish; a program with type errors must not build and run. It runs over `examples/` by default, over the compiler's own corpus with `npm run validate test/fixtures/processj`, and over `test/differential`, whose programs each record what the real compiler and runtime did with them (`// outcome: runs`, `runs-wrong`, `error`, `compiler-limit`, `deadlocks`) so a rule can never quietly contradict them. Every one of those runs is confirmed or informational, none to investigate. Latest run over the examples (a short timeout was used for expected hangs):

| example | checker says | real program | result |
| --- | --- | --- | --- |
| `bug_lookalikes.pj` | clean | finishes | CONFIRMED |
| `channel_direction.pj` | other | hangs (timeout) | informational |
| `channel_types.pj` | other | compiler crashed | n/a |
| `clean_pipeline.pj` | clean | finishes | CONFIRMED |
| `compiler_limits.pj` | other | compiler crashed | n/a |
| `const_from_variable.pj` | other | finishes with the wrong value | compiler bug (runs) |
| `deadlock_read.pj` | blocks | hangs (timeout) | CONFIRMED |
| `overloads.pj` | other | ProcessJc rejects it | informational |
| `par_deadlock.pj` | blocks | hangs (timeout) | CONFIRMED |
| `par_for_shared.pj` | other | hangs (timeout) | informational |
| `parallel_usage.pj` | other | finishes | race (runs) |
| `pri_alt_skip.pj` | other | hangs (timeout) | informational |
| `protocol_fields.pj` | other | compiler crashed | n/a |
| `read_placement.pj` | other | build failed at javac | n/a |
| `self_deadlock.pj` | blocks | hangs (timeout) | CONFIRMED |
| `shared_channel.pj` | other | hangs (timeout) | informational |
| `starving_loop.pj` | blocks | hangs (timeout) | CONFIRMED |
| `typos.pj` | other | compiler crashed | n/a |
| `par_for_body.pj` | other | finishes with the wrong value | informational |
| `shared_unlocked_end.pj` | other | hangs (timeout) | informational |
| `timer_deadline.pj` | other | finishes without waiting | informational |
| `use_import.pj` | clean | build failed at javac | compiler limit (imports) |
| `yield_through_calls.pj` | other | finishes | private-buffer yield repair works |

`other` rows are programs with type errors, races, compatibility warnings, or known compiler miscompilations: some the compiler rejects, some it builds and they hang or misbehave at runtime, which is the point of the checker. The latest run had 6 confirmed predictions, 0 missing-rule/mismatch investigations, and 0 possible false positives. `compiler limit (imports)` means the program is fine but this compiler build cannot link a user library.

### FDR against the real runtime

`node scripts/fdr-validate.js` (after `npm run build`) takes every program of
`test/fixtures/processj`, `test/differential` and `examples`, translates it from
`main`, checks FDR's default assertions, builds and runs it with the real
compiler (4 s timeout) and compares the two; `--no-run` compares with the
recorded `// outcome:` headers instead, and `--markdown` prints this table. In
the "FDR says" column, `deadlock (L12, L17)` gives the lines of the stuck
operations, `runs forever` is a program without deadlock that never ends (a
server), and `integers out of range` is the model's limit. A row's result is

- **CONFIRMED** when FDR's verdict is what the program does: a deadlock and it
  hangs, no deadlock and termination and it finishes, running forever without
  deadlock and it is still running at the timeout, a runtime error and it
  fails. A program that prints an exception and then hangs has failed (a
  process stopped with an error and the others wait for it), which is no
  deadlock;
- **language** when the model follows the language and the translation names
  where the compiled program differs: `pj/shared-unlocked-end` and
  `pj/shared-channel-end` (no lock is taken, so the compiled program hangs
  where the language has no deadlock), `pj/par-for-body`,
  `compiler/loop-labels`, `compiler/par-loop-calls`, `compiler/stop-ignored`,
  `compiler/short-circuit-read`, `compiler/replicated-alt-precondition`,
  `compiler/empty-par-for`. Also
  when the program hangs or fails as FDR says, but the report itself says the
  compiled program may differ from the model (one of these, or
  `compiler/labelled-break`, `pj/starving-loop`, `pj/multiple-alts`,
  `pj/compiler-limit`): it may hang or fail for that reason instead, so the
  run confirms nothing;
- **abstraction** when the counterexample takes an alt's skip or timeout guard
  while a guard written before it could be ready, as its caveat says, and this
  run's scheduler did not, or when the program shares an array or record
  between references (`model/aliasing`);
- **range limit** when a loop counter leaves the inferred integers (the other
  verdicts hold for the runs before that);
- **not built** when the compiler rejects the program, so FDR's verdict is about
  the language only; **not modelled**, **does not parse** (the old `proc`
  syntax), **no main**, **too big** (FDR did not finish in 60 s);
- **MISMATCH** otherwise, which fails the script.

Latest run (FDR 4.2.7, one search worker, 144 programs, about four minutes): 70
confirmed, 19 language, 4 abstraction, 2 range limit, 25 not built, 13 not
modelled, 1 too big, 6 do not parse, 4 without `main`, and no mismatch.
Programs that are clean and agree are listed together per directory:

| program | FDR says | real program | result |
| --- | --- | --- | --- |
| `test/fixtures/processj/NetworkProc.pj` | no deadlock, runs forever | finishes | abstraction |
| `test/fixtures/processj/alttest.pj` | deadlock (L6) | finishes | abstraction |
| `test/fixtures/processj/arr.pj` | not modelled: channel 'c' carries int[], which the model cannot enumerate | finishes | not modelled |
| `test/fixtures/processj/commstime.pj` | no deadlock, integers out of range (L16) | finishes | range limit |
| `test/fixtures/processj/fibonacci.pj` | deadlock (L4) | finishes | language |
| `test/fixtures/processj/fortest.pj` | no deadlock, integers out of range (L11) | finishes | range limit |
| `test/fixtures/processj/fullAdder.pj` | no answer in time | does not build (javac fails) | too big |
| `test/fixtures/processj/integrate.pj` | no deadlock, runs forever | does not build (ProcessJc fails) | not built |
| `test/fixtures/processj/mandelbrot.pj` | not modelled: a par branch receives a int[][] value from its parent, which the model cannot enumerate | finishes | not modelled |
| `test/fixtures/processj/mandelbrot2.pj` | not modelled: a par branch receives a int[][] value from its parent, which the model cannot enumerate | still running after 4 s (finishes after 18 s) | not modelled |
| `test/fixtures/processj/santa.pj` | no deadlock, runs forever | hangs | CONFIRMED |
| `test/fixtures/processj/santapar.pj` | no deadlock, runs forever | hangs | CONFIRMED |
| `test/fixtures/processj/sharedchan.pj` | no deadlock, runs forever | does not build (ProcessJc crashed) | not built |
| `test/fixtures/processj/sharedread.pj` | no deadlock, runs forever | does not build (ProcessJc crashed) | not built |
| `test/fixtures/processj/sharedwrite.pj` | no deadlock, runs forever | hangs | CONFIRMED |
| `test/fixtures/processj/simple.pj` | deadlock (L20) | hangs | CONFIRMED |
| `test/differential/alt_skip_no_writer.pj` | deadlock (L16) | finishes | abstraction |
| `test/differential/alt_timeout_guard.pj` | deadlock (L10) | finishes | abstraction |
| `test/differential/break_after_nested_do.pj` | no deadlock, terminates | hangs after java.lang.NullPointerException | language |
| `test/differential/break_after_nested_for.pj` | deadlock (L14) | hangs after java.lang.NullPointerException | language |
| `test/differential/break_after_par_for.pj` | no deadlock, terminates | hangs | language |
| `test/differential/channel_array_assigned.pj` | not modelled: the channel array 'cs' is modelled only when it is declared with 'new chan<T>[n]' (this ProcessJ build creates its channels only there) | hangs | not modelled |
| `test/differential/channel_array_forms.pj` | not modelled: arrays of channels with more than one dimension are not modelled | finishes | not modelled |
| `test/differential/claim_shared.pj` | not modelled: 'claim' is not modelled | does not build (ProcessJc crashed) | not modelled |
| `test/differential/continue_after_nested_for.pj` | no deadlock, terminates | hangs | language |
| `test/differential/end_in_variable.pj` | not modelled: a variable holding a channel end is not modelled (and does not compile with this ProcessJ build) | does not build (javac fails) | not modelled |
| `test/differential/for_in_for_break.pj` | no deadlock, terminates | hangs | language |
| `test/differential/main_break_after_for.pj` | no deadlock, terminates | hangs | language |
| `test/differential/par_ends_early_gc.pj` | deadlock (L8) | hangs | CONFIRMED |
| `test/differential/par_loop_of_calls.pj` | no deadlock, terminates | hangs | language |
| `test/differential/read_as_index_target.pj` | not modelled: a par branch receives a int[] value from its parent, which the model cannot enumerate | does not build (javac fails) | not modelled |
| `test/differential/read_positions_that_work.pj` | not modelled: a par branch receives a int[] value from its parent, which the model cannot enumerate | finishes | not modelled |
| `test/differential/replicated_alt_precondition.pj` | no deadlock, terminates | fails (exit 1: RuntimeError: One of the boolean pre-guards must be true!) | language |
| `test/differential/shared_inline_writers.pj` | no deadlock, terminates | hangs | language |
| `test/differential/shared_par_for_writers.pj` | no deadlock, terminates | hangs | language |
| `test/differential/shared_readers_first.pj` | no deadlock, terminates | hangs | language |
| `test/differential/shared_unshared_param.pj` | no deadlock, terminates | hangs | language |
| `test/differential/short_circuit_read.pj` | no deadlock, terminates | hangs | language |
| `test/differential/stop_ignored.pj` | deadlock (L4) | finishes | language |
| `test/differential/string_semicolon_and_narrow_literals.pj` | not modelled: 'suspend' (mobile processes) is not modelled | finishes | not modelled |
| `examples/bug_lookalikes.pj` | not modelled: a par branch receives a int[] value from its parent, which the model cannot enumerate | finishes | not modelled |
| `examples/channel_direction.pj` | deadlock (L12, L7, L13) | hangs | CONFIRMED |
| `examples/channel_types.pj` | deadlock (L14) | does not build (ProcessJc crashed) | not built |
| `examples/compiler_limits.pj` | not modelled: records that contain themselves (Node) are not modelled | does not build (ProcessJc crashed) | not modelled |
| `examples/deadlock_read.pj` | deadlock (L8) | hangs | CONFIRMED |
| `examples/dining_philosophers.pj` | deadlock (L28, L18) | hangs | CONFIRMED |
| `examples/dining_philosophers_fixed.pj` | no deadlock, runs forever | hangs | CONFIRMED |
| `examples/par_deadlock.pj` | deadlock (L12, L17) | hangs | CONFIRMED |
| `examples/par_for_shared.pj` | deadlock (L13) | hangs | language |
| `examples/pri_alt_skip.pj` | deadlock (L4) | hangs | CONFIRMED |
| `examples/protocol_fields.pj` | not modelled: 'halt' is not a case of Msg | does not build (ProcessJc crashed) | not modelled |
| `examples/self_deadlock.pj` | deadlock (L10) | hangs | CONFIRMED |
| `examples/shared_channel.pj` | no deadlock, terminates | hangs | language |
| `examples/shared_unlocked_end.pj` | no deadlock, terminates | hangs | language |
| `examples/starving_loop.pj` | no deadlock, runs forever | hangs | language |
| `test/fixtures/fifo/blocks_oob.pj` | no deadlock, array-index (L34) | hangs after java.lang.ArrayIndexOutOfBoundsException | CONFIRMED |
| `test/fixtures/fifo/blocks_skip.pj` | deadlock (L15, L23, L9) | hangs | CONFIRMED |
| test/fixtures/processj/: `Demo.pj`, `barrierEx.pj`, `binexpr.pj`, `bytecode.pj`, `protocolSwitch.pj`, `simplepj.pj` | - | - | does not parse |
| test/fixtures/processj/: `Demo2.pj`, `Demo_matt.pj`, `Hello.pj`, `Matt.pj`, `SwitchDemo.pj`, `array.pj`, `bartest.pj`, `car.pj`, `channelWR.pj`, `enrolledtest.pj`, `iftest.pj`, `parExp.pj`, `protocols.pj`, `readEx.pj`, `recordchan.pj`, `santatest.pj`, `timer.pj`, `verySimple.pj` | no deadlock, terminates | finishes | CONFIRMED |
| test/fixtures/processj/: `localDecl.pj`, `silly.pj`, `test22.pj` | - | - | no main |
| test/differential/: `alt_per_par_branch.pj`, `barrier_enroll.pj`, `both_ends_to_proc.pj`, `break_after_for_nonyield.pj`, `break_after_nested_while.pj`, `break_after_par.pj`, `break_before_nested_for.pj`, `break_in_inner_for.pj`, `break_in_plain_while.pj`, `breaks_that_work.pj`, `const_from_channel_read.pj`, `const_from_variable_in_main.pj`, `extended_rendezvous.pj`, `forwarded_end.pj`, `loop_reader.pj`, `nested_par.pj`, `null_compare.pj`, `par_for_body_statements.pj`, `par_for_shared_even.pj`, `par_loop_in_own_proc.pj`, `pri_alt_precondition.pj`, `proc_only_calls.pj`, `replicated_alt.pj`, `sequential_pars.pj`, `shared_writers_locked.pj`, `switch_break_after_for.pj`, `timeout_is_a_deadline.pj`, `timer_arith.pj`, `two_alts_one_process.pj`, `while_true_with_break.pj` | no deadlock, terminates | finishes | CONFIRMED |
| test/differential/: `alt_timeout_channel_read.pj`, `break_in_par.pj`, `chan_of_string.pj`, `channel_array.pj`, `channel_array_read_in_expression.pj`, `const_from_variable_in_method.pj`, `negated_condition.pj`, `nonvoid_yielding.pj`, `null_assign.pj`, `par_for_twice.pj`, `read_as_array_size.pj`, `read_then_field.pj`, `record_literal_assigned.pj`, `shared_read_param.pj`, `switch_loop_break.pj`, `two_replicated_alts.pj`, `types_mix.pj` | no deadlock, terminates | does not build | not built |
| test/differential/: `array_long_index.pj` | - | - | no main |
| examples/: `channel_array_pipeline.pj`, `clean_pipeline.pj`, `const_from_variable.pj`, `par_for_body.pj`, `parallel_usage.pj`, `timer_deadline.pj`, `yield_through_calls.pj` | no deadlock, terminates | finishes | CONFIRMED |
| examples/: `overloads.pj`, `read_placement.pj`, `typos.pj`, `use_import.pj` | no deadlock, terminates | does not build | not built |
| test/fixtures/fifo/: `blocks.pj` | no deadlock, terminates | finishes | CONFIRMED |

Every verdict that differs from the run says why in its report. FDR finds a
deadlock in five programs that really finish: three where an alt takes its
skip or timeout guard while a guard written before it could be ready
(`alttest.pj`, `alt_skip_no_writer.pj`, `alt_timeout_guard.pj`; `NetworkProc.pj`
can run forever the same way), `stop_ignored.pj` (this build ignores `stop`)
and `fibonacci.pj` (this build runs its `par for` body statement by statement,
so the write and the read of an iteration no longer wait for each other).
Thirteen programs hang while FDR finds no deadlock: the four `test/differential`
programs recorded as `deadlocks` and two examples because this build takes no
lock for a shared channel end used inline or through a plain parameter, five
`runs-wrong` programs because a `break` or `continue` after a nested `for`,
`par for` or `do` jumps to the inner loop's exit, `par_loop_of_calls.pj`
because a par branch looping over suspending calls ends its par early, and
`short_circuit_read.pj` because this build reads `d` in `x > 5 && d.read() > 0`
although `x` is 0. `replicated_alt_precondition.pj` stops with a runtime error
where the language takes the alt's index 2, because this build evaluates the
precondition `i == 2` once, with `i = 0`. Three programs hang as FDR says and
are not confirmed all the same: `break_after_nested_for.pj` hangs because its
consumer stops with a NullPointerException (the `break` after the nested `for`
jumps to the inner loop's exit, `compiler/loop-labels`), not in FDR's deadlock,
in which the consumer has ended and the producer waits to write; for
`par_for_shared.pj` (`pj/par-for-body`, `pj/shared-channel-end`) and
`starving_loop.pj` (`pj/starving-loop`: the scheduler freezes every process,
where the model has one loop running forever) the report says the compiled
program differs from the model, so the hang may have another cause.

`node scripts/fdr-validate.js --procedures [dirs or files]` checks every
procedure with a body (but `main`) on its own instead, as Check with FDR on that
procedure does, and prints a row per procedure: each check's verdict (`RANGE`
where it leaves the modelled integers), not modelled with the reason, FDR
rejecting the model (a translator bug, as is a crash; the exit code is then 1)
or no answer in time, with the arguments a procedure was checked with when its
arguments decide its network. Over `test/fixtures/processj`,
`test/differential`, `examples` and the FIFO coursework (`blocks.pj`), 167
procedures (6 more files do not parse), the latest run (60 s per procedure)
gave 158 verdicts, 0 models FDR rejects, 5 with no answer in time
(`fibonacci.pj`'s `fib`, and the gate and adder procedures of `fullAdder.pj`:
their open environments give FDR too many states; see `//@csp compress` above)
and 4 not modelled, each a
construct the model does not express: channels carrying arrays (`arr.pj`'s
`reader` and `writer`), an array data parameter, which cannot be given every
value (`array_long_index.pj`'s `get`; it is checked through its caller), and
`claim` (`claim_shared.pj`'s `writer`).
