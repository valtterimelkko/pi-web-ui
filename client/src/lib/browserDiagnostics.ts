export type BrowserDiagnosticKind =
  | 'connection'
  | 'message'
  | 'protocol_drift'
  | 'storage_error'
  | 'ui_error';

export interface BrowserBuildIdentity {
  manifestSchemaVersion: number;
  identityStatus: 'known' | 'unknown';
  buildMode: 'source' | 'compiled';
  buildId: string;
  buildFingerprint: string;
  revision: string;
  sourceFingerprint: string;
  configFingerprint: string;
  lockfileFingerprint: string;
  componentVersions: Record<string, string>;
  inputCounts?: { source: number; config: number; lockfile: number };
}

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
const MAX_EMBEDDED_IDENTITY_BYTES = 64 * 1024;
const MAX_IDENTITY_STRING_LENGTH = 256;
const MAX_INPUT_COUNT = 1_000_000;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BUILD_ID_PATTERN = /^(build|source)-[0-9a-f]{32}$/;
const COMPONENT_VERSION_KEYS = ['app', 'server', 'client', 'shared', 'internalApiMcp'] as const;
const events: BrowserDiagnosticEvent[] = [];
let malformedCount = 0;
let unknownCount = 0;
const unknownTypes = new Map<string, number>();

/**
 * The Vite build embeds a bounded identity object, not a package/version label.
 * Invalid or absent values are explicit unknown identity rather than a silently
 * trusted caller-supplied environment string.
 */
const browserBuildIdentity = readEmbeddedBuildIdentity();

/** Records only an allowlisted metadata projection. */
export function recordBrowserDiagnostic(input: BrowserDiagnosticInput): void {
  const event: BrowserDiagnosticEvent = {
    at: input.at ?? new Date().toISOString(),
    kind: input.kind,
    ...(clean(input.state) ? { state: clean(input.state) } : {}),
    ...(cleanProtocolType(input.messageType) ? { messageType: cleanProtocolType(input.messageType) } : {}),
    ...(clean(input.runtime) ? { runtime: clean(input.runtime) } : {}),
    ...(Number.isFinite(input.closeCode) ? { closeCode: input.closeCode } : {}),
    ...(() => {
      const reason = clean(input.closeReason, 160);
      return reason ? { closeReason: scrub(reason) } : {};
    })(),
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

export function getBrowserBuildIdentity(): BrowserBuildIdentity {
  return {
    ...browserBuildIdentity,
    componentVersions: { ...browserBuildIdentity.componentVersions },
    ...(browserBuildIdentity.inputCounts ? { inputCounts: { ...browserBuildIdentity.inputCounts } } : {}),
  };
}

export function createBrowserDiagnosticBundle(maxBytes = 128 * 1024): {
  generatedAt: string;
  /** Compatibility field retained for older support bundles. */
  buildVersion: string;
  buildIdentity: BrowserBuildIdentity;
  protocolDrift: { malformed: number; unknown: number; unknownTypes: Record<string, number> };
  events: BrowserDiagnosticEvent[];
  truncation?: { applied: true; droppedEvents: number };
} {
  const base = {
    generatedAt: new Date().toISOString(),
    buildVersion: browserBuildIdentity.buildId,
    buildIdentity: getBrowserBuildIdentity(),
    protocolDrift: {
      malformed: malformedCount,
      unknown: unknownCount,
      unknownTypes: Object.fromEntries(unknownTypes),
    },
  };
  // Explicit byte bound on the exported bundle (128 KiB): trim OLDEST events
  // first and mark the truncation — never silently drop or exceed the bound.
  let retained = events.map((event) => ({ ...event }));
  let dropped = 0;
  let bundle = { ...base, events: retained };
  while (JSON.stringify(bundle).length > maxBytes && retained.length > 0) {
    const removeCount = Math.max(1, Math.ceil(retained.length / 8));
    retained = retained.slice(removeCount);
    dropped += removeCount;
    bundle = {
      ...base,
      events: retained,
      ...(dropped > 0 ? { truncation: { applied: true as const, droppedEvents: dropped } } : {}),
    };
  }
  return bundle;
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

function readEmbeddedBuildIdentity(): BrowserBuildIdentity {
  const raw = import.meta.env.VITE_BUILD_IDENTITY;
  if (!raw) return unknownBrowserBuildIdentity('source');
  return parseBrowserBuildIdentity(raw);
}

/** Parse and project Vite metadata without forwarding arbitrary JSON fields. */
export function parseBrowserBuildIdentity(
  raw: string,
  fallbackMode: 'source' | 'compiled' = 'compiled',
): BrowserBuildIdentity {
  if (typeof raw !== 'string' || new TextEncoder().encode(raw).byteLength > MAX_EMBEDDED_IDENTITY_BYTES) {
    return unknownBrowserBuildIdentity(fallbackMode);
  }
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.manifestSchemaVersion !== 1) return unknownBrowserBuildIdentity(fallbackMode);
    const buildMode = value.buildMode;
    const identityStatus = value.identityStatus;
    if ((buildMode !== 'source' && buildMode !== 'compiled')
      || (identityStatus !== 'known' && identityStatus !== 'unknown')) {
      return unknownBrowserBuildIdentity(fallbackMode);
    }
    const fields = [
      'buildId', 'buildFingerprint', 'revision', 'sourceFingerprint',
      'configFingerprint', 'lockfileFingerprint',
    ].map((key) => boundedIdentityString(value[key]));
    const [buildId, buildFingerprint, revision, sourceFingerprint, configFingerprint, lockfileFingerprint] = fields;
    const componentVersions = sanitiseComponentVersions(value.componentVersions);
    const inputCounts = value.inputCounts === undefined ? undefined : sanitiseInputCounts(value.inputCounts);
    if (!buildId || !buildFingerprint || !revision || !sourceFingerprint || !configFingerprint || !lockfileFingerprint
      || !componentVersions || (value.inputCounts !== undefined && !inputCounts)) {
      return unknownBrowserBuildIdentity(fallbackMode);
    }

    if (identityStatus === 'known') {
      const expectedPrefix = buildMode === 'compiled' ? 'build-' : 'source-';
      if (!inputCounts || inputCounts.source < 1 || inputCounts.config < 1 || inputCounts.lockfile < 1
        || !isDigest(buildFingerprint) || !isDigest(sourceFingerprint)
        || !isDigest(configFingerprint) || !isDigest(lockfileFingerprint)
        || !BUILD_ID_PATTERN.test(buildId)
        || !buildId.startsWith(expectedPrefix)
        || buildId.slice(expectedPrefix.length) !== buildFingerprint.slice(7, 39)
        || (buildMode === 'source' && revision !== 'unknown')) {
        return unknownBrowserBuildIdentity(fallbackMode);
      }
    } else if (buildId !== 'unknown' || buildFingerprint !== 'unknown' || revision !== 'unknown'
      || sourceFingerprint !== 'unknown' || configFingerprint !== 'unknown' || lockfileFingerprint !== 'unknown') {
      return unknownBrowserBuildIdentity(fallbackMode);
    }

    return {
      manifestSchemaVersion: 1,
      identityStatus,
      buildMode,
      buildId,
      buildFingerprint,
      revision,
      sourceFingerprint,
      configFingerprint,
      lockfileFingerprint,
      componentVersions,
      ...(inputCounts ? { inputCounts } : {}),
    };
  } catch {
    return unknownBrowserBuildIdentity(fallbackMode);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedIdentityString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDENTITY_STRING_LENGTH) return undefined;
  return /[\r\n]/.test(value) ? undefined : value;
}

function isDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value);
}

function sanitiseComponentVersions(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const result: Record<string, string> = {};
  for (const key of COMPONENT_VERSION_KEYS) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== 'string' || value[key].length > 80 || /[\r\n]/.test(value[key])) return undefined;
    result[key] = value[key];
  }
  return result;
}

function sanitiseInputCounts(value: unknown): { source: number; config: number; lockfile: number } | undefined {
  if (!isRecord(value)) return undefined;
  const counts = { source: value.source, config: value.config, lockfile: value.lockfile };
  if (!Object.values(counts).every((count) => typeof count === 'number'
    && Number.isSafeInteger(count) && count >= 0 && count <= MAX_INPUT_COUNT)) return undefined;
  return counts as { source: number; config: number; lockfile: number };
}

function unknownBrowserBuildIdentity(buildMode: 'source' | 'compiled'): BrowserBuildIdentity {
  return {
    manifestSchemaVersion: 1,
    identityStatus: 'unknown',
    buildMode,
    buildId: 'unknown',
    buildFingerprint: 'unknown',
    revision: 'unknown',
    sourceFingerprint: 'unknown',
    configFingerprint: 'unknown',
    lockfileFingerprint: 'unknown',
    componentVersions: {},
  };
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
