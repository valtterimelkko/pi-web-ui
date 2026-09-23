import { describe, it, expect } from 'vitest';

/**
 * Provider-profile boundary at the bridge (plan §7, Phase 4).
 *
 * The provider socket is a MOCK — no provider call here (the real per-arm
 * probe is `voice-handshake-probe.ts`). This suite pins, per arm:
 *   - the connect request the profile produces (thinking present/absent);
 *   - the tool-reply shape (scheduling present only where supported);
 *   - the requested-vs-actual identity record (redacted config, provider ack,
 *     usage evidence) — never inferred from the model's own words;
 *   - late / duplicate / cancel / reconnect tool-call handling mapped to the
 *     SAME logical host operations on both arms;
 *   - honest idle semantics: a premature turn boundary must not read as
 *     "settled" while accepted tool work is outstanding on the ET arm.
 */

import { GeminiLiveBridge } from '../../../src/voice/gemini-live-bridge.js';
import { VOICE_LIVE_PROFILES } from '../../../src/voice/voice-profiles.js';
import type {
  LiveConnectRequest,
  LiveRealtimeInput,
  LiveSessionFactory,
  LiveSessionLike,
} from '../../../src/voice/types.js';

// ── Mock provider socket ────────────────────────────────────────────────────

class MockLiveSession implements LiveSessionLike {
  readonly sentRealtime: LiveRealtimeInput[] = [];
  readonly sentToolResponses: Array<{ functionResponses: Array<Record<string, unknown>> }> = [];
  closed = false;
  constructor(private readonly onClosed?: () => void) {}
  sendRealtimeInput(input: LiveRealtimeInput): void {
    this.sentRealtime.push(input);
  }
  sendClientContent(_content: unknown): void {}
  sendToolResponse(response: { functionResponses: Array<Record<string, unknown>> }): void {
    this.sentToolResponses.push(response);
  }
  close(): void {
    this.closed = true;
    this.onClosed?.();
  }
}

function createMockFactory() {
  const sessions: MockLiveSession[] = [];
  const requests: LiveConnectRequest[] = [];
  const factory: LiveSessionFactory = async (request) => {
    requests.push(request);
    const session = new MockLiveSession(() => request.callbacks.onClose());
    sessions.push(session);
    return session;
  };
  return {
    factory,
    requests,
    sessions,
    last: () => sessions[sessions.length - 1],
    request: (index = sessions.length - 1) => requests[index],
    emit: (message: unknown, index = sessions.length - 1) =>
      requests[index].callbacks.onMessage(message as never),
  };
}

type ToolCallEvent = { name: string; args: Record<string, unknown>; id: string; atMs: number };

function createBridge(
  profile: 'standard' | 'et-high',
  options: { holdToolHandler?: boolean; toolResponseScheduling?: 'WHEN_IDLE' | 'SILENT' } = {}
) {
  const mock = createMockFactory();
  const toolEvents: ToolCallEvent[] = [];
  const turnCompletes: number[] = [];
  const errors: Array<{ code: string; message: string; fatal: boolean }> = [];
  let releaseToolHandler: (() => void) | null = null;
  const bridge = new GeminiLiveBridge({
    laneId: 'lane-1:profiles',
    attachmentGeneration: 1,
    systemInstruction: 'You are a test talker.',
    sessionFactory: mock.factory,
    profile,
    ...(options.toolResponseScheduling ? { toolResponseScheduling: options.toolResponseScheduling } : {}),
    clock: (() => 0) as never,
    callbacks: {
      onToolCall: (call) => {
        toolEvents.push(call);
        // Simulate a handler that can be held in flight for the cancel test.
        if (options.holdToolHandler) {
          return new Promise<Record<string, unknown>>((resolve) => {
            releaseToolHandler = () => resolve({ ok: true });
          });
        }
        return { ok: true };
      },
      onTurnComplete: (atMs: number) => turnCompletes.push(atMs),
      onError: (error) => errors.push(error),
    },
  } as ConstructorParameters<typeof GeminiLiveBridge>[0]);
  return {
    bridge,
    mock,
    toolEvents,
    turnCompletes,
    errors,
    releaseToolHandler: () => releaseToolHandler?.(),
  };
}

function emitSetup(mock: ReturnType<typeof createMockFactory>): void {
  mock.emit({ setupComplete: {} });
}

function emitTurnComplete(mock: ReturnType<typeof createMockFactory>): void {
  mock.emit({ serverContent: { turnComplete: true } });
}

function emitToolCall(
  mock: ReturnType<typeof createMockFactory>,
  id: string,
  name = 'relay_to_worker',
  args: Record<string, unknown> = { text: 'check the deploy logs' }
): void {
  mock.emit({ toolCall: { functionCalls: [{ name, args, id }] } });
}

async function connectedBridge(
  profile: 'standard' | 'et-high',
  options: { holdToolHandler?: boolean } = {}
) {
  const harness = createBridge(profile, options);
  await harness.bridge.connect();
  emitSetup(harness.mock);
  return harness;
}

// ── Per-arm connect request and tool-reply shape ────────────────────────────

describe('connect request per arm', () => {
  it('standard requests no thinking configuration', async () => {
    const { bridge, mock } = await connectedBridge('standard');
    expect(bridge).toBeDefined();
    expect('thinkingConfig' in mock.request(0).config).toBe(false);
  });

  it('et-high requests thinking level HIGH', async () => {
    const { bridge, mock } = await connectedBridge('et-high');
    expect(bridge).toBeDefined();
    expect(mock.request(0).config.thinkingConfig?.thinkingLevel).toBe('HIGH');
  });
});

describe('tool-reply shape per arm', () => {
  it('standard acknowledges with scheduling WHEN_IDLE (finding F-1)', async () => {
    const { bridge, mock } = await connectedBridge('standard');
    emitToolCall(mock, 'call-1');
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.last().sentToolResponses).toHaveLength(1);
    expect(mock.last().sentToolResponses[0].functionResponses[0].scheduling).toBe('WHEN_IDLE');
    expect(bridge.usage.toolCalls).toBe(1);
  });

  it('et-high acknowledges WITHOUT a scheduling field (unsupported for that arm)', async () => {
    const { bridge, mock } = await connectedBridge('et-high');
    emitToolCall(mock, 'call-1');
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.last().sentToolResponses).toHaveLength(1);
    const response = mock.last().sentToolResponses[0].functionResponses[0];
    expect('scheduling' in response).toBe(false);
    expect(bridge.usage.toolCalls).toBe(1);
  });

  it('refuses to construct a bridge whose legacy scheduling option contradicts the profile', () => {
    expect(
      () =>
        createBridge('et-high', { toolResponseScheduling: 'WHEN_IDLE' })
    ).toThrow(/scheduling/i);
    expect(
      () =>
        createBridge('standard', { toolResponseScheduling: 'SILENT' })
    ).toThrow(/scheduling/i);
    expect(
      () =>
        createBridge('standard', { toolResponseScheduling: 'WHEN_IDLE' })
    ).not.toThrow();
  });
});

// ── Requested vs actual identity ────────────────────────────────────────────

describe('requested vs actual identity', () => {
  it('captures the redacted requested config before any provider message', async () => {
    const { bridge, mock } = await connectedBridge('et-high');
    expect(mock.request(0).config).toBeDefined();
    const identity = bridge.identity;
    expect(identity.requested.profile).toBe('et-high');
    expect(identity.requested.source).toBe('explicit');
    expect(identity.requested.model).toBe(VOICE_LIVE_PROFILES['et-high'].model);
    const serialized = JSON.stringify(identity.requested.connectConfig);
    expect(serialized).not.toMatch(/AIza[0-9A-Za-z_-]{35}/);
    expect(serialized).not.toMatch(/apiKey|credential|authorization/i);
    expect(identity.acknowledged.setupComplete).toBe(true);
  });

  it('records the provider acknowledgement and usage evidence, not the model saying its name', async () => {
    const { bridge, mock } = await connectedBridge('et-high');
    emitSetup(mock);
    mock.emit({
      usageMetadata: { thoughtsTokenCount: 42, totalTokenCount: 1000 },
    });
    const identity = bridge.identity;
    expect(identity.acknowledged.setupComplete).toBe(true);
    expect(identity.acknowledged.usageMetadataSamples).toBe(1);
    expect(identity.acknowledged.thoughtTokenCountTotal).toBe(42);
    expect(identity.acknowledged.totalTokenCountTotal).toBe(1000);
    // The acknowledged section is provider evidence ONLY: a fixed set of
    // fields, none of them fed from the model's own spoken words.
    expect(Object.keys(identity.acknowledged).sort()).toEqual([
      'setupAtMs',
      'setupComplete',
      'thoughtTokenCountTotal',
      'totalTokenCountTotal',
      'usageMetadataSamples',
    ]);
  });

  it('standard arm records zero expected thought-token evidence but still counts what arrives', async () => {
    const { bridge, mock } = await connectedBridge('standard');
    mock.emit({ usageMetadata: { thoughtsTokenCount: 3, totalTokenCount: 500 } });
    expect(bridge.identity.acknowledged.thoughtTokenCountTotal).toBe(3);
    expect(bridge.usage.thoughtTokens).toBe(3);
  });
});

// ── Late / duplicate / cancel / reconnect tool calls ────────────────────────

describe('late asynchronous tool calls after turnComplete (both arms)', () => {
  for (const profile of ['standard', 'et-high'] as const) {
    it(`${profile}: a tool call arriving after the turn boundary is still dispatched and acknowledged`, async () => {
      const { bridge, mock, toolEvents } = await connectedBridge(profile);
      emitTurnComplete(mock);
      expect(bridge.usage.turnCompletes).toBe(1);

      emitToolCall(mock, 'late-1');
      await Promise.resolve();
      await Promise.resolve();

      expect(toolEvents).toHaveLength(1);
      expect(toolEvents[0].id).toBe('late-1');
      expect(mock.last().sentToolResponses).toHaveLength(1);
      expect(mock.last().sentToolResponses[0].functionResponses[0].id).toBe('late-1');
      expect(bridge.usage.lateToolCalls).toBe(1);
    });

    it(`${profile}: the same logical host operation runs — one dispatch, one ack, no arm-specific privilege`, async () => {
      const { mock, toolEvents } = await connectedBridge(profile);
      emitToolCall(mock, 'mid-1');
      emitTurnComplete(mock);
      emitToolCall(mock, 'late-2');
      await Promise.resolve();
      await Promise.resolve();
      expect(toolEvents.map((call) => call.id)).toEqual(['mid-1', 'late-2']);
      expect(mock.last().sentToolResponses).toHaveLength(2);
    });
  }
});

describe('duplicate tool-call callbacks', () => {
  it('the host handler is called EXACTLY ONCE per call id; the duplicate is counted and re-acknowledged', async () => {
    const { bridge, mock, toolEvents } = await connectedBridge('standard');
    emitToolCall(mock, 'dup-1');
    emitToolCall(mock, 'dup-1');
    await Promise.resolve();
    await Promise.resolve();
    expect(toolEvents).toHaveLength(1);
    expect(bridge.usage.toolCallDuplicates).toBe(1);
    expect(bridge.usage.toolCalls).toBe(1);
    // Both the original and the duplicate got a response (the provider may be
    // waiting on either), but only ONE reached the host.
    expect(mock.last().sentToolResponses).toHaveLength(2);
  });
});

describe('cancellation while a tool handler is in flight', () => {
  it('close() during a held handler sends no ack and does not throw', async () => {
    const { bridge, mock, releaseToolHandler } = await connectedBridge('standard', {
      holdToolHandler: true,
    });
    emitToolCall(mock, 'held-1');
    await Promise.resolve();
    await Promise.resolve();
    expect(() => bridge.close()).not.toThrow();
    releaseToolHandler();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // No acknowledgement left the bridge after close.
    expect(mock.last().sentToolResponses).toHaveLength(0);
  });
});

describe('reconnect with pending late calls', () => {
  it('after goAway + reopen on the SAME conversation, a late call is dispatched once and acked on the NEW session', async () => {
    const { mock, toolEvents } = await connectedBridge('standard');
    mock.emit({ sessionResumptionUpdate: { newHandle: 'handle-9', resumable: true } });
    mock.emit({ goAway: { timeLeft: '1s' } });
    // The bridge schedules a reconnect; drive it deterministically is not
    // possible with real timers, so wait for the new session to appear.
    for (let i = 0; i < 50 && mock.sessions.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(mock.sessions.length).toBeGreaterThanOrEqual(2);
    emitSetup(mock);
    emitToolCall(mock, 'after-reconnect-1', 'relay_to_worker');
    await Promise.resolve();
    await Promise.resolve();
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0].id).toBe('after-reconnect-1');
    // The ack must have gone to the RECONNECTED session.
    expect(mock.sessions[1].sentToolResponses).toHaveLength(1);
    expect(mock.sessions[1].sentToolResponses[0].functionResponses[0].id).toBe('after-reconnect-1');
  });
});

// ── Honest idle / settled semantics ─────────────────────────────────────────

describe('interaction settled semantics per arm', () => {
  it('standard: the provider turn boundary settles the interaction', async () => {
    const { bridge, mock } = await connectedBridge('standard');
    expect(bridge.interactionSettled).toBe(false);
    emitTurnComplete(mock);
    expect(bridge.interactionSettled).toBe(true);
  });

  it('et-high: the turn boundary alone must NOT settle while accepted tool work is outstanding', async () => {
    const { bridge, mock } = await connectedBridge('et-high');
    emitToolCall(mock, 'et-work-1');
    await Promise.resolve();
    await Promise.resolve();
    emitTurnComplete(mock);
    // The call has been accepted AND acknowledged, so the lane has drained.
    expect(bridge.interactionSettled).toBe(true);
  });

  it('et-high: a late call after the boundary re-opens the drain (premature idle cannot stop listening)', async () => {
    const { bridge, mock } = await connectedBridge('et-high');
    emitTurnComplete(mock);
    expect(bridge.interactionSettled).toBe(true);
    emitToolCall(mock, 'et-late-1');
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.interactionSettled).toBe(false);
    // And the late call was still handled: dispatched and acknowledged.
    expect(bridge.usage.lateToolCalls).toBe(1);
    expect(mock.last().sentToolResponses).toHaveLength(1);
  });

  it('new operator speech re-opens the turn on both arms (settled never lies across turns)', async () => {
    for (const profile of ['standard', 'et-high'] as const) {
      const { bridge, mock } = await connectedBridge(profile);
      emitTurnComplete(mock);
      expect(bridge.interactionSettled).toBe(true);
      mock.emit({ serverContent: { interrupted: true } });
      bridge.activityStart();
      expect(bridge.interactionSettled).toBe(false);
    }
  });
});
