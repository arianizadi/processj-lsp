/**
 * The full ProcessJ build pipeline, re-implemented from the `pjc` shell script but
 * isolated in a temp directory and judged by exit codes rather than by grepping
 * the last line of output:
 *
 *   ProcessJc  ->  javac --release 8  ->  GotoLabelRewrite (ASM)  ->  Instrumenter (ASM)  ->  java <Main>
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Install } from './config';
import { exec, makeSandbox, processjcArgs, type ExecResult, type Sandbox } from './compiler';
import { parseCompilerOutput, stripAnsi } from './diagnostics';
import type { YieldAnnotationContext } from './yieldfix';

export interface Stage {
  name: string;
  ok: boolean;
  durationMs: number;
  output: string;
}

export interface BuildResult {
  ok: boolean;
  stages: Stage[];
  mainClass: string;
  /** Generated Java source, when the first stage got that far. */
  javaSource?: string;
  sandbox: Sandbox;
}

export interface RunResult {
  stages: Stage[];
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
}

function javacFor(install: Install): string {
  if (path.isAbsolute(install.javaBin)) {
    const candidate = path.join(path.dirname(install.javaBin), 'javac');
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'javac';
}

function stage(name: string, r: ExecResult, ok: boolean): Stage {
  const output = [stripAnsi(r.stdout), stripAnsi(r.stderr)].filter((s) => s.trim()).join('\n').trim();
  return { name, ok, durationMs: r.durationMs, output: r.timedOut ? `${output}\n(timed out)` : output };
}

export async function build(install: Install, sourcePath: string, text: string, opts: { timeoutMs?: number; signal?: AbortSignal; yieldContext?: YieldAnnotationContext } = {}): Promise<BuildResult> {
  const sb = makeSandbox(install, sourcePath, text, opts.yieldContext);
  const mainClass = path.basename(sb.fileName, '.pj');
  const stages: Stage[] = [];
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const common = { timeoutMs, signal: opts.signal };
  const asmJar = path.join(install.installDir, 'resources', 'jars', 'asm-all-5.2.jar');
  const binDir = path.join(install.installDir, 'bin');
  const libJvm = path.join(install.installDir, 'lib', 'JVM');
  const result: BuildResult = { ok: false, stages, mainClass, sandbox: sb };

  // 1. ProcessJ compiler: exit code is unreliable, so we look for the success banner.
  const pjc = await exec(install.javaBin, processjcArgs(install, sb), { cwd: sb.root, ...common });
  const parsed = parseCompilerOutput(pjc.stdout, pjc.stderr);
  const javaFile = path.join(sb.work, `${mainClass}.java`);
  const generated = parsed.succeeded && fs.existsSync(javaFile);
  stages.push(stage('ProcessJc', pjc, generated));
  if (generated) result.javaSource = fs.readFileSync(javaFile, 'utf8');
  if (!generated) return result;

  // 2. javac. Standard-library sources live in lib/JVM and are compiled on demand.
  const javaFiles = fs.readdirSync(sb.work).filter((f) => f.endsWith('.java')).map((f) => path.join(sb.work, f));
  const javac = await exec(javacFor(install), ['--release', '8', '-nowarn', '-cp', `${binDir}${path.delimiter}${libJvm}`, '-sourcepath', libJvm, '-d', sb.work, ...javaFiles], { cwd: sb.work, ...common });
  stages.push(stage('javac', javac, javac.exitCode === 0));
  if (javac.exitCode !== 0) return result;

  // 3 + 4. Bytecode rewriting: turn the yield/label/resume markers into real jumps.
  const asmCp = [binDir, asmJar, '.'].join(path.delimiter);
  const goto = await exec(install.javaBin, ['-cp', asmCp, 'instrument.GotoLabelRewrite', '.'], { cwd: sb.work, ...common });
  const gotoOk = goto.exitCode === 0 && /\*\* REWRITING DONE \*\*/.test(goto.stdout);
  stages.push(stage('GotoLabelRewrite', goto, gotoOk));
  if (!gotoOk) return result;

  const instr = await exec(install.javaBin, ['-cp', asmCp, 'instrument.Instrumenter', '.'], { cwd: sb.work, ...common });
  // The instrumenter prints its success banner even after an exception, so also require a clean stderr.
  const instrOk = instr.exitCode === 0 && /\*\* INSTRUMENTATION SUCCEEDED \*\*/.test(instr.stdout) && !/Exception/.test(instr.stderr);
  stages.push(stage('Instrumenter', instr, instrOk));
  if (!instrOk) return result;

  result.ok = true;
  return result;
}

export async function run(install: Install, built: BuildResult, opts: { timeoutMs?: number; signal?: AbortSignal; maxOutput?: number } = {}): Promise<RunResult> {
  const libJvm = path.join(install.installDir, 'lib', 'JVM');
  const cp = [path.join(install.installDir, 'bin'), libJvm, '.'].join(path.delimiter);
  const r = await exec(install.javaBin, ['-cp', cp, built.mainClass], { cwd: built.sandbox.work, timeoutMs: opts.timeoutMs ?? 30_000, signal: opts.signal, maxOutput: opts.maxOutput ?? 500_000 });
  const stages = [...built.stages, stage('run', r, r.exitCode === 0 && !r.timedOut)];
  const output = [r.stdout, r.stderr].filter((s) => s.trim()).join('\n');
  return { stages, output, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs };
}

/** Human-readable report for a build (and optional run), shown in the editor. */
export function formatReport(fileName: string, stages: Stage[], extra?: { output?: string; exitCode?: number | null; timedOut?: boolean }): string {
  const lines: string[] = [`ProcessJ: ${fileName}`, ''];
  for (const s of stages) {
    lines.push(`== ${s.name.padEnd(17)} ${s.ok ? 'ok ' : 'FAILED'} ${String(s.durationMs).padStart(6)} ms`);
    if (!s.ok && s.output) lines.push(indent(s.output), '');
  }
  if (extra) {
    lines.push('');
    if (extra.timedOut) lines.push('The program did not finish before the timeout. If it printed nothing new, it is probably deadlocked: every process is blocked and the scheduler is spinning.');
    else if (extra.exitCode !== undefined) lines.push(`exit code ${extra.exitCode}`);
    lines.push('', '---- program output ----', extra.output?.trimEnd() ?? '');
  }
  return lines.join('\n') + '\n';
}

function indent(s: string): string {
  return s
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}
