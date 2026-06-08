import { describe, it, expect, beforeEach } from 'vitest';
import { AntigravitySessionSubscribers } from '../../../src/antigravity/antigravity-session-subscribers.js';

describe('AntigravitySessionSubscribers', () => {
  let tracker: AntigravitySessionSubscribers;

  beforeEach(() => {
    tracker = new AntigravitySessionSubscribers();
  });

  describe('subscribe', () => {
    it('adds a client to a session', () => {
      tracker.subscribe('client-A', 'session-1');
      expect(tracker.isSubscribed('client-A', 'session-1')).toBe(true);
    });

    it('adds multiple clients to the same session', () => {
      tracker.subscribe('client-A', 'session-1');
      tracker.subscribe('client-B', 'session-1');
      expect(tracker.getSubscriberCount('session-1')).toBe(2);
    });

    it('allows a client to subscribe to multiple sessions', () => {
      tracker.subscribe('client-A', 'session-1');
      tracker.subscribe('client-A', 'session-2');
      expect(tracker.sessionCount).toBe(2);
    });

    it('is idempotent — subscribing twice does not duplicate', () => {
      tracker.subscribe('client-A', 'session-1');
      tracker.subscribe('client-A', 'session-1');
      expect(tracker.getSubscriberCount('session-1')).toBe(1);
    });
  });

  describe('unsubscribe', () => {
    it('removes a client from a session', () => {
      tracker.subscribe('client-A', 'session-1');
      tracker.unsubscribe('client-A', 'session-1');
      expect(tracker.isSubscribed('client-A', 'session-1')).toBe(false);
    });

    it('cleans up empty session entries', () => {
      tracker.subscribe('client-A', 'session-1');
      tracker.unsubscribe('client-A', 'session-1');
      expect(tracker.sessionCount).toBe(0);
    });

    it('does not remove other subscribers from the same session', () => {
      tracker.subscribe('client-A', 'session-1');
      tracker.subscribe('client-B', 'session-1');
      tracker.unsubscribe('client-A', 'session-1');
      expect(tracker.isSubscribed('client-B', 'session-1')).toBe(true);
    });

    it('unsubscribing from a non-existent session is a no-op', () => {
      expect(() => tracker.unsubscribe('client-A', 'no-such-session')).not.toThrow();
    });
  });

  describe('unsubscribeAll', () => {
    it('removes a client from all sessions', () => {
      tracker.subscribe('client-A', 'session-1');
      tracker.subscribe('client-A', 'session-2');
      tracker.unsubscribeAll('client-A');
      expect(tracker.isSubscribed('client-A', 'session-1')).toBe(false);
      expect(tracker.isSubscribed('client-A', 'session-2')).toBe(false);
    });

    it('does not affect other clients', () => {
      tracker.subscribe('client-A', 'session-1');
      tracker.subscribe('client-B', 'session-1');
      tracker.unsubscribeAll('client-A');
      expect(tracker.isSubscribed('client-B', 'session-1')).toBe(true);
    });

    it('cleans up sessions that become empty', () => {
      tracker.subscribe('client-A', 'session-1');
      tracker.unsubscribeAll('client-A');
      expect(tracker.sessionCount).toBe(0);
    });

    it('is a no-op for unknown client', () => {
      tracker.subscribe('client-A', 'session-1');
      expect(() => tracker.unsubscribeAll('unknown-client')).not.toThrow();
      expect(tracker.getSubscriberCount('session-1')).toBe(1);
    });
  });

  describe('getSubscribers', () => {
    it('returns all subscribers for a session', () => {
      tracker.subscribe('client-A', 'session-1');
      tracker.subscribe('client-B', 'session-1');
      const subs = tracker.getSubscribers('session-1');
      expect([...subs]).toEqual(expect.arrayContaining(['client-A', 'client-B']));
      expect(subs.size).toBe(2);
    });

    it('returns empty set for a session with no subscribers', () => {
      expect(tracker.getSubscribers('no-session').size).toBe(0);
    });
  });
});
