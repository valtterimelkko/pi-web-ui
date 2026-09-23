import { describe, it, expect } from 'vitest';

/**
 * Provider-profile pass-through at the session service (plan §7, Phase 4).
 *
 * The service resolves ONE profile per process (from `VOICE_LIVE_PROFILE` or
 * an explicit dep), passes it to every bridge it builds, refuses a conflicting
 * explicit model, and describes the active arm for the campaign runner. The
 * socket is a mock; no provider call here.
 */

import { VoiceSessionService } from '../../../src/voice/voice-session.js';
import { GeminiLiveBridge } from '../../../src/voice/gemini-live-bridge.js';
import { resolveVoiceLiveProfileId, VOICE_LIVE_PROFILES } from '../../../src/voice/voice-profiles.js';
import type {
  GeminiLiveBridgeOptions,
  LiveConnectRequest,
  LiveSessionFactory,
  LiveSessionLike,
} from '../../../src/voice/types.js';

function startOptions(over: Record<string, unknown> = {}) {
  return {
    laneId: 'lane-1:profiles',
    attachmentGeneration: 3,
    workerSessionId: 'session-abc',
    runtime: 'pi' as const,
    captureMode: 'open-mic' as const,
    readingLevel: 'verbatim' as const,
    callbacks: {},
    ...over,
  };
}

class RecordingBridge implements Partial<GeminiLiveBridge> {
  static instances: Array<Record<string, unknown>> = [];
  readonly options: GeminiLiveBridgeOptions;
  connectError: Error | null = null;
  constructor(options: GeminiLiveBridgeOptions) {
    this.options = options;
    RecordingBridge.instances.push(options as unknown as Record<string, unknown>);
  }
  async connect(): Promise<void> {
    if (this.connectError) throw this.connectError;
  }
  close(): void {}
  sendAudio(): boolean {
    return false;
  }
  sendContextText(): boolean {
    return false;
  }
  activityStart(): void {}
  activityEnd(): void {}
  get resumptionHandle(): string | null {
    return null;
  }
}

function makeService(overrides: ConstructorParameters<typeof VoiceSessionService>[0] = {}) {
  RecordingBridge.instances = [];
  const service = new VoiceSessionService({
    bridgeFactory: (options) => new RecordingBridge(options) as never,
    ...overrides,
  });
  return { service, built: RecordingBridge.instances };
}

describe('profile resolution and pass-through', () => {
  it('resolves the profile once and hands it to every bridge it builds', async () => {
    const { service, built } = makeService({ profile: 'et-high' });
    await service.start(startOptions());
    expect(built).toHaveLength(1);
    expect(built[0].profile).toBe('et-high');
  });

  it('without an explicit profile, the env resolution is used and recorded', async () => {
    const { service, built } = makeService();
    await service.start(startOptions());
    expect(built[0].profile).toBe(resolveVoiceLiveProfileId(process.env));
  });

  it('refuses an explicit model that contradicts the profile (no silent mixing)', () => {
    expect(() => makeService({ profile: 'et-high', model: VOICE_LIVE_PROFILES.standard.model })).toThrow(
      /model/i
    );
    expect(() =>
      makeService({ profile: 'et-high', model: VOICE_LIVE_PROFILES['et-high'].model })
    ).not.toThrow();
  });

  it('describes the active arm for the runner', async () => {
    const { service } = makeService({ profile: 'et-high' });
    expect(service.describeVoiceLiveProfile()).toEqual({
      profile: 'et-high',
      model: VOICE_LIVE_PROFILES['et-high'].model,
      thinking: { supported: true, level: 'HIGH' },
      toolReplyScheduling: { supported: false },
      idle: VOICE_LIVE_PROFILES['et-high'].idle,
    });
  });
});

describe('end-to-end pass-through to the real bridge over a mock socket', () => {
  class MockSession implements LiveSessionLike {
    closed = false;
    sendRealtimeInput(): void {}
    sendClientContent(): void {}
    sendToolResponse(): void {}
    close(): void {
      this.closed = true;
    }
  }

  function realBridgeHarness(profile: 'standard' | 'et-high') {
    const requests: LiveConnectRequest[] = [];
    const factory: LiveSessionFactory = async (request) => {
      requests.push(request);
      return new MockSession();
    };
    const service = new VoiceSessionService({
      profile,
      bridgeFactory: (options) => new GeminiLiveBridge({ ...options, sessionFactory: factory }),
      clock: () => 0,
      scheduler: (fn) => {
        fn();
        return () => {};
      },
    });
    return { service, requests };
  }

  it("the ET profile's thinking configuration reaches the provider connect request", async () => {
    const { service, requests } = realBridgeHarness('et-high');
    await service.start(startOptions());
    expect(requests[0].config.thinkingConfig?.thinkingLevel).toBe('HIGH');
  });

  it("the standard profile's connect request carries no thinking configuration", async () => {
    const { service, requests } = realBridgeHarness('standard');
    await service.start(startOptions());
    expect('thinkingConfig' in requests[0].config).toBe(false);
  });
});
