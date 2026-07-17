export type BrowserDiagnosticKind =
  | 'connection'
  | 'message'
  | 'protocol_drift'
  | 'storage_error'
  | 'ui_error';

export interface BrowserDiagnosticEvent {
  at: string;
  kind: BrowserDiagnosticKind;
  state?: string;
  messageType?: string;
  runtime?: string;
  closeCode?: number;
  closeReason?: string;
  reconnectAttempt?: number;
  operation?: string;
  errorName?: string;
}

export interface BrowserDiagnosticInput extends Omit<BrowserDiagnosticEvent, 'at'> {
  at?: string;
}

const MAX_EVENTS = 200;
const MAX_UNKNOWN_TYPES = 20;
const events: BrowserDiagnosticEvent[] = [];
let malformedCount = 0;
let unknownCount = 0;
const unknownTypes = new Map<string, number>();

/**
 * Records only an allowlisted metadata projection. Arbitrary payload fields are
 * never copied, making the bundle safe to generate manually without transcript
 * or tool content.
 */
export function recordBrowserDiagnostic(input: BrowserDiagnosticInput): void {
  const event: BrowserDiagnosticEvent = {
    at: input.at ?? new Date().toISOString(),
    kind: input.kind,
    ...(clean(input.state) ? { state: clean(input.state) } : {}),
    ...(cleanProtocolType(input.messageType) ? { messageType: cleanProtocolType(input.messageType) } : {}),
    ...(clean(input.runtime) ? { runtime: clean(input.runtime) } : {}),
    ...(Number.isFinite(input.closeCode) ? { closeCode: input.closeCode } : {}),
    ...(clean(input.closeReason) ? { closeReason: scrub(clean(input.closeReason, 160)!) } : {}),
    ...(Number.isFinite(input.reconnectAttempt) ? { reconnectAttempt: input.reconnectAttempt } : {}),
    ...(clean(input.operation) ? { operation: clean(input.operation) } : {}),
    ...(clean(input.errorName) ? { errorName: clean(input.errorName) } : {}),
  };
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

export function recordProtocolDrift(kind: 'malformed' | 'unknown', messageType?: string): void {
  if (kind === 'malformed') malformedCount += 1;
  else {
    unknownCount += 1;
    const requested = cleanProtocolType(messageType) ?? 'unknown';
    const key = unknownTypes.has(requested) || unknownTypes.size < MAX_UNKNOWN_TYPES ? requested : 'other';
    unknownTypes.set(key, (unknownTypes.get(key) ?? 0) + 1);
  }
  recordBrowserDiagnostic({ kind: 'protocol_drift', state: kind, messageType });
}

export function createBrowserDiagnosticBundle(): {
  generatedAt: string;
  buildVersion: string;
  protocolDrift: { malformed: number; unknown: number; unknownTypes: Record<string, number> };
  events: BrowserDiagnosticEvent[];
} {
  return {
    generatedAt: new Date().toISOString(),
    buildVersion: import.meta.env.VITE_BUILD_VERSION || 'unknown',
    protocolDrift: {
      malformed: malformedCount,
      unknown: unknownCount,
      unknownTypes: Object.fromEntries(unknownTypes),
    },
    events: events.map((event) => ({ ...event })),
  };
}

export async function copyBrowserDiagnostics(): Promise<void> {
  await navigator.clipboard.writeText(JSON.stringify(createBrowserDiagnosticBundle(), null, 2));
}

export function downloadBrowserDiagnostics(): void {
  const blob = new Blob([JSON.stringify(createBrowserDiagnosticBundle(), null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `pi-web-ui-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function clearBrowserDiagnostics(): void {
  events.length = 0;
  malformedCount = 0;
  unknownCount = 0;
  unknownTypes.clear();
}

function clean(value: string | undefined, max = 80): string | undefined {
  if (typeof value !== 'string') return undefined;
  const result = value.trim().slice(0, max);
  return result || undefined;
}

function cleanProtocolType(value: string | undefined): string | undefined {
  const cleaned = clean(value);
  if (!cleaned) return undefined;
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(cleaned) ? cleaned : 'invalid_type';
}

function scrub(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:access|refresh|auth|bot)?[_-]?(?:token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;&]+/gi, '[REDACTED]')
    .replace(/([?&](?:access|refresh|auth|bot)?[_-]?(?:token|secret|password|api[_-]?key)=)[^&\s]+/gi, '$1[REDACTED]');
}
