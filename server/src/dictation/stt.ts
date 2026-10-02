import { config } from '../config.js';
import { getSharedOpenAIClient } from './connectionPool.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('Stt');

/**
 * STT tiers (2026-10-02, Benchmark 6 on real dictation):
 *   1. primary — OpenRouter `openai/whisper-large-v3-turbo` pinned to
 *      DeepInfra (1.47% WER at $0.20/1k audio-min)
 *   2. fallback — local Parakeet v3 on 127.0.0.1:9000 (free, offline)
 *   3. last resort — OpenAI gpt-transcribe (the old gpt-4o transcription
 *      family is removed from the API on 2027-02-26)
 * The endpoint is one-shot JSON: the speculative warm-up in the dictation
 * route keeps final-text latency low without any streaming API.
 */
const STT_MODEL = 'openai/whisper-large-v3-turbo';
const STT_FALLBACK_MODEL = 'gpt-transcribe';
const OPENROUTER_STT_URL_DEFAULT = 'https://openrouter.ai/api/v1/audio/transcriptions';
const LOCAL_ASR_URL_DEFAULT = 'http://127.0.0.1:9000/asr';
const OPENROUTER_PROVIDER_PIN = { order: ['DeepInfra'], allow_fallbacks: false } as const;

// Resolved at call time so tests (and ops) can redirect endpoints via env.
function openrouterSttUrl(): string {
  return process.env.OPENROUTER_STT_URL || OPENROUTER_STT_URL_DEFAULT;
}
function localAsrUrl(): string {
  return process.env.LOCAL_ASR_URL || LOCAL_ASR_URL_DEFAULT;
}

export interface STTResult {
  text: string;
  model: string;
  usedFallback: boolean;
}

async function openrouterTranscribe(audioChunks: Buffer[], prompt?: string): Promise<STTResult> {
  if (!config.openrouterApiKey) {
    throw new Error('OPENROUTER_API_KEY is not configured');
  }
  const audioBuffer = Buffer.concat(audioChunks);
  const body: Record<string, unknown> = {
    model: STT_MODEL,
    input_audio: {
      data: audioBuffer.toString('base64'),
      format: 'webm',
    },
    provider: OPENROUTER_PROVIDER_PIN,
  };
  if (prompt) body.prompt = prompt;
  const response = await fetch(openrouterSttUrl(), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openrouterApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`OpenRouter STT HTTP ${response.status}: ${detail.slice(0, 200)}`);
  }
  const payload = (await response.json()) as { text?: string };
  const text = (payload.text ?? '').trim();
  if (!text) throw new Error('OpenRouter STT returned an empty transcript');
  return { text, model: STT_MODEL, usedFallback: false };
}

async function localTranscribe(audioChunks: Buffer[]): Promise<STTResult> {
  const audioBuffer = Buffer.concat(audioChunks);
  const form = new FormData();
  form.append('language', 'en');
  form.append('audio_file', new Blob([new Uint8Array(audioBuffer)], { type: 'audio/webm' }), 'audio.webm');
  const response = await fetch(localAsrUrl(), { method: 'POST', body: form });
  if (!response.ok) {
    throw new Error(`local ASR HTTP ${response.status}`);
  }
  const raw = await response.text();
  let text = raw.trim();
  try {
    const parsed = JSON.parse(raw) as { text?: string };
    if (typeof parsed.text === 'string') text = parsed.text.trim();
  } catch {
    // plain-text response — keep as-is
  }
  if (!text) throw new Error('local ASR returned an empty transcript');
  return { text, model: 'parakeet-v3-local', usedFallback: true };
}

async function openAITranscribe(audioChunks: Buffer[], prompt?: string): Promise<STTResult> {
  const client = getSharedOpenAIClient();
  const audioBuffer = Buffer.concat(audioChunks);
  const file = new File([audioBuffer], 'audio.webm', { type: 'audio/webm' });
  const response = await client.audio.transcriptions.create({
    model: STT_FALLBACK_MODEL,
    file,
    response_format: 'text',
    ...(prompt ? { prompt } : {}),
  });
  return {
    text: typeof response === 'string' ? response : String(response),
    model: STT_FALLBACK_MODEL,
    usedFallback: true,
  };
}

export async function transcribeWithFallback(audioChunks: Buffer[], prompt?: string): Promise<STTResult> {
  try {
    return await openrouterTranscribe(audioChunks, prompt);
  } catch (primaryError) {
    logger.error('primary STT (OpenRouter) failed, trying local ASR:', primaryError);
  }
  try {
    return await localTranscribe(audioChunks);
  } catch (localError) {
    logger.error('local ASR failed, falling back to OpenAI gpt-transcribe:', localError);
  }
  return openAITranscribe(audioChunks, prompt);
}

export interface SpeculativeResult {
  promise: Promise<STTResult>;
  chunkCount: number;
  startedAt: number;
}

export function startSpeculativeTranscription(chunks: Buffer[], prompt?: string): SpeculativeResult {
  const chunksCopy = chunks.map(c => Buffer.from(c));
  return {
    promise: transcribeWithFallback(chunksCopy, prompt),
    chunkCount: chunks.length,
    startedAt: Date.now(),
  };
}

export function shouldUseSpeculative(
  speculative: SpeculativeResult,
  totalChunks: number
): boolean {
  if (totalChunks <= speculative.chunkCount) return true;
  const newChunksRatio = (totalChunks - speculative.chunkCount) / totalChunks;
  return newChunksRatio < 0.3;
}
