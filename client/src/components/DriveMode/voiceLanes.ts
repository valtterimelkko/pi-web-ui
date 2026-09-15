/**
 * voiceLanes — the in-page lane floor for ONE Voice Mode tab holding several
 * worker lanes (owner decision 2026-09-15: ONE TAB HOLDS THE LANES — no
 * cross-tab coordination, no BroadcastChannel, no server-side lane registry).
 *
 * Because every lane lives in this page, there is exactly one speech arbiter
 * and one operator floor. This coordinator owns the bookkeeping the arbiter
 * must not know about:
 *
 *   - ONE WRITER for the arbiter's floor signal. Each lane reports its own
 *     capture state here; the coordinator computes the union and writes the
 *     arbiter once. No lane's effect cycle or unmount can release ANOTHER
 *     lane's floor (§4.4 — a lane never starts speech over ANY lane's
 *     capture, and speech already playing ducks to 0.15 when capture begins).
 *   - CAPTURE HANDOFF. The tab has one microphone and one operator voice:
 *     at most one lane captures at a time. Taking the mic on another lane
 *     first stops (finalises) the current lane's capture — the operator's
 *     words are never dropped; they are relayed to the lane that holds the
 *     floor, exactly as if the operator had tapped that lane's own mic.
 *   - SPEECH ATTRIBUTION. Lane-scoped intent ids carry the worker session id
 *     (receipt-<session>, chat-<session>-…, ack-<session>-…), so the strip
 *     can show WHICH lane is talking (§4.2). Cross-lane queueing itself is
 *     the shared arbiter's tier-then-arrival order — arrival order IS
 *     waiting-time fairness (§4.4 rule 3: the lane that has waited longest
 *     speaks next).
 *   - OBSERVABILITY. Capture and handoff decisions land in the browser
 *     diagnostic ring (bounded, no session ids — the bundle's privacy rule).
 *
 * Cross-tab behaviour is deliberately absent: with one tab there is nothing
 * to coordinate with, and the shipped invariants (capture unconditional, the
 * operator's floor never interrupted) are enforced by the same arbiter as
 * before.
 */

import type { SpeechArbiter } from '../../lib/speechArbiter';
import { recordBrowserDiagnostic } from '../../lib/browserDiagnostics';

/** What a lane registers so its capture can be commanded by the coordinator
 *  (the handoff must reach the OTHER lane's dictation instance). */
export interface LaneCaptureControls {
  /** Finalise this lane's capture: stop, transcribe, relay verbatim to this
   *  lane's talker. Never drops the operator's words. */
  stopCapture: () => void;
}

export interface LaneFloorCoordinator {
  registerLane(laneId: string): void;
  unregisterLane(laneId: string): void;
  /** One lane's capture state (the operator floor for that lane). */
  setLaneCapture(laneId: string, capturing: boolean): void;
  /** Register/replace the capture controls for a lane. Returns an unregister
   *  function (the lane's cleanup). */
  setCaptureControls(laneId: string, controls: LaneCaptureControls): () => void;
  /** The lane currently capturing, if any. */
  capturingLaneId(): string | null;
  isAnyCapturing(): boolean;
  /** Handoff: the operator is taking the mic on `laneId`. Stops the OTHER
   *  lane's capture (finalising its words into its own talker). True when a
   *  stop was commanded. */
  yieldFloorTo(laneId: string): boolean;
  /** Which lane's speech intent is playing, by session-scoped id prefix. */
  laneOfSpeechIntent(): string | null;
  /** Strip re-render subscription. */
  subscribe(fn: () => void): () => void;
  dispose(): void;
}

export function createLaneFloorCoordinator(arbiter: SpeechArbiter): LaneFloorCoordinator {
  /** Lanes currently mounted on this surface. */
  const lanes = new Set<string>();
  /** Per-lane capture state. At most one true at a time in practice; the map
   *  keeps the accounting honest through mount/unmount races. */
  const capturing = new Map<string, boolean>();
  const controls = new Map<string, LaneCaptureControls>();
  const listeners = new Set<() => void>();

  const notify = () => {
    listeners.forEach((fn) => fn());
  };

  const observe = (operation: string, detail: string) => {
    try {
      recordBrowserDiagnostic({ kind: 'speech', operation, state: detail });
    } catch {
      /* observation must never break scheduling */
    }
  };

  const recomputeFloor = () => {
    const any = [...capturing.values()].some(Boolean);
    arbiter.setOperatorSpeaking(any);
  };

  const coordinator: LaneFloorCoordinator = {
    registerLane(laneId) {
      lanes.add(laneId);
      notify();
    },

    unregisterLane(laneId) {
      lanes.delete(laneId);
      if (capturing.get(laneId)) {
        capturing.set(laneId, false);
        recomputeFloor();
        observe('lane_floor_released', 'lane-unmounted');
      }
      controls.delete(laneId);
      notify();
    },

    setLaneCapture(laneId, capture) {
      const was = capturing.get(laneId) ?? false;
      if (was === capture) return;
      capturing.set(laneId, capture);
      recomputeFloor();
      // Same operations the arbiter records for the floor, prefixed `lane_`:
      // the arbiter's own floor_held/floor_released still fire for the union,
      // so the ring answers "why did speech duck?" both per lane and overall.
      observe(capture ? 'lane_floor_held' : 'lane_floor_released', 'capture');
      notify();
    },

    setCaptureControls(laneId, laneControls) {
      controls.set(laneId, laneControls);
      return () => {
        if (controls.get(laneId) === laneControls) controls.delete(laneId);
      };
    },

    capturingLaneId() {
      for (const [laneId, isCapturing] of capturing) {
        if (isCapturing) return laneId;
      }
      return null;
    },

    isAnyCapturing() {
      return coordinator.capturingLaneId() !== null;
    },

    yieldFloorTo(laneId) {
      const current = coordinator.capturingLaneId();
      if (!current || current === laneId) return false;
      const stop = controls.get(current)?.stopCapture;
      observe('lane_capture_handoff', 'floor-taken');
      if (stop) {
        stop();
        return true;
      }
      return false;
    },

    laneOfSpeechIntent() {
      const current = arbiter.getState().current?.id;
      if (!current) return null;
      // Lane-scoped intent ids carry the session id INSIDE them
      // (receipt-<session>, ack-<session>-<n>, chat-<session>-<n>). Longest
      // id wins so one session path that is a prefix of another cannot steal
      // the attribution.
      const ordered = [...lanes].sort((a, b) => b.length - a.length);
      for (const laneId of ordered) {
        if (current.includes(laneId)) return laneId;
      }
      return null;
    },

    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    dispose() {
      listeners.clear();
      lanes.clear();
      capturing.clear();
      controls.clear();
    },
  };

  return coordinator;
}

/** App-wide coordinator — every lane surface on this tab shares this one. */
// Created lazily by the module that also imports the arbiter singleton, so
// tests can build isolated coordinators against a fresh arbiter instance.
