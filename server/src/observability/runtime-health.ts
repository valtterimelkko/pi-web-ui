import type { RuntimeBackendMode, SessionRuntime } from '../internal-api/types.js';

export type RuntimeCheckStatus = 'ok' | 'unavailable' | 'error' | 'disabled';

export interface RuntimeHealthEntry {
  enabled: boolean;
  available: boolean;
  backend: RuntimeBackendMode;
  checkStatus: RuntimeCheckStatus;
  checkedAt: string;
  checkDurationMs: number;
  lastFailure?: {
    at: string;
    message: string;
  };
}

export type RuntimeHealthMatrix = Record<SessionRuntime, RuntimeHealthEntry>;

export interface RuntimeProbeDefinition {
  enabled: boolean;
  backend: RuntimeBackendMode;
  probe?: () => Promise<boolean>;
}

export type RuntimeProbeDefinitions = Record<SessionRuntime, RuntimeProbeDefinition>;

/** Keeps only the latest bounded, scrubbed probe failure for each runtime. */
export class RuntimeHealthMonitor {
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly lastFailures = new Map<SessionRuntime, RuntimeHealthEntry['lastFailure']>();

  constructor(options: { now?: () => number; timeoutMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.timeoutMs = Number.isFinite(options.timeoutMs) && (options.timeoutMs as number) > 0
      ? Math.floor(options.timeoutMs as number)
      : 2_000;
  }

  async check(definitions: RuntimeProbeDefinitions): Promise<RuntimeHealthMatrix> {
    const entries = await Promise.all(
      (Object.entries(definitions) as Array<[SessionRuntime, RuntimeProbeDefinition]>).map(
        async ([runtime, definition]) => [runtime, await this.checkOne(runtime, definition)] as const,
      ),
    );
    return Object.fromEntries(entries) as RuntimeHealthMatrix;
  }

  private async checkOne(
    runtime: SessionRuntime,
    definition: RuntimeProbeDefinition,
  ): Promise<RuntimeHealthEntry> {
    const startedAt = this.now();
    const checkedAt = new Date(startedAt).toISOString();
    if (!definition.enabled) {
      return {
        enabled: false,
        available: false,
        backend: definition.backend,
        checkStatus: 'disabled',
        checkedAt,
        checkDurationMs: 0,
        ...(this.lastFailures.get(runtime) ? { lastFailure: this.lastFailures.get(runtime) } : {}),
      };
    }

    try {
      const available = definition.probe
        ? await withTimeout(definition.probe(), this.timeoutMs)
        : true;
      if (!available) this.rememberFailure(runtime, checkedAt, 'runtime unavailable');
      return {
        enabled: true,
        available,
        backend: definition.backend,
        checkStatus: available ? 'ok' : 'unavailable',
        checkedAt,
        checkDurationMs: Math.max(0, this.now() - startedAt),
        ...(this.lastFailures.get(runtime) ? { lastFailure: this.lastFailures.get(runtime) } : {}),
      };
    } catch (error) {
      this.rememberFailure(runtime, checkedAt, scrubError(error));
      return {
        enabled: true,
        available: false,
        backend: definition.backend,
        checkStatus: 'error',
        checkedAt,
        checkDurationMs: Math.max(0, this.now() - startedAt),
        lastFailure: this.lastFailures.get(runtime),
      };
    }
  }

  private rememberFailure(runtime: SessionRuntime, at: string, message: string): void {
    this.lastFailures.set(runtime, { at, message });
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`runtime check timed out after ${timeoutMs}ms`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function scrubError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:access|refresh|auth|bot)?[_-]?(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;&]+/gi, '[REDACTED]')
    .replace(/([?&](?:access|refresh|auth|bot)?[_-]?(?:token|secret|password|api[_-]?key)=)[^&\s]+/gi, '$1[REDACTED]')
    .slice(0, 160) || 'runtime check failed';
}
