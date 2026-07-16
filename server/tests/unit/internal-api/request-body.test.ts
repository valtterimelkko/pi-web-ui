import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  readBoundedJsonBody,
  RequestBodyTooLargeError,
} from '../../../src/internal-api/request-body.js';
import type { IncomingMessage } from 'node:http';

function request(chunks: string[], contentLength?: number): IncomingMessage {
  const stream = Readable.from(chunks) as IncomingMessage;
  stream.headers = contentLength === undefined ? {} : { 'content-length': String(contentLength) };
  return stream;
}

describe('readBoundedJsonBody', () => {
  it('parses a body split across chunks', async () => {
    await expect(readBoundedJsonBody(request(['{"a":', '1}']), { maxBytes: 32 }))
      .resolves.toEqual({ a: 1 });
  });

  it('returns null for empty or malformed JSON', async () => {
    await expect(readBoundedJsonBody(request([]))).resolves.toBeNull();
    await expect(readBoundedJsonBody(request(['{bad']))).resolves.toBeNull();
  });

  it('rejects an oversized declared content length before buffering', async () => {
    await expect(readBoundedJsonBody(request(['{}'], 100), { maxBytes: 10 }))
      .rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });

  it('bounds chunked requests without a content length', async () => {
    await expect(readBoundedJsonBody(request(['12345', '67890', 'x']), { maxBytes: 10 }))
      .rejects.toBeInstanceOf(RequestBodyTooLargeError);
  });
});
