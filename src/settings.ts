/** Validated initialization options. Untrusted LSP clients cannot create zero-delay loops or endless processes. */
export interface Settings {
  installDir?: string;
  javaBin?: string;
  /** Delay after the last keystroke before the compiler runs. */
  debounceMs: number;
  /** Kill the compiler after this long. */
  timeoutMs: number;
  /** Run the real compiler on every change, rather than only open/save. */
  checkOnChange: boolean;
  /** Kill a program started from the Run command after this long. */
  runTimeoutMs: number;
  /** Turn the built-in static analysis on or off. */
  lint: boolean;
  /** Offer inline Run, Build, effect, graph, protocol and FDR code lenses. */
  codeLens: boolean;
  /** Serve the graph viewer on a loopback-only local web server that follows edits; when off, the viewer is written to a file. */
  liveViewer: boolean;
  /** FDR's `refines` (or FDR's install directory); found on PATH and in the usual places when unset. */
  fdrPath?: string;
  /** Kill an FDR check after this long. */
  fdrTimeoutMs: number;
  /** Kill an FDR check once refines uses more memory than this (MB); 0: half of this machine's memory, at most 8 GB. */
  fdrMemoryMb: number;
  /**
   * refines' BFS workers: with 1 a deadlock or runtime-error counterexample is the same on every run (a
   * termination or determinism one can still differ: those searches are not this one); 0 uses every core
   * (faster on big models).
   */
  fdrWorkers: number;
  /**
   * After Check with FDR, open the graph viewer on the result: when a check
   * fails (`onFailure`), after every check (`always`), or never (the text
   * report opens instead, as it also does when the graph is not shown).
   */
  fdrShowGraph: FdrShowGraph;
}

export type FdrShowGraph = 'onFailure' | 'always' | 'never';
const FDR_SHOW_GRAPH: readonly FdrShowGraph[] = ['onFailure', 'always', 'never'];

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  installDir: undefined,
  javaBin: undefined,
  debounceMs: 400,
  timeoutMs: 20_000,
  checkOnChange: false,
  runTimeoutMs: 30_000,
  lint: true,
  codeLens: true,
  liveViewer: true,
  fdrPath: undefined,
  fdrTimeoutMs: 120_000,
  fdrMemoryMb: 0,
  fdrWorkers: 1,
  fdrShowGraph: 'onFailure',
});

export function normalizeSettings(value: unknown): Settings {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    installDir: nonEmptyString(raw.installDir),
    javaBin: nonEmptyString(raw.javaBin),
    debounceMs: boundedInteger(raw.debounceMs, DEFAULT_SETTINGS.debounceMs, 0, 60_000),
    timeoutMs: boundedInteger(raw.timeoutMs, DEFAULT_SETTINGS.timeoutMs, 100, 600_000),
    checkOnChange: boolean(raw.checkOnChange, DEFAULT_SETTINGS.checkOnChange),
    runTimeoutMs: boundedInteger(raw.runTimeoutMs, DEFAULT_SETTINGS.runTimeoutMs, 100, 3_600_000),
    lint: boolean(raw.lint, DEFAULT_SETTINGS.lint),
    codeLens: boolean(raw.codeLens, DEFAULT_SETTINGS.codeLens),
    liveViewer: boolean(raw.liveViewer, DEFAULT_SETTINGS.liveViewer),
    fdrPath: nonEmptyString(raw.fdrPath),
    fdrTimeoutMs: boundedInteger(raw.fdrTimeoutMs, DEFAULT_SETTINGS.fdrTimeoutMs, 1_000, 3_600_000),
    fdrMemoryMb: boundedInteger(raw.fdrMemoryMb, DEFAULT_SETTINGS.fdrMemoryMb, 0, 1_048_576),
    fdrWorkers: boundedInteger(raw.fdrWorkers, DEFAULT_SETTINGS.fdrWorkers, 0, 1_024),
    fdrShowGraph: oneOf(raw.fdrShowGraph, FDR_SHOW_GRAPH, DEFAULT_SETTINGS.fdrShowGraph),
  };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}
