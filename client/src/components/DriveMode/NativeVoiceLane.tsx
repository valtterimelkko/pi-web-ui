import type { VoiceRuntime } from '@pi-web-ui/shared';
import { useVoiceLiveLane } from '../../hooks/useVoiceLiveLane';
import { DriveModeVoiceLive } from './DriveModeVoiceLive';

/**
 * NativeVoiceLane — the live talker, as the main voice lane.
 *
 * 2026-09-22 (owner directive): the native live model is the talker, so this is
 * no longer an optional, collapsed second surface. It mounts expanded:
 *
 *   - the live surface is the main lane. The operator starts the microphone
 *     with its own control; nothing is captured or started until they do, so an
 *     unstarted lane opens no provider session and no microphone.
 *   - the old collapse disclosure (the "free lane") was removed — it named the
 *     same model twice.
 *   - the legacy cascade microphone path remains rendered below as the explicit
 *     fallback; the lane's own honest `unavailable` state names when it serves.
 *
 * The lane only exists for a runtime the VOICE WIRE serves. The wire's runtime
 * union is `pi | claude | antigravity` and the server defaults a missing runtime
 * to `pi`; silently pointing an OpenCode session at the pi delivery path would
 * mislabel the worker. When the caller knows the session's runtime is not
 * served, the lane says so instead of guessing.
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
        aria-label="Voice Mode"
        data-runtime-served="false"
      >
        <p
          className="text-[11px] leading-relaxed text-content-muted dark:text-content-muted-dark"
          data-testid="native-voice-lane-runtime-unavailable"
        >
          Voice Mode's live talker is not available for {props.sessionRuntime ?? 'this'} sessions yet. The fallback
          dictation path below is unaffected.
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
  const { surface, laneId } = useVoiceLiveLane({ workerSessionId: sessionId, runtime });

  return (
    <section
      className="w-full max-w-md"
      data-testid="native-voice-lane"
      data-lane-id={laneId}
      data-runtime-served="true"
      aria-label="Voice Mode live talker"
    >
      <DriveModeVoiceLive surface={surface} {...(workerLabel ? { workerLabel } : {})} />
      {/* The relay contract, taught where the operator speaks (display only: it
          changes no behaviour and grants nothing). */}
      <p
        data-testid="native-voice-lane-hint"
        className="mt-2 text-center text-[11px] leading-relaxed text-content-muted dark:text-content-muted-dark"
      >
        Talk to it freely and ask about the work. To send something to the worker, say{' '}
        <span className="font-medium">“relay to worker”</span> and then your message — it shows you the words it will
        send, and nothing goes until you approve.
      </p>
    </section>
  );
}
