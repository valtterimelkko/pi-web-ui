import { describe, expect, it } from 'vitest';
import {
  INTERNAL_API_CONTRACT_VERSION,
  type CapabilitiesResponse,
  type ModelsResponse,
  type SessionRuntime,
} from '../../../src/internal-api/types.js';

describe('Command Code Internal API boundary', () => {
  it('adds commandcode server-locally without changing shared browser types', () => {
    const runtime: SessionRuntime = 'commandcode';
    const models: ModelsResponse['models'] = { pi: [], claude: [], opencode: [], commandcode: [] };
    const capabilities: CapabilitiesResponse['runtimes'] = {
      pi: {} as any, claude: {} as any, opencode: {} as any, antigravity: {}, commandcode: {} as any,
    };
    expect(runtime).toBe('commandcode');
    expect(models.commandcode).toEqual([]);
    expect(capabilities.commandcode).toBeDefined();
    // The deliberate version pin. Bumping the contract must be an act someone
    // chooses, and this is where that choice is felt — hence exact, not a floor.
    // 1.59.0: L1 (R5 follow-up wave, 2026-10-03) — /capacity quarantinedOldestAgeMs.
    // 1.60.0: wave K (R5, 2026-10-03) — additive goal interruption surface and
    // one continue after a restart interruption (docs/INTERNAL-API-CONTRACT.md).
    // 1.61.0: W0-c (2026-10-13) — PROFILE_CAPACITY_EXHAUSTED, /capacity claudeProfiles, /models maxConcurrent.
    // 1.62.0: W2 (2026-10-13) — goalId, stalled goal_state, no NEVER_STARTED goal_end, quarantined_debt.
    // 1.63.0: step 1i.2 B (2026-10-16) — native parent linkage (parentKind "native", parentSource "declared").
    expect(INTERNAL_API_CONTRACT_VERSION).toBe('1.63.0');
  });
});
