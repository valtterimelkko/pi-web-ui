import { describe, expect, it } from 'vitest';
import * as barrel from './index.js';
import * as childSurfacingShim from './child-surfacing.js';
import * as subagentSummaryShim from './subagent-summary.js';
import * as protocol from './protocol/index.js';
import * as childSurfacing from '@pi-web-ui/session-core/child-surfacing';
import * as subagentSummary from '@pi-web-ui/session-core/subagent-summary';

// Step 1a moved these modules into @pi-web-ui/session-core and kept the old paths as re-exports.
// Pin that the old paths still hand out the very same functions, so a later clean-up cannot drop one silently.
describe('compatibility shims after the session-core move', () => {
  it('child-surfacing re-exports session-core exactly', () => {
    expect(Object.keys(childSurfacingShim).sort()).toEqual(Object.keys(childSurfacing).sort());
    for (const [name, value] of Object.entries(childSurfacing)) {
      expect((childSurfacingShim as Record<string, unknown>)[name]).toBe(value);
    }
  });

  it('subagent-summary re-exports session-core exactly', () => {
    expect(Object.keys(subagentSummaryShim).sort()).toEqual(Object.keys(subagentSummary).sort());
    for (const [name, value] of Object.entries(subagentSummary)) {
      expect((subagentSummaryShim as Record<string, unknown>)[name]).toBe(value);
    }
  });

  it('the package barrel still exposes the moved modules, the protocol and the constants', () => {
    for (const [name, value] of Object.entries({ ...childSurfacing, ...subagentSummary, ...protocol })) {
      expect((barrel as Record<string, unknown>)[name]).toBe(value);
    }
    expect(barrel.WS_EVENTS.AUTH).toBe('auth');
  });
});
