import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** A resolved ProcessJ installation plus everything needed to invoke its compiler. */
export interface Install {
  installDir: string;
  includeDir: string;
  javaBin: string;
  classpath: string;
}

export interface InstallOptions {
  /** Explicit install directory (editor initializationOptions.installDir). */
  installDir?: string;
  /** Explicit java executable (editor initializationOptions.javaBin). */
  javaBin?: string;
  /** Home directory to read processjrc from (tests override this). */
  home?: string;
  /** Environment to consult (tests override this). */
  env?: NodeJS.ProcessEnv;
}

/** Jars the compiler needs at runtime, relative to <install>/resources/jars. Mirrors the `pjc` script. */
const RUNTIME_JARS = ['java_cup_runtime.jar', 'ST-4.0.7.jar', 'asm-all-5.2.jar'];

/** Parse a `key=value` file such as ~/processjrc. Lines starting with `#` are comments. */
export function parseRcFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

export function readProcessjrc(home: string): Record<string, string> {
  try {
    return parseRcFile(fs.readFileSync(path.join(home, 'processjrc'), 'utf8'));
  } catch {
    return {};
  }
}

function expandHome(p: string, home: string): string {
  return p.replace(/^~(?=$|\/)/, home);
}

export function isInstallDir(dir: string): boolean {
  return (
    fs.existsSync(path.join(dir, 'bin', 'ProcessJc.class')) &&
    RUNTIME_JARS.every((j) => fs.existsSync(path.join(dir, 'resources', 'jars', j)))
  );
}

/**
 * Locate the ProcessJ install. Precedence: explicit option, PROCESSJ_HOME, then
 * `installdir=` in ~/processjrc (the same file the `pjc` script reads).
 */
export function findInstall(opts: InstallOptions = {}): Install | { error: string } {
  const home = opts.home ?? os.homedir();
  const env = opts.env ?? process.env;
  const rc = readProcessjrc(home);

  const candidates = [opts.installDir, env.PROCESSJ_HOME, rc.installdir]
    .filter((c): c is string => typeof c === 'string' && c.length > 0)
    .map((c) => path.resolve(expandHome(c, home)));

  for (const dir of candidates) {
    if (isInstallDir(dir)) return buildInstall(dir, opts.javaBin, env);
  }

  if (candidates.length === 0) {
    return {
      error:
        'No ProcessJ install configured. Set installdir=... in ~/processjrc, export PROCESSJ_HOME, or pass initializationOptions.installDir.',
    };
  }
  return {
    error: `No ProcessJ install found (need bin/ProcessJc.class and resources/jars). Tried: ${candidates.join(', ')}`,
  };
}

function buildInstall(dir: string, javaBin: string | undefined, env: NodeJS.ProcessEnv): Install {
  const jars = RUNTIME_JARS.map((j) => path.join(dir, 'resources', 'jars', j));
  // The install dir itself is on the classpath because the compiler loads its
  // StringTemplate groups and properties files as classpath resources.
  const classpath = [path.join(dir, 'bin'), ...jars, dir].join(path.delimiter);
  const java = javaBin ?? (env.JAVA_HOME ? path.join(env.JAVA_HOME, 'bin', 'java') : 'java');
  return { installDir: dir, includeDir: path.join(dir, 'include'), javaBin: java, classpath };
}
