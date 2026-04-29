import OpenAI from 'openai';
import { config } from '../config.js';

let openaiClient: OpenAI | null = null;
let warmedUp = false;

export function getSharedOpenAIClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: config.dictationOpenaiApiKey,
    });
  }
  return openaiClient;
}

export function isWarmedUp(): boolean {
  return warmedUp;
}

export async function warmupConnections(): Promise<void> {
  getSharedOpenAIClient();
  warmedUp = true;
}

export function resetForTesting(): void {
  openaiClient = null;
  warmedUp = false;
}
