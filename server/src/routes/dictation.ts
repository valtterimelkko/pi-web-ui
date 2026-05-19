import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import { transcribeWithFallback, startSpeculativeTranscription, shouldUseSpeculative, type SpeculativeResult } from '../dictation/stt.js';
import { cleanupTranscript } from '../dictation/cleanup.js';
import { warmupConnections } from '../dictation/connectionPool.js';
import { getVocabulary } from '../dictation/vocabulary.js';

interface ActiveRecording {
  chunks: Buffer[];
  startedAt: number;
  speculative: SpeculativeResult | null;
}

const activeRecordings = new Map<string, ActiveRecording>();

const SPECULATIVE_DELAY_MS = 3_000;

const router = Router();

router.use(cookieAuthMiddleware);

router.post('/warmup', async (_req: Request, res: Response) => {
  await warmupConnections();
  res.json({ ok: true });
});

router.post('/start', (_req: Request, res: Response) => {
  const id = uuidv4();
  const recording: ActiveRecording = {
    chunks: [],
    startedAt: Date.now(),
    speculative: null,
  };
  activeRecordings.set(id, recording);

  const vocabulary = getVocabulary();
  const specTimer = setTimeout(() => {
    const rec = activeRecordings.get(id);
    if (rec && rec.chunks.length > 0 && !rec.speculative) {
      rec.speculative = startSpeculativeTranscription(rec.chunks, vocabulary);
    }
  }, SPECULATIVE_DELAY_MS);
  specTimer.unref();

  res.json({ id });
});

router.post('/:id/stream', (req: Request, res: Response) => {
  const recording = activeRecordings.get(req.params.id);
  if (!recording) {
    res.status(404).json({ error: 'Recording session not found' });
    return;
  }
  const chunk = req.body as Buffer;
  if (!Buffer.isBuffer(chunk) || chunk.length === 0) {
    res.status(400).json({ error: 'Empty or invalid audio chunk' });
    return;
  }
  recording.chunks.push(chunk);
  res.json({ ok: true });
});

router.post('/:id/finish', async (req: Request, res: Response) => {
  const recording = activeRecordings.get(req.params.id);
  if (!recording) {
    res.status(404).json({ error: 'Recording session not found' });
    return;
  }

  activeRecordings.delete(req.params.id);

  const durationMs = Date.now() - recording.startedAt;

  let rawText = '';

  const vocabulary = getVocabulary();

  try {
    const hasSpeculative =
      recording.speculative !== null &&
      shouldUseSpeculative(recording.speculative, recording.chunks.length);

    let sttResult;
    if (hasSpeculative && recording.speculative) {
      sttResult = await recording.speculative.promise;
    } else {
      sttResult = await transcribeWithFallback(recording.chunks, vocabulary);
    }
    rawText = sttResult.text;
  } catch {
    rawText = '';
  }

  let cleanedText = rawText;
  if (rawText) {
    try {
      const cleanupResult = await cleanupTranscript(rawText, vocabulary);
      cleanedText = cleanupResult.cleanedText;
    } catch {
      cleanedText = rawText;
    }
  }

  res.json({
    text: cleanedText,
    duration_ms: durationMs,
  });
});

export function getActiveRecordingCount(): number {
  return activeRecordings.size;
}

export default router;
