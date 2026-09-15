/**
 * useDictation — capture ownership.
 *
 * RED (Child V, 2026-09-15), from a real two-tab browser reproduction
 * (operations/change-requests-20260915/child-voice/evidence/repro-v3.json):
 *
 *   - two concurrent starts (a second tap landing while the device is still
 *     being acquired) each obtained a microphone stream and started a
 *     MediaRecorder; ONE tap then stopped only one of them, leaving the app
 *     reading "Start recording" (idle) while a recorder was still recording and
 *     the microphone track was still live — the browser's recording indicator
 *     stays on with no control in the app;
 *   - leaving the surface while recording left the recorder running and the
 *     track live: the app had no control at all for a hot microphone.
 *
 * These tests pin capture as a SINGLE-OWNER resource with a deterministic
 * teardown, and the in-flight state as visible rather than reported as idle.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useDictation } from '../../../src/hooks/useDictation';

vi.mock('../../../src/lib/clientDiagnosticsReporter.js', () => ({
  reportClientError: vi.fn(),
}));

interface FakeTrack {
  kind: string;
  stop: () => void;
  stopped: boolean;
}

class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported(): boolean {
    return true;
  }
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  stream: { getTracks: () => FakeTrack[] };
  ondataavailable: ((e: { data: { size: number } }) => void) | null = null;
  private listeners = new Map<string, Array<() => void>>();

  constructor(stream: { getTracks: () => FakeTrack[] }) {
    this.stream = stream;
    FakeRecorder.instances.push(this);
  }
  start(): void {
    this.state = 'recording';
  }
  stop(): void {
    this.state = 'inactive';
    (this.listeners.get('stop') ?? []).forEach((fn) => fn());
  }
  addEventListener(type: string, fn: () => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }
}

/** A getUserMedia whose resolution the test controls. */
function createStream(): { stream: { getTracks: () => FakeTrack[] }; tracks: FakeTrack[] } {
  const track: FakeTrack = {
    kind: 'audio',
    stopped: false,
    stop(this: FakeTrack) {
      this.stopped = true;
    },
  };
  const tracks: FakeTrack[] = [track];
  return { stream: { getTracks: () => tracks }, tracks };
}

describe('useDictation — capture ownership', () => {
  let gumCalls: Array<{ resolve: (s: unknown) => void; reject: (e: unknown) => void }>;
  let openStreams: Array<{ stream: { getTracks: () => FakeTrack[] }; tracks: FakeTrack[] }>;
  let fetchCalls: string[];

  beforeEach(() => {
    gumCalls = [];
    openStreams = [];
    fetchCalls = [];
    FakeRecorder.instances = [];

    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn(
          () =>
            new Promise((resolve, reject) => {
              gumCalls.push({ resolve, reject });
            })
        ),
      },
    });
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        fetchCalls.push(String(url));
        if (String(url).includes('/start')) return { ok: true, json: async () => ({ id: `rec-${fetchCalls.length}` }) };
        if (String(url).includes('/finish')) return { ok: true, json: async () => ({ text: 'transcribed words', duration_ms: 1000 }) };
        return { ok: true, json: async () => ({ ok: true }) };
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Resolve the pending getUserMedia with a fresh stream. */
  async function resolveDevice(index = 0): Promise<void> {
    const stream = createStream();
    openStreams.push(stream);
    await act(async () => {
      gumCalls[index].resolve(stream.stream);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('reports a visible in-flight state while the device is being acquired (never plain idle)', async () => {
    const { result } = renderHook(() => useDictation(vi.fn()));

    act(() => {
      void result.current.startRecording();
    });
    // The browser may already be showing its own recording indicator here; the
    // surface must not read as plain idle.
    expect(result.current.state).toBe('starting');

    await resolveDevice();
    expect(result.current.state).toBe('recording');
  });

  it('starts exactly one capture when a second tap lands while the first start is in flight', async () => {
    const { result } = renderHook(() => useDictation(vi.fn()));

    act(() => {
      void result.current.startRecording();
    });
    expect(gumCalls.length).toBe(1);

    // The operator taps again while acquisition is still in flight.
    act(() => {
      void result.current.startRecording();
    });
    expect(gumCalls.length).toBe(1);

    await resolveDevice();
    expect(FakeRecorder.instances.length).toBe(1);
    expect(result.current.state).toBe('recording');
  });

  it('does not open a second dictation session when the surface is tapped twice in quick succession', async () => {
    const { result } = renderHook(() => useDictation(vi.fn()));

    act(() => {
      void result.current.startRecording();
      void result.current.startRecording();
    });
    await resolveDevice();
    const starts = fetchCalls.filter((u) => u.endsWith('/api/dictation/start'));
    expect(starts.length).toBe(1);
  });

  it('leaves no recorder running and no live microphone track when the hook unmounts while recording', async () => {
    const { result, unmount } = renderHook(() => useDictation(vi.fn()));

    act(() => {
      void result.current.startRecording();
    });
    await resolveDevice();
    expect(result.current.state).toBe('recording');
    expect(openStreams[0].tracks[0].stopped).toBe(false);

    unmount();

    expect(FakeRecorder.instances[0].state).toBe('inactive');
    expect(openStreams[0].tracks.every((t) => t.stopped)).toBe(true);
  });

  it('tells the server to abandon an in-flight recording when the surface goes away', async () => {
    const { result, unmount } = renderHook(() => useDictation(vi.fn()));

    act(() => {
      void result.current.startRecording();
    });
    await resolveDevice();
    unmount();

    const aborts = fetchCalls.filter((u) => u.endsWith('/abort'));
    expect(aborts.length).toBe(1);
  });

  it('stops transcribing but still releases the microphone on a normal stop', async () => {
    const onTranscript = vi.fn();
    const { result } = renderHook(() => useDictation(onTranscript));

    act(() => {
      void result.current.startRecording();
    });
    await resolveDevice();
    await act(async () => {
      await result.current.stopRecording();
    });

    expect(onTranscript).toHaveBeenCalledWith('transcribed words');
    expect(result.current.state).toBe('idle');
    expect(FakeRecorder.instances[0].state).toBe('inactive');
    expect(openStreams[0].tracks.every((t) => t.stopped)).toBe(true);
  });

  it('releases the device and reports an error when starting a recording fails', async () => {
    const { result } = renderHook(() => useDictation(vi.fn()));

    act(() => {
      void result.current.startRecording();
    });
    await act(async () => {
      gumCalls[0].reject(new Error('NotAllowedError: Permission denied'));
      await Promise.resolve();
    });

    expect(result.current.state).toBe('error');
    expect(result.current.errorMessage).toContain('permission denied');
  });

  it('is a no-op when stopping while nothing is recording', async () => {
    const { result } = renderHook(() => useDictation(vi.fn()));
    await act(async () => {
      await result.current.stopRecording();
    });
    expect(result.current.state).toBe('idle');
    expect(FakeRecorder.instances.length).toBe(0);
  });
});
