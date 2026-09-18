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
import type { ReadBackSpeech, ReadBackSpeaker } from '../../lib/voiceLive/readBack';
import type { CaptureActivityReport, CaptureSession, StartCaptureSessionOptions } from '../../lib/voiceLive/captureSession';
import type { PlaybackBackend, ScheduledHandle } from '../../lib/voiceLive/playbackSession';
import { DriveModeVoiceLive } from './DriveModeVoiceLive';
import { loadCaptureWorklet } from '../../lib/voiceLive/captureSession';

const LANE = createVoiceLane({ workerSessionId: 'worker-9', nonce: 'ui1' });

/** Read-back playback that only ends when the test says so (H3 evidence). */
class FakeReadBackSpeaker implements ReadBackSpeaker {
  readonly supported: boolean;
  readonly spoken: string[] = [];
  cancellations = 0;
  private pending: ReadBackSpeech | null = null;
  constructor(supported = true) {
    this.supported = supported;
  }
  speak(speech: ReadBackSpeech): boolean {
    if (!this.supported) return false;
    this.spoken.push(speech.text);
    this.pending = speech;
    return true;
  }
  cancel(): void {
    this.cancellations += 1;
    this.pending = null;
  }
  finish(): void {
    const speech = this.pending;
    this.pending = null;
    speech?.onEnd();
  }
  interrupt(reason = 'interrupted'): void {
    const speech = this.pending;
    this.pending = null;
    speech?.onError(reason);
  }
}

function makeSurface(options: { failMic?: boolean; failWorklet?: boolean } = {}) {
  return makeSurfaceWith(options);
}

function makeSurfaceWith(options: { failMic?: boolean; failWorklet?: boolean; readBack?: ReadBackSpeaker } = {}) {
  const speaker = new FakeReadBackSpeaker();
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
    audioWorklet: {
      addModule: async (url: string) => {
        if (options.failWorklet) throw new Error(`Failed to load module script: ${url}`);
      },
    },
    createGain: gain,
    createOscillator: () => ({ type: 'sine', frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} }),
    resume: async () => undefined,
    close: async () => undefined,
  } as unknown as AudioContext;
  const factories: VoiceLiveSurfaceFactories = {
    createAudioContext: () => fakeContext,
    createPlaybackBackend: () => backend,
    createReadBackSpeaker: () => options.readBack ?? speaker,
    getUserMedia: async () => {
      if (options.failMic) throw new Error('NotAllowedError: permission denied');
      return { getAudioTracks: () => [{ stop() {} }] } as unknown as MediaStream;
    },
    startCaptureSession: async (opts: StartCaptureSessionOptions) => {
      // Faithful to the real wiring: load the worklet exactly as production
      // does (same-origin asset first) before handing back a session, so a
      // worklet that will not load fails HERE, not silently.
      await loadCaptureWorklet(opts.context, {
        ...(opts.onFault ? { onFault: opts.onFault } : {}),
        ...(opts.workletUrls ? { workletUrls: opts.workletUrls } : {}),
      });
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
  return { surface, frames, activity, counters, speaker };
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

/** A proposal that has NOT been read back yet: the H3 starting point. */
function pendingProposal(overrides: Record<string, unknown> = {}): unknown {
  return env('proposal_created', {
    proposal: {
      proposalId: 'prop-9',
      version: 5,
      sha256: 'c'.repeat(64),
      promotionRoute: 'directed',
      original: 'ask it whether the retry handler drops the token',
      tidied: 'ask whether the retry handler drops the token',
      presentedVariant: 'tidied',
      presentation: { completed: false },
      ...overrides,
    },
  });
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
    // Push-to-talk drives the same capture path, and there is NO text input in
    // Voice Mode, so both halves of the old promise were false claims.
    expect(text).toContain('same microphone path');
    expect(text).toContain('Nothing was sent to the worker');
    expect(text).not.toContain('typing');
    expect(text).not.toContain('Push-to-talk and typing still work');
    expect(screen.getByTestId('voice-live-start')).toBeTruthy(); // retryable
  });

  it('names the worklet as the cause and never claims push-to-talk works', async () => {
    const { surface } = makeSurface({ failWorklet: true });
    render(<DriveModeVoiceLive surface={surface} />);
    fireEvent.click(screen.getByTestId('voice-live-mode-push-to-talk'));
    fireEvent.click(screen.getByTestId('voice-live-start'));
    await waitFor(() =>
      expect(screen.getByTestId('voice-live-listening-state').getAttribute('data-capture')).toBe('error'),
    );
    const text = screen.getByTestId('voice-live-listening-state').textContent ?? '';
    expect(text).toContain('capture worklet could not be loaded');
    expect(text).toContain('including push-to-talk');
    expect(text).not.toContain('typing');
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

describe('DriveModeVoiceLive — the read-back is real, and confirms the identity echo (H3)', () => {
  it('confirm disabled → read-back plays → playback ends → confirm enabled → confirm echoes the identity', async () => {
    const { surface, frames, speaker } = makeSurface();
    render(<DriveModeVoiceLive surface={surface} />);
    surface.onWireMessage(pendingProposal());

    const confirm = (await screen.findByTestId('proposal-confirm')) as HTMLButtonElement;
    expect(screen.getByTestId('proposal-card').getAttribute('data-presentation-status')).toBe('pending');
    expect(confirm.disabled).toBe(true);

    // Start the read-back: the composed bytes are spoken...
    fireEvent.click(screen.getByTestId('proposal-readback'));
    expect(speaker.spoken).toEqual(['ask whether the retry handler drops the token']);
    // ...and NOTHING has been reported: a click is not a presentation.
    expect(frames.some((frame) => frame.type === 'proposal_presentation')).toBe(false);
    expect(screen.getByTestId('proposal-readback').getAttribute('data-reading')).toBe('true');
    expect((screen.getByTestId('proposal-confirm') as HTMLButtonElement).disabled).toBe(true);

    // Playback completes: now (and only now) presentation is reported.
    speaker.finish();
    await waitFor(() =>
      expect(screen.getByTestId('proposal-card').getAttribute('data-presentation-status')).toBe('presented'),
    );
    const presentation = frames.find((frame) => frame.type === 'proposal_presentation');
    expect(presentation).toMatchObject({ completed: true, presentedVariant: 'tidied' });
    await waitFor(() => expect((screen.getByTestId('proposal-confirm') as HTMLButtonElement).disabled).toBe(false));

    // The typed confirm carries the proposalRef echo of the displayed identity.
    fireEvent.click(screen.getByTestId('proposal-confirm'));
    await waitFor(() => expect(frames.some((frame) => frame.type === 'proposal_confirm')).toBe(true));
    const confirmation = frames.find((frame) => frame.type === 'proposal_confirm');
    expect(confirmation).toMatchObject({
      proposalId: 'prop-9',
      proposalRef: { version: 5, sha256: 'c'.repeat(64) },
    });
  });

  it('reads back whichever variant is on screen, verbatim', async () => {
    const { surface, speaker } = makeSurface();
    render(<DriveModeVoiceLive surface={surface} />);
    surface.onWireMessage(pendingProposal());
    await screen.findByTestId('proposal-card');

    fireEvent.click(screen.getByTestId('proposal-variant-original'));
    fireEvent.click(screen.getByTestId('proposal-readback'));
    expect(speaker.spoken).toEqual(['ask it whether the retry handler drops the token']);
    speaker.finish();
    await waitFor(() =>
      expect(screen.getByTestId('proposal-card').getAttribute('data-presentation-status')).toBe('presented'),
    );
  });

  it('an interrupted read-back leaves the confirm refused and says where it stopped', async () => {
    const { surface, frames, speaker } = makeSurface();
    render(<DriveModeVoiceLive surface={surface} />);
    surface.onWireMessage(pendingProposal());

    fireEvent.click(await screen.findByTestId('proposal-readback'));
    speaker.interrupt('interrupted');
    await waitFor(() => expect(screen.getByTestId('voice-live-readback-interrupted')).toBeTruthy());
    expect(
      frames.some(
        (frame) => frame.type === 'proposal_presentation' && (frame as { completed: boolean }).completed === false,
      ),
    ).toBe(true);
    expect((screen.getByTestId('proposal-confirm') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('DriveModeVoiceLive — honest reachability (M7) and transport refusals (M8)', () => {
  it('renders the server\u2019s own reason when the live engine serves the lane elsewhere', async () => {
    const { surface } = makeSurface();
    render(<DriveModeVoiceLive surface={surface} workerLabel="worker-9" />);
    expect(screen.getByTestId('voice-live-start')).toBeTruthy();

    // Exactly what a cascade server answers a lane start with.
    const detail =
      'live voice is disabled on this server (VOICE_MODE_ENGINE=cascade); the push-to-talk cascade is now serving this lane';
    surface.onWireMessage(env('voice_state', { state: 'error', detail }));
    surface.onWireMessage(
      env('voice_error', { code: 'voice_provider_unavailable', message: detail, fatal: true }),
    );

    const panel = await screen.findByTestId('voice-live-unavailable');
    expect(panel.getAttribute('data-reason')).toBe('unavailable');
    expect(screen.getByTestId('voice-live-unavailable-detail').textContent).toContain(
      'VOICE_MODE_ENGINE=cascade',
    );
    // The lane offers an honest retry instead of a control that cannot work.
    expect(screen.getByTestId('voice-live-retry')).toBeTruthy();
    expect(screen.queryByTestId('voice-live-start')).toBeNull();
    expect(screen.getByTestId('voice-live-typed-fallback')).toBeTruthy();
  });

  it('starts the lane on the wire before capture, and explains a start that fails', async () => {
    const { surface, frames } = makeSurface();
    render(<DriveModeVoiceLive surface={surface} />);
    fireEvent.click(screen.getByTestId('voice-live-start'));
    // The lane is opened on the wire — the surface is genuinely reachable.
    await waitFor(() => expect(frames.some((frame) => frame.type === 'voice_session_start')).toBe(true));

    surface.onWireMessage(
      env('voice_error', { code: 'voice_provider_unavailable', message: 'no provider', fatal: true }),
    );
    const panel = await screen.findByTestId('voice-live-unavailable');
    expect(panel.getAttribute('data-reason')).toBe('unavailable');
    // A failed start must not leave the microphone open onto nothing.
    await waitFor(() => expect(surface.getState().capture).toBe('suspended'));
    expect(screen.getByTestId('voice-live-retry')).toBeTruthy();
  });

  it('shows the unavailable state in place, leaving the rest of the surface intact', async () => {
    const { surface } = makeSurface();
    render(<DriveModeVoiceLive surface={surface} />);
    surface.onWireMessage(
      env('voice_state', { state: 'error', detail: 'the live engine is unreachable' }),
    );
    await screen.findByTestId('voice-live-unavailable');
    // Nothing else on the surface was destroyed: the lane still names its worker
    // and the typed fallback is still reachable.
    expect(screen.getByTestId('drive-mode-voice-live')).toBeTruthy();
    expect(screen.getByTestId('voice-live-typed-fallback')).toBeTruthy();
  });

  it('renders a transport-level refusal that named no lane (M8)', async () => {
    const { surface } = makeSurface();
    render(<DriveModeVoiceLive surface={surface} />);
    surface.onWireMessage({
      type: 'voice_error',
      version: VOICE_WIRE_VERSION,
      laneId: '',
      attachmentGeneration: 0,
      code: 'voice_internal_error',
      message: 'Voice frame rate exceeded; the frame was dropped.',
      fatal: false,
    });
    const line = await screen.findByTestId('voice-live-transport-refusal');
    expect(line.getAttribute('data-code')).toBe('voice_internal_error');
    expect(line.textContent).toContain('Voice frame rate exceeded');
    // It is a transport notice, not a lane error and not a lane refusal.
    expect(screen.queryByTestId('voice-live-error')).toBeNull();
    expect(screen.queryByTestId('voice-live-refusal')).toBeNull();
  });
});

describe('DriveModeVoiceLive — the receipt verdict is visible and honest (N6)', () => {
  function receiptEnv(outcome: string, overrides: Record<string, unknown> = {}): VoiceReceiptEventMessage {
    return env('receipt_event', {
      receipt: {
        releaseId: 'rel-9',
        proposalId: 'prop-9',
        idempotencyKey: 'idem-9',
        outcome,
        atMs: 1,
        ...overrides,
      },
    }) as VoiceReceiptEventMessage;
  }

  it('renders a delivered verdict as the positive state, with the chime', async () => {
    const { surface } = makeSurface();
    render(<DriveModeVoiceLive surface={surface} />);
    surface.onWireMessage(receiptEnv('delivered', { mechanism: 'steer' }));

    const verdict = await screen.findByTestId('voice-live-receipt');
    expect(verdict.getAttribute('data-outcome')).toBe('delivered');
    expect(verdict.textContent).toContain('Delivered to the worker');
    expect(verdict.textContent).toContain('steer');
    // The trusted chime accompanies delivery (contract §8.1) — and only it.
    expect(screen.getByTestId('voice-live-chime').getAttribute('data-chime')).toBe('delivered');
  });

  it('renders queued as accepted but not yet handed over, with the disclosure', async () => {
    const { surface } = makeSurface();
    render(<DriveModeVoiceLive surface={surface} />);
    surface.onWireMessage(
      receiptEnv('queued', { disclosure: 'Antigravity queues this in the worker loop.' }),
    );

    const verdict = await screen.findByTestId('voice-live-receipt');
    expect(verdict.getAttribute('data-outcome')).toBe('queued');
    expect(verdict.textContent).toContain('not yet handed to the worker');
    expect(verdict.textContent).toContain('Antigravity queues this in the worker loop.');
    // Queued is NOT delivery: no chime, and nothing delivered-looking.
    expect(screen.queryByTestId('voice-live-chime')).toBeNull();
    expect(verdict.textContent?.toLowerCase()).not.toContain('delivered');
    expect(verdict.getAttribute('data-verdict-tone')).not.toBe('delivered');
  });

  it('renders refused with the server\u2019s own reason and never as delivery', async () => {
    const { surface } = makeSurface();
    render(<DriveModeVoiceLive surface={surface} />);
    surface.onWireMessage(receiptEnv('refused', { reason: 'the worker is not accepting frames' }));

    const verdict = await screen.findByTestId('voice-live-receipt');
    expect(verdict.getAttribute('data-outcome')).toBe('refused');
    expect(verdict.textContent).toContain('Refused');
    expect(verdict.textContent).toContain('the worker is not accepting frames');
    expect(screen.queryByTestId('voice-live-chime')).toBeNull();
    expect(verdict.textContent?.toLowerCase()).not.toContain('delivered');
    expect(verdict.getAttribute('data-verdict-tone')).not.toBe('delivered');
  });

  it('renders unknown as unconfirmed, naming the cause and the reconciliation', async () => {
    const { surface } = makeSurface();
    render(<DriveModeVoiceLive surface={surface} />);
    surface.onWireMessage(receiptEnv('unknown', { unknownCause: 'timeout', reconcile: true }));

    const verdict = await screen.findByTestId('voice-live-receipt');
    expect(verdict.getAttribute('data-outcome')).toBe('unknown');
    expect(verdict.getAttribute('data-reconcile')).toBe('true');
    expect(verdict.textContent).toContain('could not be confirmed');
    expect(verdict.textContent).toContain('timeout');
    expect(verdict.textContent).toContain('reconciled');
    // An unknown outcome must never look or read like a delivery.
    expect(screen.queryByTestId('voice-live-chime')).toBeNull();
    expect(verdict.textContent?.toLowerCase()).not.toContain('delivered');
    expect(verdict.getAttribute('data-verdict-tone')).not.toBe('delivered');
  });

  it('does not let an earlier delivered verdict stand for a newer, unconfirmed proposal', async () => {
    const { surface } = makeSurface();
    render(<DriveModeVoiceLive surface={surface} />);
    surface.onWireMessage(receiptEnv('delivered'));
    await screen.findByTestId('voice-live-receipt');

    // A new confirmation cycle begins: that verdict is history, not the current
    // state — a delivered figure beside a fresh confirm button would claim a
    // delivery that has not happened.
    surface.onWireMessage(
      env('proposal_created', {
        proposal: {
          proposalId: 'prop-next',
          version: 1,
          sha256: 'd'.repeat(64),
          promotionRoute: 'directed',
          original: 'ask about the lease',
          tidied: 'ask about the lease',
          presentedVariant: 'tidied',
          presentation: { completed: false },
        },
      }),
    );
    await waitFor(() => expect(screen.queryByTestId('voice-live-receipt')).toBeNull());
    expect(screen.queryByTestId('voice-live-chime')).toBeNull();

    // When the new cycle gets its own verdict, it is rendered honestly.
    surface.onWireMessage(
      receiptEnv('refused', { proposalId: 'prop-next', reason: 'that proposal is out of date' }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('voice-live-receipt').getAttribute('data-outcome')).toBe('refused'),
    );
    expect(screen.getByTestId('voice-live-receipt').textContent).toContain('that proposal is out of date');
  });

  it('replaces the verdict as each new receipt arrives, never leaving a delivered claim behind', async () => {
    const { surface } = makeSurface();
    render(<DriveModeVoiceLive surface={surface} />);
    surface.onWireMessage(receiptEnv('delivered'));
    await waitFor(() =>
      expect(screen.getByTestId('voice-live-receipt').getAttribute('data-outcome')).toBe('delivered'),
    );
    // A later, unconfirmed delivery must not leave the delivered state standing.
    surface.onWireMessage(receiptEnv('unknown', { unknownCause: 'disconnect', reconcile: true }));
    await waitFor(() =>
      expect(screen.getByTestId('voice-live-receipt').getAttribute('data-outcome')).toBe('unknown'),
    );
    expect(screen.getByTestId('voice-live-receipt').textContent?.toLowerCase()).not.toContain('delivered');
  });
});

describe('DriveModeVoiceLive — the honest lane-capacity refusal (N6/N9)', () => {
  function capacityRefusal(message: string): unknown {
    return env('voice_error', { code: 'voice_lane_capacity', message, fatal: false });
  }

  it('renders the lane-named capacity refusal with the server\u2019s own message', async () => {
    const { surface } = makeSurface();
    render(<DriveModeVoiceLive surface={surface} />);
    surface.onWireMessage(capacityRefusal('The voice lane table is full; try again shortly.'));

    const line = await screen.findByTestId('voice-live-error');
    expect(line.getAttribute('data-code')).toBe('voice_lane_capacity');
    expect(line.textContent).toContain('The voice lane table is full; try again shortly.');
    // It is a lane refusal, not a transport notice.
    expect(screen.queryByTestId('voice-live-transport-refusal')).toBeNull();
  });

  it('falls back to a local line when a lane refusal carries no message', async () => {
    const { surface } = makeSurface();
    render(<DriveModeVoiceLive surface={surface} />);
    surface.onWireMessage(capacityRefusal(''));

    const line = await screen.findByTestId('voice-live-error');
    expect(line.getAttribute('data-code')).toBe('voice_lane_capacity');
    expect(line.textContent).toContain('capacity');
    expect(line.textContent).toContain('try again');
  });
});
