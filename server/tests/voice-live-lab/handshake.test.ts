/**
 * Unit tests for Phase L1 Handshake CLI & Provider capabilities.
 */
import { describe, expect, it } from 'vitest';
import { parseArgs, main } from '../../../scripts/voice-live-lab/cli.js';
import { EventLog, createMonotonicClock, EVENT } from '../../../scripts/voice-live-lab/lib/scheduler.js';
import { FakeLiveProvider } from '../../../scripts/voice-live-lab/lib/providers/fake-live.js';
import { CAPABILITIES_SCHEMA_VERSION, type CapabilitiesReport } from '../../../scripts/voice-live-lab/lib/handshake.js';

describe('cli handshake command', () => {
  it('parses handshake command flags', () => {
    expect(parseArgs(['handshake'])).toEqual({
      command: 'handshake',
      outputPath: undefined,
      json: false,
    });

    expect(parseArgs(['handshake', '--output', '/tmp/caps.json', '--json'])).toEqual({
      command: 'handshake',
      outputPath: '/tmp/caps.json',
      json: true,
    });
  });

  it('runs handshake through cli with mock and returns 0 when status is ok', async () => {
    const mockReport: CapabilitiesReport = {
      schemaVersion: CAPABILITIES_SCHEMA_VERSION,
      recordedAt: new Date().toISOString(),
      models: {
        standard: {
          supported: true,
          model: 'gemini-3.8-live',
          connected: true,
          setupComplete: true,
          resumption: { supported: true, handleReceived: true, resumedSuccess: true, statePreserved: true },
          transcription: { inputStreaming: true, outputStreaming: true },
          vad: { naturalVadSupported: true, manualActivitySupported: true },
          toolCalling: { supported: true, asyncResponseSupported: true, survivesResumption: true },
          usageMetadata: { reported: true, fields: ['totalTokenCount'] },
          concurrency: { probedSessions: 5, concurrencySucceeded: true },
        },
        extendedThinking: {
          supported: true,
          model: 'gemini-3.8-live-extended-thinking',
          connected: true,
          setupComplete: true,
          thinkingLevel: 'HIGH',
          thoughtsCountedInUsage: true,
          turnCompleteReceived: true,
        },
      },
      judge: {
        directHttp: {
          endpoint: 'https://opencode.ai/zen/go/v1/chat/completions',
          model: 'deepseek-v4.1-flash',
          statusCode: 200,
          echoedModel: 'deepseek-v4.1-flash',
          parseableJson: true,
          reasoningContentPresent: true,
          latencyMs: 1200,
        },
        sessionCrossTransport: {
          runtime: 'pi',
          model: 'commandcode/deepseek/deepseek-v4.1-flash',
          sessionBound: true,
          agentOsInjected: true,
          customEntriesObserved: ['agent-os'],
          findings: 'observed injection',
        },
      },
      rateLimits: {
        measuredTier: 'Prepaid Tier 1',
        rateLimitObserved: false,
        status: 'ok',
        notes: 'ample',
      },
      probeResolutions: {
        '1_input_transcription_finalisation': 'done',
        '2_session_resumption': 'done',
        '3_async_tool_results_across_resumption': 'done',
        '4_interaction_status_and_extended_thinking': 'done',
        '5_concurrency_and_rate_limits': 'done',
      },
    };

    const out: string[] = [];
    const err: string[] = [];
    const code = await main(['handshake', '--json'], {
      writeOut: (l) => out.push(l),
      writeErr: (l) => err.push(l),
      handshake: async () => mockReport,
    });

    expect(code).toBe(0);
    expect(err).toEqual([]);
    const parsed = JSON.parse(out.join(''));
    expect(parsed.schemaVersion).toBe(CAPABILITIES_SCHEMA_VERSION);
    expect(parsed.rateLimits.status).toBe('ok');
  });

  it('exits 1 if handshake throws', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(['handshake'], {
      writeOut: (l) => out.push(l),
      writeErr: (l) => err.push(l),
      handshake: async () => {
        throw new Error('Network timeout during probe');
      },
    });

    expect(code).toBe(1);
    expect(err.join('')).toContain('Network timeout during probe');
  });
});

describe('FakeLiveProvider handshake lifecycle events', () => {
  it('replays setupComplete, sessionResumptionUpdate, goAway and thoughtsTokenCount', async () => {
    const log = new EventLog({ clock: createMonotonicClock() });
    const provider = new FakeLiveProvider({
      log,
      sleep: async () => {},
      script: [
        { atMs: 0, setupComplete: true },
        { atMs: 10, sessionResumptionUpdate: { newHandle: 'resumption-uuid-1', resumable: true } },
        { atMs: 20, goAway: { timeLeft: '30s' } },
        {
          atMs: 30,
          serverContent: {
            inputTranscription: { text: 'test speech' },
            outputTranscription: { text: 'test reply' },
            turnComplete: true,
          },
          usageMetadata: {
            promptTokenCount: 100,
            candidatesTokenCount: 50,
            thoughtsTokenCount: 25,
          },
        },
      ],
    });

    await provider.run();
    provider.close();

    const events = log.events();
    const lifecycleEvents = events.filter((e) => e.kind === EVENT.LIFECYCLE);
    expect(lifecycleEvents.some((e) => (e.payload as any).event === 'setupComplete')).toBe(true);
    expect(lifecycleEvents.some((e) => (e.payload as any).event === 'sessionResumptionUpdate')).toBe(true);
    expect(lifecycleEvents.some((e) => (e.payload as any).event === 'goAway')).toBe(true);

    const usageEvents = events.filter((e) => e.kind === EVENT.PROVIDER_USAGE);
    expect(usageEvents).toHaveLength(1);
    expect((usageEvents[0].payload as any).thoughtsTokenCount).toBe(25);
  });
});
