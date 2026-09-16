/*
 * INJECTION MARKING (2026-09-16) — server-side pins for the structural mark.
 *
 * The emitter marks the routine Agent OS capture prompt as a custom message
 * (role 'custom', customType 'agent-os-capture'). The talker's spoken context
 * is built from projections that keep only real conversation roles; these
 * tests PIN that marked injections drop out of every server-side projection
 * the talker and the transcript views read, and that everything else —
 * user, assistant, tool material — projects byte-for-byte as before.
 *
 * Structural-only guarantee: no projection keys on TEXT. An operator message
 * quoting the injection wording verbatim is role 'user' and is never dropped.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/claude/index.js', () => ({
  getClaudeService: () => {
    throw new Error('no claude source is needed for these pins');
  },
}));

import { TalkerSessionRegistry } from '../../../src/talker/session-registry.js';
import type { DefaultDeliveries } from '../../../src/talker/delivery.js';
import { createNullDelivery } from '../../../src/talker/delivery.js';
import type { ChatMessage, ModelTurnResult, TalkerModelClient } from '../../../src/talker/types.js';
import { parsePiSessionHistory } from '../../../src/pi/session-history.js';
import { projectDefaultViewFromEvents } from '@pi-web-ui/shared';

const OPERATOR_MARKER = '\n\nOPERATOR (out loud):';
const INJECTION_WORDS = 'Agent OS session-end memory capture (automated delivery by the D3 write lane).';
const HOUSEKEEPING_WORDS = 'Two memory candidates were extracted and evidence written to the captures folder.';

/** A model client that records the full prompt it was given every turn. */
function capturingModel(reply = 'Noted.'): TalkerModelClient & { prompts(): string[] } {
  const promptsSeen: string[] = [];
  return {
    prompts: () => promptsSeen,
    async completeTurn(messages: ChatMessage[]): Promise<ModelTurnResult> {
      promptsSeen.push(messages.map((m) => m.content).join('\n---\n'));
      return { text: reply, ttftMs: 5, totalMs: 10 };
    },
  };
}

function nullDeliveries(): DefaultDeliveries {
  return { pi: createNullDelivery(), claude: createNullDelivery(), antigravity: createNullDelivery() };
}

/** Pi manager double whose loaded session holds the given messages. */
function piManagerWith(messages: unknown[]): unknown {
  return {
    resolveSessionRef: (ref: string) => ref,
    getSessionStatus: () => ({ status: 'idle', currentStep: 0 }),
    getAgentSession: () => ({ messages }),
  };
}

async function talkerPromptFor(manager: unknown): Promise<string> {
  const model = capturingModel();
  const registry = new TalkerSessionRegistry({
    multiSessionManager: manager as never,
    deliveries: nullDeliveries(),
    modelClient: model,
  });
  await registry.handleOperatorTurn({ workerSessionId: 'sess-1', utterance: 'what did the worker just do?' });
  expect(model.prompts().length).toBeGreaterThan(0);
  return model.prompts()[0];
}

describe('the talker’s pi state view excludes marked injections (2026-09-16)', () => {
  it('a marked capture injection and its housekeeping answer never reach the talker prompt as injection material — the work does', async () => {
    // Session state as pi holds it: operator prompt, work answer, the MARKED
    // injection (role custom), then the housekeeping answer.
    const prompt = await talkerPromptFor(piManagerWith([
      { role: 'user', content: [{ type: 'text', text: 'ship the release' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'The release is tagged.' }] },
      { role: 'custom', customType: 'agent-os-capture', display: false, content: INJECTION_WORDS },
      { role: 'assistant', content: [{ type: 'text', text: HOUSEKEEPING_WORDS }] },
    ]));
    expect(prompt).toContain('The release is tagged.');
    // The injection itself is role custom → excluded from the history entries.
    expect(prompt).not.toContain(INJECTION_WORDS);
    // The housekeeping answer is the worker's own final assistant message; the
    // lastAssistantText read is unchanged behaviour (it is the worker's voice,
    // not the injection). The talker's STRUCTURED history must not contain the
    // injection, which the assertion above pins.
  });

  it('an operator message quoting the injection wording verbatim is a USER message and IS in the talker prompt (structural match only)', async () => {
    const prompt = await talkerPromptFor(piManagerWith([
      { role: 'user', content: [{ type: 'text', text: INJECTION_WORDS }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Answering the operator’s own words.' }] },
    ]));
    expect(prompt).toContain(INJECTION_WORDS);
  });

  it('toHistoryEntries keeps the same entries for a session with no injections (regression guard)', async () => {
    const base = [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'first reply' }] },
    ];
    const prompt = await talkerPromptFor(piManagerWith(base));
    expect(prompt).toContain('first reply');
  });
});

describe('parsePiSessionHistory — custom entries drop out of the session-switch replay (pin)', () => {
  it('a marked injection entry is absent; user/assistant output is identical to the same session without it', () => {
    const userEntry = { type: 'message', id: 'e1', message: { role: 'user', content: [{ type: 'text', text: 'go' }], timestamp: 1 } };
    const assistantEntry = { type: 'message', id: 'e2', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], timestamp: 2 } };
    const customEntry = { type: 'custom', customType: 'agent-os-capture', display: false, content: INJECTION_WORDS, timestamp: 3 };

    const withoutInjection = parsePiSessionHistory([userEntry, assistantEntry]);
    const withInjection = parsePiSessionHistory([userEntry, assistantEntry, customEntry]);

    expect(JSON.parse(JSON.stringify(withInjection))).toEqual(JSON.parse(JSON.stringify(withoutInjection)));
    expect(JSON.stringify(withInjection)).not.toContain('agent-os-capture');
    expect(JSON.stringify(withInjection)).not.toContain(INJECTION_WORDS);
  });
});

describe('screen-view projection — custom messages drop out (pin)', () => {
  const ts = 1700000000000;
  const eventsWithout = [
    { type: 'message_start', message: { id: 'm1', role: 'user', content: 'go' }, timestamp: ts },
    { type: 'message_start', message: { id: 'm2', role: 'assistant', content: [] }, timestamp: ts },
    { type: 'message_update', message: { id: 'm2' }, assistantMessageEvent: { type: 'text_delta', delta: 'all done' }, timestamp: ts },
  ];

  it('an event stream with no injections projects as before, and a marked injection adds nothing', () => {
    const base = projectDefaultViewFromEvents(eventsWithout);
    const withInjection = projectDefaultViewFromEvents([
      ...eventsWithout,
      { type: 'message_start', message: { id: 'm3', role: 'custom', customType: 'agent-os-capture', content: INJECTION_WORDS }, timestamp: ts },
    ]);
    expect(JSON.parse(JSON.stringify(base))).toEqual(JSON.parse(JSON.stringify(withInjection)));
    expect(JSON.stringify(withInjection)).not.toContain(INJECTION_WORDS);
  });
});
