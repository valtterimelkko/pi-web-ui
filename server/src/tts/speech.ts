import { config } from '../config.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('Tts');

/**
 * TTS tiers (2026-10-03, live-probed with real keys):
 *   1. primary — OpenRouter `google/gemini-3.8-flash-lite-tts`
 *      (Elo 1240 on the AA speech leaderboard vs tts-1's 1089). The Gemini
 *      provider on OpenRouter REJECTS response_format=mp3 (verified live),
 *      so we request pcm and wrap it in a 44-byte WAV header server-side
 *      (24 kHz mono s16le by default; the response content-type declares
 *      the actual rate/channels) and serve audio/wav.
 *   2. fallback — OpenAI gpt-4o-mini-tts serving mp3. TRANSITION LEG ONLY:
 *      the whole OpenAI legacy TTS family (tts-1, tts-1-hd,
 *      gpt-4o-mini-tts) is removed from the API on 2027-01-06; replace
 *      with OpenAI's successor (or drop the tier) when it ships.
 * Voice notes: the 30 Gemini studio voices replace the OpenAI voice list;
 * legacy OpenAI voice names are aliased so saved user preferences keep
 * working, and unknown voices degrade to the Kore default.
 */
const OPENROUTER_TTS_URL_DEFAULT = 'https://openrouter.ai/api/v1/audio/speech';
const OPENAI_TTS_URL_DEFAULT = 'https://api.openai.com/v1/audio/speech';
const OPENAI_FALLBACK_VOICE = 'alloy';

// Resolved at call time so tests (and ops) can redirect endpoints via env.
function openrouterTtsUrl(): string {
  return process.env.OPENROUTER_TTS_URL || OPENROUTER_TTS_URL_DEFAULT;
}
function openAiTtsUrl(): string {
  return process.env.OPENAI_TTS_URL || OPENAI_TTS_URL_DEFAULT;
}

export const GEMINI_VOICES = [
  'Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede',
  'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba',
  'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar',
  'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi',
  'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafath',
] as const;

export type GeminiVoice = (typeof GEMINI_VOICES)[number];

export const DEFAULT_VOICE: GeminiVoice = 'Kore';

/** Saved preferences carry legacy OpenAI voice names; alias them onto Gemini voices. */
const LEGACY_VOICE_ALIASES: Record<string, GeminiVoice> = {
  alloy: 'Kore', ash: 'Charon', ballad: 'Fenrir', coral: 'Leda',
  echo: 'Puck', fable: 'Aoede', nova: 'Sulafath', onyx: 'Orus',
  sage: 'Algieba', shimmer: 'Zephyr', verse: 'Iapetus',
  marin: 'Laomedeia', cedar: 'Enceladus',
};

export function resolveVoice(voice: unknown): GeminiVoice {
  if (typeof voice === 'string') {
    const lower = voice.toLowerCase();
    const direct = GEMINI_VOICES.find(v => v.toLowerCase() === lower);
    if (direct) return direct;
    const alias = LEGACY_VOICE_ALIASES[lower];
    if (alias) return alias;
  }
  return DEFAULT_VOICE;
}

/** Wrap raw s16le PCM in a 44-byte RIFF/WAVE header (the browser plays WAV, not bare PCM). */
export function pcmToWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** `audio/pcm;rate=24000;channels=1` → { rate, channels } with sane defaults. */
function parsePcmContentType(contentType: string | null): { rate: number; channels: number } {
  const ct = contentType ?? '';
  const rate = /rate=(\d+)/.exec(ct)?.[1];
  const channels = /channels=(\d+)/.exec(ct)?.[1];
  return {
    rate: rate ? Number(rate) : 24000,
    channels: channels ? Number(channels) : 1,
  };
}

export class TtsNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TtsNotConfiguredError';
  }
}

export interface SpeechResult {
  audio: Buffer;
  contentType: string;
  model: string;
  usedFallback: boolean;
}

async function openRouterSpeech(text: string, voice: GeminiVoice): Promise<SpeechResult> {
  if (!config.openrouterApiKey) {
    throw new TtsNotConfiguredError('OPENROUTER_API_KEY is not configured');
  }
  const response = await fetch(openrouterTtsUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openrouterApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.ttsModel,
      input: text,
      voice,
      response_format: 'pcm',
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenRouter TTS HTTP ${response.status}: ${detail.slice(0, 200)}`);
  }
  const pcm = Buffer.from(await response.arrayBuffer());
  if (pcm.length === 0) throw new Error('OpenRouter TTS returned an empty audio body');
  const { rate, channels } = parsePcmContentType(response.headers.get('content-type'));
  return {
    audio: pcmToWav(pcm, rate, channels),
    contentType: 'audio/wav',
    model: config.ttsModel,
    usedFallback: false,
  };
}

async function openAiFallbackSpeech(text: string): Promise<SpeechResult> {
  if (!config.ttsOpenaiApiKey) {
    throw new TtsNotConfiguredError('No TTS provider key is configured');
  }
  const response = await fetch(openAiTtsUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.ttsOpenaiApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.ttsOpenaiFallbackModel,
      voice: OPENAI_FALLBACK_VOICE,
      input: text,
      response_format: 'mp3',
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenAI TTS HTTP ${response.status}: ${detail.slice(0, 200)}`);
  }
  const mp3 = Buffer.from(await response.arrayBuffer());
  if (mp3.length === 0) throw new Error('OpenAI TTS returned an empty audio body');
  return {
    audio: mp3,
    contentType: 'audio/mpeg',
    model: config.ttsOpenaiFallbackModel,
    usedFallback: true,
  };
}

export async function synthesizeSpeech(text: string, voice: unknown): Promise<SpeechResult> {
  try {
    return await openRouterSpeech(text, resolveVoice(voice));
  } catch (primaryError) {
    if (primaryError instanceof TtsNotConfiguredError && !config.ttsOpenaiApiKey) throw primaryError;
    logger.error('primary TTS (OpenRouter Gemini) failed, trying OpenAI fallback:', primaryError);
  }
  return openAiFallbackSpeech(text);
}
