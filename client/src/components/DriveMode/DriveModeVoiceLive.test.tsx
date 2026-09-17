import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  VOICE_WIRE_VERSION,
  type VoiceClientMessage,
  type VoiceReceiptEventMessage,
} from '@pi-web-ui/shared';
import { createSpeechArbiter } from '../../lib/speechArbiter';
import { VoiceLiveSurface, type VoiceLiveSurfaceFactories } from '../../lib/voiceLive/surface';
import { createVoiceLane } from '../../lib/voiceLive/messages';
import type { CaptureActivityReport, CaptureSession, StartCaptureSessionOptions } from '../../lib/voiceLive/captureSession';
import type { PlaybackBackend, ScheduledHandle } from '../../lib/voiceLive/playbackSession';
import { DriveModeVoiceLive } from './DriveModeVoiceLive';

const LANE = createVoiceLane({ workerSessionId: 'worker-9', nonce: 'ui1' });

function makeSurface(options: { failMic?: boolean } = {}) {
  const frames: VoiceClientMessage[] = [];
  const activity: Array<(report: CaptureActivityReport) => void> = [];
  const counters = { captureStops: 0 };
  const backend: PlaybackBackend = {
    currentTime: () => 0,
    schedule: (): ScheduledHandle => ({ stop() {} }),
    setVolumeAt() {},
    setVolumeNow() {},
    stopAll() {},
    currentVolume: () => 1,
  };
  const gain = () => ({
    gain: { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {} },
    connect() {},
    disconnect() {},
  });
  const fakeContext = {
    state: 'running',
    currentTime: 0,
    destination: {},
    audioWorklet: { addModule: async () => undefined },
    createGain: gain,
    createOscillator: () => ({ type: 'sine', frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} }),
    resume: async () => undefined,
    close: async () => undefined,
  } as unknown as AudioContext;
  const factories: VoiceLiveSurfaceFactories = {
    createAudioContext: () => fakeContext,
    createPlaybackBackend: () => backend,
    getUserMedia: async () => {
      if (options.failMic) throw new Error('NotAllowedError: permission denied');
      return { getAudioTracks: () => [{ stop() {} }] } as unknown as MediaStream;
    },
    startCaptureSession: async (opts: StartCaptureSessionOptions) => {
      activity.push(opts.onActivity ?? (() => {}));
      const session: CaptureSession = {
        inputRate: 48_000,
        stop: async () => {
          counters.captureStops += 1;
        },
        flush() {},
        stats: () => ({ framesProduced: 0, chunksSent: 0, chunksDropped: 0, speaking: false, pendingChunks: 0 }),
      };
      return session;
    },
  };
  const surface = new VoiceLiveSurface({
    lane: LANE,
    send: (frame) => void frames.push(frame),
    arbiter: createSpeechArbiter(),
    factories,
  });
  return { surface, frames, activity, counters };
}

function env(type: string, extra: Record<string, unknown> = {}): unknown {
  return {
    type,
    version: VOICE_WIRE_VERSION,
    laneId: LANE.laneId,
    attachmentGeneration: LANE.attachmentGeneration,
    ...extra,
  };
}

describe('DriveModeVoiceLive', () => {
  it('starts honest: not listening, with a start control and the typed fallback named', () => {
    const { surface } = makeSurface();
    render(<DriveModeVoiceLive surface={surface} workerLabel="worker-9" />);
    expect(screen.getByTestId('voice-live-listening-state').getAttribute('data-listening')).toBe('false');
    expect(screen.getByTestId('voice-live-listening-state').textContent).toContain('Not listening yet');
    expect(screen.getByTestId('voice-live-start')).toBeTruthy();
    expect(screen.getByTestId('voice-live-typed-fallback').textContent).toContain('never carries your words');
  });

  it('defaults to open mic and says so once listening', async () => {
    const { surface } = makeSurface();
    render(<DriveModeVoiceLive surface={surface} />);
    expect(
      (screen.getByTestId('voice-live-mode-open-mic') as HTMLButtonElement).getAttribute('aria-checked'),
    ).toBe('true');
    fireEvent.click(screen.getByTestId('voice-live-start'));
    await waitFor(() =>
      expect(screen.getByTestId('voice-live-listening-state').getAttribute('data-listening')).toBe('true'),
    );
    expect(screen.getByTestId('voice-live-listening-state').textContent).toContain('open mic');
  });

  it('never claims to listen when the microphone was refused', async () => {
    const { surface } = makeSurface({ failMic: true });
    render(<DriveModeVoiceLive surface={surface} />);
    fireEvent.click(screen.getByTestId('voice-live-start'));
    await waitFor(() =>
      expect(screen.getByTestId('voice-live-listening-state').getAttribute('data-capture')).toBe('error'),
    );
    const text = screen.getByTestId('voice-live-listening-state').textContent ?? '';
    expect(text).toContain('Microphone unavailable');
    expect(text).toContain('permission denied');
    expect(text).toContain('Push-to-talk and typing still work');
    expect(screen.getByTestId('voice-live-start')).toBeTruthy(); // retryable
  });

  it('shows the honest suspended state after an explicit pause', async () => {
    const { surface, counters } = makeSurface();
    render(<DriveModeVoiceLive surface={surface} />);
    fireEvent.click(screen.getByTestId('voice-live-start'));
    await waitFor(() => expect(screen.getByTestId('voice-live-stop')).toBeTruthy());
    fireEvent.click(screen.getByTestId('voice-live-stop'));
    await waitFor(() =>
      expect(screen.getByTestId('voice-live-listening-state').getAttribute('data-capture')).toBe('suspended'),
    );
    expect(screen.getByTestId('voice-live-listening-state').textContent).toContain('Listening suspended');
    expect(counters.captureStops).toBe(1);
  });

  it('offers push-to-talk as a fallback mode, keeping capture running only while held', async () => {
    const { surface } = makeSurface();
    render(<DriveModeVoiceLive surface={surface} />);
    fireEvent.click(screen.getByTestId('voice-live-mode-push-to-talk'));
    expect(
      (screen.getByTestId('voice-live-mode-push-to-talk') as HTMLButtonElement).getAttribute('aria-checked'),
    ).toBe('true');
    // Switching capture mode restarts the lane's session on the wire (pinned
    // in the controller tests); here we only need the held-to-talk behaviour.
    const holdButton = await screen.findByTestId('voice-live-push-to-talk');
    fireEvent.pointerDown(holdButton);
    await waitFor(() => expect(screen.getByTestId('voice-live-listening-state').getAttribute('data-listening')).toBe('true'));
    fireEvent.pointerUp(holdButton);
    await waitFor(() => expect(screen.getByTestId('voice-live-listening-state').getAttribute('data-listening')).toBe('false'));
  });

  it('renders the live proposal as a card and confirms through the surface', async () => {
    const { surface, frames } = makeSurface();
    render(<DriveModeVoiceLive surface={surface} />);
    surface.onWireMessage(
      env('proposal_created', {
        proposal: {
          proposalId: 'prop-5',
          version: 2,
          sha256: 'f'.repeat(64),
          promotionRoute: 'parked_item',
          sourceItemId: 'item-7',
          original: 'ask about the retry',
          tidied: 'ask about the retry',
          presentedVariant: 'tidied',
          presentation: { completed: true },
        },
      }),
    );
    const card = await screen.findByTestId('proposal-card');
    expect(card.getAttribute('data-proposal-id')).toBe('prop-5');
    fireEvent.click(screen.getByTestId('proposal-confirm'));
    await waitFor(() => expect(frames.some((frame) => frame.type === 'proposal_confirm')).toBe(true));
    const confirm = frames.find((frame) => frame.type === 'proposal_confirm') as { proposalId: string };
    expect(confirm.proposalId).toBe('prop-5');
  });

  it('renders parked items and promotes one at a time through the surface', async () => {
    const { surface, frames } = makeSurface();
    render(<DriveModeVoiceLive surface={surface} />);
    surface.onWireMessage(
      env('parking_updated', {
        operation: 'listed',
        items: [
          { itemId: 'item-1', text: 'first', createdAtMs: 1 },
          { itemId: 'item-2', text: 'second', createdAtMs: 2 },
        ],
      }),
    );
    await screen.findByTestId('parking-lot');
    fireEvent.click(screen.getByTestId('parking-promote-item-2'));
    await waitFor(() => expect(frames.some((frame) => frame.type === 'parking_promote')).toBe(true));
    const promote = frames.filter((frame) => frame.type === 'parking_promote');
    expect(promote).toHaveLength(1);
    expect((promote[0] as { itemId: string }).itemId).toBe('item-2');
  });

  it('shows the delivered chime only for a delivered receipt', async () => {
    const { surface } = makeSurface();
    const { unmount } = render(<DriveModeVoiceLive surface={surface} />);
    surface.onWireMessage(env('proposal_resolved', { proposalId: 'p', outcome: 'released' }));
    expect(screen.queryByTestId('voice-live-chime')).toBeNull();
    unmount();

    const second = makeSurface();
    render(<DriveModeVoiceLive surface={second.surface} />);
    const receipt: VoiceReceiptEventMessage = env('receipt_event', {
      receipt: { releaseId: 'rel', proposalId: 'p', idempotencyKey: 'k', outcome: 'delivered', atMs: 1 },
    }) as VoiceReceiptEventMessage;
    second.surface.onWireMessage(receipt);
    await waitFor(() =>
      expect(screen.getByTestId('voice-live-chime').getAttribute('data-chime')).toBe('delivered'),
    );
  });

  it('surfaces a refusal instead of swallowing it', async () => {
    const { surface } = makeSurface();
    render(<DriveModeVoiceLive surface={surface} />);
    surface.onWireMessage({ ...(env('voice_state', { state: 'live' }) as object), laneId: 'someone-else' });
    await waitFor(() => expect(screen.getByTestId('voice-live-refusal')).toBeTruthy());
    expect(screen.getByTestId('voice-live-refusal').textContent).toContain('another lane');
  });

  it('changes reading level through the typed operation, never free text', async () => {
    const { surface, frames } = makeSurface();
    render(<DriveModeVoiceLive surface={surface} />);
    fireEvent.click(screen.getByTestId('voice-live-level-headlines'));
    await waitFor(() => expect(frames.some((frame) => frame.type === 'voice_reading_level')).toBe(true));
    const level = frames.find((frame) => frame.type === 'voice_reading_level') as { level: string };
    expect(level.level).toBe('headlines');
  });
});
