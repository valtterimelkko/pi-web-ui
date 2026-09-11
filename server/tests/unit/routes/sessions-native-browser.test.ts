import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Pass-through auth middleware
vi.mock('../../../src/middleware/auth.js', () => ({
  cookieAuthMiddleware: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Mock Pi service
vi.mock('../../../src/pi/index.js', () => ({
  getPiService: () => ({
    listAllSessions: vi.fn().mockResolvedValue([]),
    listSessions: vi.fn().mockResolvedValue([]),
  }),
}));

describe('Browser Sessions Routes — Native Discovery & Import', () => {
  let app: express.Application;
  let testDir: string;
  let registryPath: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'browser-native-test-'));
    registryPath = path.join(testDir, 'registry.json');

    const { getSessionRegistry } = await import('../../../src/session-registry.js');
    const { config } = await import("../../../src/config.js");
    config.sessionRegistryPath = registryPath;
    getSessionRegistry(registryPath);

    const { default: sessionsRouter } = await import('../../../src/routes/sessions.js');
    app = express();
    app.use(express.json());
    app.use('/api/sessions', sessionsRouter);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe('GET /api/sessions/native', () => {
    it('returns 200 with sessions array and scannedRoots', async () => {
      const res = await request(app).get('/api/sessions/native').expect(200);
      expect(res.body).toHaveProperty('sessions');
      expect(Array.isArray(res.body.sessions)).toBe(true);
      expect(res.body).toHaveProperty('scannedRoots');
    });

    it('rejects unsupported runtimes with 400', async () => {
      const res = await request(app).get('/api/sessions/native?runtime=invalid-rt').expect(400);
      expect(res.body.error).toContain('Unsupported');
    });

    it('rejects pi runtime with 400 and explanatory message', async () => {
      const res = await request(app).get('/api/sessions/native?runtime=pi').expect(400);
      expect(res.body.error).toContain('SessionWatcher');
    });
  });

  describe('POST /api/sessions/import-native', () => {
    it('rejects missing runtime or nativeId with 400', async () => {
      const res = await request(app)
        .post('/api/sessions/import-native')
        .send({})
        .expect(400);
      expect(res.body.error).toBeDefined();
    });

    it('returns 404 when native file does not exist on disk', async () => {
      // Hermetic: redirect the claude projects root at the (empty) test dir.
      vi.stubEnv('CLAUDE_CONFIG_DIR', testDir);
      const res = await request(app)
        .post('/api/sessions/import-native')
        .send({
          runtime: 'claude',
          nativeId: '00000000-0000-0000-0000-000000000000',
          cwd: '/root/pi-web-ui',
        })
        ;
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NATIVE_SESSION_NOT_FOUND');
    });

    it('successfully imports an unmanaged Claude CLI session', async () => {
      // resolveClaudeProjectsRoot() honours CLAUDE_CONFIG_DIR per request.
      vi.stubEnv('CLAUDE_CONFIG_DIR', testDir);
      const claudeDir = path.join(testDir, 'projects');

      const sid = '12345678-1234-4234-8234-123456789abc';
      const projDir = path.join(claudeDir, '-root-my-proj');
      await fs.mkdir(projDir, { recursive: true });
      await fs.writeFile(
        path.join(projDir, `${sid}.jsonl`),
        JSON.stringify({ type: 'user', message: { content: 'My first CLI turn' } }) + '\n'
      );

      const res = await request(app)
        .post('/api/sessions/import-native')
        .send({
          runtime: 'claude',
          nativeId: sid,
          cwd: '/root/my-proj',
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.runtime).toBe('claude');
      expect(res.body.sessionId).toBeDefined();

      const { getSessionRegistry } = await import('../../../src/session-registry.js');
      const registry = getSessionRegistry(registryPath);
      const entry = await registry.get(res.body.sessionId);
      expect(entry).toBeDefined();
      expect(entry?.claudeSessionId).toBe(sid);
      expect(entry?.origin).toBe('native-discovered');
      expect(entry?.firstMessage).toContain('My first CLI turn');
    });

    it('rejects unsafe nativeId (path traversal) with 400', async () => {
      const res = await request(app)
        .post('/api/sessions/import-native')
        .send({
          runtime: 'claude',
          nativeId: '../../etc/passwd',
          cwd: '/root',
        })
        .expect(400);
      expect(res.body.error).toBeDefined();
    });

    it('imports a Command Code session from the real projects/<encoded-cwd> layout', async () => {
      const { config } = await import('../../../src/config.js');
      const cliHome = path.join(testDir, 'cmdc-home');
      config.commandCodeCliHomeDir = cliHome;

      const sid = '77777777-7777-4777-8777-777777777777';
      const projDir = path.join(cliHome, 'projects', 'root-my-proj');
      await fs.mkdir(projDir, { recursive: true });
      await fs.writeFile(
        path.join(projDir, `${sid}.jsonl`),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'Command Code first turn' } }) + '\n'
      );

      const res = await request(app)
        .post('/api/sessions/import-native')
        .send({ runtime: 'commandcode', nativeId: sid, cwd: '/root/my-proj' })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.runtime).toBe('commandcode');
      const { getSessionRegistry } = await import('../../../src/session-registry.js');
      const registry = getSessionRegistry(registryPath);
      const entry = await registry.get(res.body.sessionId);
      expect(entry?.commandCodeNativeSessionId).toBe(sid);
      expect(entry?.origin).toBe('native-discovered');
    });

    it('returns alreadyRegistered: true if session is already in registry', async () => {
      const sid = '99999999-9999-4999-8999-999999999999';
      const existingId = '88888888-8888-4888-8888-888888888888';
      const { getSessionRegistry } = await import('../../../src/session-registry.js');
      const registry = getSessionRegistry(registryPath);
      await registry.upsert({
        id: existingId,
        sdkType: 'claude',
        path: '/sessions/dummy.jsonl',
        cwd: '/root',
        claudeSessionId: sid,
        firstMessage: 'Already here',
        messageCount: 1,
        status: 'idle',
      });

      const res = await request(app)
        .post('/api/sessions/import-native')
        .send({
          runtime: 'claude',
          nativeId: sid,
          cwd: '/root',
        })
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.alreadyRegistered).toBe(true);
      expect(res.body.sessionId).toBe(existingId);
    });

    it('imports an antigravity conversation that only exists under the desktop root (contract 1.42.0)', async () => {
      const { config } = await import('../../../src/config.js');
      const cliDir = path.join(testDir, 'agy-cli', 'conversations');
      const desktopDir = path.join(testDir, 'agy-desktop', 'conversations');
      await fs.mkdir(cliDir, { recursive: true });
      await fs.mkdir(desktopDir, { recursive: true });
      const sid = '8f0c2d1a-0000-4000-8000-00000000d001';
      await fs.writeFile(path.join(desktopDir, `${sid}.db`), 'sqlite', 'utf-8');
      const logsDir = path.join(testDir, 'agy-desktop', 'brain', sid, '.system_generated', 'logs');
      await fs.mkdir(logsDir, { recursive: true });
      await fs.writeFile(
        path.join(logsDir, 'transcript.jsonl'),
        JSON.stringify({ type: 'USER_INPUT', content: '<USER_REQUEST>\nDesktop import probe\n</USER_REQUEST>' }) + '\n',
      );

      const prevCli = config.antigravityNativeConversationsDir;
      const prevDesktop = config.antigravityNativeDesktopConversationsDir;
      config.antigravityNativeConversationsDir = cliDir;
      config.antigravityNativeDesktopConversationsDir = desktopDir;
      try {
        const res = await request(app)
          .post('/api/sessions/import-native')
          .send({ runtime: 'antigravity', nativeId: sid })
          .expect(200);

        expect(res.body.success).toBe(true);
        const { getSessionRegistry } = await import('../../../src/session-registry.js');
        const entry = await getSessionRegistry(registryPath).get(res.body.sessionId);
        expect(entry?.antigravityConversationId).toBe(sid);
        expect(entry?.path).toContain(path.join('agy-desktop', 'conversations'));
        expect(entry?.firstMessage).toBe('Desktop import probe');
      } finally {
        config.antigravityNativeConversationsDir = prevCli;
        config.antigravityNativeDesktopConversationsDir = prevDesktop;
      }
    });
  });
});
