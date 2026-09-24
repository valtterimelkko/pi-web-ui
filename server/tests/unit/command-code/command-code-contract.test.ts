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
    expect(INTERNAL_API_CONTRACT_VERSION).toBe('1.45.0');
  });
});
