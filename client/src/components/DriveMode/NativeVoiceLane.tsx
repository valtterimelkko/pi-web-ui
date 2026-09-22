import { useState } from 'react';
import type { VoiceRuntime } from '@pi-web-ui/shared';
import { useVoiceLiveLane } from '../../hooks/useVoiceLiveLane';
import { DriveModeVoiceLive } from './DriveModeVoiceLive';

/**
 * NativeVoiceLane — the free (live-model) lane, kept below the bounded main UI.
 *
 * The operator asked (2026-09-22) for the pre-`ff75d0c4` arrangement back: the
 * bounded, gated voice controls on top, this free lane at the bottom, collapsed
 * by default. It is the same live surface as before, now the place where the
 * model-driven relay is reached, and it teaches the one new contract — say
 * "relay to worker" and the talker will show you exactly what it will send.
 *
 * Three deliberate choices, all about not damaging the bounded main surface and
 * not lying about what the lane can do:
 *
 *   - it is CLOSED by default. Opening the free lane takes the microphone on its
 *     own explicit control, and a closed lane cannot surprise the operator with a
 *     second capture path competing with the mic they are already using.
 *   - the lane only exists for a runtime the VOICE WIRE serves.
 *   - a lane that cannot start says so itself (see `DriveModeVoiceLive`).
 */
export interface NativeVoiceLaneProps {
  /** The worker session this lane attaches to. */
  sessionId: string;
  /** The runtime the voice wire serves for this session. Absent = not served. */
  runtime?: VoiceRuntime;
  /** The session's runtime as the app knows it, for the honest message only. */
  sessionRuntime?: string | null;
  /** Shown in the surface's own header (the worker this lane talks to). */
  workerLabel?: string;
}

export function NativeVoiceLane(props: NativeVoiceLaneProps) {
  if (!props.runtime) {
    return (
      <section
        className="mt-4 w-full max-w-md"
        data-testid="native-voice-lane"
        aria-label="Native voice lane"
        data-runtime-served="false"
      >
        <p
          className="text-[11px] leading-relaxed text-content-muted dark:text-content-muted-dark"
          data-testid="native-voice-lane-runtime-unavailable"
        >
          Native voice lane is not available for {props.sessionRuntime ?? 'this'} sessions yet. Voice Mode's
          existing microphone path below is unaffected.
        </p>
      </section>
    );
  }
  return <NativeVoiceLaneMounted {...props} runtime={props.runtime} />;
}

function NativeVoiceLaneMounted({
  sessionId,
  runtime,
  workerLabel,
}: NativeVoiceLaneProps & { runtime: VoiceRuntime }) {
  const [open, setOpen] = useState(false);
  const { surface, laneId } = useVoiceLiveLane({ workerSessionId: sessionId, runtime });

  return (
    <section
      className="mt-4 w-full max-w-md"
      data-testid="native-voice-lane"
      data-lane-id={laneId}
      data-runtime-served="true"
      aria-label="Native voice lane"
    >
      <button
        type="button"
        data-testid="native-voice-lane-toggle"
        aria-expanded={open}
        className="inline-flex w-full items-center gap-1.5 rounded-lg border border-outline-default dark:border-outline-default-dark px-3 py-2 text-xs font-medium text-content-muted dark:text-content-muted-dark"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? '▾' : '▸'}
        Free lane — live talker
        <span className="ml-auto text-[11px]">{open ? 'Hide' : 'Open'}</span>
      </button>
      {!open && (
        <p
          className="mt-1.5 text-[11px] text-content-muted dark:text-content-muted-dark"
          data-testid="native-voice-lane-summary"
        >
          Talk to the live talker in a free conversation. Say “relay to worker” and then your message to send
          something to the worker — it shows you the words first, and nothing goes until you approve.
        </p>
      )}
      {open && (
        <div className="mt-2" data-testid="native-voice-lane-surface">
          <DriveModeVoiceLive surface={surface} {...(workerLabel ? { workerLabel } : {})} />
          {/* The relay contract, taught where the operator speaks (display only). */}
          <p
            data-testid="native-voice-lane-hint"
            className="mt-2 text-center text-[11px] leading-relaxed text-content-muted dark:text-content-muted-dark"
          >
            Say <span className="font-medium">“relay to worker”</span> and then your message — the talker shows you
            the words it will send, and nothing goes until you approve.
          </p>
        </div>
      )}
    </section>
  );
}
