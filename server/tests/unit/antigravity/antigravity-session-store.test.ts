import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AntigravitySessionStore } from '../../../src/antigravity/antigravity-session-store.js';

describe('AntigravitySessionStore', () => {
  let tempDir: string;
  let store: AntigravitySessionStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'agy-store-test-'));
    store = new AntigravitySessionStore(tempDir);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe('loadHistory', () => {
    it('returns empty array for unknown session', async () => {
      const history = await store.loadHistory('nonexistent-session');
      expect(history).toEqual([]);
    });

    it('returns all turns after appending', async () => {
      const sessionId = 'test-session';
      await store.appendTurn(sessionId, { prompt: 'Hello', response: 'Hi!', model: 'Gemini 3.5 Flash (Medium)', conversationId: null, timestamp: 1000 });
      await store.appendTurn(sessionId, { prompt: 'World', response: 'Earth!', model: 'Gemini 3.5 Flash (Medium)', conversationId: 'conv-1', timestamp: 2000 });

      const history = await store.loadHistory(sessionId);
      expect(history).toHaveLength(2);
      expect(history[0].prompt).toBe('Hello');
      expect(history[0].response).toBe('Hi!');
      expect(history[1].prompt).toBe('World');
      expect(history[1].conversationId).toBe('conv-1');
    });

    it('persists turns across store instances', async () => {
      const sessionId = 'persistent-session';
      await store.appendTurn(sessionId, { prompt: 'Persist me', response: 'Persisted', model: 'm', conversationId: null, timestamp: 1 });

      const store2 = new AntigravitySessionStore(tempDir);
      const history = await store2.loadHistory(sessionId);
      expect(history).toHaveLength(1);
      expect(history[0].prompt).toBe('Persist me');
    });
  });

  describe('appendTurn', () => {
    it('assigns a unique turnId', async () => {
      const turn = await store.appendTurn('sess', { prompt: 'p', response: 'r', model: 'm', conversationId: null, timestamp: 1 });
      expect(typeof turn.turnId).toBe('string');
      expect(turn.turnId.length).toBeGreaterThan(0);
    });

    it('creates session directory if it does not exist', async () => {
      const nestedStore = new AntigravitySessionStore(join(tempDir, 'nested', 'sessions'));
      const turn = await nestedStore.appendTurn('sess', { prompt: 'p', response: 'r', model: 'm', conversationId: null, timestamp: 1 });
      expect(turn.prompt).toBe('p');
    });

    it('appends multiple turns to same session', async () => {
      const sessionId = 'multi';
      for (let i = 0; i < 5; i++) {
        await store.appendTurn(sessionId, { prompt: `prompt-${i}`, response: `reply-${i}`, model: 'm', conversationId: null, timestamp: i });
      }
      const history = await store.loadHistory(sessionId);
      expect(history).toHaveLength(5);
      expect(history[4].prompt).toBe('prompt-4');
    });
  });

  describe('priorStdoutLength', () => {
    it('returns 0 for empty history', () => {
      expect(store.priorStdoutLength([])).toBe(0);
    });

    it('returns rawStdoutLength of the last turn when present', async () => {
      const sessionId = 'raw-stdout-test';
      await store.appendTurn(sessionId, { prompt: 'p1', response: 'abc', model: 'm', conversationId: null, timestamp: 1, rawStdoutLength: 30 });
      await store.appendTurn(sessionId, { prompt: 'p2', response: 'defgh', model: 'm', conversationId: null, timestamp: 2, rawStdoutLength: 50 });
      const history = await store.loadHistory(sessionId);
      // Should return the last turn's rawStdoutLength (cumulative)
      expect(store.priorStdoutLength(history)).toBe(50);
    });

    it('falls back to sum of response lengths for legacy turns without rawStdoutLength', async () => {
      const sessionId = 'legacy-test';
      await store.appendTurn(sessionId, { prompt: 'p1', response: 'abc', model: 'm', conversationId: null, timestamp: 1 });
      await store.appendTurn(sessionId, { prompt: 'p2', response: 'defgh', model: 'm', conversationId: null, timestamp: 2 });
      const history = await store.loadHistory(sessionId);
      expect(store.priorStdoutLength(history)).toBe(8); // 'abc'.length + 'defgh'.length
    });
  });

  describe('sessionExists', () => {
    it('returns false for nonexistent session', async () => {
      expect(await store.sessionExists('no-such')).toBe(false);
    });

    it('returns true after creating a session', async () => {
      await store.appendTurn('exists', { prompt: 'x', response: 'y', model: 'm', conversationId: null, timestamp: 1 });
      expect(await store.sessionExists('exists')).toBe(true);
    });
  });
});
