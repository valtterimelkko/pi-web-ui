/**
 * useVoiceLiveLane — the app-side owner of one native voice lane (M7).
 *
 * Binds a `VoiceLiveSurface` to the page's single session socket:
 *   - outbound frames go through `frameBus.sendVoiceFrame` (the same socket
 *     every other frame uses);
 *   - inbound `voice_*` frames are routed from the socket tap to this lane by
 *     `laneId` (see `lib/voiceLive/frameBus.ts`);
 *   - the lane identity is stable for the lifetime of the PAGE, so re-mounting
 *     the same worker session (switching lanes, reopening Drive Mode) re-uses
 *     its lane instead of minting a new one on every mount.
 *
 * Nothing is opened until the operator actually starts the lane: constructing
 * the surface creates no AudioContext, sends no frame and starts no capture.
 * Unmount stops capture and releases the microphone.
 */

import { useEffect, useMemo } from 'react';
import type { VoiceClientMessage, VoiceRuntime } from '@pi-web-ui/shared';
import { speechArbiter } from '../lib/speechArbiter';
import { createVoiceLane, mintLaneNonce } from '../lib/voiceLive/messages';
import { registerVoiceLane, sendVoiceFrame } from '../lib/voiceLive/frameBus';
import { VoiceLiveSurface, type VoiceLiveSurfaceFactories } from '../lib/voiceLive/surface';

/** One nonce per page load: every lane on this page is distinguishable from the
 *  same lane in another tab, while remaining stable across re-mounts. */
const PAGE_LANE_NONCE = mintLaneNonce();

/** The native-voice surfaces this page currently holds, by laneId. Lane ids
 *  are minted only by `createVoiceLane` in this module, so a mounted worker
 *  session's lane is found deterministically — which is what lets the Drive
 *  Mode picker stop a lane by worker session id when it hands that lane to
 *  another worker (C24). */
const mountedSurfaces = new Map<string, VoiceLiveSurface>();

/**
 * The Drive Mode picker is handing `workerSessionId`'s lane to another worker
 * (contract §3.2, step 1): stop that lane's native session with reason
 * `worker_switch` so the server resolves any live proposal
 * (`proposal_resolved {replaced}`) and closes the provider session BEFORE the
 * swap. Must be called while the old lane's surface is still mounted — the
 * picker commits do exactly that. Returns false (and sends nothing) when the
 * lane is not mounted or its wire session was never opened.
 */
export function stopVoiceLaneForWorkerSwitch(workerSessionId: string): boolean {
  const laneId = createVoiceLane({ workerSessionId, nonce: PAGE_LANE_NONCE }).laneId;
  const surface = mountedSurfaces.get(laneId);
  if (!surface) return false;
  return surface.stopForWorkerSwitch();
}

export interface UseVoiceLiveLaneOptions {
  /** The worker session this lane is attached to. Must be non-empty. */
  workerSessionId: string;
  runtime?: VoiceRuntime;
  /** Test seam: replaced audio/capture/speech factories. */
  factories?: VoiceLiveSurfaceFactories;
  onRefusal?: (refusal: import('../lib/voiceLive/controller').VoiceLiveRefusal) => void;
}

export interface VoiceLiveLaneHandle {
  surface: VoiceLiveSurface;
  laneId: string;
}

export function useVoiceLiveLane(options: UseVoiceLiveLaneOptions): VoiceLiveLaneHandle {
  const { workerSessionId, runtime, factories, onRefusal } = options;

  const lane = useMemo(
    () =>
      createVoiceLane({
        workerSessionId,
        ...(runtime ? { runtime } : {}),
        nonce: PAGE_LANE_NONCE,
      }),
    [workerSessionId, runtime],
  );

  const surface = useMemo(
    () =>
      new VoiceLiveSurface({
        lane,
        arbiter: speechArbiter,
        // A frame that could not even be handed to the socket is a refusal the
        // controller records and the surface renders — never a silent drop.
        send: (frame: VoiceClientMessage) => {
          if (sendVoiceFrame(frame) === 'failed') {
            throw new Error('the session socket could not carry the voice frame');
          }
        },
        ...(factories ? { factories } : {}),
        ...(onRefusal ? { onRefusal } : {}),
      }),
    // `factories`/`onRefusal` are expected to be stable (or undefined) so the
    // surface is created once per lane.
    [lane, factories, onRefusal],
  );

  useEffect(() => {
    // The subscription is owned here, not only by the constructor: React
    // StrictMode mounts/cleans up/re-mounts in development, and the cleanup
    // must not leave the memoized surface deaf (2026-09-22).
    const disarm = surface.armController();
    mountedSurfaces.set(lane.laneId, surface);
    const unregister = registerVoiceLane(lane.laneId, (_frame, raw) => {
      surface.onWireMessage(raw);
    });
    return () => {
      unregister();
      disarm();
      if (mountedSurfaces.get(lane.laneId) === surface) mountedSurfaces.delete(lane.laneId);
      void surface.teardownForUnmount();
    };
  }, [lane.laneId, surface]);

  return { surface, laneId: lane.laneId };
}
