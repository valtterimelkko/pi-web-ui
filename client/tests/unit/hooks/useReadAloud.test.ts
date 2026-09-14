import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useReadAloud } from '../../../src/hooks/useReadAloud';
import {
  speechArbiter,
  NORMAL_VOLUME,
  DUCKED_VOLUME,
} from '../../../src/lib/speechArbiter';
import { spokenLedger } from '../../../src/lib/spokenLedger';

/**
 * P4 — useReadAloud rewired through the speech arbiter (plan §4.1):
 * sentence-chunked synthesis (speech starts early), queueing, pause/resume
 * at chunk boundaries, and gain-based ducking on barge-in. The existing
 * surface ({ state, play, stop, speedEnabled, toggleSpeed }) is preserved.
 */

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

class FakeGainNode {
  gain = { value: 1 };
  connect = vi.fn();
  disconnect = vi.fn();
}

class FakeSourceNode {
  buffer: unknown = null;
  playbackRate = { value: 1 };
  connected: FakeGainNode | null = null;
  started = false;
  stopped = false;
  private ended: (() => void) | null = null;
  connect(dest: FakeGainNode) {
    this.connected = dest;
    return dest;
  }
  disconnect = vi.fn();
  addEventListener(ev: string, fn: () => void) {
    if (ev === 'ended') this.ended = fn;
  }
  start() {
    this.started = true;
    FakeAudioContext.sources.push(this);
  }
  stop() {
    this.stopped = true;
    this.ended?.();
  }
  fireEnded() {
    this.ended?.();
  }
}

class FakeAudioContext {
  static sources: FakeSourceNode[] = [];
  state = 'running';
  destination = {};
  resume = vi.fn(async () => {});
  createBufferSource() {
    return new FakeSourceNode();
  }
  createGain() {
    return new FakeGainNode();
  }
  decodeAudioData = vi.fn(async () => ({ duration: 0.5 }));
  static lastSource(): FakeSourceNode {
    const src = FakeAudioContext.sources[FakeAudioContext.sources.length - 1];
    if (!src) throw new Error('no source started');
    return src;
  }
}

let fetchCalls: Array<{ url: string; body: unknown }> = [];

beforeEach(() => {
  fetchCalls = [];
  FakeAudioContext.sources = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
    return {
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
      json: async () => ({}),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  spokenLedger.clear();
});

afterEach(() => {
  speechArbiter.stopAll();
  speechArbiter.setOperatorSpeaking(false);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useReadAloud — chunked playback through the speech arbiter', () => {
  it('synthesises and plays sentence chunks one at a time, starting with the first chunk only', async () => {
    const { result } = renderHook(() => useReadAloud('msg-1'));
    await act(async () => {
      result.current.play('First sentence. Second sentence.');
      await flush();
    });

    // Only the FIRST chunk is fetched — speech starts after a short
    // synthesis, not after the whole text (§4.1 chunked TTS).
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]).toMatchObject({ body: { text: 'First sentence.' } });
    expect(result.current.state).toBe('playing');
    expect(speechArbiter.getState().current).toMatchObject({
      id: 'msg-1',
      chunkIndex: 0,
      totalChunks: 2,
    });

    // Finishing chunk 1 is the chunk boundary that fetches/plays chunk 2.
    await act(async () => {
      FakeAudioContext.lastSource().fireEnded();
      await flush();
    });
    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1]).toMatchObject({ body: { text: 'Second sentence.' } });

    await act(async () => {
      FakeAudioContext.lastSource().fireEnded();
      await flush();
    });
    expect(result.current.state).toBe('idle');
    expect(speechArbiter.getState().current).toBeNull();
  });

  it('tapping play again while playing stops playback (toggle preserved)', async () => {
    const { result } = renderHook(() => useReadAloud('msg-1'));
    await act(async () => {
      result.current.play('One. Two.');
      await flush();
    });
    expect(result.current.state).toBe('playing');

    await act(async () => {
      result.current.play('One. Two.');
      await flush();
    });
    expect(result.current.state).toBe('idle');
    expect(speechArbiter.getState().current).toBeNull();
  });

  it('playing another message replaces the answer currently playing', async () => {
    const first = renderHook(() => useReadAloud('msg-1'));
    await act(async () => {
      first.result.current.play('First message. Second sentence.');
      await flush();
    });
    const second = renderHook(() => useReadAloud('msg-2'));
    await act(async () => {
      second.result.current.play('Other message.');
      await flush();
    });
    expect(speechArbiter.getState().current).toMatchObject({ id: 'msg-2' });
    expect(fetchCalls[fetchCalls.length - 1]).toMatchObject({
      body: { text: 'Other message.' },
    });
  });

  it('pause takes effect at the chunk boundary; resume continues from the next chunk', async () => {
    const { result } = renderHook(() => useReadAloud('msg-1'));
    await act(async () => {
      result.current.play('One. Two. Three.');
      await flush();
    });
    act(() => {
      result.current.pause();
    });
    expect(speechArbiter.getState().paused).toBe(true);

    // The in-flight chunk finishes; nothing further is fetched.
    await act(async () => {
      FakeAudioContext.lastSource().fireEnded();
      await flush();
    });
    expect(fetchCalls).toHaveLength(1);
    expect(result.current.state).toBe('paused');

    act(() => {
      result.current.resume();
    });
    await act(async () => {
      await flush();
    });
    // Resumed from the NEXT chunk — 'Two.', never a replay of 'One.'.
    expect(fetchCalls[1]).toMatchObject({ body: { text: 'Two.' } });
    expect(result.current.state).toBe('playing');
  });

  it('stop clears arbiter playback', async () => {
    const { result } = renderHook(() => useReadAloud('msg-1'));
    await act(async () => {
      result.current.play('One. Two.');
      await flush();
    });
    act(() => {
      result.current.stop();
    });
    expect(result.current.state).toBe('idle');
    expect(speechArbiter.getState().current).toBeNull();
  });

  it('ducks the in-flight chunk via its gain node when the operator takes the floor, restoring at the boundary', async () => {
    const { result } = renderHook(() => useReadAloud('msg-1'));
    await act(async () => {
      result.current.play('One. Two. Three.');
      await flush();
    });
    const source = FakeAudioContext.lastSource();
    expect(source.connected?.gain.value).toBe(NORMAL_VOLUME);

    // Barge-in: the playing chunk's gain drops — no hard stop.
    act(() => {
      speechArbiter.setOperatorSpeaking(true);
    });
    expect(source.connected?.gain.value).toBe(DUCKED_VOLUME);
    expect(source.stopped).toBe(false);

    // The next chunk boundary starts ducked...
    await act(async () => {
      source.fireEnded();
      await flush();
    });
    const second = FakeAudioContext.lastSource();
    expect(second).not.toBe(source);
    expect(second.connected?.gain.value).toBe(DUCKED_VOLUME);

    // ...and after the floor is released, the next boundary restores volume.
    act(() => {
      speechArbiter.setOperatorSpeaking(false);
    });
    await act(async () => {
      second.fireEnded();
      await flush();
    });
    const third = FakeAudioContext.lastSource();
    expect(third).not.toBe(second);
    expect(third.connected?.gain.value).toBe(NORMAL_VOLUME);
  });
});
