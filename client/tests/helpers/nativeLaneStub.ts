/**
 * nativeLaneStub — a test seam for suites that pin the CASCADE fallback
 * behaviour of `DriveModeDictate` (native-primary, Phase 2).
 *
 * The main surface now binds the familiar controls to the NATIVE voice lane
 * and keeps the cascade talker as the EXPLICIT fallback only. Suites that
 * exercise the cascade path mock `useVoiceLiveLane` with this stub (the lane
 * reports `unavailable`, so the degraded state — and with it the explicit
 * fallback gesture — is offered), then activate the fallback before driving
 * the cascade path exactly as the shipped surface behaves in that state.
 */
import { fireEvent } from '@testing-library/react';
import type { VoiceLiveSurfaceState } from '../../src/lib/voiceLive/surface';

/** An inert surface whose lane can never be served. Everything is a no-op. */
export function makeUnavailableNativeLaneStub() {
  const state: VoiceLiveSurfaceState = {
    capture: 'idle',
    captureDetail: null,
    captureFaultReason: null,
    captureStats: null,
    playback: null,
    lastChime: null,
    captureFaults: [],
    playbackFaults: [],
    lane: { state: 'unavailable', detail: 'test stub: the native lane is not served here' },
    readBack: { state: 'idle', supported: false, variant: null, proposalId: null },
    controller: {
      lane: { laneId: 'stub-lane', attachmentGeneration: 0, workerSessionId: 'stub' },
      wireState: 'idle',
      captureMode: 'open-mic',
      readingLevel: 'summary',
      workerActivity: 'unknown',
      listeningSuspended: true,
      detail: null,
      operatorSpeaking: false,
      captions: [],
      proposal: null,
      parking: { items: [], operation: null },
      receipts: [],
      lastError: null,
      refusals: [],
      transportRefusals: [],
      pendingRequests: new Set<string>(),
    },
  } as unknown as VoiceLiveSurfaceState;
  const surface = {
    subscribe: () => () => {},
    getState: () => state,
    controller: {
      setCaptureMode: () => {},
      setReadingLevel: () => {},
      confirmProposal: () => {},
      cancelProposal: () => {},
      promoteParkedItem: () => {},
      requestParkingList: () => {},
      snapshot: () => state.controller,
    },
    startLane: () => 'unsupported' as const,
    startCapture: async () => 'error' as const,
    stopCapture: async () => {},
    beginPushToTalk: async () => 'error' as const,
    endPushToTalk: async () => {},
    readBackProposal: async () => 'unsupported' as const,
    // The shipped surface grew the host-controlled read-back switch (H2/K);
    // suites that pin the cascade fallback must expose it too, or the
    // component throws on mount and every legacy assertion fails on the
    // TypeError instead of its own subject.
    setAutoReadBackActive: (_active: boolean) => {},
    retryLane: () => {},
    teardownForUnmount: async () => {},
    armController: () => () => {},
    onWireMessage: () => 'refused' as const,
    playDeliveredChime: () => null,
    playNotDeliveredChime: () => {},
    stopPlayback: () => {},
  };
  return { surface, laneId: 'stub-lane' };
}

/** The hook replacement for `vi.mock('../../../.../useVoiceLiveLane', ...)`. */
export async function useVoiceLiveLaneStubModule() {
  const { makeUnavailableNativeLaneStub } = await import('./nativeLaneStub');
  return { useVoiceLiveLane: makeUnavailableNativeLaneStub };
}

/**
 * Engage the EXPLICIT cascade fallback on a freshly rendered surface whose
 * native lane is (per the stub) unavailable. The degraded banner — and only
 * that banner — offers the gesture, mirroring the shipped explicitness.
 */
export function activateCascadeFallback(): void {
  const button = document.querySelector<HTMLButtonElement>(
    '[data-testid="voice-engine-fallback-activate"]',
  );
  if (!button) throw new Error('the fallback gesture was not offered — is the native lane stubbed unavailable?');
  fireEvent.click(button);
}
