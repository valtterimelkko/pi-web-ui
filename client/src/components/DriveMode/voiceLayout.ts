/**
 * voiceLayout — Voice Mode's two layout modes.
 *
 * Operator, verbatim (2026-09-15):
 *   "Two modes for voice mode? For a computer screen, one that also shows the
 *    session itself on one half of the screen - the current version could stay
 *    as 'mobile mode' as mobile screen can't really handle more information."
 *
 * The mode is the operator's explicit, persisted choice. The LAYOUT is derived:
 * 'desktop' splits only when the window can hold two readable halves, so a wide
 * preference on a narrow window degrades to the existing mobile surface rather
 * than compressing both panes into slivers. Pure selection lives here (testable
 * without a browser); the components only render what `resolveVoiceLayout`
 * decided.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type VoiceLayoutMode = 'mobile' | 'desktop';
/** What the surface actually renders, given the mode AND the window. */
export type VoiceLayout = 'mobile' | 'split';

export const VOICE_LAYOUT_STORAGE_KEY = 'pi-voice-mode-layout';
export const DEFAULT_VOICE_LAYOUT_MODE: VoiceLayoutMode = 'mobile';

/**
 * Below this width a split would leave neither pane usable: the voice controls
 * are large touch targets and the transcript needs a readable measure, so the
 * narrow window keeps the mobile surface.
 */
export const SPLIT_MIN_WIDTH = 1024;

export function isVoiceLayoutMode(value: unknown): value is VoiceLayoutMode {
  return value === 'mobile' || value === 'desktop';
}

export function nextVoiceLayoutMode(mode: VoiceLayoutMode): VoiceLayoutMode {
  return mode === 'desktop' ? 'mobile' : 'desktop';
}

/**
 * The layout the surface renders. An unknown width (0/NaN — jsdom, prerender)
 * can never produce a split: a layout decision is not made on a missing
 * measurement.
 */
export function resolveVoiceLayout(mode: VoiceLayoutMode, viewportWidth: number): VoiceLayout {
  const width = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 0;
  return mode === 'desktop' && width >= SPLIT_MIN_WIDTH ? 'split' : 'mobile';
}

/** Read a usable viewport width, or 0 when there is not one. */
export function selectViewportWidth(source: { innerWidth?: number } | undefined | null): number {
  const width = source?.innerWidth;
  return typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : 0;
}

interface VoiceLayoutState {
  mode: VoiceLayoutMode;
  setMode: (mode: VoiceLayoutMode) => void;
  toggleMode: () => void;
}

/**
 * The operator's default, persisted (localStorage) so it survives reloads: the
 * layout is a working preference — chosen once, on the screen they use it on.
 */
export const useVoiceLayoutStore = create<VoiceLayoutState>()(
  persist(
    (set, get) => ({
      mode: DEFAULT_VOICE_LAYOUT_MODE,
      setMode: (mode) => set({ mode: isVoiceLayoutMode(mode) ? mode : DEFAULT_VOICE_LAYOUT_MODE }),
      toggleMode: () => set({ mode: nextVoiceLayoutMode(get().mode) }),
    }),
    {
      name: VOICE_LAYOUT_STORAGE_KEY,
      // Only the choice is persisted; the actions are not data.
      partialize: (state) => ({ mode: state.mode }),
      // A stored value from an older/newer surface is never trusted blindly.
      merge: (persisted, current) => {
        const stored = (persisted as { mode?: unknown } | undefined)?.mode;
        return { ...current, mode: isVoiceLayoutMode(stored) ? stored : current.mode };
      },
    }
  )
);

/**
 * Test seam: drop the in-memory choice and take whatever is in storage, applying
 * the same guard a real reload applies.
 */
export function resetVoiceLayoutStore(): void {
  useVoiceLayoutStore.setState({ mode: readPersistedVoiceLayoutMode() });
}

function readPersistedVoiceLayoutMode(): VoiceLayoutMode {
  try {
    const raw = localStorage.getItem(VOICE_LAYOUT_STORAGE_KEY);
    if (!raw) return DEFAULT_VOICE_LAYOUT_MODE;
    const parsed = JSON.parse(raw) as { state?: { mode?: unknown } };
    return isVoiceLayoutMode(parsed?.state?.mode) ? parsed.state.mode : DEFAULT_VOICE_LAYOUT_MODE;
  } catch {
    return DEFAULT_VOICE_LAYOUT_MODE;
  }
}
