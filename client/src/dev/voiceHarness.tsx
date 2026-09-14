/**
 * TEMPORARY DEV HARNESS for screenshotting the Voice Mode four states —
 * not part of the app bundle (nothing imports it; served only at
 * /voice-harness.html by the dev server). Delete or keep at review.
 *
 * Network is stubbed: /api/tts returns a generated tone, /api/dictation/*
 * return canned transcripts, and WebSocket is a fake that accepts sends so
 * talker turns are "accepted" without a backend. Everything else on screen
 * (surface, hook, arbiter, confirmation card, floor banner) is the REAL
 * production code.
 */
/* eslint-disable */
// @ts-nocheck

// --- Network stubs must be installed before any component mounts ------------
const openSockets: FakeWebSocket[] = [];
const sentMessages: Record<string, unknown>[] = [];

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  url: string;
  readyState = 1;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  constructor(url: string) {
    this.url = url;
    openSockets.push(this);
    setTimeout(() => this.onopen?.({ type: 'open' }), 0);
  }
  send(message: unknown) {
    // P17 harness addition: record what the surface sent, and answer a digest
    // request with a canned digest through the REAL result bus, so the reading
    // levels can be driven end to end for a screenshot without a backend.
    // WebSocketClient serialises here, so the message arrives as JSON text.
    const parsed = typeof message === 'string' ? (JSON.parse(message) as Record<string, unknown>) : message;
    sentMessages.push(parsed as Record<string, unknown>);
    const msg = parsed as { type?: string; requestId?: string; kind?: string };
    if (msg?.type === 'talker_digest' && msg.requestId) {
      setTimeout(() => {
        emitTurnDigestResult({
          type: 'talker_digest_result',
          requestId: msg.requestId,
          workerSessionId: '/tmp/harness/worker.jsonl',
          kind: msg.kind === 'headlines' ? 'headlines' : 'summary',
          digest:
            msg.kind === 'headlines'
              ? 'Done: the auth refactor is complete and green. Needs you: approve the deploy.'
              : 'The auth refactor is complete and every suite is green. The migration is half written, and the deploy is waiting on your approval.',
        });
      }, 60);
    }
  }
  close() {
    this.readyState = 3;
  }
  addEventListener(_t: string, fn: (ev: unknown) => void) {
    if (_t === 'open') setTimeout(() => fn({ type: 'open' }), 0);
  }
  removeEventListener() {}
}

(window as any).WebSocket = FakeWebSocket;

/** A 3-second 440 Hz mono 16 kHz WAV — long enough to screenshot mid-play. */
function toneWav(seconds = 3, freq = 440): ArrayBuffer {
  const rate = 16000;
  const n = rate * seconds;
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const w = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  w(36, 'data');
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * freq * i) / rate) * 8000), true);
  }
  return buffer;
}

const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('/api/tts')) {
    return new Response(toneWav(), {
      headers: { 'Content-Type': 'audio/wav' },
    });
  }
  if (url.includes('/api/dictation/start')) {
    return new Response(JSON.stringify({ id: 'harness-1' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  if (url.includes('/api/dictation/harness-1/finish')) {
    return new Response(
      JSON.stringify({ text: 'rebase the auth branch and rerun the smoke tests', duration_ms: 1500 }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  }
  if (url.includes('/api/dictation/')) {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return realFetch(input as RequestInfo, init);
};

// --- Real production surface --------------------------------------------------
import { createRoot } from 'react-dom/client';
import { DriveModeDictate } from '../components/DriveMode/DriveModeDictate';
import { speechArbiter } from '../lib/speechArbiter';
import { useSessionStore } from '../store/sessionStore';
import { emitTalkerTurnResult } from '../lib/talkerBus';
import { emitTurnDigestResult } from '../lib/turnDigest';
import '../index.css';

// Screenshot/evidence tap: what the arbiter was actually asked to SPEAK (the
// arbiter itself is production code and is not modified — this wraps it).
const spoken: Array<{ id: string; tier: number; text: string }> = [];
const realSubmit = speechArbiter.submit.bind(speechArbiter);
(speechArbiter as { submit: typeof speechArbiter.submit }).submit = (input) => {
  spoken.push({
    id: input.id ?? '',
    tier: input.tier,
    text: input.text ?? (input.chunks ? input.chunks.join(' ') : ''),
  });
  return realSubmit(input);
};

(window as any).__voice = {
  speechArbiter,
  emitTalkerTurnResult,
  emitTurnDigestResult,
  sessionStore: useSessionStore,
  sentMessages,
  spoken,
};

const app = document.getElementById('root')!;
app.className =
  'max-w-[430px] mx-auto h-screen bg-white dark:bg-gray-950 border-x border-gray-200 dark:border-gray-800';

createRoot(app).render(
  <DriveModeDictate
    sessionId="/tmp/harness/worker.jsonl"
    sdkType="pi"
    modelName="Gemma 4 26B (talker) · Claude Sonnet 5 (worker)"
    sessionDisplayName="Harness Worker Session"
    onExit={() => {}}
    onAbort={() => {}}
  />
);
