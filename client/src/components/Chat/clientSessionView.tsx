import type { ReactNode } from 'react';
import { SessionViewProvider, useHasSessionView, type SessionViewValue } from '@pi-web-ui/session-ui/SessionView';
import { useSessionStore } from '../../store';
import { TRANSFER_READY_MESSAGE } from '../../store/sessionStore';
import { useBackgroundChildrenStore } from '../../store/backgroundChildrenStore';
import { useReadAloud } from '../../hooks/useReadAloud';
import { copyToClipboard } from '../../lib/clipboard';
import { ReadAloudButton } from './ReadAloudButton';
import { ClaudeStreamHeartbeat } from './ClaudeStreamHeartbeat';
import { MessageBubble } from './MessageBubble';
import { CodeBlock } from './CodeBlock';

/**
 * Pi Web UI's value for the @pi-web-ui/session-ui provider: the exact store
 * selectors, clipboard toast, read-aloud and heartbeat the cards used before
 * they moved into the package (command-centre step 1a), so nothing renders or
 * subscribes differently. Slots resolve the client's own module paths at call
 * time (the wrappers import this module, so a direct reference would be a
 * cycle), which also keeps tests that mock those paths effective.
 */
export const clientSessionView: SessionViewValue = {
  useSdkType: () => useSessionStore((state) => state.currentSessionSdkType),
  useIsStreaming: () => useSessionStore((state) => state.isStreaming),
  useSessionId: () => useSessionStore((state) => state.currentSessionId),
  useBackgroundChild: (sessionId, taskId) => useBackgroundChildrenStore((state) =>
    (sessionId && taskId !== undefined ? state.getChild(sessionId, taskId) : undefined)),
  useHistoryReplayActive: (sessionId) => useSessionStore((state) => !!(sessionId && state.historyReplayActive[sessionId])),
  copy: (text, successMessage) => copyToClipboard(text, successMessage),
  // Read lazily, as the list did before (only when the banner renders).
  get transferReadyMessage() { return TRANSFER_READY_MESSAGE; },
  readAloud: {
    useReadAloud: (messageId) => useReadAloud(messageId),
    Button: (props) => <ReadAloudButton {...props} />,
  },
  components: {
    MessageBubble: (props) => <MessageBubble {...props} />,
    CodeBlock: (props) => <CodeBlock {...props} />,
    StreamHeartbeat: (props) => <ClaudeStreamHeartbeat {...props} />,
  },
};

/** Provide {@link clientSessionView} unless a provider is already mounted. */
export function WithClientSessionView({ children }: { children: ReactNode }) {
  const provided = useHasSessionView();
  if (provided) return <>{children}</>;
  return <SessionViewProvider value={clientSessionView}>{children}</SessionViewProvider>;
}
