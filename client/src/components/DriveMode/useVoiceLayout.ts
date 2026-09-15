/**
 * useVoiceLayout — the operator's mode plus a live viewport measurement.
 *
 * The store owns the CHOICE ('mobile' | 'desktop', persisted). This hook adds
 * the window measurement and returns the layout the surface should render, so
 * a wide preference on a narrow window degrades to the mobile surface instead
 * of squeezing two panes into slivers.
 */
import { useEffect, useState } from 'react';
import {
  resolveVoiceLayout,
  selectViewportWidth,
  useVoiceLayoutStore,
  type VoiceLayout,
  type VoiceLayoutMode,
} from './voiceLayout';

export interface VoiceLayoutView {
  /** The operator's persisted choice. */
  mode: VoiceLayoutMode;
  /** What to render right now, given the window. */
  layout: VoiceLayout;
  viewportWidth: number;
  setMode: (mode: VoiceLayoutMode) => void;
  toggleMode: () => void;
}

export function useVoiceLayout(): VoiceLayoutView {
  const mode = useVoiceLayoutStore((s) => s.mode);
  const setMode = useVoiceLayoutStore((s) => s.setMode);
  const toggleMode = useVoiceLayoutStore((s) => s.toggleMode);
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window === 'undefined' ? 0 : selectViewportWidth(window)
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const sync = () => setViewportWidth(selectViewportWidth(window));
    sync();
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', sync);
    return () => {
      window.removeEventListener('resize', sync);
      window.removeEventListener('orientationchange', sync);
    };
  }, []);

  return {
    mode,
    layout: resolveVoiceLayout(mode, viewportWidth),
    viewportWidth,
    setMode,
    toggleMode,
  };
}
