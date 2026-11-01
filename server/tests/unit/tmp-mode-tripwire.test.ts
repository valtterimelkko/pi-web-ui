import { describe, expect, it } from 'vitest';
import { formatMode, readDirMode, tmpModeChangeMessage } from '../tmp-mode-tripwire.js';

/**
 * The tripwire itself (the /tmp 0700 incident): the harness must fail the run
 * when the shared temporary directory's mode moved, name the cause class, and
 * stay silent when nothing changed.
 */
describe('shared tmp mode tripwire', () => {
  it('reports nothing when the mode is unchanged', () => {
    expect(tmpModeChangeMessage('/tmp', 0o1777, 0o1777)).toBeNull();
  });

  it('reports nothing when the mode could not be read (the run cannot judge)', () => {
    expect(tmpModeChangeMessage('/tmp', null, 0o700)).toBeNull();
    expect(tmpModeChangeMessage('/tmp', 0o1777, null)).toBeNull();
  });

  it('fails with both modes and names the cause class when a test locks the shared directory down', () => {
    const message = tmpModeChangeMessage('/tmp', 0o1777, 0o700);
    expect(message).toBeTruthy();
    expect(message).toContain('changed mode from 1777 to 700');
    expect(message).toContain('scripts/with-production-lock.sh');
    expect(message).toContain('server/tests/setup-env.ts');
    expect(message).toContain('chmod 1777 /tmp');
  });

  it('also catches a change in the other direction', () => {
    expect(tmpModeChangeMessage('/tmp', 0o700, 0o1777)).toContain('changed mode from 700 to 1777');
  });

  it('formats and reads modes as plain octal', () => {
    expect(formatMode(0o1777)).toBe('1777');
    expect(formatMode(0o700)).toBe('700');
    // A real directory we own: read back what the mode bits say.
    expect(readDirMode('/tmp') === null || typeof readDirMode('/tmp') === 'number').toBe(true);
    expect(readDirMode('/definitely/not/a/directory')).toBeNull();
  });
});
