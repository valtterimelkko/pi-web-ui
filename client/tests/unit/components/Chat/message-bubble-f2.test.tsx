import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MessageBubble } from '../../../../src/components/Chat/MessageBubble';
import type { LiveMessage } from '../../../../src/hooks/useSessionStream';

/**
 * F2 characterization: MessageBubble's custom memo comparator is correct and
 * beneficial — equivalent props skip the render; a content change rerenders.
 * Counting useSessionStore calls counts MessageBubble renders (one call/render).
 */
const storeCall = vi.hoisted(() => vi.fn());
vi.mock('../../../../src/store', () => ({
  useSessionStore: (selector?: (s: { isStreaming: boolean }) => unknown) => {
    storeCall();
    return selector ? selector({ isStreaming: false }) : { isStreaming: false };
  },
}));
vi.mock('../../../../src/hooks/useReadAloud', () => ({
  useReadAloud: () => ({ state: 'idle', play: vi.fn(), stop: vi.fn() }),
}));

function userMessage(id: string, text: string): LiveMessage {
  return { id, role: 'user', content: [{ type: 'text', text }], timestamp: 1, role2: undefined } as unknown as LiveMessage;
}

describe('F2: MessageBubble memo comparator', () => {
  it('skips rerender when props are equivalent (same id + content)', () => {
    const m = userMessage('m1', 'hello');
    const { rerender } = render(<MessageBubble message={m} />);
    const afterFirst = storeCall.mock.calls.length;
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    // Re-render with the SAME message reference -> memo comparator returns true -> body skipped.
    rerender(<MessageBubble message={m} />);
    expect(storeCall.mock.calls.length).toBe(afterFirst);
  });

  it('rerenders when content changes', () => {
    const m1 = userMessage('m2', 'first');
    const { rerender } = render(<MessageBubble message={m1} />);
    const afterFirst = storeCall.mock.calls.length;

    // New message object with DIFFERENT content -> comparator false -> body runs.
    rerender(<MessageBubble message={userMessage('m2', 'second')} />);
    expect(storeCall.mock.calls.length).toBeGreaterThan(afterFirst);
  });

  it('rerenders when a structural prop changes (isLast)', () => {
    const m = userMessage('m3', 'hi');
    const { rerender } = render(<MessageBubble message={m} />);
    const afterFirst = storeCall.mock.calls.length;
    rerender(<MessageBubble message={m} isLast={true} />);
    expect(storeCall.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});
