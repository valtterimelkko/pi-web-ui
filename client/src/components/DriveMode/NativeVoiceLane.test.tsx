import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { VOICE_WIRE_VERSION } from '@pi-web-ui/shared';

const mocks = vi.hoisted(() => ({
  sent: [] as unknown[],
}));

vi.mock('../../lib/websocket', () => ({
  getWebSocketClient: () => ({
    send: (frame: unknown) => {
      mocks.sent.push(frame);
      return 'sent';
    },
  }),
}));

import { emitVoiceFrame, voiceLaneRegistrationCount } from '../../lib/voiceLive/frameBus';
import { NativeVoiceLane } from './NativeVoiceLane';

/**
 * jsdom has no microphone; the lane's honest capability check would (correctly)
 * report "unsupported". These tests substitute the capture API the same way the
 * ducking lab substitutes the operating system's device, so the mounted lane is
 * exercised as a real one.
 */
function installFakeCaptureApi(): void {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async () => ({ getAudioTracks: () => [{ stop() {} }] }),
    },
  });
}

beforeEach(() => {
  mocks.sent.length = 0;
  installFakeCaptureApi();
});

function laneIdFromDom(): string {
  const id = screen.getByTestId('native-voice-lane').getAttribute('data-lane-id');
  if (!id) throw new Error('the mounted lane has no laneId');
  return id;
}

function serverFrame(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type,
    version: VOICE_WIRE_VERSION,
    laneId: laneIdFromDom(),
    attachmentGeneration: 0,
    ...extra,
  };
}

describe('NativeVoiceLane — the live talker is the main lane (2026-09-22)', () => {
  it('mounts the real surface directly, with no separate free-lane toggle and no frames sent', () => {
    render(<NativeVoiceLane sessionId="worker-7" runtime="pi" workerLabel="worker-7" />);
    // The live surface IS the lane, mounted; nothing is behind a disclosure...
    expect(screen.getByTestId('drive-mode-voice-live')).toBeTruthy();
    expect(screen.queryByTestId('native-voice-lane-toggle')).toBeNull();
    expect(screen.queryByTestId('native-voice-lane-summary')).toBeNull();
    // ...and the relay contract is taught where the operator speaks.
    expect(screen.getByTestId('native-voice-lane-hint').textContent).toContain('relay to worker');
    // Nothing starts, and no frame can have been sent, until the operator does.
    expect(mocks.sent).toHaveLength(0);
  });

  it('sends the lane frame on the app socket when the operator starts listening', async () => {
    render(<NativeVoiceLane sessionId="worker-7" runtime="pi" />);
    const laneId = laneIdFromDom();
    fireEvent.click(await screen.findByTestId('voice-live-start'));

    await waitFor(() =>
      expect(mocks.sent.some((frame) => (frame as { type?: string }).type === 'voice_session_start')).toBe(true),
    );
    const start = mocks.sent.find(
      (frame) => (frame as { type?: string }).type === 'voice_session_start',
    ) as { workerSessionId?: string; laneId?: string };
    expect(start.workerSessionId).toBe('worker-7');
    expect(start.laneId).toBe(laneId);
  });

  it('routes server frames for its lane from the socket tap into the surface', async () => {
    render(<NativeVoiceLane sessionId="worker-7" runtime="pi" />);
    await screen.findByTestId('drive-mode-voice-live');

    // The app's single socket tap offers every frame; only this lane's are ours.
    const mine = serverFrame('voice_state', { state: 'live' });
    expect(emitVoiceFrame(mine)).toBe(true);
    expect(emitVoiceFrame({ ...mine, laneId: 'other:lane' })).toBe(true);

    await waitFor(() =>
      expect(screen.getByTestId('voice-live-wire-state').getAttribute('data-state')).toBe('live'),
    );
  });

  it('renders the honest unavailable state when the lane cannot be served', async () => {
    render(<NativeVoiceLane sessionId="worker-7" runtime="pi" />);
    await screen.findByTestId('drive-mode-voice-live');

    emitVoiceFrame(
      serverFrame('voice_error', {
        code: 'voice_provider_unavailable',
        message: 'live voice is disabled on this server (VOICE_MODE_ENGINE=cascade)',
        fatal: true,
      }),
    );

    const panel = await screen.findByTestId('voice-live-unavailable');
    expect(panel.getAttribute('data-reason')).toBe('unavailable');
    expect(screen.getByTestId('voice-live-unavailable-detail').textContent).toContain('cascade');
    // The surface is still there, in place: the failure did not take the lane
    // (or anything around it) down.
    expect(screen.getByTestId('drive-mode-voice-live')).toBeTruthy();
  });

  it('registers its lane while mounted and releases it on unmount', async () => {
    const { unmount } = render(<NativeVoiceLane sessionId="worker-7" runtime="pi" />);
    expect(voiceLaneRegistrationCount()).toBe(1);
    unmount();
    expect(voiceLaneRegistrationCount()).toBe(0);
  });

  it('keeps the lane identity stable for the same worker across remounts', () => {
    const first = render(<NativeVoiceLane sessionId="worker-7" runtime="pi" />);
    const firstLaneId = laneIdFromDom();
    expect(firstLaneId.startsWith('worker-7:')).toBe(true);
    first.unmount();

    render(<NativeVoiceLane sessionId="worker-7" runtime="pi" />);
    expect(laneIdFromDom()).toBe(firstLaneId);

    // A different worker is a different lane.
    const other = render(<NativeVoiceLane sessionId="worker-8" runtime="claude" />);
    const laneIds = screen.getAllByTestId('native-voice-lane').map((node) => node.getAttribute('data-lane-id'));
    expect(new Set(laneIds).size).toBe(2);
    other.unmount();
  });
});

describe('NativeVoiceLane — a runtime the voice wire does not serve is named, not guessed', () => {
  it('does not create a lane for a session whose runtime the wire cannot serve', () => {
    render(<NativeVoiceLane sessionId="worker-9" sessionRuntime="opencode" />);
    const lane = screen.getByTestId('native-voice-lane');
    expect(lane.getAttribute('data-runtime-served')).toBe('false');
    expect(screen.getByTestId('native-voice-lane-runtime-unavailable').textContent).toContain('opencode');
    // No lane was created, so nothing can be addressed to the wrong runtime.
    expect(screen.queryByTestId('native-voice-lane-toggle')).toBeNull();
    expect(voiceLaneRegistrationCount()).toBe(0);
    expect(mocks.sent).toHaveLength(0);
  });
});
