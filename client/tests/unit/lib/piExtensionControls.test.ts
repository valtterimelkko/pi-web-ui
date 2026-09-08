import { describe, it, expect } from 'vitest';
import {
  canSteerWhileStreaming,
  canSendStreamingText,
  streamingComposeIsQueueOnly,
} from '../../../src/lib/piExtensionControls';

describe('streaming compose routing (antigravity stream-json integration)', () => {
  it('antigravity accepts streaming compose (queue-capable)', () => {
    expect(canSteerWhileStreaming(true, 'antigravity')).toBe(true);
  });

  it('antigravity is queue-only: no steer transport exists', () => {
    expect(streamingComposeIsQueueOnly('antigravity')).toBe(true);
    expect(streamingComposeIsQueueOnly('pi')).toBe(false);
    expect(streamingComposeIsQueueOnly('claude')).toBe(false);
    expect(streamingComposeIsQueueOnly('commandcode')).toBe(false);
    expect(streamingComposeIsQueueOnly('opencode')).toBe(false);
  });

  it('attachments still block streaming sends on antigravity', () => {
    expect(canSendStreamingText(true, 'antigravity', true)).toBe(false);
    expect(canSendStreamingText(true, 'antigravity', false)).toBe(true);
  });

  it('non-streaming sessions never offer streaming compose', () => {
    expect(canSteerWhileStreaming(false, 'antigravity')).toBe(false);
  });
});
