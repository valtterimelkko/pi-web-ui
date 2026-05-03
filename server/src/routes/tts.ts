import { Router, type Request, type Response } from 'express';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import { config } from '../config.js';

const router = Router();

const ALLOWED_VOICES = [
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable',
  'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar',
] as const;

type AllowedVoice = typeof ALLOWED_VOICES[number];

const DEFAULT_VOICE: AllowedVoice = 'alloy';
const MAX_TEXT_LENGTH = 4000;

function isAllowedVoice(v: unknown): v is AllowedVoice {
  return typeof v === 'string' && ALLOWED_VOICES.includes(v as AllowedVoice);
}

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

  const selectedVoice: AllowedVoice = isAllowedVoice(voice) ? voice : DEFAULT_VOICE;

  if (!config.ttsOpenaiApiKey) {
    res.status(503).json({ error: 'TTS service not configured' });
    return;
  }

  try {
    const openaiRes = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.ttsOpenaiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.ttsModel,
        voice: selectedVoice,
        input: trimmedText,
        response_format: 'mp3',
      }),
    });

    if (!openaiRes.ok) {
      const body = await openaiRes.json().catch(() => ({})) as Record<string, unknown>;
      throw new Error((body.error as { message?: string } | undefined)?.message ?? `OpenAI HTTP ${openaiRes.status}`);
    }

    const arrayBuffer = await openaiRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', buffer.length.toString());
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(buffer);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'TTS generation failed';
    console.error('TTS error:', message);
    res.status(502).json({ error: 'Failed to generate speech', detail: message });
  }
});

export default router;
