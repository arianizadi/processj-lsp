import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Install } from './config';
import type { RawDiagnostic } from './diagnostics';
import { parse } from './parser/parser';
import { augmentYieldAnnotations, mapYieldGeneratedRange, type YieldAnnotationContext, type YieldSourceMap } from './yieldfix';

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
  /** Called with each chunk of standard output as it arrives (decoded). */
  onStdout?: (chunk: string) => void;
  /** Called once the process has started, with its pid (on POSIX also its process group). */
  onSpawn?: (pid: number) => void;
}

/** Children still running, so a server shutdown can take its JVMs with it. */
const liveChildren = new Set<ChildProcess>();
/** After the child exits, wait at most this long for a descendant holding its pipes before giving up on more output. */
const STREAM_GRACE_MS = 500;

/** Kill the process (on POSIX its whole process group, so wrappers cannot leave a grandchild behind). */
function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

/** Stop every process this module started. Called when the server shuts down. */
export function killAllChildren(): void {
  for (const child of liveChildren) killTree(child);
}

/**
 * Private temporary directories still on disk (compiler sandboxes, FDR's
 * working copies): in use, or with their removal still running. A sandbox is
 * removed in the background once its compiler run is over (the keystroke path
 * never waits for it), so a process that exits meanwhile removes what is left
 * at once, before it goes.
 */
const privateDirs = new Set<string>();

/** A new private directory in the system's temporary directory (`prefix` and a random suffix), removed at exit at the latest. */
export function makePrivateDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  privateDirs.add(dir);
  return dir;
}

/** Remove a directory made by makePrivateDir: in the background, or at once with `now`. */
export function removePrivateDir(dir: string, now = false): void {
  if (now) {
    removeNow(dir);
    privateDirs.delete(dir);
    return;
  }
  // Until the removal has finished, an exit removes the directory itself.
  fs.rm(dir, { recursive: true, force: true }, (error) => {
    if (!error) privateDirs.delete(dir);
  });
}

/** Remove every private directory still on disk, synchronously. Called when the server shuts down and when the process exits. */
export function removeAllPrivateDirs(): void {
  for (const dir of privateDirs) removeNow(dir);
  privateDirs.clear();
}

function removeNow(dir: string): void {
  try {
    // A JVM killed a moment ago may still be writing into it: retry a directory that is not empty yet.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 });
  } catch {
    /* best effort */
  }
}

// `exit` also fires for process.exit(), which is how the LSP library ends the
// server (after `exit`, or when its input closes); killing and removing are
// synchronous, so neither a JVM nor a private directory survives a shutdown,
// a signal or a crash. (SIGKILL ends a process before any of this can run.)
process.on('exit', () => {
  killAllChildren();
  removeAllPrivateDirs();
});
// Children live in their own process group, so a signal aimed at the server's
// group (Ctrl-C in a terminal, an editor killing its subprocesses) no longer
// reaches them by itself; take them along, then exit as the default would.
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
  process.once(signal, () => {
    killAllChildren();
    process.exit();
  });
}

/** Run a process, capture its output, kill it on timeout or abort. */
export function exec(cmd: string, args: string[], opts: ExecOptions): Promise<ExecResult> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const maxOutput = opts.maxOutput ?? 2_000_000;
  const started = Date.now();
  // A queued check may have been invalidated before it starts. In particular,
  // never attempt to kill a child whose spawn has not succeeded yet.
  if (opts.signal?.aborted) return Promise.resolve({ stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: true, durationMs: 0 });
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let done = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    // Its own process group on POSIX, so a timeout or abort can kill the JVM
    // together with anything it spawned.
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    liveChildren.add(child);
    if (child.pid) opts.onSpawn?.(child.pid);
    // Decode as a stream: a multi-byte character split across two chunks must not become U+FFFD.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => {
      if (stdout.length < maxOutput) stdout += d;
      opts.onStdout?.(d);
    });
    child.stderr.on('data', (d: string) => {
      if (stderr.length < maxOutput) stderr += d;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    if (opts.signal?.aborted) onAbort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const finish = (code: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      liveChildren.delete(child);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ stdout, stderr, exitCode: code, timedOut, aborted, durationMs: Date.now() - started });
    };
    child.on('error', (err) => {
      stderr += `\n${String(err)}`;
      finish(null);
    });
    // `close` waits for the stdio pipes, which a surviving descendant may keep
    // open forever. Give trailing output a moment after `exit`, then finish anyway.
    child.on('exit', (code) => {
      graceTimer = setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        finish(code);
      }, STREAM_GRACE_MS);
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
  /** Maps token columns in the private compiler copy back to the editor text. */
  yieldSourceMap: YieldSourceMap;
  /** Why the compiler must not run on these files (it would write outside the sandbox); it is then not started. */
  refused?: { message: string; file: string; line: number };
  cleanup: () => void;
}

/** A package root the compiler must be able to see from the sandbox, exactly as import resolution found it. */
export interface ImportMirror {
  /** First segment of the import path (`geom` for `import geom.shapes;`). */
  name: string;
  /** The directory or file that segment resolved to. */
  target: string;
}

/**
 * The compiler's working directory for one run: a private copy of the
 * document, read-only copies of the .pj files its imports reach, and a home
 * of its own. Nothing in it links out: the compiler writes generated
 * libraries to paths built from `#pragma FILE` and the package name, and a
 * link to a directory of the workspace would let those writes land there
 * (or, through a link the workspace contains, anywhere). A `#pragma FILE`
 * that names a path rather than a file name would leave the directory by
 * itself, so the compiler is not run on such files (Sandbox.refused).
 */
export function makeSandbox(install: Install, sourcePath: string, text: string, yieldContext?: YieldAnnotationContext, mirrors: readonly ImportMirror[] = []): Sandbox {
  const root = makePrivateDir('processj-lsp-');
  const home = path.join(root, '.pjlsp-home');
  const work = path.join(home, 'work');
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(path.join(home, 'processjrc'), `workingdir=work\ninstalldir=${install.installDir}\n`);
  const base = path.basename(sourcePath);
  const fileName = base.endsWith('.pj') ? base : 'buffer.pj';
  const src = path.join(root, fileName);
  const augmented = augmentYieldAnnotations(text, yieldContext);
  fs.writeFileSync(src, augmented.text);
  // Java canonicalizes macOS' /var symlink to /private/var when it reports a
  // diagnostic. Capture the same stable spelling while the temp file exists;
  // compile() starts asynchronous cleanup before the server maps diagnostics.
  const canonicalSourcePath = fs.realpathSync(src);
  let refused = unsafeLibraryFile(augmented.text, sourcePath);
  // The compiler resolves `import a.b;` relative to its working directory before the include directory:
  // the files the imports reach from the file's own directory (then from the workspace package roots)
  // are copied to the same relative paths here, as `pjc` run next to the file would find them.
  const dir = path.dirname(sourcePath);
  const copied = path.isAbsolute(dir) ? copyImports(augmented.text, root, fileName, dir, mirrors) : [];
  for (const copy of copied) refused ??= unsafeLibraryFile(copy.text, copy.source);
  return {
    root,
    home,
    work,
    fileName,
    sourcePath: canonicalSourcePath,
    yieldSourceMap: augmented.sourceMap,
    ...(refused ? { refused } : {}),
    cleanup: () => removePrivateDir(root),
  };
}

/** Most files and characters copied into one sandbox (as many files as a wildcard import may reach). */
const MAX_SANDBOX_FILES = 2000;
const MAX_SANDBOX_CHARS = 32_000_000;
const MAX_PACKAGE_DEPTH = 8;

/**
 * Copy into `root` every .pj file the imports of `text` reach, transitively,
 * looking where the compiler would from a working directory that holds the
 * file's own directory (`dir`) and the workspace package roots (`mirrors`).
 * The copies are regular files, read-only, in real directories.
 */
function copyImports(text: string, root: string, fileName: string, dir: string, mirrors: readonly ImportMirror[]): Array<{ source: string; text: string }> {
  const copied: Array<{ source: string; text: string }> = [];
  const taken = new Set<string>([fileName]);
  let chars = 0;
  const full = (): boolean => copied.length >= MAX_SANDBOX_FILES || chars >= MAX_SANDBOX_CHARS;
  const copy = (source: string, relative: string): void => {
    if (full() || taken.has(relative)) return;
    let content: string;
    try {
      if (!fs.statSync(source).isFile()) return;
      content = fs.readFileSync(source, 'utf8');
    } catch {
      return;
    }
    taken.add(relative);
    chars += content.length;
    const target = path.join(root, relative);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, { flag: 'wx' });
      if (process.platform !== 'win32') fs.chmodSync(target, 0o444);
    } catch {
      return;
    }
    copied.push({ source, text: content });
    queue.push(content);
  };
  /** Where an import is found: next to the file, else under the workspace package root of its first segment. */
  const locate = (parts: string[], wildcard: boolean): string | undefined => {
    const bases = [dir];
    for (const mirror of mirrors) {
      if (!mirror.name || mirror.name.startsWith('.') || mirror.name.includes('/') || mirror.name.includes(path.sep)) continue;
      if (mirror.name === parts[0] || mirror.name === `${parts[0]}.pj`) bases.push(path.dirname(mirror.target));
    }
    for (const base of bases) {
      const target = path.join(base, ...parts);
      if (wildcard ? isDirectory(target) : isFile(`${target}.pj`)) return target;
    }
    return undefined;
  };
  const queue: string[] = [text];
  for (let next = queue.shift(); next !== undefined && !full(); next = queue.shift()) {
    let imports: ReturnType<typeof parse>['program']['imports'];
    try {
      imports = parse(next).program.imports;
    } catch {
      continue;
    }
    for (const im of imports) {
      const parts = im.path.map((part) => part.name);
      if (!parts.length || parts.some((part) => !part || part.startsWith('.'))) continue;
      const target = locate(parts, im.wildcard);
      if (!target) continue;
      if (!im.wildcard) {
        copy(`${target}.pj`, `${path.join(...parts)}.pj`);
        continue;
      }
      // `import a.*;` reads every .pj file under a/, sub-packages included (imports.ts listPj).
      const walk = (from: string, relative: string, depth: number): void => {
        if (depth > MAX_PACKAGE_DEPTH || full()) return;
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(from, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const source = path.join(from, entry.name);
          if (entry.name.endsWith('.pj')) copy(source, path.join(relative, entry.name));
          else if (isDirectory(source)) walk(source, path.join(relative, entry.name), depth + 1);
        }
      };
      walk(target, path.join(...parts), 0);
    }
  }
  return copied;
}

/**
 * The first `#pragma FILE "..."` of a file whose value is not a plain file
 * name: the compiler builds a library's output paths from it (and the
 * package name), so `/../x` or an absolute path would write outside its
 * working directory.
 */
function unsafeLibraryFile(text: string, file: string): Sandbox['refused'] {
  const pragma = /#\s*pragma\s+file\s*"([^"\n]*)"/gi;
  for (let m = pragma.exec(text); m; m = pragma.exec(text)) {
    const value = m[1];
    if (/^[A-Za-z0-9_][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/.test(value)) continue;
    const line = (text.slice(0, m.index).match(/\n/g) ?? []).length;
    return { message: `#pragma FILE "${value}" is not a plain file name, so the compiler (which writes the library's files to a path made from it) is not run on ${path.basename(file)}`, file, line };
  }
  return undefined;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(file: string): boolean {
  try {
    return fs.statSync(file).isDirectory();
  } catch {
    return false;
  }
}

/** Arguments for running the ProcessJ compiler front end inside a sandbox. */
export function processjcArgs(install: Install, sb: Sandbox): string[] {
  return [`-Duser.home=${sb.home}`, '-cp', install.classpath, 'ProcessJc', '-include', install.includeDir, sb.fileName];
}

export interface CompileResult extends ExecResult {
  sourcePath: string;
  yieldSourceMap: YieldSourceMap;
  /** The compiler was not run (Sandbox.refused). */
  refused?: Sandbox['refused'];
}

/** Whether a compiler message belongs to the private copy of the current file. */
export function compilerDiagnosticTargetsBuffer(
  result: Pick<CompileResult, 'sourcePath'>,
  diagnostic: Pick<RawDiagnostic, 'file'>,
): boolean {
  if (!diagnostic.file) return true;
  const sourcePath = path.resolve(result.sourcePath);
  const reported = path.normalize(diagnostic.file);
  // The compiler normally prints just the input filename for the root unit.
  // A relative path with directories, however, identifies an imported unit.
  const candidate = path.isAbsolute(reported)
    ? path.resolve(reported)
    : path.dirname(reported) === '.'
      ? path.join(path.dirname(sourcePath), reported)
      : path.resolve(path.dirname(sourcePath), reported);
  return process.platform === 'win32'
    ? candidate.toLowerCase() === sourcePath.toLowerCase()
    : candidate === sourcePath;
}

/** Translate only diagnostics emitted for the augmented private buffer. */
export function remapCompilerDiagnostic(
  result: Pick<CompileResult, 'sourcePath' | 'yieldSourceMap'>,
  diagnostic: RawDiagnostic,
): RawDiagnostic {
  if (diagnostic.line < 0 || !compilerDiagnosticTargetsBuffer(result, diagnostic)) return diagnostic;
  const mapped = mapYieldGeneratedRange(result.yieldSourceMap, diagnostic.line, diagnostic.startCol, diagnostic.endCol);
  if (mapped.startCol === diagnostic.startCol && mapped.endCol === diagnostic.endCol) return diagnostic;
  return { ...diagnostic, ...mapped };
}

/** Run only the ProcessJ compiler (front end + Java codegen) over `text`, for diagnostics. */
export async function compile(install: Install, sourcePath: string, text: string, opts: { timeoutMs?: number; signal?: AbortSignal; yieldContext?: YieldAnnotationContext; mirrors?: readonly ImportMirror[] } = {}): Promise<CompileResult> {
  const sb = makeSandbox(install, sourcePath, text, opts.yieldContext, opts.mirrors);
  try {
    if (sb.refused) return { stdout: '', stderr: '', exitCode: null, timedOut: false, aborted: false, durationMs: 0, sourcePath: sb.sourcePath, yieldSourceMap: sb.yieldSourceMap, refused: sb.refused };
    const r = await exec(install.javaBin, processjcArgs(install, sb), { cwd: sb.root, timeoutMs: opts.timeoutMs, signal: opts.signal });
    return { ...r, sourcePath: sb.sourcePath, yieldSourceMap: sb.yieldSourceMap };
  } finally {
    sb.cleanup();
  }
}
