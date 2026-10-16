import { config } from '../config.js';
import { getSharedOpenAIClient } from './connectionPool.js';
import { createLogger } from '../logging/logger.js';

const logger = createLogger('Stt');

/**
 * STT tiers (xAI primary since 2026-10-16; before that OpenRouter
 * whisper-large-v3-turbo, Benchmark 6):
 *   1. primary — xAI Grok speech-to-text `grok-voice-transcribe-2.0`
 *      ($0.10 per audio hour). Whisper-turbo invented phrases such as
 *      "Thank you." and "Bye." on pauses and quiet audio (31 in ~5,700 words
 *      of real dictation history vs 0 for the OpenAI models); xAI did not.
 *   2. fallback — local ASR on 127.0.0.1:9000 (Fluid Speech Mini; free, offline)
 *   3. last resort — OpenAI gpt-transcribe (the old gpt-4o transcription
 *      family is removed from the API on 2027-02-26)
 * The endpoint is one-shot: the speculative warm-up in the dictation route
 * keeps final-text latency low without any streaming API.
 *
 * Hardening (2026-10-12): every tier attempt runs under a timeout
 * (STT_REQUEST_TIMEOUT_MS, default 30000), the primary tier is retried once
 * on a transient failure (timeout, network error, 429/5xx; delay
 * STT_RETRY_DELAY_MS, default 400), and every attempt logs one line
 * `attempt tier=... n=... outcome=... ms=... bytes=...` so tier usage and
 * empty-transcript rates can be counted from the journal.
 */
const STT_MODEL = 'grok-voice-transcribe-2.0';
const STT_FALLBACK_MODEL = 'gpt-transcribe';
const XAI_STT_URL_DEFAULT = 'https://api.x.ai/v1/stt';
const LOCAL_ASR_URL_DEFAULT = 'http://127.0.0.1:9000/asr';
const XAI_MAX_KEYTERMS = 100;
const XAI_MAX_KEYTERM_CHARS = 50;

// Resolved at call time so tests (and ops) can redirect endpoints via env.
function xaiSttUrl(): string {
  return process.env.XAI_STT_URL || XAI_STT_URL_DEFAULT;
}
function localAsrUrl(): string {
  return process.env.LOCAL_ASR_URL || LOCAL_ASR_URL_DEFAULT;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 400;
const DETAIL_MAX_CHARS = 300;

function requestTimeoutMs(): number {
  const raw = Number(process.env.STT_REQUEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REQUEST_TIMEOUT_MS;
}
function retryDelayMs(): number {
  const raw = Number(process.env.STT_RETRY_DELAY_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_RETRY_DELAY_MS;
}

type AttemptOutcome = 'empty' | 'http_error' | 'timeout' | 'network_error' | 'error';

/** One failed tier attempt; carries what the structured log line needs. */
class SttAttemptError extends Error {
  constructor(
    readonly outcome: AttemptOutcome,
    message: string,
    readonly transient: boolean,
    readonly detail?: string,
  ) {
    super(message);
  }
}

function clip(text: string): string {
  return text.replace(/\s+/g, ' ').slice(0, DETAIL_MAX_CHARS);
}

function classify(err: unknown): SttAttemptError {
  if (err instanceof SttAttemptError) return err;
  const name = (err as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return new SttAttemptError('timeout', 'request timed out', true);
  }
  if (err instanceof TypeError) {
    return new SttAttemptError('network_error', err.message, true);
  }
  return new SttAttemptError('error', err instanceof Error ? err.message : String(err), false);
}

/**
 * Run one tier attempt under a timeout and emit one greppable line either way:
 * `attempt tier=<t> n=<k> outcome=<o> ms=<ms> bytes=<n>`. Successes are logged
 * so tier usage (and any empty-transcript rate) can be counted from the journal.
 */
async function attempt(
  tier: string,
  n: number,
  bytes: number,
  run: (signal: AbortSignal) => Promise<STTResult>,
): Promise<STTResult> {
  const started = Date.now();
  try {
    const result = await run(AbortSignal.timeout(requestTimeoutMs()));
    logger.info(`attempt tier=${tier} n=${n} outcome=ok ms=${Date.now() - started} bytes=${bytes}`);
    return result;
  } catch (err) {
    const failure = classify(err);
    const detail = failure.detail ? ` detail=${JSON.stringify(failure.detail)}` : '';
    logger.error(
      `attempt tier=${tier} n=${n} outcome=${failure.outcome} ms=${Date.now() - started} bytes=${bytes} msg=${JSON.stringify(clip(failure.message))}${detail}`,
    );
    throw failure;
  }
}

function isTransientStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

export interface STTResult {
  text: string;
  model: string;
  usedFallback: boolean;
}

/** Split the comma/newline separated custom vocabulary into xAI key terms. */
function toKeyterms(vocabulary?: string): string[] {
  if (!vocabulary) return [];
  return vocabulary
    .split(/[,\n]/)
    .map((t) => t.trim().slice(0, XAI_MAX_KEYTERM_CHARS))
    .filter(Boolean)
    .slice(0, XAI_MAX_KEYTERMS);
}

async function xaiTranscribe(audioChunks: Buffer[], prompt: string | undefined, signal: AbortSignal): Promise<STTResult> {
  if (!config.xaiApiKey) {
    throw new Error('XAI_API_KEY is not configured');
  }
  const audioBuffer = Buffer.concat(audioChunks);
  // xAI requires the `file` field to be the LAST multipart field.
  const form = new FormData();
  form.append('model', STT_MODEL);
  form.append('language', 'en');
  for (const term of toKeyterms(prompt)) form.append('keyterm', term);
  form.append('file', new Blob([new Uint8Array(audioBuffer)], { type: 'audio/webm' }), 'audio.webm');
  const response = await fetch(xaiSttUrl(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.xaiApiKey}` },
    body: form,
    signal,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new SttAttemptError(
      'http_error',
      `xAI STT HTTP ${response.status}`,
      isTransientStatus(response.status),
      clip(detail),
    );
  }
  const payload = (await response.json()) as { text?: string };
  const text = (payload.text ?? '').trim();
  if (!text) {
    // Keep the payload (no transcript text in it by definition) so an empty
    // result can be told apart: silence, a provider quirk, or a billing-only reply.
    throw new SttAttemptError('empty', 'xAI STT returned an empty transcript', false, clip(JSON.stringify(payload)));
  }
  return { text, model: STT_MODEL, usedFallback: false };
}

async function localTranscribe(audioChunks: Buffer[], signal: AbortSignal): Promise<STTResult> {
  const audioBuffer = Buffer.concat(audioChunks);
  const form = new FormData();
  form.append('language', 'en');
  form.append('audio_file', new Blob([new Uint8Array(audioBuffer)], { type: 'audio/webm' }), 'audio.webm');
  const response = await fetch(localAsrUrl(), { method: 'POST', body: form, signal });
  if (!response.ok) {
    throw new SttAttemptError('http_error', `local ASR HTTP ${response.status}`, false);
  }
  const raw = await response.text();
  let text = raw.trim();
  try {
    const parsed = JSON.parse(raw) as { text?: string };
    if (typeof parsed.text === 'string') text = parsed.text.trim();
  } catch {
    // plain-text response — keep as-is
  }
  if (!text) throw new SttAttemptError('empty', 'local ASR returned an empty transcript', false);
  return { text, model: 'local-asr', usedFallback: true };
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
  const bytes = audioChunks.reduce((sum, c) => sum + c.length, 0);
  try {
    return await attempt('xai', 1, bytes, (signal) => xaiTranscribe(audioChunks, prompt, signal));
  } catch (primaryError) {
    if (primaryError instanceof SttAttemptError && primaryError.transient) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs()));
      try {
        return await attempt('xai', 2, bytes, (signal) => xaiTranscribe(audioChunks, prompt, signal));
      } catch {
        // already logged by attempt(); fall through to the local tier
      }
    }
    logger.warn('primary STT (xAI) failed, trying local ASR');
  }
  try {
    return await attempt('local', 1, bytes, (signal) => localTranscribe(audioChunks, signal));
  } catch {
    logger.warn('local ASR failed, falling back to OpenAI gpt-transcribe');
  }
  return attempt('openai', 1, bytes, () => openAITranscribe(audioChunks, prompt));
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
