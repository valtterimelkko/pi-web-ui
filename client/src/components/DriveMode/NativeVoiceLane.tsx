import { useState } from 'react';
import type { VoiceRuntime } from '@pi-web-ui/shared';
import { useVoiceLiveLane } from '../../hooks/useVoiceLiveLane';
import { DriveModeVoiceLive } from './DriveModeVoiceLive';

/**
 * NativeVoiceLane — where the native voice lane lives in the app (M7).
 *
 * The surface (`DriveModeVoiceLive`) was delivered wired to nothing but the dev
 * lab, so the operator could not reach it. This is the mount: one lane for the
 * worker session its Drive Mode surface belongs to, on the app's own socket.
 *
 * Three deliberate choices, all about not damaging the Drive Mode that ships
 * and not lying about what the lane can do:
 *
 *   - it is CLOSED by default. Opening the native lane takes the microphone on
 *     its own explicit control, and a closed lane cannot surprise the operator
 *     with a second capture path competing with the mic they are already using.
 *     The header names what it is, so nothing is hidden behind the disclosure.
 *   - the lane only exists for a runtime the VOICE WIRE serves. The wire's
 *     runtime union is `pi | claude | antigravity` and the server defaults a
 *     missing runtime to `pi`; silently pointing an OpenCode session at the pi
 *     delivery path would mislabel the worker. When the caller knows the
 *     session's runtime is not served, the lane says so instead of guessing.
 *   - a lane that cannot start says so itself (see `DriveModeVoiceLive`): the
 *     surface's honest unavailable state names the host's or the server's own
 *     reason, and a failed start never reaches the rest of this screen.
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
        Native voice lane
        <span className="ml-auto text-[11px]">{open ? 'Hide' : 'Open'}</span>
      </button>
      {!open && (
        <p
          className="mt-1.5 text-[11px] text-content-muted dark:text-content-muted-dark"
          data-testid="native-voice-lane-summary"
        >
          One lane for this worker, on this page's own voice protocol. Nothing starts until you open it and press
          Start listening.
        </p>
      )}
      {open && (
        <div className="mt-2" data-testid="native-voice-lane-surface">
          <DriveModeVoiceLive surface={surface} {...(workerLabel ? { workerLabel } : {})} />
        </div>
      )}
    </section>
  );
}
