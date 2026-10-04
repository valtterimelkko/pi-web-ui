import { Router, type Request, type Response } from 'express';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import { createLogger } from '../logging/logger.js';
import { synthesizeSpeech, TtsNotConfiguredError } from '../tts/speech.js';

const logger = createLogger('Tts');

const router = Router();

const MAX_TEXT_LENGTH = 4000;

router.use(cookieAuthMiddleware);

router.post('/', async (req: Request, res: Response) => {
  const { text, voice } = req.body as { text?: unknown; voice?: unknown };

  if (typeof text !== 'string' || text.trim().length === 0) {
    res.status(400).json({ error: 'Missing or empty text field' });
    return;
  }

  const trimmedText = text.trim();
  if (trimmedText.length > MAX_TEXT_LENGTH) {
    res.status(400).json({ error: `Text exceeds maximum length of ${MAX_TEXT_LENGTH} characters` });
    return;
  }

  try {
    const result = await synthesizeSpeech(trimmedText, voice);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Length', result.audio.length.toString());
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(result.audio);
  } catch (err: unknown) {
    if (err instanceof TtsNotConfiguredError) {
      res.status(503).json({ error: err.message });
      return;
    }
    const message = err instanceof Error ? err.message : 'TTS generation failed';
    logger.error('TTS error:', message);
    res.status(502).json({ error: 'Failed to generate speech', detail: message });
  }
});

export default router;
