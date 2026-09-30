import { describe, expect, it } from 'vitest';
import { groupPath, ownGroupName, sanitiseId, sessionGroupName } from '../../../src/placement/keys.js';
import { resolvePlacementConfig } from '../../../src/placement/config.js';

describe('placement group keys', () => {
  it('sanitises ids to cgroup-safe names', () => {
    expect(sanitiseId('01a0f2a6-55e9-7554-9cf9-d61455a19bf3')).toBe('01a0f2a6-55e9-7554-9cf9-d61455a19bf3');
    expect(sanitiseId('../../etc/passwd')).not.toMatch(/[/]+/);
    expect(sanitiseId('../../etc/passwd')).not.toContain('..');
    expect(sanitiseId('a b/c:d*e')).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it('maps a session id deterministically to the same group name', () => {
    const a = sessionGroupName('pi', undefined, '01a0f2a6-55e9');
    const b = sessionGroupName('pi', undefined, '01a0f2a6-55e9');
    expect(a).toBe(b);
    expect(a.startsWith('pi-')).toBe(true);
  });

  it('maps ids that sanitise to the same string to DIFFERENT groups (hash disambiguation)', () => {
    const a = sessionGroupName('pi', undefined, 'a/b');
    const b = sessionGroupName('pi', undefined, 'a_b');
    expect(sanitiseId('a/b')).toBe(sanitiseId('a_b'));
    expect(a).not.toBe(b);
  });

  it('names runtime groups by runtime and session id', () => {
    const g = sessionGroupName('rt', 'claude', 'sess-1');
    expect(g.startsWith('rt-claude-')).toBe(true);
  });

  it('generates own- groups that differ per call', () => {
    expect(ownGroupName()).not.toBe(ownGroupName());
    expect(ownGroupName()).toMatch(/^own-[a-z0-9]+$/);
  });

  it('joins group paths under the tools root and refuses anything outside it', () => {
    const cfg = resolvePlacementConfig({ PI_TOOLS_PLACEMENT: 'on' });
    const ok = groupPath(cfg, sessionGroupName('pi', undefined, 's1'));
    expect(ok).toBe(`${cfg.toolsRoot}/${sessionGroupName('pi', undefined, 's1')}`);
    expect(groupPath(cfg, '../escape')).toBeUndefined();
    expect(groupPath(cfg, 'a/b')).toBeUndefined();
    expect(groupPath(cfg, '')).toBeUndefined();
    expect(groupPath(cfg, '.')).toBeUndefined();
  });
});
