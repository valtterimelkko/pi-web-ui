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

  describe('startTurn / finalizeTurn — durable turn lifecycle', () => {
    it('startTurn writes a running line with an empty response', async () => {
      const turn = await store.startTurn('sess', { turnId: 't1', prompt: 'hello', model: 'm', conversationId: null, timestamp: 1 });
      expect(turn.status).toBe('running');
      expect(turn.response).toBe('');

      const history = await store.loadHistory('sess');
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('running');
      expect(history[0].prompt).toBe('hello');
      expect(history[0].response).toBe('');
    });

    it('finalizeTurn flips running → done with response + rawStdoutLength and keeps exactly one line for the turn', async () => {
      const turn = await store.startTurn('sess', { turnId: 't1', prompt: 'hello', model: 'm', conversationId: null, timestamp: 1 });
      await store.finalizeTurn('sess', 't1', { status: 'done', response: 'world', rawStdoutLength: 42 });

      const history = await store.loadHistory('sess');
      expect(history).toHaveLength(1); // no duplicate line
      expect(history[0].turnId).toBe(turn.turnId);
      expect(history[0].status).toBe('done');
      expect(history[0].response).toBe('world');
      expect(history[0].rawStdoutLength).toBe(42);
    });

    it('finalizeTurn → error sets status:error + error text and leaves rawStdoutLength unset', async () => {
      await store.startTurn('sess', { turnId: 't1', prompt: 'hello', model: 'm', conversationId: null, timestamp: 1 });
      await store.finalizeTurn('sess', 't1', { status: 'error', response: 'partial', error: 'timed out' });

      const history = await store.loadHistory('sess');
      expect(history).toHaveLength(1);
      expect(history[0].status).toBe('error');
      expect(history[0].error).toBe('timed out');
      expect(history[0].response).toBe('partial');
      expect(history[0].rawStdoutLength).toBeUndefined();
    });

    it('finalizeTurn preserves other turns when rewriting (atomic in-place update)', async () => {
      await store.appendTurn('sess', { prompt: 'p0', response: 'r0', model: 'm', conversationId: null, timestamp: 0, rawStdoutLength: 10 });
      await store.startTurn('sess', { turnId: 't1', prompt: 'p1', model: 'm', conversationId: null, timestamp: 1 });
      await store.finalizeTurn('sess', 't1', { status: 'done', response: 'r1', rawStdoutLength: 20 });

      const history = await store.loadHistory('sess');
      expect(history).toHaveLength(2);
      expect(history[0].response).toBe('r0');
      expect(history[1].turnId).toBe('t1');
      expect(history[1].status).toBe('done');
    });

    it('finalizeTurn on an unknown turnId appends a finalized line (defensive)', async () => {
      await store.finalizeTurn('sess', 'never-started', { status: 'error', response: '', error: 'interrupted' });
      const history = await store.loadHistory('sess');
      expect(history).toHaveLength(1);
      expect(history[0].turnId).toBe('never-started');
      expect(history[0].status).toBe('error');
    });

    it('finalizeTurn can update conversationId on a previously-running turn', async () => {
      await store.startTurn('sess', { turnId: 't1', prompt: 'p', model: 'm', conversationId: null, timestamp: 1 });
      await store.finalizeTurn('sess', 't1', { status: 'done', response: 'r', conversationId: 'conv-1', rawStdoutLength: 5 });
      const history = await store.loadHistory('sess');
      expect(history[0].conversationId).toBe('conv-1');
    });

    it('finalizeTurn persists turnDurationMs (timing observability)', async () => {
      await store.startTurn('sess', { turnId: 't1', prompt: 'p', model: 'm', conversationId: null, timestamp: 1 });
      await store.finalizeTurn('sess', 't1', { status: 'done', response: 'r', rawStdoutLength: 1, turnDurationMs: 1234 });
      const history = await store.loadHistory('sess');
      expect(history[0].turnDurationMs).toBe(1234);
    });
  });

  describe('legacy / back-compat', () => {
    it('a turn loaded with no status field is treated as done by isDone()', async () => {
      await store.appendTurn('sess', { prompt: 'p', response: 'r', model: 'm', conversationId: null, timestamp: 1 });
      const history = await store.loadHistory('sess');
      expect(history[0].status).toBeUndefined();
      // isDone must be true for a legacy (no-status) line.
      expect(store.isDone(history[0])).toBe(true);
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

    it('ignores a trailing running turn and returns the offset of the last done turn', async () => {
      // done turn (offset 30) followed by a still-running turn with no offset.
      await store.appendTurn('sess', { prompt: 'p1', response: 'abc', model: 'm', conversationId: null, timestamp: 1, status: 'done', rawStdoutLength: 30 });
      await store.startTurn('sess', { turnId: 't-running', prompt: 'p2', model: 'm', conversationId: null, timestamp: 2 });
      const history = await store.loadHistory('sess');
      expect(store.priorStdoutLength(history)).toBe(30);
    });

    it('ignores a trailing error turn (no rawStdoutLength) and returns the last done offset', async () => {
      await store.appendTurn('sess', { prompt: 'p1', response: 'abc', model: 'm', conversationId: null, timestamp: 1, status: 'done', rawStdoutLength: 30 });
      await store.appendTurn('sess', { prompt: 'p2', response: '', model: 'm', conversationId: null, timestamp: 2, status: 'error', error: 'boom' });
      const history = await store.loadHistory('sess');
      expect(store.priorStdoutLength(history)).toBe(30);
    });

    it('§5.1 regression: a done → error → done sequence yields the second done offset, not a corrupted one', async () => {
      // Turn 1: done, cumulative offset 100.
      await store.appendTurn('sess', { prompt: 'p1', response: 'abc', model: 'm', conversationId: null, timestamp: 1, status: 'done', rawStdoutLength: 100 });
      // Turn 2: error — must contribute NO offset.
      await store.appendTurn('sess', { prompt: 'p2', response: '', model: 'm', conversationId: null, timestamp: 2, status: 'error', error: 'timed out' });
      // Turn 3: done, cumulative offset 250. The next turn's reply slice must start at 250,
      // proving the intervening error turn did not corrupt the running offset.
      await store.appendTurn('sess', { prompt: 'p3', response: 'def', model: 'm', conversationId: null, timestamp: 3, status: 'done', rawStdoutLength: 250 });
      const history = await store.loadHistory('sess');
      expect(store.priorStdoutLength(history)).toBe(250);
    });

    it('returns 0 when only running/error turns exist (no done turn to anchor on)', async () => {
      await store.appendTurn('sess', { prompt: 'p1', response: '', model: 'm', conversationId: null, timestamp: 1, status: 'error', error: 'x' });
      await store.startTurn('sess', { turnId: 'tr', prompt: 'p2', model: 'm', conversationId: null, timestamp: 2 });
      const history = await store.loadHistory('sess');
      expect(store.priorStdoutLength(history)).toBe(0);
    });
  });

  describe('priorReplyAnchor', () => {
    it('returns offset 0 and empty text for empty history', () => {
      expect(store.priorReplyAnchor([])).toEqual({ offset: 0, text: '' });
    });

    it('pairs the last done turn\'s rawStdoutLength with its response text', async () => {
      const sessionId = 'anchor-test';
      await store.appendTurn(sessionId, { prompt: 'p1', response: 'abc', model: 'm', conversationId: null, timestamp: 1, rawStdoutLength: 30 });
      await store.appendTurn(sessionId, { prompt: 'p2', response: 'defgh', model: 'm', conversationId: null, timestamp: 2, rawStdoutLength: 50 });
      const history = await store.loadHistory(sessionId);
      expect(store.priorReplyAnchor(history)).toEqual({ offset: 50, text: 'defgh' });
    });

    it('ignores a trailing running turn and anchors on the last done turn', async () => {
      await store.appendTurn('sess', { prompt: 'p1', response: 'abc', model: 'm', conversationId: null, timestamp: 1, status: 'done', rawStdoutLength: 30 });
      await store.startTurn('sess', { turnId: 't-running', prompt: 'p2', model: 'm', conversationId: null, timestamp: 2 });
      const history = await store.loadHistory('sess');
      expect(store.priorReplyAnchor(history)).toEqual({ offset: 30, text: 'abc' });
    });

    it('ignores a trailing error turn and anchors on the last done turn', async () => {
      await store.appendTurn('sess', { prompt: 'p1', response: 'abc', model: 'm', conversationId: null, timestamp: 1, status: 'done', rawStdoutLength: 30 });
      await store.appendTurn('sess', { prompt: 'p2', response: '', model: 'm', conversationId: null, timestamp: 2, status: 'error', error: 'boom' });
      const history = await store.loadHistory('sess');
      expect(store.priorReplyAnchor(history)).toEqual({ offset: 30, text: 'abc' });
    });

    it('falls back to the legacy summed offset for turns without rawStdoutLength, anchored on the last turn\'s text', async () => {
      const sessionId = 'legacy-anchor-test';
      await store.appendTurn(sessionId, { prompt: 'p1', response: 'abc', model: 'm', conversationId: null, timestamp: 1 });
      await store.appendTurn(sessionId, { prompt: 'p2', response: 'defgh', model: 'm', conversationId: null, timestamp: 2 });
      const history = await store.loadHistory(sessionId);
      expect(store.priorReplyAnchor(history)).toEqual({ offset: 8, text: 'defgh' });
    });

    it('returns offset 0 and empty text when only running/error turns exist', async () => {
      await store.appendTurn('sess', { prompt: 'p1', response: '', model: 'm', conversationId: null, timestamp: 1, status: 'error', error: 'x' });
      await store.startTurn('sess', { turnId: 'tr', prompt: 'p2', model: 'm', conversationId: null, timestamp: 2 });
      const history = await store.loadHistory('sess');
      expect(store.priorReplyAnchor(history)).toEqual({ offset: 0, text: '' });
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
