import { describe, expect, it } from 'vitest';
import type { NormalizedEvent } from '@pi-web-ui/shared';
import {
  PHASE7_PI_SHADOW_POLICY_VERSION,
  PHASE7_PI_SHADOW_THRESHOLDS,
  classifyPhase7PiShadow,
  createPhase7PiShadowState,
  finalizePhase7PiShadow,
  observePhase7PiShadowEvent,
} from '../../../src/internal-api/phase7-pi-shadow.js';

function event(type: string): NormalizedEvent {
  return {
    type,
    sessionId: 'pi-shadow-session',
    timestamp: 1_700_000_000_000,
    data: {},
  } as NormalizedEvent;
}

describe('phase 7 Pi Internal API shadow classifier', () => {
  it('freezes the policy, default profile, session affinity, and shared-service truth', () => {
    const classification = classifyPhase7PiShadow({
      sessionId: 'pi-shadow-session',
      message: 'Review the small change and explain the result.',
    });

    expect(PHASE7_PI_SHADOW_POLICY_VERSION).toBe('phase7-pi-shadow/v1');
    expect(classification).toMatchObject({
      policyVersion: 'phase7-pi-shadow/v1',
      mode: 'shadow',
      profile: 'standard',
      affinity: {
        kind: 'session',
        sessionId: 'pi-shadow-session',
        ownership: 'server-owned',
      },
      resourceIdentity: {
        kind: 'shared-service',
        boundary: 'pi-control-process',
        ownership: 'server-owned',
        sessionScoped: false,
      },
      evidence: { promptBytes: expect.any(Number), toolEventCount: 0 },
    });
    expect(classification.reasonCodes).toEqual(['default_standard']);
  });

  it('marks explicit fork or memory pressure work as a heavy shadow candidate', () => {
    const classification = classifyPhase7PiShadow({
      sessionId: 'pi-shadow-session',
      message: 'Run the bounded fork and memory-pressure fixture, then report pids.',
    });

    expect(classification.profile).toBe('heavy');
    expect(classification.reasonCodes).toEqual([
      'message_fork_or_memory_signal',
    ]);
  });

  it('marks explicit test/build tool work without treating caller labels as authority', () => {
    const classification = classifyPhase7PiShadow({
      sessionId: 'pi-shadow-session',
      message: 'Please run npm test and npm run build, then inspect the output.',
    });

    expect(classification.profile).toBe('heavy');
    expect(classification.reasonCodes).toEqual(['message_tool_signal']);
  });

  it('keeps duration separate from heavy resource classification', () => {
    const state = createPhase7PiShadowState(
      classifyPhase7PiShadow({ sessionId: 'pi-shadow-session', message: 'Keep working.' }),
      1_000,
    );

    const final = finalizePhase7PiShadow(state, 1_000 + PHASE7_PI_SHADOW_THRESHOLDS.longTurnMs);

    expect(final.profile).toBe('long-horizon');
    expect(final.reasonCodes).toEqual(['turn_duration_threshold']);
    expect(final.evidence.durationMs).toBe(PHASE7_PI_SHADOW_THRESHOLDS.longTurnMs);
  });

  it('upgrades a standard turn when observed tool events cross the frozen threshold', () => {
    const state = createPhase7PiShadowState(
      classifyPhase7PiShadow({ sessionId: 'pi-shadow-session', message: 'Keep working.' }),
      1_000,
    );

    for (let index = 0; index < PHASE7_PI_SHADOW_THRESHOLDS.toolEventCount; index += 1) {
      observePhase7PiShadowEvent(state, event('tool_execution_start'), 1_100 + index);
    }

    const final = finalizePhase7PiShadow(state, 2_000);

    expect(final.profile).toBe('heavy');
    expect(final.reasonCodes).toEqual(['tool_event_threshold']);
    expect(final.evidence.toolEventCount).toBe(PHASE7_PI_SHADOW_THRESHOLDS.toolEventCount);
  });

  it('does not count tool events attributed to another session', () => {
    const state = createPhase7PiShadowState(
      classifyPhase7PiShadow({ sessionId: 'pi-shadow-session', message: 'Keep working.' }),
      1_000,
    );

    for (let index = 0; index < PHASE7_PI_SHADOW_THRESHOLDS.toolEventCount; index += 1) {
      observePhase7PiShadowEvent(state, {
        type: 'tool_execution_start',
        sessionId: 'another-session',
      }, 1_100 + index);
    }

    expect(finalizePhase7PiShadow(state, 2_000)).toMatchObject({
      profile: 'standard',
      evidence: { toolEventCount: 0 },
    });
  });

  it('does not persist prompt text in the classification evidence', () => {
    const secretPrompt = 'do not persist this prompt: token_sk_live_secret_value';
    const classification = classifyPhase7PiShadow({
      sessionId: 'pi-shadow-session',
      message: secretPrompt,
    });

    expect(JSON.stringify(classification)).not.toContain(secretPrompt);
    expect(JSON.stringify(classification)).not.toContain('token_sk_live_secret_value');
  });
});
