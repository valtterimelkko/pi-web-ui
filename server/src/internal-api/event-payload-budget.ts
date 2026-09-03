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

export function measureAndSlim(event: NormalizedEvent, budgetBytes: number): MeasuredEvent {
  const original = serialize(event);
  if (budgetBytes === 0 || original.bytes <= budgetBytes) {
    return { event, ...original, truncated: false, originalBytes: original.bytes };
  }

  const data = isRecord(event.data) ? event.data : {};
  const marker = { originalBytes: original.bytes, budgetBytes };
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
    return { event: candidate, ...measured, truncated: true, originalBytes: original.bytes };
  }

  const minimal = { ...event, data: { payloadTruncated: marker } } as NormalizedEvent;
  const minimalMeasured = serialize(minimal);
  return { event: minimal, ...minimalMeasured, truncated: true, originalBytes: original.bytes };
}
