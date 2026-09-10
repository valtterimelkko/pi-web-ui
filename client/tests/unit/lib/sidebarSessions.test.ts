import { describe, it, expect } from 'vitest';
import {
  RECENT_WINDOW_MS,
  NATIVE_DISCOVERED_WINDOW_MS,
  filterRecentActiveSessions,
} from '../../../src/lib/sidebarSessions';

/**
 * Sidebar active-list hygiene (plan Phase 3): the default view keeps the list
 * to recent sessions. Sessions discovered natively from disk
 * (origin: 'native-discovered') obey a tighter 14-day recency cutoff unless
 * "Show all" is checked, so a watcher that indexes hundreds of historical CLI
 * sessions never floods the sidebar.
 */

interface Row {
  id: string;
  lastActivity?: string;
  origin?: 'browser' | 'internal-api' | 'native-discovered';
}

const NOW = 1_800_000_000_000;
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

const row = (overrides: Partial<Row> = {}): Row => ({ id: 's1', ...overrides });

describe('filterRecentActiveSessions', () => {
  it('keeps sessions inside the default 30-day window', () => {
    const sessions = [row({ id: 'a', lastActivity: daysAgo(10) })];
    expect(filterRecentActiveSessions(sessions, { now: NOW })).toHaveLength(1);
    expect(RECENT_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('hides plain sessions older than 30 days (existing behaviour)', () => {
    const sessions = [row({ id: 'old', lastActivity: daysAgo(45) })];
    expect(filterRecentActiveSessions(sessions, { now: NOW })).toHaveLength(0);
  });

  it('hides native-discovered sessions already older than the 14-day cutoff', () => {
    const sessions = [row({ id: 'hist', lastActivity: daysAgo(20), origin: 'native-discovered' })];
    expect(filterRecentActiveSessions(sessions, { now: NOW })).toHaveLength(0);
  });

  it('keeps native-discovered sessions inside the 14-day cutoff', () => {
    const sessions = [row({ id: 'recent-cli', lastActivity: daysAgo(6), origin: 'native-discovered' })];
    expect(filterRecentActiveSessions(sessions, { now: NOW })).toHaveLength(1);
    expect(NATIVE_DISCOVERED_WINDOW_MS).toBe(14 * 24 * 60 * 60 * 1000);
  });

  it('always keeps the currently open session regardless of age/origin', () => {
    const sessions = [row({ id: 'hist', lastActivity: daysAgo(90), origin: 'native-discovered' })];
    expect(filterRecentActiveSessions(sessions, { now: NOW, currentSessionId: 'hist' })).toHaveLength(1);
  });

  it('keeps sessions with unknown lastActivity visible (existing behaviour)', () => {
    const sessions = [row({ id: 'unknown' }), row({ id: 'unknown-cli', origin: 'native-discovered' })];
    expect(filterRecentActiveSessions(sessions, { now: NOW })).toHaveLength(2);
  });

  it('"show all" bypasses every recency cutoff', () => {
    const sessions = [
      row({ id: 'old', lastActivity: daysAgo(45) }),
      row({ id: 'old-cli', lastActivity: daysAgo(300), origin: 'native-discovered' }),
    ];
    expect(filterRecentActiveSessions(sessions, { now: NOW, showAll: true })).toHaveLength(2);
  });
});
