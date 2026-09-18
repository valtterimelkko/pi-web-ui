/**
 * voiceLive/readBack — speaking one proposal's composed bytes aloud, locally.
 *
 * Contract §4.3/§4.6 and intent §18.2 make "the operator heard the actual
 * bytes" part of what a confirmation authorises. The surfacing rule the review
 * (H3) found broken was not the absence of a read-back — it was that
 * "presented" meant "the button was clicked". This module is the honest
 * replacement: it owns the *playback*, and it is the only place that can say
 * whether the utterance finished, was interrupted, or never started.
 *
 * Properties it holds:
 *   - the text handed to the speaker is the retained release text of the
 *     variant being read, verbatim (never re-summarised here);
 *   - the outcome is reported from the playback's own lifecycle
 *     (`onend` / `onerror` / `cancel`), never optimistically;
 *   - an interrupted read-back reports where it stopped (the last boundary
 *     character offset), which is the narrowing `stoppedAtChar` the wire wants;
 *   - a host with no speech synthesis is reported as unsupported rather than
 *     silently "completing" a read-back that never happened.
 *
 * It is framework-free and side-effect-free apart from the synthesis it is
 * asked to perform, so the wiring above it can be unit-tested with a fake.
 */

/** How one read-back attempt ended. */
export type ReadBackOutcome =
  /** The utterance ran to its end. */
  | 'completed'
  /** Playback was stopped or errored before the end. */
  | 'interrupted'
  /** This host has no speech synthesis at all. */
  | 'unsupported'
  /** There was no live proposal to read (or a newer one replaced it). */
  | 'no-proposal';

export interface ReadBackSpeech {
  /** The composed bytes, verbatim. */
  readonly text: string;
  /** Playback reached the end of the utterance. */
  onEnd: () => void;
  /** Playback failed or was stopped; `reason` is the host's own word for it. */
  onError: (reason: string) => void;
  /** Where the voice had reached, in characters (from the host's boundary events). */
  onBoundary?: (charIndex: number) => void;
}

/**
 * The host's speech synthesiser, reduced to what a read-back needs. Implemented
 * over `window.speechSynthesis` in the browser and injected in tests.
 */
export interface ReadBackSpeaker {
  /** False when this host cannot speak at all (no `speechSynthesis`). */
  readonly supported: boolean;
  /** Begin one utterance. Returns false when the host refused to start it. */
  speak(speech: ReadBackSpeech): boolean;
  /** Stop whatever is speaking. Idempotent. */
  cancel(): void;
}

/**
 * The browser implementation: `window.speechSynthesis` + `SpeechSynthesisUtterance`.
 *
 * Deliberately minimal: no voice selection, no rate/pitch games (the operator's
 * own device defaults), and no reliance on `speechSynthesis.speaking` — the
 * utterance's own callbacks are the only authority, so a stub/patched synthesis
 * behaves exactly like a real one as far as this module is concerned.
 */
export function createBrowserReadBackSpeaker(): ReadBackSpeaker {
  const host = typeof window !== 'undefined'
    ? (window as unknown as {
        speechSynthesis?: {
          speak?: (utterance: unknown) => void;
          cancel?: () => void;
        };
        SpeechSynthesisUtterance?: new (text: string) => {
          text: string;
          onend: (() => void) | null;
          onerror: ((event: { error?: string }) => void) | null;
          onboundary: ((event: { charIndex?: number }) => void) | null;
        };
      })
    : undefined;
  const synthesis = host?.speechSynthesis;
  const Utterance = host?.SpeechSynthesisUtterance;
  if (typeof synthesis?.speak !== 'function' || typeof Utterance !== 'function') {
    return {
      supported: false,
      speak: () => false,
      cancel: () => undefined,
    };
  }
  const speakFn = synthesis.speak.bind(synthesis);
  const cancelFn = typeof synthesis.cancel === 'function' ? synthesis.cancel.bind(synthesis) : null;

  return {
    supported: true,
    speak(speech) {
      const utterance = new Utterance(speech.text);
      utterance.text = speech.text;
      utterance.onend = () => speech.onEnd();
      utterance.onerror = (event) => speech.onError(event?.error ?? 'speech_error');
      if (speech.onBoundary) {
        const onBoundary = speech.onBoundary;
        utterance.onboundary = (event) => {
          if (typeof event?.charIndex === 'number') onBoundary(event.charIndex);
        };
      }
      try {
        // A host that is already speaking would queue behind it; a read-back is
        // the current utterance or nothing.
        cancelFn?.();
        speakFn(utterance);
      } catch {
        return false;
      }
      return true;
    },
    cancel() {
      try {
        cancelFn?.();
      } catch {
        /* cancelling an idle host must never throw at the caller */
      }
    },
  };
}
