import { getSharedOpenAIClient } from './connectionPool.js';

const OPENAI_CLEANUP_MODEL = 'gpt-5-nano';

const SYSTEM_PROMPT = "You are a transcription editor. Clean up voice transcripts with a LIGHT touch:\n1. Fix spelling and grammar mistakes only when they're clearly wrong\n2. Convert American spellings to British (color→colour, organize→organise, etc.)\n3. Remove filler words (um, uh, mmm, ooh, aah, öö, ääh, etc.)\n4. Fix obvious transcription errors\n5. Preserve the original language (don't translate)\n6. IMPORTANT: Keep the speaker's authentic voice, quirks, and natural speech patterns\n   - Do NOT remove sentences or restructure the flow\n   - Do NOT replace words just to make it sound more 'proper' or 'perfect'\n   - Do NOT smooth out rough edges or back-and-forth thinking\n   - Preserve non-native speaker expressions and authentic word choices\n   - Keep fragmented sentences if that's how the person speaks\n   - The transcript will be used for prompting LLMs, not for publication\n\nReturn ONLY the cleaned text, nothing else.";

export interface CleanupResult {
  cleanedText: string;
}

export async function cleanupTranscript(rawText: string): Promise<CleanupResult> {
  const client = getSharedOpenAIClient();

  const response = await client.chat.completions.create({
    model: OPENAI_CLEANUP_MODEL,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Clean up this transcript:\n\n${rawText}` },
    ],
    temperature: 0.3,
  });

  const cleanedText = response.choices?.[0]?.message?.content || '';

  return {
    cleanedText: cleanedText || rawText,
  };
}
