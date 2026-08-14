import { describe, expect, it } from 'vitest';
import { resolveInternalApiAdmissionOptions } from '../../../src/internal-api/server.js';

describe('Internal API admission wiring', () => {
  it('maps configured Command Code concurrency to the commandcode runtime limit', () => {
    const options = resolveInternalApiAdmissionOptions({
      admissionMaxActiveTurns: 6,
      admissionInteractiveReserve: 1,
      admissionMinimumHeadroomBytes: 100,
      admissionHostMinimumHeadroomBytes: 100,
      admissionReservedBytesPerTurn: 1,
      admissionReservedPidsPerTurn: 1,
      commandCodeConcurrency: 3,
    });

    expect(options.runtimeMaxActiveTurns).toEqual({ commandcode: 3 });
  });
});
