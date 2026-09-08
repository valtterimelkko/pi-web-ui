import type { LogRecord } from './logger.js';

export const MAX_LOG_RECORD_BYTES = 8192;
const MAX_STRING_CHARS = 4096;
const MAX_FIELDS = 256;
const MAX_DEPTH = 6;
const sensitive = /(?:password|passwd|secret|secrets|token|tokens|apikey|authorization|cookie|cookies|bearer|credential|credentials|privatekey|prompt|transcript)(?:value|header|data|contents?|text|string)?$/i;
const marker = '[TRUNCATED]';
const nativeStackGetter = Object.getOwnPropertyDescriptor(new Error(), 'stack')?.get;

function scrubString(value: string): string {
  // Drop oversized strings whole: truncating before redaction could retain a
  // credential prefix, while regex-scanning unbounded input defeats the budget.
  if (value.length > MAX_STRING_CHARS) return marker;
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, '[REDACTED]')
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[REDACTED]')
    .replace(/\bxox[bpoa]-[A-Za-z0-9-]{10,}/g, '[REDACTED]')
    .replace(/\b(?:access|refresh|auth|bot)?[_-]?(?:token|secret|password|api[_-]?key)\s*[=:]\s*(?!%[sdifjoOc%])[^\s,;&]+/gi, '[REDACTED]');
}

/** A bounded plain-data projection. Never invokes accessors or custom inspect. */
export function safeLogValue(value: unknown, onTruncate: () => void = () => {}): unknown {
  const seen = new WeakSet<object>();
  let visited = 0;
  function project(input: unknown, depth: number, key = ''): unknown {
    if (++visited > MAX_FIELDS || depth > MAX_DEPTH) { onTruncate(); return marker; }
    const normalized = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (typeof input === 'number' && Number.isFinite(input)
      && /^(?:input|output|prompt|completion|cache(?:read|write)?|total)?tokens?(?:count)?$/.test(normalized)) return input;
    if (normalized === 'auth' || sensitive.test(normalized)) return '[REDACTED]';
    if (typeof input === 'string') {
      if (input.length > MAX_STRING_CHARS) onTruncate();
      return scrubString(input);
    }
    if (input === null || typeof input === 'boolean' || typeof input === 'number') return input;
    if (typeof input === 'undefined') return undefined;
    if (typeof input !== 'object') return `[${typeof input}]`;
    if (seen.has(input)) { onTruncate(); return '[CIRCULAR]'; }
    seen.add(input);
    try {
      const out: Record<string, unknown> = Object.create(null);
      if (input instanceof Error) {
        const descriptorFor = (field: string): PropertyDescriptor | undefined => {
          let target: object | null = input;
          for (let hops = 0; target && hops < MAX_DEPTH; hops++, target = Object.getPrototypeOf(target)) {
            const descriptor = Object.getOwnPropertyDescriptor(target, field);
            if (descriptor) return descriptor;
          }
          return undefined;
        };
        let unsafeIdentityAccessor = false;
        for (const field of ['name', 'message', 'stack']) {
          const descriptor = descriptorFor(field);
          if (descriptor && 'value' in descriptor) out[field] = project(descriptor.value, depth + 1, field);
          else if (field === 'stack' && !unsafeIdentityAccessor && descriptor?.get === nativeStackGetter && nativeStackGetter) {
            out[field] = project(nativeStackGetter.call(input), depth + 1, field);
          } else if (descriptor) {
            onTruncate(); out[field] = '[UNREADABLE]';
            if (field !== 'stack') unsafeIdentityAccessor = true;
          } else out[field] = field === 'name' ? 'Error' : field === 'message' ? '' : undefined;
        }
      } else {
        for (const field in input) {
          if (!Object.hasOwn(input, field)) continue;
          if (visited >= MAX_FIELDS) { onTruncate(); out.truncated = marker; break; }
          if (field.length > 128) { onTruncate(); visited++; out.truncated = marker; continue; }
          const descriptor = Object.getOwnPropertyDescriptor(input, field);
          out[field] = descriptor && 'value' in descriptor
            ? project(descriptor.value, depth + 1, field) : '[UNREADABLE]';
        }
      }
      return Array.isArray(input) ? Object.values(out) : out;
    } catch { onTruncate(); return '[UNREADABLE]'; }
    finally { seen.delete(input); }
  }
  return project(value, 0);
}

export function safeLogRecord(record: LogRecord): LogRecord {
  let truncated = false;
  const projected = safeLogValue(record, () => { truncated = true; }) as LogRecord;
  let out = projected && typeof projected === 'object' ? projected : {
    ts: new Date().toISOString(), level: 'error' as const, component: 'Logger', msg: '[UNREADABLE]',
  };
  out.ts = typeof out.ts === 'string' && out.ts.length <= 64 ? out.ts : new Date().toISOString();
  out.level = ['error', 'warn', 'info', 'debug'].includes(out.level) ? out.level : 'error';
  out.component = typeof out.component === 'string' && out.component.length <= 128 ? out.component : 'Logger';
  out.msg = typeof out.msg === 'string' ? out.msg : '[UNREADABLE]';
  const droppedFields: string[] = [];
  for (const field of ['requestId', 'runId', 'sessionId', 'runtime', 'executionInstanceId']) {
    if (out[field] !== undefined && typeof out[field] !== 'string') { delete out[field]; droppedFields.push(field); }
  }
  if (truncated || droppedFields.length) out.logSafety = { truncated: true, ...(droppedFields.length ? { droppedFields } : {}) };
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_LOG_RECORD_BYTES) {
    // Keep the core correlation envelope first. Oversized optional data is
    // explicitly omitted, not disguised as a complete original object.
    out = { ts: out.ts, level: out.level, component: out.component, msg: out.msg,
      requestId: out.requestId, runId: out.runId, sessionId: out.sessionId,
      runtime: out.runtime, executionInstanceId: out.executionInstanceId,
      logSafety: { truncated: true } };
    if (Buffer.byteLength(JSON.stringify(out)) > MAX_LOG_RECORD_BYTES) {
      out = { ts: out.ts, level: out.level, component: 'Logger', msg: marker, logSafety: { truncated: true } };
    }
  }
  return out;
}
