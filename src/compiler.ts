import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Install } from './config';
import { withYieldAnnotations } from './yieldfix';

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Stop collecting output past this many characters (program runs can be chatty). */
  maxOutput?: number;
}

/** Run a process, capture its output, kill it on timeout or abort. */
export function exec(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxOutput = opts.maxOutput ?? 2_000_000;
  const started = Date.now();
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let done = false;

    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => {
      if (stdout.length < maxOutput) stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < maxOutput) stderr += d.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, exitCode: code, timedOut, aborted, durationMs: Date.now() - started });
    };
    child.on('error', (err) => {
      stderr += `\n${String(err)}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

/**
 * A private directory layout for one compiler invocation.
 *
 * The compiler reads `processjrc` from the JVM's `user.home`, so we point
 * `-Duser.home` at `home/` with a `processjrc` of our own. Generated Java then
 * lands in `home/work/` and the user's real `~/workingpj` (which `pjc` wipes on
 * every build) is never touched.
 */
export interface Sandbox {
  root: string;
  home: string;
  work: string;
  fileName: string;
  sourcePath: string;
  cleanup: () => void;
}

export function makeSandbox(install: Install, sourcePath: string, text: string): Sandbox {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'processj-lsp-'));
  const home = path.join(root, '.pjlsp-home');
  const work = path.join(home, 'work');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(home, 'processjrc'), `workingdir=work\ninstalldir=${install.installDir}\n`);
  const base = path.basename(sourcePath);
  const fileName = base.endsWith('.pj') ? base : 'buffer.pj';
  const src = path.join(root, fileName);
  fs.writeFileSync(src, withYieldAnnotations(text));
  // The compiler resolves `import a.b;` relative to its working directory before the
  // include directory, so mirror the file's own directory here with symlinks (no copies):
  // sibling .pj files and subdirectories become visible exactly as with `pjc`.
  const dir = path.dirname(sourcePath);
  if (path.isAbsolute(dir)) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      /* buffer without a directory on disk */
    }
    for (const e of entries) {
      if (e.name === fileName || e.name.startsWith('.')) continue;
      if (!(e.isDirectory() || (e.isFile() && e.name.endsWith('.pj')))) continue;
      try {
        fs.symlinkSync(path.join(dir, e.name), path.join(root, e.name));
      } catch {
        /* a name clash or unsupported symlinks: the compiler just won't see this entry */
      }
    }
  }
  return {
    root,
    home,
    work,
    fileName,
    sourcePath: src,
    cleanup: () => fs.rm(root, { recursive: true, force: true }, () => {}),
  };
}

/** Arguments for running the ProcessJ compiler front end inside a sandbox. */
export function processjcArgs(install: Install, sb: Sandbox): string[] {
  return [`-Duser.home=${sb.home}`, '-cp', install.classpath, 'ProcessJc', '-include', install.includeDir, sb.fileName];
}

export interface CompileResult extends ExecResult {
  sourcePath: string;
}

/** Run only the ProcessJ compiler (front end + Java codegen) over `text`, for diagnostics. */
export async function compile(install: Install, sourcePath: string, text: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CompileResult> {
  const sb = makeSandbox(install, sourcePath, text);
  try {
    const r = await exec(install.javaBin, processjcArgs(install, sb), { cwd: sb.root, timeoutMs: opts.timeoutMs, signal: opts.signal });
    return { ...r, sourcePath: sb.sourcePath };
  } finally {
    sb.cleanup();
  }
}
