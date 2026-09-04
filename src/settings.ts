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
  /** Offer inline Run, Build, effect, graph, and protocol code lenses. */
  codeLens: boolean;
}

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  installDir: undefined,
  javaBin: undefined,
  debounceMs: 400,
  timeoutMs: 20_000,
  checkOnChange: false,
  runTimeoutMs: 30_000,
  lint: true,
  codeLens: true,
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
  };
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
