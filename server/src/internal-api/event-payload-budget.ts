import type { NormalizedEvent } from '@pi-web-ui/shared';

export interface MeasuredEvent {
  event: NormalizedEvent;
  serialized: string;
  bytes: number;
  truncated: boolean;
  originalBytes: number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function slimMessage(message: unknown): JsonRecord | undefined {
  if (!isRecord(message)) return undefined;
  return Object.fromEntries(
    ['id', 'stopReason', 'role']
      .filter((key) => message[key] !== undefined)
      .map((key) => [key, message[key]]),
  );
}

function truncateStrings(value: unknown, maxStringLength: number): unknown {
  if (typeof value === 'string') {
    return value.length > maxStringLength
      ? `${value.slice(0, Math.max(0, maxStringLength - 12))}…[truncated]`
      : value;
  }
  if (Array.isArray(value)) return value.map((item) => truncateStrings(item, maxStringLength));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, truncateStrings(item, maxStringLength)]),
  );
}

function serialize(event: NormalizedEvent): Pick<MeasuredEvent, 'serialized' | 'bytes'> {
  const serialized = JSON.stringify(event);
  return { serialized, bytes: Buffer.byteLength(serialized) };
}

// eslint-disable-next-line no-control-regex -- JSON escaping includes this exact range.
const JSON_ESCAPES_OR_SURROGATES = /["\\\u0000-\u001f\uD800-\uDFFF]/;

function jsonStringBytes(value: string): number {
  const utf8Bytes = Buffer.byteLength(value);
  if (!JSON_ESCAPES_OR_SURROGATES.test(value)) return utf8Bytes + 2;

  let escapeBytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c
      || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      escapeBytes += 1;
    } else if (code < 0x20) {
      escapeBytes += 5;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
      else escapeBytes += 3;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      escapeBytes += 3;
    }
  }
  return utf8Bytes + escapeBytes + 2;
}

function jsonBytes(value: unknown): number {
  if (value === null) return 4;
  if (typeof value === 'string') return jsonStringBytes(value);
  if (typeof value === 'boolean') return value ? 4 : 5;
  if (typeof value === 'number') return Number.isFinite(value) ? Buffer.byteLength(String(value)) : 4;
  if (Array.isArray(value)) {
    let bytes = 2 + Math.max(0, value.length - 1);
    for (const item of value) {
      const omitted = item === undefined || typeof item === 'function' || typeof item === 'symbol';
      bytes += jsonBytes(omitted ? null : item);
    }
    return bytes;
  }
  if (!isRecord(value)) return 0;
  let bytes = 2;
  let retained = 0;
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (item === undefined || typeof item === 'function' || typeof item === 'symbol') continue;
    bytes += (retained > 0 ? 1 : 0) + jsonStringBytes(key) + 1 + jsonBytes(item);
    retained += 1;
  }
  return bytes;
}

export function measureAndSlim(event: NormalizedEvent, budgetBytes: number): MeasuredEvent {
  let originalBytes: number;
  if (budgetBytes > 0 && event.type === 'message_update') {
    originalBytes = jsonBytes(event);
    if (originalBytes <= budgetBytes) {
      const measured = serialize(event);
      return { event, ...measured, truncated: false, originalBytes };
    }
  } else {
    const original = serialize(event);
    originalBytes = original.bytes;
    if (budgetBytes === 0 || originalBytes <= budgetBytes) {
      return { event, ...original, truncated: false, originalBytes };
    }
  }

  const data = isRecord(event.data) ? event.data : {};
  const marker = { originalBytes, budgetBytes };
  const candidateData = event.type === 'message_update'
    ? {
        ...data,
        ...(slimMessage(data.message) ? { message: slimMessage(data.message) } : {}),
        payloadTruncated: marker,
      }
    : {
        ...truncateStrings(data, Math.max(16, Math.floor(budgetBytes / 4))) as JsonRecord,
        payloadTruncated: marker,
      };
  const candidate = { ...event, data: candidateData } as NormalizedEvent;
  const measured = serialize(candidate);
  if (measured.bytes <= budgetBytes) {
    return { event: candidate, ...measured, truncated: true, originalBytes };
  }

  const minimal = { ...event, data: { payloadTruncated: marker } } as NormalizedEvent;
  const minimalMeasured = serialize(minimal);
  return { event: minimal, ...minimalMeasured, truncated: true, originalBytes };
}
