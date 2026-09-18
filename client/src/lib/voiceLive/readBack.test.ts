import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserReadBackSpeaker } from './readBack';

/**
 * The browser speaker is a thin adapter over the host's speech synthesis, so
 * these tests pin the adapter contract the surface depends on: `supported` is
 * honest, the utterance's own `onend`/`onerror`/`onboundary` are what it
 * forwards, and the text spoken is exactly the text it was given.
 */

interface FakeUtterance {
  text: string;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onboundary: ((event: { charIndex?: number }) => void) | null;
}

interface FakeSynthesis {
  spoken: string[];
  utterances: FakeUtterance[];
  cancellations: number;
}

function installFakeSynthesis(): FakeSynthesis {
  const fake: FakeSynthesis = { spoken: [], utterances: [], cancellations: 0 };
  class FakeSpeechSynthesisUtterance implements FakeUtterance {
    text: string;
    onend: (() => void) | null = null;
    onerror: ((event: { error?: string }) => void) | null = null;
    onboundary: ((event: { charIndex?: number }) => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  }
  vi.stubGlobal('SpeechSynthesisUtterance', FakeSpeechSynthesisUtterance);
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    writable: true,
    value: {
      speak(utterance: FakeUtterance) {
        fake.spoken.push(utterance.text);
        fake.utterances.push(utterance);
      },
      cancel() {
        fake.cancellations += 1;
      },
    },
  });
  return fake;
}

afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, 'speechSynthesis');
});

describe('createBrowserReadBackSpeaker', () => {
  it('is unsupported (and never claims to speak) when the host has no synthesis', () => {
    Reflect.deleteProperty(window, 'speechSynthesis');
    const speaker = createBrowserReadBackSpeaker();
    expect(speaker.supported).toBe(false);
    const onEnd = vi.fn();
    expect(speaker.speak({ text: 'hello', onEnd, onError: () => undefined })).toBe(false);
    expect(onEnd).not.toHaveBeenCalled();
    expect(() => speaker.cancel()).not.toThrow();
  });

  it('speaks the exact text and forwards the utterance end', () => {
    const fake = installFakeSynthesis();
    const speaker = createBrowserReadBackSpeaker();
    expect(speaker.supported).toBe(true);

    const onEnd = vi.fn();
    const started = speaker.speak({
      text: 'ask about the retry handler',
      onEnd,
      onError: () => undefined,
    });
    expect(started).toBe(true);
    expect(fake.spoken).toEqual(['ask about the retry handler']);
    expect(onEnd).not.toHaveBeenCalled();

    fake.utterances[0].onend?.();
    expect(onEnd).toHaveBeenCalledTimes(1);
  });

  it('forwards an interruption as an error, and boundary offsets as positions', () => {
    const fake = installFakeSynthesis();
    const speaker = createBrowserReadBackSpeaker();
    const onError = vi.fn();
    const onBoundary = vi.fn();
    speaker.speak({ text: 'a sentence', onEnd: vi.fn(), onError, onBoundary });

    fake.utterances[0].onboundary?.({ charIndex: 4 });
    fake.utterances[0].onboundary?.({ charIndex: undefined });
    expect(onBoundary).toHaveBeenCalledTimes(1);
    expect(onBoundary).toHaveBeenCalledWith(4);

    fake.utterances[0].onerror?.({ error: 'interrupted' });
    expect(onError).toHaveBeenCalledWith('interrupted');
  });

  it('stops whatever is speaking before starting a new utterance', () => {
    const fake = installFakeSynthesis();
    const speaker = createBrowserReadBackSpeaker();
    speaker.speak({ text: 'first', onEnd: vi.fn(), onError: vi.fn() });
    speaker.speak({ text: 'second', onEnd: vi.fn(), onError: vi.fn() });
    expect(fake.cancellations).toBe(2);
    expect(fake.spoken).toEqual(['first', 'second']);
  });
});
