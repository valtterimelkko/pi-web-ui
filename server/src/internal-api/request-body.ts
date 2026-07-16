import type { IncomingMessage } from 'node:http';

export const DEFAULT_INTERNAL_API_BODY_LIMIT = 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`Internal API request body exceeds ${maxBytes} bytes.`);
    this.name = 'RequestBodyTooLargeError';
    this.maxBytes = maxBytes;
  }
}

/** Parse JSON while keeping malformed-input semantics and bounding memory use. */
export async function readBoundedJsonBody<T>(
  req: IncomingMessage,
  options: { maxBytes?: number } = {},
): Promise<T | null> {
  const maxBytes = options.maxBytes ?? DEFAULT_INTERNAL_API_BODY_LIMIT;
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    req.resume();
    throw new RequestBodyTooLargeError(maxBytes);
  }

  return new Promise<T | null>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let oversized = false;

    req.on('data', (chunk: Buffer | string) => {
      if (oversized) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > maxBytes) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buffer);
    });
    req.on('end', () => {
      if (oversized) {
        reject(new RequestBodyTooLargeError(maxBytes));
        return;
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw) as T);
      } catch {
        resolve(null);
      }
    });
    req.on('error', reject);
  });
}
