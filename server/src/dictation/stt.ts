import { getSharedOpenAIClient } from './connectionPool.js';

const STT_MODEL = 'gpt-4o-mini-transcribe';

export interface STTResult {
  text: string;
  model: string;
  usedFallback: boolean;
}

export async function streamTranscribe(audioChunks: Buffer[]): Promise<STTResult> {
  const client = getSharedOpenAIClient();
  const audioBuffer = Buffer.concat(audioChunks);
  const file = new File([audioBuffer], 'audio.webm', { type: 'audio/webm' });

  const response = await client.audio.transcriptions.create({
    model: STT_MODEL,
    file: file,
    response_format: 'text',
  });

  return {
    text: typeof response === 'string' ? response : String(response),
    model: STT_MODEL,
    usedFallback: false,
  };
}

export async function batchTranscribe(audioBuffer: Buffer): Promise<STTResult> {
  const client = getSharedOpenAIClient();
  const file = new File([audioBuffer], 'audio.webm', { type: 'audio/webm' });

  const response = await client.audio.transcriptions.create({
    model: STT_MODEL,
    file: file,
    response_format: 'text',
  });

  return {
    text: typeof response === 'string' ? response : String(response),
    model: STT_MODEL,
    usedFallback: true,
  };
}

export async function transcribeWithFallback(audioChunks: Buffer[]): Promise<STTResult> {
  try {
    return await streamTranscribe(audioChunks);
  } catch (primaryError) {
    console.error('primary STT failed, attempting batch fallback:', primaryError);
    const audioBuffer = Buffer.concat(audioChunks);
    return await batchTranscribe(audioBuffer);
  }
}

export interface SpeculativeResult {
  promise: Promise<STTResult>;
  chunkCount: number;
  startedAt: number;
}

export function startSpeculativeTranscription(chunks: Buffer[]): SpeculativeResult {
  const chunksCopy = chunks.map(c => Buffer.from(c));
  return {
    promise: transcribeWithFallback(chunksCopy),
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
