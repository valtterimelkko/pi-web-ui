import { closeSync, fchmodSync, fsyncSync, openSync, writeSync } from 'node:fs';

const SENSITIVE_KEY = /(?:password|passwd|secret|token|apikey|authorization|cookie|credential|privatekey)$/;

export interface ValidationLogWriter {
  append(record: Record<string, unknown>): boolean;
  close(): void;
}

/** Open eagerly so validation fails before proxying if evidence cannot be written. */
export function createValidationLogWriter(
  logPath: string,
  options: { reportError?: (message: string) => void } = {},
): ValidationLogWriter {
  const reportError = options.reportError ?? ((message: string) => console.error(message));
  const fd = openSync(logPath, 'a', 0o600);
  fchmodSync(fd, 0o600);
  let closed = false;
  let reportedFailure = false;

  return {
    append(record): boolean {
      if (closed) {
        if (!reportedFailure) reportError(`validation proxy log write failed: log is closed (${logPath})`);
        reportedFailure = true;
        return false;
      }
      try {
        writeSync(fd, `${JSON.stringify(record)}\n`, undefined, 'utf8');
        fsyncSync(fd);
        return true;
      } catch (error) {
        if (!reportedFailure) {
          reportError(`validation proxy log write failed (${logPath}): ${error instanceof Error ? error.message : String(error)}`);
          reportedFailure = true;
        }
        return false;
      }
    },
    close(): void {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
}

/**
 * Recursive allow-by-shape sanitizer used only after explicit unsafe body-log
 * opt-in. Prompt/message content is always omitted, credential keys are
 * redacted, strings/arrays/depth are bounded, and the final JSON is size-capped.
 */
export function sanitizeValidationRequestPath(value: string | undefined): string {
  return (value ?? '').split('?', 1)[0].slice(0, 1000);
}

export function sanitizeValidationExtract(path: string, value: unknown, maxBytes = 2000): unknown {
  const segments = path.split('.').map((segment) => segment.replace(/[^a-z0-9]/gi, '').toLowerCase());
  if (segments.some((segment) => /^(?:messages?|prompt|input|content|text)$/.test(segment))) {
    return '[content omitted]';
  }
  return sanitizeValidationCapture(value, maxBytes);
}

export function sanitizeValidationCapture(value: unknown, maxBytes = 16 * 1024): unknown {
  const sanitized = sanitize(value, undefined, 0);
  const raw = JSON.stringify(sanitized);
  if (Buffer.byteLength(raw, 'utf8') <= maxBytes) return sanitized;
  return {
    truncated: true,
    preview: raw.slice(0, Math.max(0, Math.min(raw.length, maxBytes - 80))),
  };
}

function sanitize(value: unknown, key: string | undefined, depth: number): unknown {
  const normalizedKey = key?.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (normalizedKey && SENSITIVE_KEY.test(normalizedKey)) return '[REDACTED]';
  if (normalizedKey && /^(?:messages?|prompt|input|content|text)$/.test(normalizedKey)) {
    return Array.isArray(value) ? `[${value.length} content items omitted]` : '[content omitted]';
  }
  if (typeof value === 'string') return scrubString(value).slice(0, 500);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '[depth limit]';
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, undefined, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    output[childKey] = sanitize(childValue, childKey, depth + 1);
  }
  return output;
}

function scrubString(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:access|refresh|auth|bot)?[_-]?(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;&]+/gi, '[REDACTED]')
    .replace(/([?&](?:access|refresh|auth|bot)?[_-]?(?:token|secret|password|api[_-]?key)=)[^&\s]+/gi, '$1[REDACTED]')
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/g, '[REDACTED]');
}
