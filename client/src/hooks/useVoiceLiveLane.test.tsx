/**
 * C24 — the lane registry behind the picker's worker switch.
 *
 * Drive Mode's session picker swaps a lane's worker IN PLACE (store
 * `replaceVoiceLane`), so the lane's surface is discarded without the
 * contract's §3.2 step-1 stop: the server never learns the worker changed,
 * `resolveLiveProposalForWorkerChange` never fires, and a pending proposal
 * silently outlives the switch. The stop must be sendable at the moment the
 * picker commits — while the OLD lane's surface is still mounted — so the
 * hook module exposes `stopVoiceLaneForWorkerSwitch(workerSessionId)`, which
 * finds that lane by its deterministic page identity and stops it with
 * reason `worker_switch`.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { VoiceClientMessage } from '@pi-web-ui/shared';
import type { VoiceLiveSurfaceFactories } from '../lib/voiceLive/surface';

// The hook's outbound frames ride the page's single session socket through
// the frameBus; the test substitutes the socket seam and records the wire.
const wire = vi.hoisted(() => {
  const state: { frames: unknown[]; connected: boolean } = { frames: [], connected: true };
  return state;
});

vi.mock('../lib/websocket', () => ({
  getWebSocketClient: () =>
    wire.connected
      ? {
          send: (frame: unknown) => {
            wire.frames.push(frame);
            return 'sent' as const;
          },
        }
      : null,
}));

import { useVoiceLiveLane, stopVoiceLaneForWorkerSwitch } from './useVoiceLiveLane';

/** Give the surface a capture capability so `startLane` is not refused as
 *  unsupported in jsdom (the real browser has one; the test fakes it). */
const factories: VoiceLiveSurfaceFactories = {
  getUserMedia: async () => ({ getAudioTracks: () => [{ stop() {} }] }) as unknown as MediaStream,
};

beforeEach(() => {
  wire.frames = [];
  wire.connected = true;
});

describe('useVoiceLiveLane — stopVoiceLaneForWorkerSwitch (C24)', () => {
  it('stops a mounted, open lane with voice_session_stop {worker_switch} and reports true', async () => {
    const { result, unmount } = renderHook(() =>
      useVoiceLiveLane({ workerSessionId: 'worker-A', factories })
    );
    // The lane's wire session is open (the mic tap did this in production).
    await act(async () => {
      expect(result.current.surface.startLane()).toBe('started');
    });
    const startCount = wire.frames.filter(
      (frame) => (frame as VoiceClientMessage).type === 'voice_session_start'
    ).length;
    expect(startCount).toBe(1);

    // The picker commits the swap: the old lane is stopped by workerSessionId.
    let stopped = false;
    act(() => {
      stopped = stopVoiceLaneForWorkerSwitch('worker-A');
    });
    expect(stopped).toBe(true);

    const stop = wire.frames.find(
      (frame) => (frame as VoiceClientMessage).type === 'voice_session_stop'
    ) as { type: string; reason: string; laneId: string; attachmentGeneration: number } | undefined;
    expect(stop).toBeDefined();
    expect(stop?.reason).toBe('worker_switch');
    // The stop is addressed to the lane's REAL page identity — the same
    // laneId the start used — so the server resolves THAT lane's proposal.
    expect(stop?.laneId).toBe(result.current.laneId);
    expect(stop?.attachmentGeneration).toBe(0);
    unmount();
  });

  it('is a no-op (false, no frame) for a lane whose wire session never opened', () => {
    renderHook(() => useVoiceLiveLane({ workerSessionId: 'worker-B', factories }));
    let stopped: boolean | undefined;
    act(() => {
      stopped = stopVoiceLaneForWorkerSwitch('worker-B');
    });
    expect(stopped).toBe(false);
    expect(wire.frames).toHaveLength(0);
  });

  it('is a no-op (false, no frame) for a worker session this page does not hold', () => {
    let stopped: boolean | undefined;
    act(() => {
      stopped = stopVoiceLaneForWorkerSwitch('worker-never-mounted');
    });
    expect(stopped).toBe(false);
    expect(wire.frames).toHaveLength(0);
  });
});
