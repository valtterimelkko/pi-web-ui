import { describe, it, expect, vi } from 'vitest';
import {
  pickExplicitParentId,
  InFlightBashCorrelator,
  buildChildDispatchedCard,
  ChildLinkRegistry,
  type ParentLink,
  type LinkageRegistry,
} from '../../../src/internal-api/child-linkage.js';

describe('pickExplicitParentId', () => {
  it('prefers the header over the body value', () => {
    expect(pickExplicitParentId(' hdr ', 'body')).toBe('hdr');
  });
  it('falls back to the body value', () => {
    expect(pickExplicitParentId(undefined, ' body-id ')).toBe('body-id');
  });
  it('returns undefined for empty/whitespace values', () => {
    expect(pickExplicitParentId('   ', undefined)).toBeUndefined();
    expect(pickExplicitParentId(undefined, '')).toBeUndefined();
  });
});

describe('InFlightBashCorrelator', () => {
  it('correlates the newest in-flight bash call referencing the internal API socket', () => {
    const clock = { t: 1_000_000 };
    const correlator = new InFlightBashCorrelator(() => clock.t);
    correlator.observe('/sessions/a.jsonl', {
      type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash',
      args: { command: 'curl -s --unix-socket /root/.pi-web-ui/internal-api.sock http://localhost/api/v1/models' },
    });
    correlator.observe('/sessions/b.jsonl', {
      type: 'tool_execution_start', toolCallId: 't2', toolName: 'bash',
      args: { command: 'ls -la' },
    });
    expect(correlator.correlate()).toBe('/sessions/a.jsonl');
  });

  it('matches the api() wrapper form (SOCKET=...; curl) and prefers the newest caller', () => {
    const clock = { t: 1_000_000 };
    const correlator = new InFlightBashCorrelator(() => clock.t);
    correlator.observe('/a.jsonl', { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'SOCKET=/root/.pi-web-ui/internal-api.sock; curl -s ...' } });
    clock.t += 500;
    correlator.observe('/b.jsonl', { type: 'tool_execution_start', toolCallId: 't2', toolName: 'bash', args: { command: 'python3 script.py' } });
    expect(correlator.correlate()).toBe('/a.jsonl');
  });

  it('drops the call once its tool_execution_end arrives', () => {
    const clock = { t: 1_000_000 };
    const correlator = new InFlightBashCorrelator(() => clock.t);
    correlator.observe('/a.jsonl', { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'curl --unix-socket /root/.pi-web-ui/internal-api.sock x' } });
    correlator.observe('/a.jsonl', { type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash' });
    expect(correlator.correlate()).toBeNull();
  });

  it('expires stale in-flight entries (10 min ceiling)', () => {
    const clock = { t: 1_000_000 };
    const correlator = new InFlightBashCorrelator(() => clock.t);
    correlator.observe('/a.jsonl', { type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'curl --unix-socket /root/.pi-web-ui/internal-api.sock x' } });
    clock.t += 11 * 60 * 1000;
    expect(correlator.correlate()).toBeNull();
  });

  it('ignores non-bash tools', () => {
    const correlator = new InFlightBashCorrelator(() => 1_000_000);
    correlator.observe('/a.jsonl', { type: 'tool_execution_start', toolCallId: 't1', toolName: 'read', args: { path: '/root/.pi-web-ui/internal-api.sock' } });
    expect(correlator.correlate()).toBeNull();
  });
});

describe('buildChildDispatchedCard', () => {
  it('projects an internal-api child card with runtime and binding', () => {
    const card = buildChildDispatchedCard({
      childSessionId: 'child-1',
      runtime: 'pi',
      model: 'zai/glm-5.3-flash',
      modelSelector: 'zai/glm-5.3-flash',
      resolvedModel: 'zai/glm-5.3-flash',
      cwd: '/tmp/work',
      parentSessionId: 'parent-1',
    });
    expect(card).toMatchObject({
      id: 'child-1',
      childSessionId: 'child-1',
      kind: 'internal_api_child',
      status: 'dispatched',
      runtime: 'pi',
      model: 'zai/glm-5.3-flash',
      parentSessionId: 'parent-1',
    });
    expect(card.label.length).toBeGreaterThan(0);
  });

  it('uses the selector as the model when no resolved model is reported', () => {
    const card = buildChildDispatchedCard({
      childSessionId: 'child-2',
      runtime: 'claude',
      model: 'profile:glm',
      parentSessionId: 'parent-1',
    });
    expect(card.model).toBe('profile:glm');
    expect(card.modelSelector).toBeUndefined();
  });
});

function makeLinkageRegistry(): LinkageRegistry {
  return {
    get: async (id: string) => (id === 'parent-1'
      ? { id: 'parent-1', sdkType: 'pi', path: '/sessions/parent.jsonl' }
      : undefined),
    getByPath: async (p: string) => (p === '/sessions/parent.jsonl'
      ? { id: 'parent-1', sdkType: 'pi', path: p }
      : undefined),
  } as unknown as LinkageRegistry;
}

describe('ChildLinkRegistry.resolveParent', () => {
  it('resolves a parent id (pi -> broker key is the path)', async () => {
    const links = new ChildLinkRegistry({ broker: {} as never, broadcast: () => {}, publish: () => {}, registry: makeLinkageRegistry() });
    expect(await links.resolveParent('parent-1', undefined)).toEqual({
      parentSessionId: 'parent-1',
      parentBrokerKey: '/sessions/parent.jsonl',
      parentSdkType: 'pi',
    });
  });

  it('resolves a parent path and prefers the header over the body', async () => {
    const links = new ChildLinkRegistry({ broker: {} as never, broadcast: () => {}, publish: () => {}, registry: makeLinkageRegistry() });
    expect((await links.resolveParent(undefined, '/sessions/parent.jsonl'))?.parentSessionId).toBe('parent-1');
    expect((await links.resolveParent('parent-1', '/other.jsonl'))?.parentSessionId).toBe('parent-1');
  });

  it('returns null for an unresolvable parent (silent no-linkage)', async () => {
    const links = new ChildLinkRegistry({ broker: {} as never, broadcast: () => {}, publish: () => {}, registry: makeLinkageRegistry() });
    expect(await links.resolveParent('does-not-exist', undefined)).toBeNull();
    expect(await links.resolveParent(undefined, undefined)).toBeNull();
  });
});

describe('ChildLinkRegistry.linkChild + child_turn_ended', () => {
  function makeRegistry() {
    const published: Array<{ key: string; type: string; data: unknown }> = [];
    const broadcasts: Array<Record<string, unknown>> = [];
    const subscribedKeys: string[] = [];
    let childHandler: ((event: { type: string; data?: unknown }) => void) | undefined;
    const broker = {
      subscribe: (key: string, handler: (event: { type: string; data?: unknown }) => void) => {
        subscribedKeys.push(key);
        childHandler = handler;
        return () => {};
      },
    };
    const links = new ChildLinkRegistry({
      broker: broker as never,
      broadcast: (m) => broadcasts.push(m),
      publish: (key, event) => published.push({ key, type: event.type, data: event.data }),
      registry: makeLinkageRegistry(),
    });
    return { links, published, broadcasts, subscribedKeys, childHandler: () => childHandler };
  }

  it('subscribes to the child broker key and links the child', async () => {
    const { links, subscribedKeys } = makeRegistry();
    const link: ParentLink = { parentSessionId: 'parent-1', parentBrokerKey: '/sessions/parent.jsonl', parentSdkType: 'pi' };
    await links.linkChild({ sessionId: 'child-9', sessionPath: '/sessions/child-9.jsonl', runtime: 'pi', model: 'zai/glm-5.3-flash' }, link);
    expect(subscribedKeys).toEqual(['/sessions/child-9.jsonl']);
  });

  it('publishes child_turn_ended to the parent key + browser on child agent_end, once', async () => {
    const { links, published, broadcasts, childHandler } = makeRegistry();
    const link: ParentLink = { parentSessionId: 'parent-1', parentBrokerKey: '/sessions/parent.jsonl', parentSdkType: 'pi' };
    await links.linkChild({ sessionId: 'child-9', sessionPath: '/sessions/child-9.jsonl', runtime: 'pi', model: 'zai/glm-5.3-flash' }, link);

    childHandler()?.({ type: 'agent_end' });
    const turnEnded = published.find((p) => p.type === 'child_turn_ended');
    expect(turnEnded).toBeDefined();
    expect(turnEnded!.key).toBe('/sessions/parent.jsonl');
    expect((turnEnded!.data as { sessionId: string }).sessionId).toBe('parent-1');
    expect(broadcasts.some((b) => b.type === 'child_turn_ended' && b.sessionId === 'parent-1')).toBe(true);

    // A second agent_end must NOT re-publish (single terminal notification).
    childHandler()?.({ type: 'agent_end' });
    expect(published.filter((p) => p.type === 'child_turn_ended')).toHaveLength(1);
  });

  it('ignores non-terminal events flowing on the child key', async () => {
    const { links, published, childHandler } = makeRegistry();
    const link: ParentLink = { parentSessionId: 'parent-1', parentBrokerKey: '/sessions/parent.jsonl', parentSdkType: 'pi' };
    await links.linkChild({ sessionId: 'child-9', sessionPath: '/sessions/child-9.jsonl', runtime: 'pi' }, link);
    childHandler()?.({ type: 'message_update' });
    childHandler()?.({ type: 'tool_execution_start' });
    expect(published.filter((p) => p.type === 'child_turn_ended')).toHaveLength(0);
  });
});
