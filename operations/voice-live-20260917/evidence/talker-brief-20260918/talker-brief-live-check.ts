/**
 * Live proof for the 2026-09-18 field report: the native talker refused to say
 * anything about the worker's work.
 *
 * This runs the REAL production pieces against the REAL provider:
 *   - the real system instruction (DEFAULT_VOICE_SYSTEM_INSTRUCTION),
 *   - the real context text (composeContextText) carrying a worker brief,
 *   - a real Gemini Live session, asked the operator's own question by text.
 *
 * It runs the question twice: WITHOUT a brief (the shipped behaviour) and WITH
 * one (the fix). The comparison is the point — not a claim that a prompt is nice.
 *
 * Run: cd /root/pi-web-ui && npx tsx /tmp/talker-brief-live-check.ts
 */
import { readFileSync } from 'node:fs';
import { GoogleGenAI } from '/root/pi-web-ui/node_modules/@google/genai/dist/node/index.mjs';
import { buildVoiceConnectConfig } from '/root/pi-web-ui/server/src/voice/gemini-live-bridge.js';
import { composeContextText, DEFAULT_VOICE_SYSTEM_INSTRUCTION } from '/root/pi-web-ui/server/src/voice/voice-session.js';
import { VOICE_PROVIDER_MODEL } from '/root/pi-web-ui/server/src/voice/types.js';

const QUESTION = 'What is the most significant work that the worker has done here?';

const brief = composeContextText({
  workerActivity: 'idle',
  statusLine: 'CURRENT STATUS: IDLE',
  atMs: Date.now(),
  history: {
    entries: [
      { role: 'user', text: 'Please make the voice lane capture work in the deployed UI, and tell me what you find.' },
      {
        role: 'assistant',
        text:
          'Found it: the capture worklet was handed to audioWorklet.addModule as a blob: URL, and the production CSP (script-src self, no blob:) refuses that as a script — so capture could never start in the deployed UI while working in dev. Fixed by serving the same generated worklet bytes as a same-origin asset emitted into the bundle, with the dev server serving the same path, and the blob kept only as a fallback. Verified in a real browser against a production build behind the exact production CSP: the same-origin worklet loads, the blob is refused, and the native lane reached capture live for both open mic and push-to-talk. Deployed and CI green.',
      },
      { role: 'user', text: 'Did the legacy relay lane still work?' },
      { role: 'assistant', text: 'Yes — it uses a different capture path, which is what isolated the fault to the native lane.' },
    ],
    total: 4,
  },
});

async function ask(label: string, extraContext: string | null): Promise<string> {
  const key = readFileSync('/root/.pi-web-ui/secrets.env', 'utf8').match(/^GEMINI_API_KEY=(.*)$/m)?.[1]?.trim();
  if (!key) throw new Error('no GEMINI_API_KEY');
  const ai = new GoogleGenAI({ apiKey: key });
  const spoken: string[] = [];
  let done = false;

  // The SDK directly: this scratch check needs `sendClientContent` (text turns),
  // which the production bridge deliberately does not expose (audio only).
  const session = await ai.live.connect({
    model: VOICE_PROVIDER_MODEL,
    config: buildVoiceConnectConfig({
      manualActivityDetection: true,
      systemInstruction: DEFAULT_VOICE_SYSTEM_INSTRUCTION,
    }) as never,
    callbacks: {
      onopen: () => console.log(`[${label}] socket open`),
      onmessage: (message: Record<string, unknown>) => {
        const content = message.serverContent as
          | { outputTranscription?: { text?: string }; turnComplete?: boolean }
          | undefined;
        const text = content?.outputTranscription?.text;
        if (text) spoken.push(text);
        if (content?.turnComplete) done = true;
      },
      onerror: (error: Error) => console.log(`[${label}] provider error:`, error.message),
      onclose: () => undefined,
    } as never,
  });
  await new Promise((resolve) => setTimeout(resolve, 500));

  const sender = session as unknown as {
    sendClientContent: (input: unknown) => void;
  };
  if (extraContext) {
    // The host context is a turn of its own (as production injects it), and we
    // discard whatever the model says about it before asking the real question.
    sender.sendClientContent({ turns: [{ role: 'user', parts: [{ text: extraContext }] }], turnComplete: true });
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    spoken.length = 0;
    done = false;
  }
  sender.sendClientContent({ turns: [{ role: 'user', parts: [{ text: QUESTION }] }], turnComplete: true });

  // A live text turn occasionally lands with no transcript (provider timing, not
  // a behaviour difference): retry the question once before reporting silence.
  let deadline = Date.now() + 40_000;
  while (!done && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
  if (spoken.length === 0) {
    console.log(`[${label}] (no transcript on the first attempt; asking again)`);
    done = false;
    sender.sendClientContent({ turns: [{ role: 'user', parts: [{ text: QUESTION }] }], turnComplete: true });
    deadline = Date.now() + 40_000;
    while (!done && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  try { session.close(); } catch { /* ignore */ }
  const answer = spoken.join(' ').trim();
  console.log(`\n[${label}] ANSWER: ${answer || '(no transcript)'}\n`);
  return answer;
}

async function main(): Promise<void> {
  const withoutBrief = await ask('without brief (shipped behaviour)', null);
  const withBrief = await ask('with brief (the fix)', brief);

  const refusal = /don'?t have access|no access to|do not have access|I'?m sorry, but I/i;
  console.log('--- verdict ---');
  console.log(`without brief refused/hedged: ${refusal.test(withoutBrief)}`);
  console.log(`with brief refused?          : ${refusal.test(withBrief)}`);
  console.log(`with brief mentions the work : ${/worklet|blob|CSP|capture|voice lane|retry|deploy/i.test(withBrief)}`);
  console.log(`with brief length            : ${withBrief.length} chars`);
  process.exit(0);
}

main().catch((error) => { console.error('CHECK ERROR:', error); process.exit(3); });
