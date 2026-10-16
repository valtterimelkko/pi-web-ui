import { memo } from 'react';
import { WatchStrip as SessionWatchStrip } from '@pi-web-ui/session-ui/WatchStrip';
import { useWatchSurfacingStore } from '../../store/watchSurfacingStore';

/** Moved to @pi-web-ui/session-ui (command-centre step 1a); this wrapper reads the watch store. */
export const WatchStrip = memo(function WatchStrip({ sessionId }: { sessionId: string | null }) {
  const watches = useWatchSurfacingStore((state) => (sessionId ? state.bySession[sessionId] : undefined));
  if (!sessionId) return null;
  return <SessionWatchStrip watches={watches} />;
});
