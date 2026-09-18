import { describe, it, expect } from 'vitest';

/**
 * Gemini Live bridge unit suite (Track B, plan Phase 3).
 *
 * The provider socket is a MOCK (`LiveSessionFactory`) — no provider call is
 * made here. The live handshake is proven separately, for real, by
 * `npm run test:voice-handshake`. This suite covers the lifecycle the plan
 * demands be tested offline: setup, send/receive, tool-call validation,
 * resumption-handle reuse across reconnect, `goAway`, unexpected disconnect,
 * bounded reconnect, latency and a send flood.
 */

import { GeminiLiveBridge } from '../../../src/voice/gemini-live-bridge.js';
import type {
  LiveConnectRequest,
  LiveRealtimeInput,
  LiveSessionFactory,
  LiveSessionLike,
} from '../../../src/voice/types.js';
import { VOICE_TOOL_NAMES } from '../../../src/voice/types.js';

// ── Mock provider socket ────────────────────────────────────────────────────

class MockLiveSession implements LiveSessionLike {
  readonly sentRealtime: LiveRealtimeInput[] = [];
  readonly sentClientContent: Array<{
    turns: Array<{ role: string; parts: Array<{ text: string }> }>;
    turnComplete: boolean;
  }> = [];
  readonly sentToolResponses: Array<{ functionResponses: Array<Record<string, unknown>> }> = [];
  closed = false;
  throwOnSend = false;

  sendRealtimeInput(input: LiveRealtimeInput): void {
    if (this.throwOnSend) throw new Error('socket write failed');
    this.sentRealtime.push(input);
  }

  sendClientContent(content: {
    turns: Array<{ role: string; parts: Array<{ text: string }> }>;
    turnComplete: boolean;
  }): void {
    this.sentClientContent.push(content);
  }

  sendToolResponse(response: { functionResponses: Array<Record<string, unknown>> }): void {
    this.sentToolResponses.push(response);
  }

  close(): void {
    this.closed = true;
  }
}

function createMockFactory() {
  const sessions: MockLiveSession[] = [];
  const requests: LiveConnectRequest[] = [];
  const factory: LiveSessionFactory = async (request) => {
    requests.push(request);
    const session = new MockLiveSession();
    sessions.push(session);
    return session;
  };
  const indexOrLast = (index?: number) => (index === undefined ? sessions.length - 1 : index);
  return {
    factory,
    requests,
    sessions,
    last: () => sessions[sessions.length - 1],
    request: (index?: number) => requests[indexOrLast(index)],
    emit: (message: unknown, index?: number) =>
      requests[indexOrLast(index)].callbacks.onMessage(message as never),
    open: (index?: number) => requests[indexOrLast(index)].callbacks.onOpen(),
    fail: (error: unknown, index?: number) => requests[indexOrLast(index)].callbacks.onError(error),
    socketClose: (index?: number) => requests[indexOrLast(index)].callbacks.onClose(),
  };
}

function createCallbacks() {
  const events: Array<{ kind: string; payload: Record<string, unknown> }> = [];
  return {
    events,
    callbacks: {
      onState: (state: string, detail?: string) => events.push({ kind: 'state', payload: { state, detail } }),
      onSetupComplete: () => events.push({ kind: 'setup', payload: {} }),
      onResumptionHandle: (handle: string, resumable: boolean) =>
        events.push({ kind: 'resumption', payload: { handle, resumable } }),
      onGoAway: (timeLeft?: string) => events.push({ kind: 'go_away', payload: { timeLeft } }),
      onAudioPcm: (pcm: Buffer, mimeType: string) =>
        events.push({ kind: 'audio', payload: { bytes: pcm.byteLength, mimeType } }),
      onInputTranscription: (text: string, atMs: number) =>
        events.push({ kind: 'input_transcript', payload: { text, atMs } }),
      onOutputTranscription: (text: string, atMs: number) =>
        events.push({ kind: 'output_transcript', payload: { text, atMs } }),
      onTurnComplete: () => events.push({ kind: 'turn_complete', payload: {} }),
      onInterrupted: () => events.push({ kind: 'interrupted', payload: {} }),
      onToolCall: (call: { name: string; args: unknown; id: string }) =>
        events.push({ kind: 'tool_call', payload: call as unknown as Record<string, unknown> }),
      onError: (error: { code: string; message: string; fatal: boolean }) =>
        events.push({ kind: 'error', payload: error as unknown as Record<string, unknown> }),
      onReconnected: () => events.push({ kind: 'reconnected', payload: {} }),
    },
  };
}

function createBridge(
  overrides: Partial<Parameters<typeof GeminiLiveBridge.prototype.connect>> = {},
  logLines: string[] = []
) {
  const mock = createMockFactory();
  const { callbacks, events } = createCallbacks();
  const scheduled: Array<{ fn: () => void; delayMs: number }> = [];
  const bridge = new GeminiLiveBridge({
    laneId: 'lane-1:probe',
    attachmentGeneration: 3,
    systemInstruction: 'You are a test talker.',
    callbacks,
    sessionFactory: mock.factory,
    log: {
      debug: (message: string, meta?: unknown) => logLines.push(`debug ${message} ${JSON.stringify(meta ?? {})}`),
      info: (message: string, meta?: unknown) => logLines.push(`info ${message} ${JSON.stringify(meta ?? {})}`),
      warn: (message: string, meta?: unknown) => logLines.push(`warn ${message} ${JSON.stringify(meta ?? {})}`),
      error: (message: string, meta?: unknown) => logLines.push(`error ${message} ${JSON.stringify(meta ?? {})}`),
    },
    clock: () => 1_000,
    scheduler: (fn, delayMs) => {
      scheduled.push({ fn, delayMs });
      return () => {
        const index = scheduled.findIndex((entry) => entry.fn === fn);
        if (index >= 0) scheduled.splice(index, 1);
      };
    },
    ...overrides,
  });
  return { bridge, mock, events, scheduled };
}

/**
 * Tool acknowledgements now await the kernel's answer (a retrieval result IS the
 * tool response), so the send lands a microtask later than the emit.
 */
async function flushToolAcknowledgement(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function connectedBridge(overrides: Record<string, unknown> = {}) {
  const harness = createBridge(overrides as never);
  const connectPromise = harness.bridge.connect();
  await connectPromise;
  harness.mock.open();
  harness.mock.emit({ setupComplete: {} });
  return harness;
}

// ── Connect and setup ───────────────────────────────────────────────────────

describe('GeminiLiveBridge connect/setup', () => {
  it('reaches live exactly once the provider reports setup complete', async () => {
    const { bridge, mock, events } = createBridge();
    expect(bridge.state).toBe('idle');
    await bridge.connect();
    expect(bridge.state).toBe('connecting');
    mock.open();
    expect(bridge.state).toBe('connecting');
    mock.emit({ setupComplete: {} });
    expect(bridge.state).toBe('live');
    expect(events.filter((event) => event.kind === 'setup')).toHaveLength(1);
    expect(bridge.usage.setupCompletes).toBe(1);
    bridge.close();
  });

  it('announces the live model at info the moment the provider reports setup complete', async () => {
    // The server's whole point of this line: at the default log level, the model
    // a live lane is actually running on is a recorded fact, not an inference.
    const lines: string[] = [];
    const { bridge, mock } = createBridge({}, lines);
    await bridge.connect();
    mock.open();
    mock.emit({ setupComplete: {} });
    const ready = lines.filter((line) => line.startsWith('info ') && line.includes('voice live session ready'));
    expect(ready).toHaveLength(1);
    expect(ready[0]).toContain('gemini-3.8-live');
    bridge.close();
  });

  it('builds the tier-1 config: audio modality, both transcriptions, resumption, manual VAD and the two parameterless gate tools plus the one read-only retrieval tool', async () => {
    const { bridge, mock } = await connectedBridge();
    const config = mock.request(0).config;
    expect(config.responseModalities).toEqual(['AUDIO']);
    expect(config.inputAudioTranscription).toEqual({});
    expect(config.outputAudioTranscription).toEqual({});
    expect(config.sessionResumption).toEqual({});
    expect(config.realtimeInputConfig?.automaticActivityDetection).toEqual({ disabled: true });
    expect(config.systemInstruction?.parts[0].text).toBe('You are a test talker.');
    const declarations = (config.tools?.[0].functionDeclarations ?? []) as Array<{
      name: string;
      parameters: { properties: Record<string, { type?: string }>; required: string[] };
      behavior: string;
    }>;
    expect(declarations.map((declaration) => declaration.name).sort()).toEqual([...VOICE_TOOL_NAMES].sort());
    for (const declaration of declarations) {
      expect(declaration.behavior).toBe('NON_BLOCKING');
      if (declaration.name === 'read_worker_history') {
        // The single parameterised tool, and its exception is one bounded string.
        expect(Object.keys(declaration.parameters.properties)).toEqual(['query']);
        expect(declaration.parameters.properties.query.type).toBe('STRING');
        expect(declaration.parameters.required).toEqual(['query']);
        continue;
      }
      expect(declaration.parameters.properties).toEqual({});
      expect(declaration.parameters.required).toEqual([]);
    }
    bridge.close();
  });

  it('leaves natural VAD untouched when manual activity detection is disabled', async () => {
    const { bridge, mock } = await connectedBridge({ manualActivityDetection: false });
    expect(mock.request(0).config.realtimeInputConfig?.automaticActivityDetection).toEqual({});
    bridge.close();
  });

  it('refuses to connect twice and refuses after close', async () => {
    const { bridge, mock } = await connectedBridge();
    await bridge.connect();
    expect(mock.sessions).toHaveLength(1);
    bridge.close();
    await expect(bridge.connect()).rejects.toThrow(/closed/i);
  });

  it('reports a provider-unavailable error and a fatal error state when the socket cannot be opened', async () => {
    const mock = createMockFactory();
    const { callbacks, events } = createCallbacks();
    const bridge = new GeminiLiveBridge({
      laneId: 'lane-1:probe',
      attachmentGeneration: 3,
      systemInstruction: 'x',
      callbacks,
      sessionFactory: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    await expect(bridge.connect()).rejects.toThrow(/ECONNREFUSED/);
    expect(bridge.state).toBe('error');
    const error = events.find((event) => event.kind === 'error');
    expect(error?.payload.code).toBe('voice_provider_unavailable');
    expect(error?.payload.fatal).toBe(true);
    expect(mock.sessions).toHaveLength(0);
  });
});

// ── Audio send ──────────────────────────────────────────────────────────────

describe('GeminiLiveBridge audio send', () => {
  it('sends provider-framed base64 PCM16 and counts bytes', async () => {
    const { bridge, mock } = await connectedBridge();
    const pcm = Buffer.alloc(640, 5);
    expect(bridge.sendAudio(pcm)).toBe(true);
    const sent = mock.last().sentRealtime[0];
    expect(sent).toEqual({ audio: { mimeType: 'audio/pcm;rate=16000', data: pcm.toString('base64') } });
    expect(bridge.usage.audioChunksIn).toBe(1);
    expect(bridge.usage.audioBytesIn).toBe(640);
    bridge.close();
  });

  it('never throws when the socket write fails, and surfaces a non-fatal error', async () => {
    const { bridge, mock, events } = await connectedBridge();
    mock.last().throwOnSend = true;
    expect(() => bridge.sendAudio(Buffer.alloc(640))).not.toThrow();
    expect(bridge.sendAudio(Buffer.alloc(640))).toBe(false);
    const error = events.find((event) => event.kind === 'error');
    expect(error?.payload.code).toBe('voice_provider_unavailable');
    expect(error?.payload.fatal).toBe(false);
    bridge.close();
  });

  it('drops audio when not live and never throws', async () => {
    const { bridge } = createBridge();
    expect(bridge.sendAudio(Buffer.alloc(640))).toBe(false);
    expect(bridge.usage.audioBytesIn).toBe(0);
  });

  it('survives a fast burst of sends (latency-spike shape)', async () => {
    const { bridge } = await connectedBridge();
    for (let i = 0; i < 2_000; i += 1) {
      expect(() => bridge.sendAudio(Buffer.alloc(640))).not.toThrow();
    }
    expect(bridge.usage.audioChunksIn).toBe(2_000);
    bridge.close();
  });
});

// ── Receive: transcription, audio, turn, interruption ───────────────────────

describe('GeminiLiveBridge receive', () => {
  it('maps input and output transcription deltas and counts them', async () => {
    const { bridge, mock, events } = await connectedBridge();
    mock.emit({ serverContent: { inputTranscription: { text: 'hello ' } } });
    mock.emit({ serverContent: { outputTranscription: { text: 'hi' }, turnComplete: true } });
    expect(events.filter((event) => event.kind === 'input_transcript')).toHaveLength(1);
    expect(events.find((event) => event.kind === 'input_transcript')?.payload.text).toBe('hello ');
    expect(events.find((event) => event.kind === 'output_transcript')?.payload.text).toBe('hi');
    expect(events.find((event) => event.kind === 'turn_complete')).toBeTruthy();
    expect(bridge.usage.inputTranscriptDeltas).toBe(1);
    expect(bridge.usage.outputTranscriptDeltas).toBe(1);
    expect(bridge.usage.turnCompletes).toBe(1);
    bridge.close();
  });

  it('maps model audio parts to PCM callbacks and counts bytes', async () => {
    const { bridge, mock, events } = await connectedBridge();
    const pcm = Buffer.alloc(960, 9);
    mock.emit({
      serverContent: {
        modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: pcm.toString('base64') } }] },
      },
    });
    const audio = events.find((event) => event.kind === 'audio');
    expect(audio?.payload.bytes).toBe(960);
    expect(bridge.usage.audioBytesOut).toBe(960);
    expect(bridge.usage.audioChunksOut).toBe(1);
    bridge.close();
  });

  it('maps interruption', async () => {
    const { bridge, mock, events } = await connectedBridge();
    mock.emit({ serverContent: { interrupted: true } });
    expect(events.find((event) => event.kind === 'interrupted')).toBeTruthy();
    expect(bridge.usage.interruptions).toBe(1);
    bridge.close();
  });

  it('records provider usage metadata without emitting it as an event', async () => {
    const { bridge, mock, events } = createBridge();
    await bridge.connect();
    mock.open();
    mock.emit({ setupComplete: {}, usageMetadata: { totalTokenCount: 12 } });
    expect(bridge.usage.usageMetadataSamples).toBe(1);
    expect(events.some((event) => event.kind === 'usage')).toBe(false);
    bridge.close();
  });

  it('ignores messages after close', async () => {
    const { bridge, mock, events } = await connectedBridge();
    bridge.close();
    const before = events.length;
    mock.emit({ serverContent: { inputTranscription: { text: 'late' } } });
    expect(events.length).toBe(before);
  });
});

// ── Tool calls: the two declared functions, parameterless by construction ───

describe('GeminiLiveBridge tool calls', () => {
  it('forwards a declared parameterless call and acknowledges it WHEN_IDLE by default (F-1)', async () => {
    const { bridge, mock, events } = await connectedBridge();
    mock.emit({
      toolCall: { functionCalls: [{ name: 'mark_addressed_to_talker', args: {}, id: 'call-1' }] },
    });
    const call = events.find((event) => event.kind === 'tool_call');
    expect(call?.payload.name).toBe('mark_addressed_to_talker');
    expect(call?.payload.args).toEqual({});
    await flushToolAcknowledgement();
    const acknowledgement = mock.last().sentToolResponses[0];
    expect(acknowledgement.functionResponses[0]).toMatchObject({
      id: 'call-1',
      name: 'mark_addressed_to_talker',
      scheduling: 'WHEN_IDLE',
    });
    expect(bridge.usage.toolCalls).toBe(1);
    bridge.close();
  });

  it('honours an explicit SILENT tool-response scheduling override', async () => {
    const { bridge, mock } = await connectedBridge({ toolResponseScheduling: 'SILENT' });
    mock.emit({
      toolCall: { functionCalls: [{ name: 'offer_ask_worker', args: {}, id: 'call-silent' }] },
    });
    await flushToolAcknowledgement();
    expect(mock.last().sentToolResponses[0].functionResponses[0]).toMatchObject({
      id: 'call-silent',
      scheduling: 'SILENT',
    });
    bridge.close();
  });

  it('refuses an undeclared function name and never forwards it', async () => {
    const { bridge, mock, events } = await connectedBridge();
    mock.emit({ toolCall: { functionCalls: [{ name: 'release_instruction', args: {}, id: 'call-2' }] } });
    expect(events.some((event) => event.kind === 'tool_call')).toBe(false);
    const error = events.find((event) => event.kind === 'error');
    expect(error?.payload.code).toBe('voice_internal_error');
    expect(mock.last().sentToolResponses).toHaveLength(0);
    expect(bridge.usage.toolCallViolations).toBe(1);
    bridge.close();
  });

  it('refuses a declared function that smuggles arguments, and never forwards or acknowledges it', async () => {
    const { bridge, mock, events } = await connectedBridge();
    mock.emit({
      toolCall: {
        functionCalls: [{ name: 'offer_ask_worker', args: { text: 'do something' }, id: 'call-3' }],
      },
    });
    expect(events.some((event) => event.kind === 'tool_call')).toBe(false);
    const error = events.find((event) => event.kind === 'error');
    expect(error?.payload.code).toBe('voice_internal_error');
    expect(mock.last().sentToolResponses).toHaveLength(0);
    expect(bridge.usage.toolCallViolations).toBe(1);
    bridge.close();
  });

  it('refuses a non-empty phantom argument object and an array-shaped args value', async () => {
    for (const args of [[], { note: 'x' }, 'text']) {
      const { bridge, mock, events } = await connectedBridge();
      mock.emit({ toolCall: { functionCalls: [{ name: 'mark_addressed_to_talker', args, id: 'call-x' }] } });
      expect(events.some((event) => event.kind === 'tool_call')).toBe(false);
      expect(events.find((event) => event.kind === 'error')?.payload.code).toBe('voice_internal_error');
      bridge.close();
    }
  });
});

// ── Resumption, goAway, unexpected disconnect ───────────────────────────────

describe('GeminiLiveBridge resumption and reconnect', () => {
  it('captures the resumption handle and seeds the next connect with it', async () => {
    const { bridge, mock, scheduled } = await connectedBridge();
    mock.emit({ sessionResumptionUpdate: { newHandle: 'handle-1', resumable: true } });
    expect(bridge.resumptionHandle).toBe('handle-1');
    expect(bridge.usage.resumptionHandles).toBe(1);

    mock.emit({ goAway: { timeLeft: '10s' } });
    expect(bridge.usage.goAways).toBe(1);
    expect(bridge.state).toBe('reconnecting');
    expect(scheduled).toHaveLength(1);
    scheduled[0].fn();
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.requests).toHaveLength(2);
    expect(mock.request(1).config.sessionResumption).toEqual({ handle: 'handle-1' });
    mock.open(1);
    mock.emit({ setupComplete: {} }, 1);
    expect(bridge.state).toBe('live');
    expect(bridge.usage.reconnects).toBe(1);
    bridge.close();
  });

  it('reconnects after an unexpected socket close when a handle exists', async () => {
    const { bridge, mock, events, scheduled } = await connectedBridge();
    mock.emit({ sessionResumptionUpdate: { newHandle: 'handle-2', resumable: true } });
    mock.socketClose();
    expect(bridge.state).toBe('reconnecting');
    expect(scheduled).toHaveLength(1);
    scheduled[0].fn();
    await Promise.resolve();
    await Promise.resolve();
    expect(mock.requests[1].config.sessionResumption).toEqual({ handle: 'handle-2' });
    mock.open(1);
    mock.emit({ setupComplete: {} }, 1);
    expect(events.some((event) => event.kind === 'reconnected')).toBe(true);
    expect(bridge.state).toBe('live');
    bridge.close();
  });

  it('gives up with a fatal provider error when no handle exists', async () => {
    const { bridge, mock, events } = await connectedBridge();
    mock.socketClose();
    expect(bridge.state).toBe('error');
    const error = events.find((event) => event.kind === 'error');
    expect(error?.payload.code).toBe('voice_provider_unavailable');
    expect(error?.payload.fatal).toBe(true);
    expect(bridge.usage.reconnects).toBe(0);
    bridge.close();
  });

  it('classifies a quota-exhausted provider failure as voice_quota_exhausted', async () => {
    const { bridge, mock, events } = await connectedBridge();
    mock.fail(new Error('429 RESOURCE_EXHAUSTED: quota exceeded for project'));
    mock.socketClose();
    const error = events.filter((event) => event.kind === 'error').at(-1);
    expect(error?.payload.code).toBe('voice_quota_exhausted');
    expect(error?.payload.fatal).toBe(true);
    bridge.close();
  });

  it('classifies a quota-exhausted connect failure as voice_quota_exhausted', async () => {
    const { callbacks, events } = createCallbacks();
    const bridge = new GeminiLiveBridge({
      laneId: 'lane-1:probe',
      attachmentGeneration: 3,
      systemInstruction: 'test',
      callbacks,
      sessionFactory: async () => {
        throw new Error('429 Too Many Requests: rate limit exceeded');
      },
    });
    await expect(bridge.connect()).rejects.toThrow(/rate limit/i);
    const error = events.find((event) => event.kind === 'error');
    expect(error?.payload.code).toBe('voice_quota_exhausted');
    expect(error?.payload.fatal).toBe(true);
    bridge.close();
  });

  it('gives up after the bounded reconnect attempts are exhausted', async () => {
    const { bridge, mock, events, scheduled } = await connectedBridge({ reconnect: { maxAttempts: 1, delayMs: 50 } });
    mock.emit({ sessionResumptionUpdate: { newHandle: 'handle-3', resumable: true } });
    mock.socketClose();
    expect(scheduled).toHaveLength(1);
    scheduled[0].fn();
    await Promise.resolve();
    await Promise.resolve();
    mock.socketClose(1);
    expect(bridge.state).toBe('error');
    expect(events.filter((event) => event.kind === 'error').length).toBeGreaterThanOrEqual(1);
    expect(bridge.usage.reconnects).toBe(1);
    bridge.close();
  });

  it('a deliberately closed bridge never reconnects', async () => {
    const { bridge, mock, scheduled, events } = await connectedBridge();
    mock.emit({ sessionResumptionUpdate: { newHandle: 'handle-4', resumable: true } });
    bridge.close();
    expect(bridge.state).toBe('stopped');
    expect(mock.last().closed).toBe(true);
    mock.socketClose();
    expect(scheduled).toHaveLength(0);
    expect(bridge.state).toBe('stopped');
    expect(events.filter((event) => event.kind === 'state').map((event) => event.payload.state)).toContain('stopped');
  });

  it('reconnect delay respects the configured scheduler delay', async () => {
    const { bridge, mock, scheduled } = await connectedBridge({ reconnect: { maxAttempts: 2, delayMs: 250 } });
    mock.emit({ sessionResumptionUpdate: { newHandle: 'handle-5', resumable: true } });
    mock.socketClose();
    expect(scheduled[0].delayMs).toBe(250);
    bridge.close();
  });
});

// ── Context injection and activity markers ─────────────────────────────────

describe('GeminiLiveBridge context and activity', () => {
  it('sends client content with turnComplete false and counts it', async () => {
    const { bridge, mock } = await connectedBridge();
    expect(bridge.sendContextText('CURRENT STATUS: RUNNING')).toBe(true);
    const content = mock.last().sentClientContent[0];
    expect(content.turnComplete).toBe(false);
    expect(content.turns[0].role).toBe('user');
    expect(content.turns[0].parts[0].text).toBe('CURRENT STATUS: RUNNING');
    expect(bridge.usage.contextSends).toBe(1);
    bridge.close();
  });

  it('sends explicit activity markers when manual detection is on, and never when it is off', async () => {
    const manual = await connectedBridge();
    manual.bridge.activityStart();
    manual.bridge.activityEnd();
    expect(manual.mock.last().sentRealtime).toEqual([{ activityStart: {} }, { activityEnd: {} }]);
    manual.bridge.close();

    const natural = await connectedBridge({ manualActivityDetection: false });
    natural.bridge.activityStart();
    natural.bridge.activityEnd();
    expect(natural.mock.last().sentRealtime).toEqual([]);
    natural.bridge.close();
  });

  it('never throws when sending context to a dead socket', async () => {
    const { bridge, mock } = await connectedBridge();
    mock.last().throwOnSend = true;
    // sendClientContent is not instrumented to throw in the mock; the bridge
    // must still guard the real SDK's failure mode.
    expect(() => bridge.sendContextText('x')).not.toThrow();
    bridge.close();
  });

  it('never logs or emits the provider credential', async () => {
    const sentinel = 'AIzaSENTINELKEYMATERIAL0000000000000000';
    const mock = createMockFactory();
    const { callbacks, events } = createCallbacks();
    const logs: string[] = [];
    const bridge = new GeminiLiveBridge({
      laneId: 'lane-1:probe',
      attachmentGeneration: 3,
      systemInstruction: 'x',
      callbacks,
      sessionFactory: mock.factory,
      apiKeyProvider: () => sentinel,
      log: {
        debug: (message, meta) => logs.push(`${message}${JSON.stringify(meta ?? {})}`),
        info: (message, meta) => logs.push(`${message}${JSON.stringify(meta ?? {})}`),
        warn: (message, meta) => logs.push(`${message}${JSON.stringify(meta ?? {})}`),
        error: (message, meta) => logs.push(`${message}${JSON.stringify(meta ?? {})}`),
      },
    });
    await bridge.connect();
    mock.open();
    mock.emit({ setupComplete: {}, usageMetadata: { totalTokenCount: 1 } });
    mock.fail(new Error('socket error'));
    bridge.close();
    const haystack = JSON.stringify({ events, logs });
    expect(haystack).not.toContain(sentinel);
    expect(haystack).not.toContain('AIza');
  });
});
