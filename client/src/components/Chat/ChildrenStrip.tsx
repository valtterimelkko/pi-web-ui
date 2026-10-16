import { memo } from 'react';
import { ChildrenStrip as SessionChildrenStrip } from '@pi-web-ui/session-ui/ChildrenStrip';
import { useBackgroundChildrenStore } from '../../store/backgroundChildrenStore';

/** Moved to @pi-web-ui/session-ui (command-centre step 1a); this wrapper reads the children store. */
export const ChildrenStrip = memo(function ChildrenStrip({ sessionId }: { sessionId: string | null }) {
  const children = useBackgroundChildrenStore((state) => (sessionId ? state.bySession[sessionId] : undefined));
  if (!sessionId) return null;
  return <SessionChildrenStrip childCards={children} />;
});
