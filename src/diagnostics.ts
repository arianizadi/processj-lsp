/**
 * Turn the ProcessJ compiler's console output into structured diagnostics.
 *
 * The compiler has three distinct reporting paths, each with its own format:
 *
 *  1. CUP parser (`ProcessJ.cup` syntax_error): a "file:line: Syntax error:" line,
 *     a blank line, the source line, and a caret line whose `^` marks the column.
 *     End of input prints "Unexpected end of file." with no location.
 *
 *  2. PJBugManager (name checker and friends): `error[405]: message`, then
 *     `[+] /abs/path.pj:LINE`, then ` ### Token: 'y', line 4 [13:13] (kind: 115)`
 *     where [start:end] are 1-based inclusive columns. Output may carry ANSI colour
 *     codes because `-showColor` is a persisted toggle in the install.
 *
 *  3. Legacy `utilities.Error` (type checker): `file:LINE: message` followed by
 *     `Error number: NNNN` or `Warning number: NNNN`. One of the printers omits the
 *     trailing newline, so the next message can start on the same line as the number.
 *
 * Success is only signalled by the literal banner "** COMPILATION COMPLITED
 * SUCCESSFULLY **" (typo included, the `pjc` script depends on it).
 */

export type Severity = 'error' | 'warning' | 'info';

export interface RawDiagnostic {
  /** 0-based line. -1 means "end of file". */
  line: number;
  /** 0-based start column, when the compiler told us. */
  startCol?: number;
  /** 0-based exclusive end column, when the compiler told us. */
  endCol?: number;
  message: string;
  severity: Severity;
  /** Compiler error number, e.g. "405" or "3029". */
  code?: string;
  /** File name as printed by the compiler (may be relative or absolute). */
  file?: string;
  /** Which reporting path produced this. */
  source: 'parser' | 'bugmanager' | 'legacy' | 'crash' | 'lsp';
}

export interface ParsedOutput {
  diagnostics: RawDiagnostic[];
  succeeded: boolean;
  crash?: string;
}

const ANSI = /\x1b\[[0-9;]*m/g;
const SUCCESS_BANNER = /\*\* COMPILATION COMPL[EI]TED SUCCESSFULLY \*\*/;
const PROGRESS_LINE = /^-- /;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

export function parseCompilerOutput(stdout: string, stderr: string): ParsedOutput {
  const text = stripAnsi(stdout);
  const err = stripAnsi(stderr);
  const succeeded = SUCCESS_BANNER.test(text);
  const diagnostics: RawDiagnostic[] = [];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 1a. Parser: "file:line: Syntax error:" + blank + source + caret.
    const syn = /^(.*?):(\d+): Syntax error:\s*$/.exec(line);
    if (syn) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      const src = lines[j] ?? '';
      const caret = lines[j + 1] ?? '';
      const col = caret.indexOf('^');
      const d: RawDiagnostic = {
        file: syn[1],
        line: Number(syn[2]) - 1,
        message: 'Syntax error',
        severity: 'error',
        code: 'syntax',
        source: 'parser',
      };
      if (col >= 0) {
        d.startCol = col;
        const tok = /^\S+/.exec(src.slice(col));
        d.endCol = col + (tok ? tok[0].length : 1);
      }
      diagnostics.push(d);
      i = j + 1;
      continue;
    }

    // 1b. Parser: unexpected end of file.
    if (line.startsWith('Unexpected end of file.')) {
      diagnostics.push({
        line: -1,
        message: 'Unexpected end of file (unbalanced braces or an unfinished statement)',
        severity: 'error',
        code: 'syntax',
        source: 'parser',
      });
      continue;
    }

    // 2. PJBugManager: "error[405]: msg" / "[+] file:line" / " ### Token: 'y', line 4 [13:13] ..."
    const bug = /^(error|warning|info)\[(\d+)\]:\s*(.*)$/.exec(line);
    if (bug) {
      const d: RawDiagnostic = {
        severity: bug[1] as Severity,
        code: bug[2],
        message: bug[3].trim(),
        line: 0,
        source: 'bugmanager',
      };
      let j = i + 1;
      const loc = /^\[\+\]\s+(.*?):(\d+)\s*$/.exec(lines[j] ?? '');
      if (loc) {
        d.file = loc[1];
        d.line = Number(loc[2]) - 1;
        j++;
      }
      const tok = /^\s*###\s+Token:\s+'(.*)',\s+line\s+(\d+)\s+\[(\d+):(\d+)\]/.exec(lines[j] ?? '');
      if (tok) {
        d.line = Number(tok[2]) - 1;
        d.startCol = Number(tok[3]) - 1;
        d.endCol = Number(tok[4]);
        j++;
      }
      diagnostics.push(d);
      i = j - 1;
      continue;
    }
  }

  // 3. Legacy Error.java: "file:LINE: message\nError number: N", possibly glued to the next message.
  const legacy = /([^\s:][^\n:]*?):(\d+): ([^\n]*?)\s*\n\s*(Error|Warning) number: (\d+)/g;
  for (let m = legacy.exec(text); m; m = legacy.exec(text)) {
    diagnostics.push({
      file: m[1],
      line: Number(m[2]) - 1,
      message: m[3].trim(),
      severity: m[4] === 'Warning' ? 'warning' : 'error',
      code: m[5],
      source: 'legacy',
    });
  }

  // 4. Uncaught exceptions inside the compiler itself.
  const crashSource = /Exception in thread "main"/.test(err) ? err : /Exception in thread "main"/.test(text) ? text : '';
  let crash: string | undefined;
  if (crashSource) {
    const at = crashSource.indexOf('Exception in thread "main"');
    const head = crashSource.slice(at).split(/\r?\n/);
    const first = head[0].replace(/^Exception in thread "main"\s*/, '');
    const frame = head.find((l) => /^\s+at\s+/.test(l))?.trim();
    crash = frame ? `${first} (${frame})` : first;
    diagnostics.push({
      line: 0,
      message: 'The ProcessJ compiler crashed on this file, so it cannot be built; the code itself may be correct (details in the server log)',
      severity: 'warning',
      code: 'crash',
      source: 'crash',
    });
  }

  // 5. Failure with nothing parseable: surface the last meaningful line.
  if (!succeeded && diagnostics.length === 0) {
    const tail = lines
      .map((l) => l.trim())
      .filter((l) => l && !PROGRESS_LINE.test(l))
      .pop();
    diagnostics.push({
      line: 0,
      message: tail ? `ProcessJ compiler failed: ${tail}` : 'ProcessJ compiler failed without a message',
      severity: 'error',
      code: 'unknown',
      source: 'lsp',
    });
  }

  return { diagnostics: dedupe(diagnostics), succeeded, crash };
}

/** The name checker and the type checker often report the same problem on the same line; keep one. */
function dedupe(diags: RawDiagnostic[]): RawDiagnostic[] {
  const seen = new Set<string>();
  const out: RawDiagnostic[] = [];
  for (const d of diags) {
    const key = `${d.line}|${d.startCol ?? ''}|${d.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out;
}
