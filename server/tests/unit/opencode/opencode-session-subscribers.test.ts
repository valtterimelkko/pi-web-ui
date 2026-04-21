import { describe, it, expect, beforeEach } from 'vitest';
import { OpenCodeSessionSubscribers } from '../../../src/opencode/opencode-session-subscribers.js';

describe('OpenCodeSessionSubscribers', () => {
  let tracker: OpenCodeSessionSubscribers;

  beforeEach(() => {
    tracker = new OpenCodeSessionSubscribers();
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
      expect(tracker.isSubscribed('client-A', 'session-1')).toBe(true);
      expect(tracker.isSubscribed('client-B', 'session-1')).toBe(true);
    });

    it('allows a client to subscribe to multiple sessions', () => {
      tracker.subscribe('client-A', 'session-1');
      tracker.subscribe('client-A', 'session-2');
      expect(tracker.isSubscribed('client-A', 'session-1')).toBe(true);
      expect(tracker.isSubscribed('client-A', 'session-2')).toBe(true);
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
      expect(tracker.getSubscriberCount('session-1')).toBe(0);
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
      expect(tracker.getSubscriberCount('session-1')).toBe(1);
    });

    it('unsubscribing from a non-existent session is a no-op', () => {
      expect(() => tracker.unsubscribe('client-A', 'no-such-session')).not.toThrow();
    });

    it('unsubscribing a non-subscribed client from a session is a no-op', () => {
      tracker.subscribe('client-A', 'session-1');
      tracker.unsubscribe('client-B', 'session-1');
      expect(tracker.getSubscriberCount('session-1')).toBe(1);
    });
  });

  describe('unsubscribeAll', () => {
    it('removes a client from all sessions', () => {
      tracker.subscribe('client-A', 'session-1');
      tracker.subscribe('client-A', 'session-2');
      tracker.subscribe('client-A', 'session-3');
      tracker.unsubscribeAll('client-A');
      expect(tracker.isSubscribed('client-A', 'session-1')).toBe(false);
      expect(tracker.isSubscribed('client-A', 'session-2')).toBe(false);
      expect(tracker.isSubscribed('client-A', 'session-3')).toBe(false);
    });

    it('does not affect other clients in the same sessions', () => {
      tracker.subscribe('client-A', 'session-1');
      tracker.subscribe('client-B', 'session-1');
      tracker.unsubscribeAll('client-A');
      expect(tracker.isSubscribed('client-B', 'session-1')).toBe(true);
    });

    it('cleans up sessions that become empty after disconnect', () => {
      tracker.subscribe('client-A', 'session-1');
      tracker.unsubscribeAll('client-A');
      expect(tracker.sessionCount).toBe(0);
    });

    it('is a no-op for an unknown client', () => {
      tracker.subscribe('client-A', 'session-1');
      expect(() => tracker.unsubscribeAll('unknown-client')).not.toThrow();
      expect(tracker.getSubscriberCount('session-1')).toBe(1);
    });
  });

  describe('getSubscribers', () => {
    it('returns all subscribers for a session', () => {
      tracker.subscribe('client-A', 'session-1');
      tracker.subscribe('client-B', 'session-1');
      tracker.subscribe('client-C', 'session-2');
      const subs = tracker.getSubscribers('session-1');
      expect([...subs]).toEqual(expect.arrayContaining(['client-A', 'client-B']));
      expect(subs.size).toBe(2);
    });

    it('returns empty set for a session with no subscribers', () => {
      const subs = tracker.getSubscribers('no-session');
      expect(subs.size).toBe(0);
    });
  });

  describe('session switching scenario', () => {
    it('client switches from one OpenCode session to another', () => {
      tracker.subscribe('client-A', 'session-1');
      expect(tracker.getSubscriberCount('session-1')).toBe(1);

      tracker.unsubscribe('client-A', 'session-1');
      tracker.subscribe('client-A', 'session-2');

      expect(tracker.isSubscribed('client-A', 'session-1')).toBe(false);
      expect(tracker.isSubscribed('client-A', 'session-2')).toBe(true);
      expect(tracker.sessionCount).toBe(1);
    });

    it('multiple clients viewing different sessions with switching', () => {
      tracker.subscribe('client-A', 'session-1');
      tracker.subscribe('client-B', 'session-2');

      tracker.unsubscribe('client-A', 'session-1');
      tracker.subscribe('client-A', 'session-2');

      expect(tracker.sessionCount).toBe(1);
      expect(tracker.getSubscriberCount('session-2')).toBe(2);
    });
  });

  describe('event broadcasting simulation', () => {
    it('simulates broadcasting events to all session subscribers', () => {
      tracker.subscribe('client-A', 'session-1');
      tracker.subscribe('client-B', 'session-1');
      tracker.subscribe('client-C', 'session-2');

      const recipients: string[] = [];
      const subscribers = tracker.getSubscribers('session-1');
      for (const clientId of subscribers) {
        recipients.push(clientId);
      }

      expect(recipients).toEqual(expect.arrayContaining(['client-A', 'client-B']));
      expect(recipients).toHaveLength(2);
      expect(recipients).not.toContain('client-C');
    });

    it('broadcasts correctly after a client disconnects mid-stream', () => {
      tracker.subscribe('client-A', 'session-1');
      tracker.subscribe('client-B', 'session-1');

      tracker.unsubscribeAll('client-B');

      const recipients: string[] = [];
      for (const clientId of tracker.getSubscribers('session-1')) {
        recipients.push(clientId);
      }

      expect(recipients).toEqual(['client-A']);
    });

    it('handles subscriber leaving and rejoining', () => {
      tracker.subscribe('client-A', 'session-1');

      tracker.unsubscribe('client-A', 'session-1');
      expect(tracker.getSubscriberCount('session-1')).toBe(0);

      tracker.subscribe('client-A', 'session-1');

      const subs = tracker.getSubscribers('session-1');
      expect([...subs]).toEqual(['client-A']);
    });
  });
});
