import { describe, it, expect, afterAll, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../../../src/app.js';
import { generateSessionToken } from '../../../src/security/auth.js';

// Security review 2026-11-27, finding 6: the 50 MB upload cap was attached only
// to the `application/octet-stream` body parser, so every other MIME type was
// streamed to disk without a ceiling. These tests exercise the route's own cap:
// a small cap keeps the overflow bodies small while running the identical
// counting path the production 50 MB default uses.

vi.mock('../../../src/middleware/auth.js', () => ({
  cookieAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// A small cap keeps the overflow bodies small while running the identical
// byte-counting path the production 50 MB default uses. The env value must be
// set before any module import (vi.hoisted runs first), because the route
// resolves its cap at module load.
const { CAP } = vi.hoisted(() => {
  process.env.FILE_UPLOAD_MAX_BYTES = String(64 * 1024);
  return { CAP: 64 * 1024 };
});

const { default: filesRoutes, MAX_UPLOAD_BYTES, resolveUploadMaxBytes } =
  await import('../../../src/routes/files.js');

const UPLOAD_DIR = '/tmp/pi-uploads';
const TEST_BASES = ['cap-test-small', 'cap-test-length', 'cap-test-chunked', 'cap-test-octet', 'cap-test-json', 'cap-test-exact'];

const app = express();
app.use('/api/files', filesRoutes);

async function savedFilesFor(base: string): Promise<string[]> {
  const entries = await fs.readdir(UPLOAD_DIR).catch(() => [] as string[]);
  return entries.filter((entry) => entry.startsWith(`${base}-`));
}

/**
 * POST a body with `Transfer-Encoding: chunked` and no `Content-Length`, which
 * superagent cannot send. Returns the status and the raw response body.
 */
async function postChunked(
  application: express.Express,
  headers: Record<string, string>,
  chunks: Buffer[],
): Promise<{ status: number; body: string }> {
  const server = application.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const { port } = server.address() as AddressInfo;
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value: { status: number; body: string }): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: '/api/files/upload',
        method: 'POST',
        headers: { ...headers, 'Transfer-Encoding': 'chunked' },
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => finish({ status: res.statusCode ?? 0, body }));
        res.on('error', () => { /* the response already ended, or never will */ });
      });
      req.on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
      for (const chunk of chunks) req.write(chunk);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

afterAll(async () => {
  for (const base of TEST_BASES) {
    for (const name of await savedFilesFor(base)) {
      await fs.rm(path.join(UPLOAD_DIR, name), { force: true });
    }
  }
});

describe('upload cap (security review 2026-11-27, finding 6)', () => {
  it('accepts a small non-octet-stream upload and stores every byte', async () => {
    const body = Buffer.from('hello upload cap\n', 'utf8');
    const res = await request(app)
      .post('/api/files/upload')
      .set('Content-Type', 'text/plain')
      .set('x-filename', encodeURIComponent('cap-test-small.txt'))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.size).toBe(body.length);
    expect(await fs.readFile(res.body.path)).toEqual(body);
  });

  it('accepts a body exactly at the cap', async () => {
    const body = Buffer.alloc(CAP, 'a');
    const res = await request(app)
      .post('/api/files/upload')
      .set('Content-Type', 'text/plain')
      .set('x-filename', encodeURIComponent('cap-test-exact.txt'))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.size).toBe(CAP);
  });

  it('rejects an over-cap text/plain body announced by Content-Length and leaves no file', async () => {
    const res = await request(app)
      .post('/api/files/upload')
      .set('Content-Type', 'text/plain')
      .set('x-filename', encodeURIComponent('cap-test-length.txt'))
      .send(Buffer.alloc(CAP + 1024, 'b'));

    expect(res.status).toBe(413);
    expect(String(res.body.error)).toMatch(/upload limit/i);
    expect(await savedFilesFor('cap-test-length')).toEqual([]);
  });

  it('rejects an over-cap chunked body with no Content-Length and unlinks the partial file', async () => {
    // A small first chunk proves the counter runs over a streamed body; the
    // second chunk pushes the total past the cap.
    const res = await postChunked(app, {
      'Content-Type': 'text/plain',
      'x-filename': encodeURIComponent('cap-test-chunked.txt'),
    }, [Buffer.alloc(1024, 'c'), Buffer.alloc(CAP, 'c')]);

    expect(res.status).toBe(413);
    expect(res.body).toMatch(/upload limit/i);
    expect(await savedFilesFor('cap-test-chunked')).toEqual([]);
  });

  it('stores an octet-stream body already consumed by a raw body parser instead of an empty file', async () => {
    // A router mounted behind express.raw must still store what was parsed, not
    // an empty pipe of a spent stream.
    const parsedApp = express();
    parsedApp.use(express.raw({ type: 'application/octet-stream', limit: CAP }));
    parsedApp.use('/api/files', filesRoutes);

    const body = Buffer.from('already parsed octet stream', 'utf8');
    const res = await request(parsedApp)
      .post('/api/files/upload')
      .set('Content-Type', 'application/octet-stream')
      .set('x-filename', encodeURIComponent('cap-test-octet.bin'))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.size).toBe(body.length);
    expect(await fs.readFile(res.body.path)).toEqual(body);
  });

  it('streams an octet-stream upload through the real app wiring (no spent stream)', async () => {
    // app.ts must leave the upload route out of the express.raw parser.
    const wiredApp = createApp();
    const body = Buffer.from('octet bytes through createApp', 'utf8');
    const res = await request(wiredApp)
      .post('/api/files/upload')
      .set('Cookie', [`accessToken=${generateSessionToken('default-user')}`])
      .set('Content-Type', 'application/octet-stream')
      .set('x-filename', encodeURIComponent('cap-test-octet.bin'))
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.size).toBe(body.length);
    expect(await fs.readFile(res.body.path)).toEqual(body);
  });

  it('stores a JSON upload verbatim instead of the JSON parser consuming it', async () => {
    // A .json file arrives as application/json; the upload route must receive
    // its bytes unchanged, not a parsed object and an empty pipe.
    const wiredApp = createApp();
    const jsonText = '{"answer":42,"note":"json upload stays raw"}';
    const body = Buffer.from(jsonText, 'utf8');
    const res = await request(wiredApp)
      .post('/api/files/upload')
      .set('Cookie', [`accessToken=${generateSessionToken('default-user')}`])
      .set('Content-Type', 'application/json')
      .set('x-filename', encodeURIComponent('cap-test-json.json'))
      // A string body is sent verbatim; a Buffer would be re-serialised by the
      // superagent JSON serialiser before it reaches the server.
      .send(jsonText);

    expect(res.status).toBe(200);
    expect(res.body.size).toBe(body.length);
    expect(await fs.readFile(res.body.path)).toEqual(body);
  });
});

describe('resolveUploadMaxBytes', () => {
  it('defaults to 50 MB when unset, invalid or non-positive', () => {
    expect(MAX_UPLOAD_BYTES).toBe(CAP);
    expect(resolveUploadMaxBytes(undefined)).toBe(50 * 1024 * 1024);
    expect(resolveUploadMaxBytes('')).toBe(50 * 1024 * 1024);
    expect(resolveUploadMaxBytes('not-a-number')).toBe(50 * 1024 * 1024);
    expect(resolveUploadMaxBytes('0')).toBe(50 * 1024 * 1024);
    expect(resolveUploadMaxBytes('-5')).toBe(50 * 1024 * 1024);
  });

  it('honours a positive configured byte count', () => {
    expect(resolveUploadMaxBytes('1024')).toBe(1024);
    expect(resolveUploadMaxBytes('7864320')).toBe(7864320);
  });
});
