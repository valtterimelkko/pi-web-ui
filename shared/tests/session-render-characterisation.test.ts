/**
 * Characterisation (command-centre step 1a): pins the screen-view projection
 * over the invented per-runtime Pi-format streams (produced by the server
 * characterisation of `normEventToPiFormat`).
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { projectDefaultViewFromEvents, renderScreenViewMarkdown } from '../src/screen-view.js';

const GOLDEN = new URL('../../fixtures/session-render/__golden__/', import.meta.url);
const RUNTIMES = ['pi', 'claude', 'antigravity', 'commandcode'] as const;

describe('session-render characterisation: screen view', () => {
  for (const runtime of RUNTIMES) {
    it(`projects the ${runtime} fixture stream unchanged`, async () => {
      const events = JSON.parse(readFileSync(new URL(`${runtime}.pi-events.json`, GOLDEN), 'utf8')) as Array<Record<string, unknown>>;
      const collapsed = projectDefaultViewFromEvents(events);
      const expanded = projectDefaultViewFromEvents(events, { expand: { tools: true, thinking: true } });
      const golden = { collapsed, expanded, markdown: renderScreenViewMarkdown(collapsed) };
      await expect(JSON.stringify(golden, null, 2) + '\n')
        .toMatchFileSnapshot(`../../fixtures/session-render/__golden__/${runtime}.screen-view.json`);
    });
  }
});
