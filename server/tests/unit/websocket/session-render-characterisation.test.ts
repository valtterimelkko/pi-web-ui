/**
 * Characterisation (command-centre step 1a): pins `normEventToPiFormat` over
 * invented per-runtime NormalizedEvent streams so the move into
 * `@pi-web-ui/session-core` is provably behaviour-preserving. The golden output
 * is also the input of the client fold and screen-view characterisations.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { normEventToPiFormat } from '../../../src/websocket/connection.js';
import type { NormalizedEvent } from '@pi-web-ui/shared';

const FIXTURES = new URL('../../../../fixtures/session-render/', import.meta.url);
const RUNTIMES = ['pi', 'claude', 'antigravity', 'commandcode'] as const;

describe('session-render characterisation: normEventToPiFormat', () => {
  for (const runtime of RUNTIMES) {
    it(`converts the ${runtime} fixture stream unchanged`, async () => {
      const events = JSON.parse(readFileSync(new URL(`${runtime}.normalized.json`, FIXTURES), 'utf8')) as NormalizedEvent[];
      const piEvents = events.map((event) => normEventToPiFormat(event));
      await expect(JSON.stringify(piEvents, null, 2) + '\n')
        .toMatchFileSnapshot(`../../../../fixtures/session-render/__golden__/${runtime}.pi-events.json`);
    });
  }
});
