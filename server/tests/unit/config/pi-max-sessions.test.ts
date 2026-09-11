import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../../../src/config.js';

describe('piMaxSessions (PI_MAX_SESSIONS)', () => {
  it('defaults to 20 when PI_MAX_SESSIONS is unset', () => {
    // Test env does not set PI_MAX_SESSIONS; the singleton reflects that.
    expect(process.env.PI_MAX_SESSIONS).toBeUndefined();
    expect(config.piMaxSessions).toBe(20);
  });

  it('is a safe positive integer', () => {
    expect(Number.isSafeInteger(config.piMaxSessions)).toBe(true);
    expect(config.piMaxSessions).toBeGreaterThan(0);
  });

  it('connection.ts wires MultiSessionManager.maxSessions from config (no hardcoded literal)', () => {
    const connectionSource = readFileSync(
      fileURLToPath(new URL('../../../src/websocket/connection.ts', import.meta.url)),
      'utf8',
    );
    expect(connectionSource).toMatch(/maxSessions:\s*config\.piMaxSessions/);
    // The historical hardcoded cap must be gone.
    expect(connectionSource).not.toMatch(/maxSessions:\s*4\b/);
  });
});
