/**
 * App-lane unit tests: the transport gate and the not_run contract.
 *
 * The audio-capture behaviour itself is proven by the live `app` command's
 * immutable records; these tests pin the gates that decide pass/fail so a
 * regression in the gate logic cannot silently certify a broken transport.
 */
import { describe, expect, it } from 'vitest';
import { APP_LANE_SCENARIOS, assertRealTransport } from '../../../scripts/audio-lab/lib/app-scenarios.js';

describe('app lane — real-transport gate', () => {
  it('passes only when every served request was a real 200 from the endpoint', () => {
    expect(
      assertRealTransport({ servedRequests: [{ status: 200, servedFromFixture: false }, { status: 200, servedFromFixture: false }] }).ok
    ).toBe(true);
  });

  it('fails when any request was served from a fixture', () => {
    const result = assertRealTransport({ servedRequests: [{ status: 200, servedFromFixture: true }] });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('fromFixture=true');
  });

  it('fails when a request errored', () => {
    const result = assertRealTransport({ servedRequests: [{ status: 502, servedFromFixture: false }] });
    expect(result.ok).toBe(false);
    expect(result.detail).toContain('status=502');
  });

  it('fails on an empty request log — no proof is not a pass', () => {
    expect(assertRealTransport({ servedRequests: [] }).ok).toBe(false);
  });
});

describe('app lane — reading-level-change honesty', () => {
  it('is registered as required and reports not_run rather than simulating', async () => {
    const scenario = APP_LANE_SCENARIOS.find((entry) => entry.id === 'app.reading-level-change');
    expect(scenario).toBeDefined();
    expect(Boolean(scenario?.required)).toBe(true);
    await expect((scenario as { run: (c: never) => Promise<unknown> }).run({} as never)).rejects.toThrow(/^not_run:/);
  });

  it('keeps the login scenario first so the lane warms auth before anything else', () => {
    expect(APP_LANE_SCENARIOS[0].id).toBe('app.login-tts-read');
  });
});
