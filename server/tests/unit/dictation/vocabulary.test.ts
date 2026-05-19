import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';

const { mockDbPath } = vi.hoisted(() => {
  const { tmpdir } = require('os');
  const { join } = require('path');
  return {
    mockDbPath: join(tmpdir(), `pi-web-ui-vocab-test-${Date.now()}.db`),
  };
});

vi.mock('../../../src/config.js', () => ({
  config: {
    dictationVocabularyDbPath: mockDbPath,
  },
}));

import { getVocabulary, clearVocabularyCache } from '../../../src/dictation/vocabulary.js';

describe('Vocabulary Reader', () => {
  beforeEach(() => {
    clearVocabularyCache();
    // Create a fresh test DB
    const db = new Database(mockDbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        default_cleanup_model TEXT NOT NULL DEFAULT 'kimi',
        retention_days INTEGER NOT NULL DEFAULT 60,
        stt_vocabulary TEXT NOT NULL DEFAULT ''
      );
      INSERT OR REPLACE INTO user_settings (id, default_cleanup_model, retention_days, stt_vocabulary)
      VALUES (1, 'kimi', 60, '');
    `);
    db.close();
  });

  afterEach(() => {
    clearVocabularyCache();
    try {
      fs.unlinkSync(mockDbPath);
    } catch {
      // ignore
    }
  });

  it('returns empty string when vocabulary is empty', () => {
    const vocab = getVocabulary();
    expect(vocab).toBe('');
  });

  it('reads vocabulary from shared DB', () => {
    const db = new Database(mockDbPath);
    db.prepare("UPDATE user_settings SET stt_vocabulary = ? WHERE id = 1").run('Claude\nAnthropic');
    db.close();

    const vocab = getVocabulary();
    expect(vocab).toBe('Claude\nAnthropic');
  });

  it('caches results', () => {
    const db = new Database(mockDbPath);
    db.prepare("UPDATE user_settings SET stt_vocabulary = ? WHERE id = 1").run('Kubernetes');
    db.close();

    const first = getVocabulary();
    expect(first).toBe('Kubernetes');

    // Update DB behind the cache
    const db2 = new Database(mockDbPath);
    db2.prepare("UPDATE user_settings SET stt_vocabulary = ? WHERE id = 1").run('Docker');
    db2.close();

    // Should still return cached value
    const second = getVocabulary();
    expect(second).toBe('Kubernetes');
  });

  it('returns empty string when DB is missing', () => {
    clearVocabularyCache();
    fs.unlinkSync(mockDbPath);

    const vocab = getVocabulary();
    expect(vocab).toBe('');
  });
});
