/**
 * The package answers the step-1a characterisation goldens directly (the same
 * files the server, shared and client characterisations pin through the old
 * import paths), so the moved code is proven equivalent at its new home.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { normEventToPiFormat, type NormalizedEvent } from '../src/events.js';
import { projectDefaultViewFromEvents, renderScreenViewMarkdown } from '../src/screen-view.js';

const FIXTURES = new URL('../../../fixtures/session-render/', import.meta.url);
const RUNTIMES = ['pi', 'claude', 'antigravity', 'commandcode'] as const;
const read = (name: string): unknown => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));

describe('session-core against the session-render goldens', () => {
  for (const runtime of RUNTIMES) {
    it(`${runtime}: normEventToPiFormat matches the golden Pi-format events`, () => {
      const events = read(`${runtime}.normalized.json`) as NormalizedEvent[];
      expect(events.map(normEventToPiFormat)).toEqual(read(`__golden__/${runtime}.pi-events.json`));
    });

    it(`${runtime}: the screen view matches the golden projection`, () => {
      const events = read(`__golden__/${runtime}.pi-events.json`) as Array<Record<string, unknown>>;
      const collapsed = projectDefaultViewFromEvents(events);
      const expanded = projectDefaultViewFromEvents(events, { expand: { tools: true, thinking: true } });
      expect({ collapsed, expanded, markdown: renderScreenViewMarkdown(collapsed) })
        .toEqual(read(`__golden__/${runtime}.screen-view.json`));
    });
  }
});
