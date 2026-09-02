// Contract 1.30.0 — GET /api/v1/sessions/native (A3): a bounded, read-only
// discovery scan of the NATIVE on-disk session stores of the runtimes whose
// direct-CLI sessions never enter the pi-web-ui registry:
//   claude       ~/.claude/projects/<encoded-cwd>/<uuid>.jsonl
//   commandcode  ~/.commandcode/projects/<encoded-cwd>/<uuid>.jsonl
//                + server-spawned <native-home>/<internalId>/.commandcode/projects/...
//   opencode     ~/.local/share/opencode/storage/session/<project|global>/ses_*.json
//   antigravity  ~/.gemini/antigravity-cli/conversations/<uuid>.db
// Pi is intentionally not scannable here: native pi sessions are auto-discovered
// into the registry by the SessionWatcher. The registry is never mutated.
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSessionRoutes, type SessionRoutesDeps } from '../../../src/internal-api/routes/sessions.js';
import { SessionRegistryManager } from '../../../src/session-registry.js';

function jsonReq(method: string, url: string, body?: unknown): IncomingMessage {
  const req = new PassThrough() as IncomingMessage;
  (req as any).method = method;
  (req as any).url = url;
  (req as any).headers = { 'content-type': 'application/json' };
  process.nextTick(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function mockRes(): ServerResponse & { body: string; statusCode: number } {
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      chunks.push(chunk);
      callback();
    },
  }) as unknown as ServerResponse & { body: string; statusCode: number };
  res.statusCode = 200;
  res.setHeader = vi.fn() as any;
  res.writeHead = vi.fn(function (this: typeof res, code: number) { res.statusCode = code; return this; }) as any;
  res.end = vi.fn(function (this: typeof res, data?: string | Buffer) {
    if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    res.body = Buffer.concat(chunks).toString();
    return this;
  }) as any;
  res.write = vi.fn((data: string | Buffer) => { chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data)); return true; }) as any;
  res.getHeader = vi.fn();
  res.on = vi.fn(() => res) as any;
  return res;
}

const UUID_KNOWN = 'aaaaaaaa-1111-4111-8111-000000000001';
const UUID_UNKNOWN = 'aaaaaaaa-1111-4111-8111-000000000002';

// Real, dash-free directories: the encoded project-dir names only decode
// verifiably when the decoded path exists on disk (the scanner omits cwd
// otherwise — see the lossy-decode test below). The names must not contain
// dashes because the encoding maps every dash to a path separator.
const REAL_CWD_A = `/tmp/nativescana${Math.floor(Math.random() * 1e9).toString(36)}`;
const REAL_CWD_B = `/tmp/nativescanb${Math.floor(Math.random() * 1e9).toString(36)}`;

const encodeProject = (cwd: string): string => cwd.split(path.sep).filter(Boolean).join('-');

async function writeJsonl(filePath: string, lines: object[], mtimeMs: number): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
  await fs.utimes(filePath, new Date(mtimeMs), new Date(mtimeMs));
}

describe('GET /api/v1/sessions/native (contract 1.30.0)', () => {
  let dir: string;
  let claudeProjectsDir: string;
  let commandCodeCliHomeDir: string;
  let commandCodeNativeHomeDir: string;
  let opencodeStorageDir: string;
  let antigravityConversationsDir: string;
  let registry: SessionRegistryManager;
  let registryPath: string;
  let routes: ReturnType<typeof createSessionRoutes>;

  const getNative = async (url = '/api/v1/sessions/native'): Promise<{ status: number; body: any }> => {
    const res = mockRes();
    await routes.handleListNativeSessions(jsonReq('GET', url), res);
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-native-sessions-'));
    claudeProjectsDir = path.join(dir, 'claude-projects');
    commandCodeCliHomeDir = path.join(dir, 'commandcode-home');
    commandCodeNativeHomeDir = path.join(dir, 'commandcode-native-home');
    opencodeStorageDir = path.join(dir, 'opencode-storage');
    antigravityConversationsDir = path.join(dir, 'agy-conversations');
    registryPath = path.join(dir, 'session-registry.json');
    registry = new SessionRegistryManager(registryPath);

    routes = createSessionRoutes({
      claudeService: { isRunning: vi.fn(() => false) } as any,
      opencodeService: { isRunning: vi.fn(() => false) } as any,
      antigravityService: { isRunning: vi.fn(() => false) } as any,
      multiSessionManager: {} as unknown as SessionRoutesDeps['multiSessionManager'],
      sessionRegistry: registry,
      piService: {} as any,
      internalClientId: 'test-client',
      claudeProjectsDir,
      commandCodeCliHomeDir,
      commandCodeNativeHomeDir,
      opencodeStorageDir,
      antigravityConversationsDir,
    });
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(REAL_CWD_A, { recursive: true, force: true }).catch(() => undefined);
    await fs.rm(REAL_CWD_B, { recursive: true, force: true }).catch(() => undefined);
  });

  it('scans native claude projects, sorted newest-first, with decoded cwd and bounded preview', async () => {
    await fs.mkdir(REAL_CWD_A, { recursive: true });
    await fs.mkdir(REAL_CWD_B, { recursive: true });
    const t2 = Date.parse('2026-08-10T00:00:00.000Z');
    const t1 = Date.parse('2026-08-01T00:00:00.000Z');
    await writeJsonl(path.join(claudeProjectsDir, encodeProject(REAL_CWD_B), `${UUID_UNKNOWN}.jsonl`), [
      { type: 'user', message: { role: 'user', content: 'what is the migration plan?' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'working on it' }] } },
    ], t1);
    await writeJsonl(path.join(claudeProjectsDir, encodeProject(REAL_CWD_A), `${UUID_KNOWN}.jsonl`), [
      { type: 'custom-title', customTitle: 'Atlasfix', sessionId: UUID_KNOWN },
      { type: 'user', message: { role: 'user', content: 'hello there' } },
    ], t2);

    const { status, body } = await getNative('/api/v1/sessions/native?runtime=claude');
    expect(status).toBe(200);
    expect(body.sessions).toHaveLength(2);
    expect(body.sessions[0].nativePath).toBe(path.join(claudeProjectsDir, encodeProject(REAL_CWD_A), `${UUID_KNOWN}.jsonl`));
    expect(body.sessions[0].cwd).toBe(REAL_CWD_A);
    expect(body.sessions[0].mtime).toBe(new Date(t2).toISOString());
    expect(body.sessions[0].preview).toBe('Atlasfix');
    expect(body.sessions[1].preview).toBe('what is the migration plan?');
    expect(body.truncated).toBe(false);
  });

  it('marks claude sessions already present in the registry as known', async () => {
    await registry.upsert({
      id: 'reg-claude-1', sdkType: 'claude', path: '/pi-web-ui/replay.jsonl', cwd: REAL_CWD_A,
      claudeSessionId: UUID_KNOWN, firstMessage: 'm', messageCount: 1, status: 'idle',
      createdAt: '2026-08-01T00:00:00.000Z', lastActivity: '2026-08-01T00:00:00.000Z',
    });
    const t = Date.parse('2026-08-10T00:00:00.000Z');
    await fs.mkdir(REAL_CWD_A, { recursive: true });
    await writeJsonl(path.join(claudeProjectsDir, encodeProject(REAL_CWD_A), `${UUID_KNOWN}.jsonl`), [
      { type: 'user', message: { role: 'user', content: 'hi' } },
    ], t);
    await writeJsonl(path.join(claudeProjectsDir, encodeProject(REAL_CWD_A), `${UUID_UNKNOWN}.jsonl`), [
      { type: 'user', message: { role: 'user', content: 'hi' } },
    ], t);

    const { body } = await getNative('/api/v1/sessions/native?runtime=claude');
    const byPath = new Map<string, any>(body.sessions.map((s: any) => [s.nativePath, s]));
    expect(byPath.get(path.join(claudeProjectsDir, encodeProject(REAL_CWD_A), `${UUID_KNOWN}.jsonl`)).knownInRegistry).toBe(true);
    expect(byPath.get(path.join(claudeProjectsDir, encodeProject(REAL_CWD_A), `${UUID_KNOWN}.jsonl`)).registrySessionId).toBe('reg-claude-1');
    expect(byPath.get(path.join(claudeProjectsDir, encodeProject(REAL_CWD_A), `${UUID_UNKNOWN}.jsonl`)).knownInRegistry).toBe(false);
  });

  it('scans plain-CLI commandcode projects, ignoring checkpoints files', async () => {
    const t = Date.parse('2026-08-10T00:00:00.000Z');
    await fs.mkdir(REAL_CWD_A, { recursive: true });
    const uuid = 'bbbbbbbb-1111-4111-8111-000000000001';
    await writeJsonl(path.join(commandCodeCliHomeDir, 'projects', encodeProject(REAL_CWD_A), `${uuid}.jsonl`), [
      { id: uuid, turnNumber: 1, prompt: 'Reply with exactly COMMAND-CODE-MUSE-LIVE and do not use tools.' },
    ], t);
    await writeJsonl(path.join(commandCodeCliHomeDir, 'projects', encodeProject(REAL_CWD_A), `${uuid}.checkpoints.jsonl`), [
      { junk: true },
    ], t);

    const { body } = await getNative('/api/v1/sessions/native?runtime=commandcode');
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].cwd).toBe(REAL_CWD_A);
    expect(body.sessions[0].preview).toBe('Reply with exactly COMMAND-CODE-MUSE-LIVE and do not use tools.');
  });

  it('omits a decoded cwd that does not exist on disk (lossy dash-encoding)', async () => {
    const t = Date.parse('2026-08-10T00:00:00.000Z');
    // 'tmp-definitely-missing-dir-xyz' decodes to a multi-level path that
    // does not exist; the scanner must omit cwd rather than report a
    // plausible-looking wrong path.
    const uuid = 'cccccccc-2222-4222-8222-000000000001';
    await writeJsonl(path.join(commandCodeCliHomeDir, 'projects', 'tmp-definitely-missing-dir-xyz', `${uuid}.jsonl`), [
      { prompt: 'decode check' },
    ], t);
    // 'tmp' decodes to /tmp which DOES exist, so cwd is reported.
    const uuid2 = 'cccccccc-2222-4222-8222-000000000002';
    await writeJsonl(path.join(commandCodeCliHomeDir, 'projects', 'tmp', `${uuid2}.jsonl`), [
      { prompt: 'decode check 2' },
    ], t);

    const { body } = await getNative('/api/v1/sessions/native?runtime=commandcode&limit=10');
    const byPreview = new Map<string, any>(body.sessions.map((s: any) => [s.preview, s]));
    expect(byPreview.get('decode check').cwd).toBeUndefined();
    expect(byPreview.get('decode check 2').cwd).toBe('/tmp');
  });

  it('scans server-spawned commandcode sessions under the native home', async () => {
    const t = Date.parse('2026-08-10T00:00:00.000Z');
    const uuid = 'cccccccc-1111-4111-8111-000000000001';
    await fs.mkdir(REAL_CWD_B, { recursive: true });
    await writeJsonl(
      path.join(commandCodeNativeHomeDir, 'cmdc-internal-1', '.commandcode', 'projects', encodeProject(REAL_CWD_B), `${uuid}.jsonl`),
      [{ id: uuid, prompt: 'spawned by server' }],
      t,
    );

    const { body } = await getNative('/api/v1/sessions/native?runtime=commandcode');
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].preview).toBe('spawned by server');
    expect(body.sessions[0].cwd).toBe(REAL_CWD_B);
  });

  it('scans opencode session storage with title/directory metadata', async () => {
    const t = Date.parse('2026-08-10T00:00:00.000Z');
    const sessionDir = path.join(opencodeStorageDir, 'session', 'global');
    await fs.mkdir(sessionDir, { recursive: true });
    const sessionPath = path.join(sessionDir, 'ses_abc123.json');
    await fs.writeFile(sessionPath, JSON.stringify({
      id: 'ses_abc123', slug: 'misty-tiger', title: 'Code reviewer guidelines',
      projectID: 'global', directory: '/root',
      time: { created: t, updated: t },
    }), 'utf-8');
    await fs.utimes(sessionPath, new Date(t), new Date(t));

    const { body } = await getNative('/api/v1/sessions/native?runtime=opencode');
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toMatchObject({
      runtime: 'opencode',
      cwd: '/root',
      preview: 'Code reviewer guidelines',
      knownInRegistry: false,
    });
  });

  it('scans antigravity conversation databases without content previews', async () => {
    const t = Date.parse('2026-08-10T00:00:00.000Z');
    const dbPath = path.join(antigravityConversationsDir, 'dddddddd-1111-4111-8111-000000000001.db');
    await fs.mkdir(antigravityConversationsDir, { recursive: true });
    await fs.writeFile(dbPath, 'not really a sqlite db', 'utf-8');
    await fs.utimes(dbPath, new Date(t), new Date(t));
    // Non-conversation artefacts must be ignored.
    await fs.writeFile(path.join(antigravityConversationsDir, 'conversation_summaries.db'), 'x', 'utf-8');

    const { body } = await getNative('/api/v1/sessions/native?runtime=antigravity');
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0].runtime).toBe('antigravity');
    expect(body.sessions[0].preview).toBeUndefined();
  });

  it('refuses runtime=pi with an explanatory 400 (pi is auto-discovered into the registry)', async () => {
    const { status, body } = await getNative('/api/v1/sessions/native?runtime=pi');
    expect(status).toBe(400);
    expect(body.code).toBe('INVALID_REQUEST');
    expect(body.error).toMatch(/auto-discovered|sessionwatcher/i);
  });

  it('rejects unknown runtimes with 400', async () => {
    const { status } = await getNative('/api/v1/sessions/native?runtime=banana');
    expect(status).toBe(400);
  });

  it('scans all supported runtimes by default and merges results newest-first', async () => {
    const t = Date.parse('2026-08-10T00:00:00.000Z');
    await writeJsonl(path.join(claudeProjectsDir, 'tmp', `${UUID_UNKNOWN}.jsonl`), [
      { type: 'user', message: { role: 'user', content: 'claude q' } },
    ], t);
    const uuid = 'eeeeeeee-1111-4111-8111-000000000001';
    await writeJsonl(path.join(commandCodeCliHomeDir, 'projects', 'tmp', `${uuid}.jsonl`), [
      { prompt: 'cmdc q' },
    ], t - 1000);

    const { body } = await getNative();
    expect(body.sessions.map((s: any) => s.runtime)).toEqual(['claude', 'commandcode']);
  });

  it('applies the since filter on mtime and caps results with limit', async () => {
    const tNew = Date.parse('2026-08-10T00:00:00.000Z');
    const tOld = Date.parse('2026-08-01T00:00:00.000Z');
    for (let i = 0; i < 5; i++) {
      const uuid = `f0000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      await writeJsonl(path.join(claudeProjectsDir, '-root-proj', `${uuid}.jsonl`), [
        { type: 'user', message: { role: 'user', content: `q${i}` } },
      ], i < 2 ? tOld : tNew);
    }

    const sinceBody = await getNative(`/api/v1/sessions/native?runtime=claude&since=${tNew}`);
    expect(sinceBody.body.sessions).toHaveLength(3);

    const limitBody = await getNative('/api/v1/sessions/native?runtime=claude&limit=2');
    expect(limitBody.body.sessions).toHaveLength(2);
    expect(limitBody.body.truncated).toBe(true);
  });

  it('rejects junk limit and since with 400', async () => {
    expect((await getNative('/api/v1/sessions/native?limit=abc')).status).toBe(400);
    expect((await getNative('/api/v1/sessions/native?since=nonsense')).status).toBe(400);
    expect((await getNative('/api/v1/sessions/native?limit=9999')).status).toBe(400);
  });

  it('returns an empty bounded response when no native roots exist', async () => {
    const { status, body } = await getNative();
    expect(status).toBe(200);
    expect(body.sessions).toEqual([]);
    expect(body.truncated).toBe(false);
  });
});
