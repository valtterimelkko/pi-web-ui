import { createContext, useContext, type ComponentType, type ReactNode } from 'react';
import type { ChildCardProjection } from '@pi-web-ui/session-core/child-surfacing';
import type { LiveMessage } from '@pi-web-ui/session-core/model';

/**
 * What the session cards need from their host app, supplied once through
 * {@link SessionViewProvider} instead of importing the host's stores.
 *
 * Reads are HOOKS, not values, so the host keeps its own subscription
 * semantics: Pi Web UI passes thin wrappers over the exact zustand selectors
 * the cards used before the extraction, so render and re-render behaviour is
 * unchanged. A host with plain state can use {@link staticSessionView}.
 * Every hook must be stable for the lifetime of the provider value.
 */
export interface SessionViewValue {
  useSdkType: () => string | null;
  useIsStreaming: () => boolean;
  useSessionId: () => string | null;
  /** Live state of a background child launched by a tool call, if known. */
  useBackgroundChild: (sessionId: string | null, taskId: string | undefined) => ChildCardProjection | undefined;
  useHistoryReplayActive: (sessionId: string | undefined) => boolean;
  /** Copy text; resolves true on success (the host may show a toast). */
  copy: (text: string, successMessage?: string) => Promise<boolean>;
  /** Banner shown after a context transfer (VirtualizedMessageList `transferReady`). */
  transferReadyMessage: string;
  /** Optional read-aloud action: a hook for the player plus its button. */
  readAloud?: {
    useReadAloud: (messageId: string) => ReadAloudControls;
    Button: ComponentType<ReadAloudButtonProps>;
  };
  /**
   * Component slots. The host may substitute its own components (Pi Web UI
   * passes its re-exported paths so its test doubles keep applying); absent
   * slots fall back to this package's components or render nothing.
   */
  components?: {
    MessageBubble?: ComponentType<MessageBubbleSlotProps>;
    CodeBlock?: ComponentType<{ children: ReactNode }>;
    /** Live "still streaming" indicator for Claude turns. */
    StreamHeartbeat?: ComponentType<{ compact?: boolean }>;
  };
}

export interface MessageBubbleSlotProps {
  message: LiveMessage;
  isLast?: boolean;
  isCurrentRun?: boolean;
  forceExpanded?: boolean;
}

export type ReadAloudState = 'idle' | 'loading' | 'playing' | 'paused';

export interface ReadAloudControls {
  state: ReadAloudState;
  speedEnabled: boolean;
  play: (text: string) => Promise<void> | void;
  stop: () => void;
  toggleSpeed: () => void;
}

export interface ReadAloudButtonProps {
  state: ReadAloudState;
  speedEnabled: boolean;
  onClick: () => void;
  onToggleSpeed: () => void;
}

const TRANSFER_READY_DEFAULT = 'Context transferred — ready for your next instruction';

async function navigatorCopy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A provider value backed by plain values (no live subscriptions). */
export function staticSessionView(values: {
  sdkType?: string | null;
  isStreaming?: boolean;
  sessionId?: string | null;
  childFor?: (sessionId: string, taskId: string) => ChildCardProjection | undefined;
  historyReplayActive?: boolean;
  copy?: SessionViewValue['copy'];
  transferReadyMessage?: string;
} = {}): SessionViewValue {
  return {
    useSdkType: () => values.sdkType ?? null,
    useIsStreaming: () => values.isStreaming ?? false,
    useSessionId: () => values.sessionId ?? null,
    useBackgroundChild: (sessionId, taskId) =>
      (sessionId && taskId && values.childFor ? values.childFor(sessionId, taskId) : undefined),
    useHistoryReplayActive: () => values.historyReplayActive ?? false,
    copy: values.copy ?? navigatorCopy,
    transferReadyMessage: values.transferReadyMessage ?? TRANSFER_READY_DEFAULT,
  };
}

const DEFAULT_VIEW = staticSessionView();
const SessionViewContext = createContext<SessionViewValue | null>(null);

export function SessionViewProvider({ value, children }: { value: SessionViewValue; children?: ReactNode }) {
  return <SessionViewContext.Provider value={value}>{children}</SessionViewContext.Provider>;
}

/** The nearest provider's value, or inert defaults when there is none. */
export function useSessionView(): SessionViewValue {
  return useContext(SessionViewContext) ?? DEFAULT_VIEW;
}

/** True when a provider is mounted above (hosts use it to avoid nesting). */
export function useHasSessionView(): boolean {
  return useContext(SessionViewContext) !== null;
}
