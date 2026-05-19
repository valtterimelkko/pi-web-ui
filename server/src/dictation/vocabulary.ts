import Database from 'better-sqlite3';
import { config } from '../config.js';

let cachedVocabulary: string | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 5_000; // Refresh every 5 seconds to pick up edits without hammering the DB

/**
 * Read the user's STT vocabulary from the shared streaming-dictation database.
 * Results are cached briefly to avoid repeated disk reads during a single session.
 */
export function getVocabulary(): string {
  const now = Date.now();
  if (cachedVocabulary !== null && now - cachedAt < CACHE_TTL_MS) {
    return cachedVocabulary;
  }

  try {
    const db = new Database(config.dictationVocabularyDbPath, { readonly: true });
    const row = db.prepare(
      'SELECT stt_vocabulary FROM user_settings WHERE id = 1'
    ).get() as { stt_vocabulary: string } | undefined;
    db.close();
    cachedVocabulary = row?.stt_vocabulary ?? '';
  } catch {
    cachedVocabulary = '';
  }

  cachedAt = now;
  return cachedVocabulary;
}

/** Exposed for testing. */
export function clearVocabularyCache(): void {
  cachedVocabulary = null;
  cachedAt = 0;
}
