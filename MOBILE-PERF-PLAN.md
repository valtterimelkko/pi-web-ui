# Mobile Performance Improvement Plan

> **Status**: Ready for execution  
> **Date**: April 2026  
> **Scope**: Client-side only (no server changes)  
> **Test baseline**: 735 passing (2 pre-existing failures in terminal-manager.test.ts unrelated)

## Problem Statement

During streaming on long sessions (50+ messages), typing in the message input becomes sluggish on mobile browsers. The root cause is a cascade of re-renders triggered by Zustand store updates on every streaming token. Every token chunk triggers `sessionStore.set()`, which creates a new copy of the entire store state, notifies 34+ subscribers in `MessageInput` alone, runs `JSON.stringify` comparisons on every visible message, and re-parses markdown AST on every rendered block.

Kimi CLI's web UI avoids all of this by keeping messages in local hook state (not global store), using a faster markdown parser (`streamdown`/`marked` instead of `react-markdown`/`remark-gfm`), and passing data as props rather than store subscriptions.

## Architecture Before and After

```
BEFORE (current — every token = global store update = re-render cascade):
  Server → session_event → useWebSocket → sessionStore.set() → ChatView
    → messagesToLiveMessages() (allocates N new objects every render)
    → VirtualizedMessageList
    → MessageBubble × N (JSON.stringify memo comparison, remark-gfm AST parse)

AFTER (tokens accumulate in refs, structural changes only to state):
  Server → session_event → useSessionStream (hook-local refs/state)
    → ChatView receives { messages, status, streamingContent } as props
    → VirtualizedMessageList
    → MessageBubble × N (shallow comparison, streamdown regex parse)

  sessionStore keeps: sessions[], currentSessionId, currentModel, sessionData (metadata only)
  sessionStore drops: messages[], streaming event handlers
```

**No server-side changes are needed.** Both Pi SDK and Claude Direct paths emit the same `session_event` wire format to the client. The normalization layer (`ClaudeEventNormalizer` → `normEventToPiFormat()` / `EventForwarder.mapEventToMessage()`) is entirely server-side and untouched.

---

## Module Overview and Dependency Graph

```
Module 0: Foundation (types, deps)           ← NO DEPS
Module 1: useSessionStream overhaul          ← depends on Module 0
Module 2: ChatView wiring refactor           ← depends on Module 1
Module 3: Streamdown migration               ← depends on Module 0 (parallel with 1)
Module 4: MessageInput props-only            ← depends on Module 2
Module 5: MessageBubble memo + streaming     ← depends on Module 2, Module 3
Module 6: sessionStore cleanup               ← depends on Module 2, Module 4
Module 7: Integration + edge cases           ← depends on all above
```

**Parallelization:**
- Modules 1 and 3 can run in parallel (both depend only on Module 0)
- Module 2 must wait for Module 1
- Modules 4 and 5 can run in parallel (both depend on Module 2)
- Module 6 must wait for Modules 2 and 4
- Module 7 runs last

**Minimum execution waves: 4**
```
Wave 1: Module 0
Wave 2: Module 1 + Module 3 (parallel)
Wave 3: Module 2
Wave 4: Module 4 + Module 5 (parallel)
Wave 5: Module 6
Wave 6: Module 7
```

---

## Git Strategy

- **Commit granularity**: One commit per module, with format `perf(mobile): <module description>`
- **Build check**: Run `npm run build` after every module commit
- **Test check**: Run `npm test` after every module commit — must not introduce new failures
- **Regression gate**: After all modules, run `npm run build && npm test` — must match baseline (735 passing)
- **No force-push**: Each commit builds on the previous; linear history
- **Module independence**: If a module introduces a failure, it should be revertible without breaking earlier modules (hence the build/test gate per module)

---

## Module 0: Foundation — Types and Dependencies

### Goal
Prepare types and install `streamdown` so downstream modules can proceed in parallel.

### Files Changed

| File | Change |
|------|--------|
| `client/package.json` | Add `streamdown` dependency |
| `client/src/hooks/useSessionStream.ts` | Expand `LiveMessage` type to match current `sessionStore.Message` shape (add `toolCall`, `toolResult`, `isComplete`) |
| `client/src/lib/messageAdapter.ts` | Add `sessionEventToLiveMessage()` converter for incoming WS events |

### Detailed Changes

**1. Install streamdown**
```bash
cd client && npm install streamdown
```

**2. Unify `LiveMessage` type**

The current `LiveMessage` in `useSessionStream.ts` is a subset of what `sessionStore.Message` provides. It needs to carry the full data:

```typescript
// client/src/hooks/useSessionStream.ts

export interface LiveMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: ContentPart[];
  timestamp: number;
  isComplete: boolean;
  // Tool support (both Pi SDK and Claude Direct)
  toolCall?: {
    id: string;
    name: string;
    args: unknown;
  };
  toolResult?: {
    output: string;
    isError: boolean;
  };
}
```

This matches the shape that `MessageBubble`, `CollapsibleToolCard`, `SubagentToolCard`, and `TodoToolCard` already expect.

**3. Add `sessionEventToLiveMessage` in `messageAdapter.ts`**

A converter function that takes incoming `session_event` objects and produces `LiveMessage` instances:

```typescript
export function sessionEventToMessages(
  event: { type: string; [key: string]: unknown }
): LiveMessage[] | { id: string; updates: Partial<LiveMessage> } | null {
  // Handles: message_start, message_update, tool_execution_start, etc.
}
```

This replaces the inline event processing currently in `sessionStore.handleServerMessage`.

### Tests

| Test File | What to Test |
|-----------|-------------|
| `client/tests/unit/hooks/useSessionStream.test.ts` | Update type assertions to verify `LiveMessage` has `toolCall`/`toolResult` fields |
| `client/tests/unit/lib/messageAdapter.test.ts` (NEW) | Test `sessionEventToMessages` for all event types: `message_start`, `message_update` (text_delta, thinking_delta), `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `agent_start`, `agent_end`. Test with both Pi SDK format and Claude Direct format (PascalCase tool names). |

### Edge Cases

- `message_update` events with no `message.id` (Pi SDK raw events) — must use tracked fallback ID
- `tool_execution_end` with empty result — must produce `toolResult.output = ''`
- Claude events with `rate_limit` and `session_init` types — these return `null` (metadata, not messages)

### Acceptance Criteria
- `npm install` succeeds in `client/`
- `npm run build` succeeds
- New `messageAdapter.test.ts` passes
- Existing `useSessionStream.test.ts` passes with updated types

---

## Module 1: useSessionStream Overhaul — Primary Data Path

### Goal
Transform `useSessionStream` from an unused hook into the primary message data source for `ChatView`. It must handle all event types that `sessionStore.handleServerMessage` currently handles for messages, using refs for accumulation and `useState` only for structural changes.

### Files Changed

| File | Change |
|------|--------|
| `client/src/hooks/useSessionStream.ts` | Major rewrite: add event processing for all `session_event` subtypes, connect to legacy WebSocket |
| `client/src/store/sessionStore.ts` | Remove `messages[]` from store state (keep in this module as dead code; Module 6 cleans up) |

### Detailed Changes

**1. Connect to the existing legacy WebSocket**

The hook currently tries to create its own JSON-RPC WebSocket. Instead, it must listen on the existing singleton WebSocket that `useWebSocket()` creates. The approach:

- The hook receives a `sessionId` prop (as before)
- It registers as a listener on the existing WebSocket client singleton via `WebSocketClient.onMessage()`
- It processes only `session_event` messages for its `sessionId`
- Other message types (sessions_list, session_created, etc.) are ignored — they remain in `sessionStore`

**Implementation pattern:**

```typescript
// Import the singleton factory
import { getWebSocketClient } from '../lib/websocket';

export function useSessionStream(sessionId: string | null) {
  // Refs for accumulation (no re-renders)
  const textRef = useRef('');
  const thinkingRef = useRef('');
  const currentMessageIdRef = useRef<string | null>(null);
  
  // State for completed messages only
  const [messages, setMessages] = useState<LiveMessage[]>([]);
  const [status, setStatus] = useState<ChatStatus>('idle');
  const [contextPercent, setContextPercent] = useState(0);
  const [currentStep, setCurrentStep] = useState(0);
  
  // Streaming content exposed for UI
  const streamingContentRef = useRef<ContentPart[]>([]);
  const [, forceUpdate] = useState(0);
  
  // Process session_event
  const processEvent = useCallback((event: { type: string; [key: string]: unknown }) => {
    switch (event.type) {
      case 'agent_start':
        setStatus('streaming');
        break;
      case 'agent_end':
        // Commit any remaining streaming content
        commitStreamingMessage();
        setStatus('idle');
        break;
      case 'message_start': {
        // If there's accumulated streaming content, commit it first
        commitStreamingMessage();
        // Track the new message
        const msgData = event.message as { id: string; role: string };
        currentMessageIdRef.current = msgData.id;
        
        if (msgData.role === 'user') {
          // User messages are complete immediately — add to messages
          const userMsg: LiveMessage = { ... };
          setMessages(prev => [...prev, userMsg]);
        }
        // For assistant messages, start accumulating
        break;
      }
      case 'message_update': {
        // Accumulate in refs — NO state update
        const { assistantMessageEvent } = event;
        if (assistantMessageEvent?.type === 'text_delta') {
          textRef.current += assistantMessageEvent.delta;
        } else if (assistantMessageEvent?.type === 'thinking_delta') {
          thinkingRef.current += assistantMessageEvent.delta;
        }
        // Update ref for streaming display
        streamingContentRef.current = buildContentParts(textRef.current, thinkingRef.current);
        // Throttled force update for streaming cursor (60fps max)
        requestThrottledUpdate();
        break;
      }
      case 'message_end': {
        // Commit accumulated content to state
        commitStreamingMessage();
        break;
      }
      case 'tool_execution_start': {
        // Tool messages are structural — add immediately
        const toolMsg: LiveMessage = { ... };
        setMessages(prev => [...prev, toolMsg]);
        break;
      }
      case 'tool_execution_end': {
        // Update existing tool message with result
        setMessages(prev => prev.map(msg => 
          msg.id === event.toolCallId 
            ? { ...msg, toolResult: { output: ..., isError: ... }, isComplete: true }
            : msg
        ));
        break;
      }
    }
  }, []);
  
  // Commit streaming refs to a completed message in state
  const commitStreamingMessage = useCallback(() => {
    if (!currentMessageIdRef.current) return;
    const content = buildContentParts(textRef.current, thinkingRef.current);
    if (content.length === 0) return;
    
    const msgId = currentMessageIdRef.current;
    setMessages(prev => {
      const existing = prev.find(m => m.id === msgId);
      if (existing) {
        return prev.map(m => m.id === msgId ? { ...m, content, isComplete: true } : m);
      }
      return [...prev, { id: msgId, role: 'assistant', content, timestamp: Date.now(), isComplete: true }];
    });
    
    textRef.current = '';
    thinkingRef.current = '';
    currentMessageIdRef.current = null;
  }, []);
  
  // Subscribe to the global WebSocket for session events
  useEffect(() => {
    if (!sessionId) return;
    
    const client = getWebSocketClient();
    const unsubscribe = client.onMessage((msg: unknown) => {
      const parsed = msg as { type: string; sessionId?: string; event?: unknown };
      if (parsed.type === 'session_event' && parsed.sessionId === sessionId) {
        processEvent(parsed.event as { type: string; [key: string]: unknown });
      }
    });
    
    return () => unsubscribe();
  }, [sessionId, processEvent]);
  
  // ... rest of hook
}
```

**2. Key design decisions:**

- **Single WebSocket listener**: The hook subscribes to the existing singleton `WebSocketClient`, not its own connection. It filters by `sessionId` and `type === 'session_event'`.
- **Ref accumulation**: `textRef` and `thinkingRef` accumulate streaming content without triggering re-renders.
- **`forceUpdate` throttled to 60fps**: The `requestThrottledUpdate` uses `requestAnimationFrame` or a 16ms timeout to batch streaming content updates for the UI.
- **`commitStreamingMessage`**: Called on `message_end` and `agent_end` to move accumulated content into `messages` state. This is the only time `setMessages` is called during streaming.
- **Identity guard**: The `useLayoutEffect` cleanup invalidates identity before disconnecting, preventing stale callbacks.

**3. History replay handling:**

When the user switches sessions, the server sends `history_start` → series of `session_event` → `history_end`. The hook must handle this:

```typescript
case 'history_start':
  setMessages([]);
  textRef.current = '';
  thinkingRef.current = '';
  break;
  
case 'history_end':
  // All replay events processed
  setStatus('idle');
  break;
```

Replay events use the same `message_start`/`message_update`/`message_end` pattern, so the same processing logic handles them.

**4. The `sendPrompt` action:**

The hook needs a `sendPrompt` function that sends via the existing WebSocket:

```typescript
const sendPrompt = useCallback((content: string, images?: unknown[]) => {
  const client = getWebSocketClient();
  return client.send({
    type: 'prompt',
    sessionId,
    message: content,
    images,
  });
}, [sessionId]);
```

**5. What stays in `sessionStore`:**

After this module, `sessionStore` keeps handling ALL non-message events:
- `sessions_list`, `session_created`, `session_switched`, `session_update` → session metadata
- `session_status`, `worker_status` → status tracking
- `extension_ui_request` → extension dialogs
- `auto_compaction_start/end` → compaction state
- `model_changed` → model updates
- `notification` → toasts
- `claude_available` → SDK availability
- `rate_limit`, `session_init` → Claude-specific metadata

The `sessionStore.handleServerMessage` is modified to **skip** `session_event` messages — they are now handled entirely by `useSessionStream`. This is the critical split.

**Implementation:** In `sessionStore.handleServerMessage`, add an early return for `session_event`:

```typescript
case 'session_event':
  // Handled by useSessionStream hook — skip here
  // Exception: update sessionData metadata for background sessions
  // and sidebar status indicators
  {
    const sessionEvent = msg as { sessionId: string; event: { type: string } };
    const { sessionId: evtSessionId, event } = sessionEvent;
    
    // Only update lightweight metadata in sessionData (not messages)
    switch (event.type) {
      case 'agent_start':
        get().setSessionStatus(evtSessionId, 'streaming');
        if (get().currentSessionId === evtSessionId) set({ isStreaming: true });
        break;
      case 'agent_end':
        get().setSessionStatus(evtSessionId, 'idle');
        if (get().currentSessionId === evtSessionId) set({ isStreaming: false });
        break;
      case 'session_init':
        // Update model info
        break;
      case 'rate_limit':
        // Update quota info
        break;
      // All other event types (message_start, message_update, tool_*) 
      // are NOT processed here — useSessionStream handles them
    }
  }
  break;
```

### Tests

| Test File | What to Test |
|-----------|-------------|
| `client/tests/unit/hooks/useSessionStream.test.ts` (MAJOR REWRITE) | 1. Ref accumulation: send 100 `message_update` text_delta events, verify only 1 `setMessages` call after `message_end`. 2. Identity guard: switch sessionId during streaming, verify old session's callbacks are blocked. 3. Atomic teardown: verify useLayoutEffect cleanup invalidates identity. 4. History replay: send `history_start` → events → `history_end`, verify messages are populated. 5. Tool events: `tool_execution_start` adds message, `tool_execution_end` updates it. 6. Rapid session switching: switch 5 times quickly, verify no cross-session message leak. 7. Claude Direct events: test with `session_init`, `rate_limit` types (should update metadata, not messages). 8. Background session: events for non-current sessionId should NOT update hook state. |
| `client/tests/unit/store/sessionStore.test.ts` | Update existing tests that assert `messages` state — remove or skip those that test the message path. Add test verifying `session_event` with `message_start` does NOT add to `sessionStore.messages`. |

### Edge Cases

- **Session switch during streaming**: Hook receives `agent_end` for old session after switching. Identity guard blocks it.
- **WebSocket reconnect**: The singleton reconnects; hook re-registers its listener. Server re-sends `switch_session` which triggers `history_start`/`history_end` replay.
- **Two browser tabs**: Each tab has its own hook instance, its own WebSocket connection. Naturally isolated.
- **Very long message (50KB+ text)**: Accumulated in ref (string), committed once on `message_end`. No per-chunk re-renders.
- **Optimistic message insertion**: `sendPrompt` must allow caller to add optimistic user message to `messages` immediately. Expose `addOptimisticMessage` helper.
- **Empty `message_end` (thinking-only message)**: `commitStreamingMessage` must still create the message with thinking content.

### Acceptance Criteria
- `useSessionStream` processes all event types correctly
- `sessionStore` no longer adds messages from `session_event`
- All existing tests pass (with appropriate updates)
- `npm run build` succeeds

---

## Module 2: ChatView Wiring Refactor

### Goal
Rewire `ChatView` to get message data from `useSessionStream` (hook-local state) instead of `sessionStore.messages`. Remove `messagesToLiveMessages()` conversion.

### Files Changed

| File | Change |
|------|--------|
| `client/src/App.tsx` | Re-introduce `useSessionStream` call in `AuthenticatedApp`, pass data down |
| `client/src/components/Chat/ChatView.tsx` | Accept `messages`, `status`, `sendPrompt`, etc. as props instead of reading from store |
| `client/src/components/Chat/VirtualizedMessageList.tsx` | Remove `messagesToLiveMessages` import; accept `LiveMessage[]` directly |
| `client/src/lib/messageAdapter.ts` | Remove `messagesToLiveMessages` function (dead code) |

### Detailed Changes

**1. `App.tsx` — useSessionStream lives here**

```typescript
function AuthenticatedApp() {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  
  const {
    messages,
    status,
    contextPercent,
    currentStep,
    isReplaying,
    streamingContent,
    sendPrompt,
    cancelCurrentTurn,
  } = useSessionStream(currentSessionId);
  
  // ... existing code ...
  
  return (
    <div className="h-screen flex flex-col bg-white overflow-hidden">
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        <div className="flex-1 flex flex-col overflow-hidden">
          <IntegratedHeader onOpenSettings={() => setSettingsOpen(true)} />
          <div className="flex-1 overflow-hidden relative flex">
            <TabPanel tab="chat">
              <ChatView
                messages={messages}
                isStreaming={status === 'streaming'}
                isReplaying={isReplaying}
                contextPercent={contextPercent}
                currentStep={currentStep}
                streamingContent={streamingContent}
                onSendPrompt={sendPrompt}
                onCancelStream={cancelCurrentTurn}
                onOpenSettings={() => setSettingsOpen(true)}
              />
            </TabPanel>
            {/* ... other tabs ... */}
          </div>
        </div>
      </div>
      <BottomNav />
      {/* ... modals ... */}
    </div>
  );
}
```

**2. `ChatView.tsx` — Props-based, no store subscriptions for messages**

```typescript
interface ChatViewProps {
  messages: LiveMessage[];
  isStreaming: boolean;
  isReplaying: boolean;
  contextPercent: number;
  currentStep: number;
  streamingContent: ContentPart[];
  onSendPrompt: (content: string, images?: unknown[]) => boolean;
  onCancelStream: () => void;
  onOpenSettings?: () => void;
}

export function ChatView({ messages, isStreaming, ... }: ChatViewProps) {
  // No store subscriptions for messages, isStreaming, etc.
  // Only subscribe to session metadata that ChatView owns:
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const getWorkerStatus = useSessionStore((state) => state.getWorkerStatus);
  
  // Tree entries still computed locally (lightweight)
  const treeEntries = useMemo(() => messages.map(...), [messages]);
  
  return (
    <div className="flex flex-col h-full bg-white">
      <main className="flex-1 flex flex-col overflow-hidden relative">
        <VirtualizedMessageList
          messages={messages}  // Already LiveMessage[] — no conversion!
          isStreaming={isStreaming}
          onAtBottomChange={handleAtBottomChange}
          hasSession={!!currentSessionId}
          onCreateSession={() => setShowNewSessionModal(true)}
          workerStatus={workerStatus}
        />
        <MessageInput
          disabled={!currentSessionId}
          isStreaming={isStreaming}
          contextPercent={contextPercent}
          onSend={onSendPrompt}
          onCancel={onCancelStream}
          onOpenSettings={onOpenSettings}
        />
      </main>
      {/* ... modals ... */}
    </div>
  );
}
```

**3. Remove `messagesToLiveMessages`**

Delete from `messageAdapter.ts` and remove all imports. The `normalizeToolName` function stays — it's still needed for routing tool names.

### Tests

| Test File | What to Test |
|-----------|-------------|
| `client/tests/unit/components/Chat/ChatView.test.tsx` (NEW or UPDATE) | 1. Renders messages from props. 2. Does NOT subscribe to `sessionStore.messages`. 3. Passes `onSendPrompt` to MessageInput. 4. Handles empty messages state. 5. Shows worker status from store. |
| `client/tests/unit/components/Chat/VirtualizedMessageList.test.tsx` | Update to pass `LiveMessage[]` directly instead of `Message[]`. Verify no `messagesToLiveMessages` usage. |
| `client/tests/unit/lib/messageAdapter.test.ts` | Remove `messagesToLiveMessages` tests. Keep `normalizeToolName` and `sessionEventToMessages` tests. |

### Edge Cases

- **`currentSessionId` is null**: `useSessionStream(null)` returns empty messages. ChatView shows empty state.
- **Session switch**: App re-renders with new sessionId → useSessionStream reconnects → ChatView receives new messages.
- **Sidebar session switch**: `sessionStore.switchSession()` changes `currentSessionId` → App passes new ID to `useSessionStream`.

### Acceptance Criteria
- `ChatView` has ZERO subscriptions to `sessionStore.messages`
- `messagesToLiveMessages` function is deleted
- All component tests pass
- `npm run build` succeeds

---

## Module 3: Streamdown Migration

### Goal
Replace `react-markdown` + `remark-gfm` with `streamdown` for 3-5x faster markdown rendering.

### Files Changed

| File | Change |
|------|--------|
| `client/src/components/Chat/StreamingText.tsx` | Replace `ReactMarkdown` with `Streamdown` |
| `client/src/components/Chat/MessageBubble.tsx` | Replace `ReactMarkdown` with `Streamdown` for non-streaming messages |
| `client/package.json` | `react-markdown` and `remark-gfm` can be removed (check no other usage) |

### Detailed Changes

**1. Create `client/src/lib/markdown.tsx` — shared markdown renderer**

```typescript
import { Streamdown } from 'streamdown';
import { safeRemarkPlugins, safeRehypePlugins, escapeHtmlOutsideCodeBlocks, streamdownRootClass } from './streamdown-config';

interface MarkdownRendererProps {
  content: string;
  isStreaming?: boolean;
  className?: string;
}

export function MarkdownRenderer({ content, isStreaming, className }: MarkdownRendererProps) {
  const escaped = escapeHtmlOutsideCodeBlocks(content);
  
  return (
    <div className={`${streamdownRootClass} ${className || ''}`}>
      <Streamdown
        content={escaped}
        remarkPlugins={safeRemarkPlugins}
        rehypePlugins={safeRehypePlugins}
        components={{
          // Custom code block component (reuse existing styling)
          code: ({ inline, className, children, ...props }) => { ... },
          // Custom table components (reuse existing styling)
          table: ({ children }) => { ... },
          // ... other component overrides matching current styling
        }}
      />
    </div>
  );
}

export function StreamingMarkdownRenderer({ content, className }: { content: string; className?: string }) {
  // During streaming, use a lighter rendering path:
  // - No rehype plugins
  // - Simpler code block handling
  // - Cursor indicator
  return (
    <div className={`${streamdownRootClass} ${className || ''}`}>
      <Streamdown content={escapeHtmlOutsideCodeBlocks(content)} />
      <span className="inline-block w-2 h-4 ml-0.5 bg-blue-500 animate-pulse align-middle" />
    </div>
  );
}
```

**2. Update `StreamingText.tsx`**

```typescript
import { StreamingMarkdownRenderer } from '../../lib/markdown';

export function StreamingText({ text }: { text: string }) {
  return <StreamingMarkdownRenderer content={text} className="prose prose-sm max-w-none" />;
}
```

**3. Update `MessageBubble.tsx`**

Replace the inline `<ReactMarkdown remarkPlugins={[remarkGfm]} components={...}>` with:

```typescript
import { MarkdownRenderer } from '../../lib/markdown';

// In the rendering:
<MarkdownRenderer 
  content={displayText} 
  className="prose prose-sm max-w-none prose-gray prose-table:w-full prose-compact"
/>
```

**4. Styling preservation**

The current `MessageBubble` has custom components for `table`, `thead`, `tbody`, `tr`, `th`, `td`, `code`, `p`, `ul`, `ol`, `li`, `h1`-`h4`, `blockquote`, `hr`, `a`. These must be replicated as `streamdown` component overrides to maintain identical appearance.

### Tests

| Test File | What to Test |
|-----------|-------------|
| `client/tests/unit/lib/markdown.test.tsx` (NEW) | 1. Renders basic markdown (bold, italic, links). 2. Renders code blocks with language class. 3. Renders tables. 4. Renders lists. 5. Escapes HTML outside code blocks. 6. Streaming renderer shows cursor. 7. Handles empty content. 8. Handles very long content (50KB). |
| `client/tests/unit/components/Chat/MessageBubble.test.tsx` | Update rendering assertions — verify markdown content still renders correctly with streamdown. |
| `client/tests/unit/components/Chat/StreamingText.test.tsx` (NEW) | Verify streaming renderer shows content + cursor. |

### Edge Cases

- **HTML in markdown**: `escapeHtmlOutsideCodeBlocks` should escape `<script>` etc. but preserve code blocks
- **Nested code blocks**: Backtick-delimited code blocks should not be escaped
- **Very long inline code**: Should wrap, not overflow
- **Empty content**: Should render nothing without errors
- **Math expressions**: Streamdown supports KaTeX via rehype plugin; ensure it's configured

### Acceptance Criteria
- `react-markdown` and `remark-gfm` are removed from `client/package.json`
- All markdown renders identically to before (visual comparison)
- Bundle size decreases
- `npm run build` succeeds

---

## Module 4: MessageInput Props-Only

### Goal
Remove all 34 Zustand store subscriptions from `MessageInput`. Receive data as props from `ChatView`.

### Files Changed

| File | Change |
|------|--------|
| `client/src/components/Chat/MessageInput.tsx` | Remove all `useSessionStore`, `useChatStore`, `useDraftStore` subscriptions; accept props |
| `client/src/components/Chat/ChatView.tsx` | Pass required data as props to `MessageInput` |

### Detailed Changes

**1. `MessageInput` interface**

```typescript
interface MessageInputProps {
  disabled?: boolean;
  isStreaming: boolean;
  isCompacting: boolean;
  compactionReason: string | null;
  currentModel: string | null;
  contextPercent: number;
  currentSessionId: string | null;
  currentSessionSdkType: 'pi' | 'claude' | null;
  quotaInfo?: { isUsingOverage: boolean; status: string; rateLimitType: string; resetsAt?: number } | null;
  onSend: (content: string, images?: unknown[]) => boolean;
  onCancel: () => void;
  onOpenSettings?: () => void;
  isReplaying?: boolean;
}
```

**2. Keep `useChatStore` for file attachment state only**

File attachments (selectedFiles, uploadedFiles, isDragging) are purely local UI state that doesn't affect rendering performance during streaming. These can stay in `chatStore` or be moved to `useState` within MessageInput. Recommendation: move to `useState` for zero store subscriptions.

```typescript
const [inputValue, setInputValue] = useState('');
const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
const [isDragging, setIsDragging] = useState(false);
const [showThinking, setShowThinking] = useState(false);
```

**3. Draft persistence**

The `draftStore` provides per-session draft persistence. This is a lightweight read/write that doesn't cause re-renders during streaming. It can stay as a store subscription BUT should be accessed via `useDraftStore.getState()` in callbacks, not via subscriptions:

```typescript
// Instead of subscribing to draft state:
// const currentDraft = useDraftStore(state => state.currentDraft); // REMOVE

// Use getState in callbacks:
const handleSend = useCallback(() => {
  const draft = useDraftStore.getState().currentDraft;
  // ...
}, []);
```

For the textarea value, use local `useState` synced with draft store on session change:

```typescript
const [inputValue, setInputValue] = useState('');

useEffect(() => {
  // Sync draft when session changes
  useDraftStore.getState().syncCurrentDraft();
  const draft = useDraftStore.getState().currentDraft;
  setInputValue(draft);
}, [currentSessionId]);
```

**4. Wrap in `React.memo`**

```typescript
export const MessageInput = memo(function MessageInput(props: MessageInputProps) {
  // ...
}, (prev, next) => {
  return prev.disabled === next.disabled
    && prev.isStreaming === next.isStreaming
    && prev.isCompacting === next.isCompacting
    && prev.currentModel === next.currentModel
    && prev.contextPercent === next.contextPercent
    && prev.currentSessionId === next.currentSessionId
    && prev.currentSessionSdkType === next.currentSessionSdkType
    && prev.onSend === next.onSend
    && prev.onCancel === next.onCancel;
});
```

### Tests

| Test File | What to Test |
|-----------|-------------|
| `client/tests/unit/components/Chat/MessageInput.test.tsx` (NEW or UPDATE) | 1. Renders with props only. 2. Send button calls `onSend` prop. 3. Cancel button calls `onCancel` prop. 4. File attachment UI works with local state. 5. Context percent displays from prop. 6. Model name displays from prop. 7. Streaming state disables input. 8. Compact modal works. 9. Slash palette works. |
| `client/tests/unit/store/chatStore.test.ts` | Unchanged (store still exists, just not used by MessageInput during streaming) |

### Edge Cases

- **Typing during streaming**: With 0 store subscriptions, textarea re-renders only when props change (streaming status, model). Typing uses local `useState` — no store churn.
- **File upload during streaming**: Local state, no conflict.
- **Session switch while typing**: `currentSessionId` prop changes → sync draft from store.
- **Empty currentSessionId**: Input should be disabled.

### Acceptance Criteria
- `MessageInput` has ZERO `useSessionStore` subscriptions
- `MessageInput` has ZERO `useDraftStore` subscriptions (uses `getState` in callbacks)
- `MessageInput` has ZERO `useChatStore` subscriptions (uses local state for files)
- All MessageInput functionality preserved
- `npm run build` succeeds

---

## Module 5: MessageBubble Memo Fix + Streaming Render Mode

### Goal
Replace `JSON.stringify` comparison with shallow property checks. Add a lightweight streaming rendering mode.

### Files Changed

| File | Change |
|------|--------|
| `client/src/components/Chat/MessageBubble.tsx` | Fix memo comparison; add streaming-specific render path |

### Detailed Changes

**1. Fix memo comparison**

Current (SLOW):
```typescript
JSON.stringify(prevProps.message.content) === JSON.stringify(nextProps.message.content)
```

New (FAST):
```typescript
function contentEqual(a: ContentPart[], b: ContentPart[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].type !== b[i].type) return false;
    if (a[i].type === 'text' && a[i].text !== b[i].text) return false;
    if (a[i].type === 'thinking' && a[i].thinking !== b[i].thinking) return false;
  }
  return true;
}

// In memo comparator:
return prevProps.message.id === nextProps.message.id
  && contentEqual(prevProps.message.content, nextProps.message.content)
  && prevProps.isLast === nextProps.isLast
  && prevProps.isCurrentRun === nextProps.isCurrentRun
  && prevProps.message.toolResult?.output === nextProps.message.toolResult?.output
  && prevProps.message.toolResult?.isError === nextProps.message.toolResult?.isError
  && prevProps.forceExpanded === nextProps.forceExpanded;
```

**2. Streaming render mode**

During streaming (`isLast && isStreaming`), use `StreamingMarkdownRenderer` which skips rehype plugins and uses simpler rendering. When message is complete, re-render with full `MarkdownRenderer`.

This is already partially done in the current code (`StreamingText` component for streaming, `ReactMarkdown` for completed). After Module 3, this naturally uses `StreamingMarkdownRenderer` vs `MarkdownRenderer`.

**3. Avoid re-rendering the message bubble when only the cursor position changes**

The streaming cursor is rendered inside `StreamingText`, which is only rendered for `isLast`. Other messages don't re-render at all during streaming because their memo comparison passes.

### Tests

| Test File | What to Test |
|-----------|-------------|
| `client/tests/unit/components/Chat/MessageBubble.test.tsx` | 1. Memo comparison: identical messages → no re-render. 2. Memo comparison: different content → re-render. 3. Content arrays with same text → equal. 4. Content arrays with different lengths → not equal. 5. Tool result changes → re-render. 6. Streaming message uses streaming renderer. 7. Completed message uses full renderer. |

### Edge Cases

- **Content part with both text and thinking**: Comparison must check both fields.
- **Empty content array**: `contentEqual([], [])` → true.
- **Very long content (50KB)**: Shallow comparison is O(n) on part count, not O(n) on text length.

### Acceptance Criteria
- No `JSON.stringify` in any memo comparator
- Streaming uses lightweight renderer
- Completed messages use full renderer
- All MessageBubble tests pass
- `npm run build` succeeds

---

## Module 6: sessionStore Cleanup

### Goal
Remove dead message-handling code from `sessionStore`. Reduce the store to metadata-only responsibilities.

### Files Changed

| File | Change |
|------|--------|
| `client/src/store/sessionStore.ts` | Remove `messages[]` state, `addMessage`, `updateMessage`, `clearMessages`, message-related `handleServerMessage` cases. Keep `sessionData` for metadata only. |

### Detailed Changes

**1. State to remove from `sessionStore`**

```typescript
// REMOVE these from state:
messages: Message[];
sessionCache: Map<string, SessionCache>;
sessionMessages: Record<string, Message[]>;

// REMOVE these actions:
addMessage(message)
updateMessage(id, updates)
clearMessages()
evictIfNeeded()
getCacheStats()

// REMOVE from handleServerMessage:
case 'message_start': ...
case 'message_update': ...
case 'message_end': ...
case 'tool_execution_start': ...
case 'tool_execution_update': ...
case 'tool_execution_end': ...
```

**2. State to KEEP in `sessionStore`**

```typescript
// Session metadata
sessions: Session[];
currentSessionId: string | null;
currentSessionSdkType: 'pi' | 'claude' | null;
currentModel: string | null;

// Per-session lightweight metadata (NO messages)
sessionData: Record<string, {
  status: 'idle' | 'busy' | 'streaming' | 'error';
  lastEventTimestamp: number;
  contextPercent: number;
  currentStep: number;
  model: string | null;
  quotaInfo?: { ... } | null;  // Claude Direct only
}>;

// Worker tracking
workerStatus: Record<string, WorkerStatus>;
activeWorkers: string[];

// Preferences
archivedSessionPaths: string[];
sessionDisplayNames: Record<string, string>;

// UI state
isStreaming: boolean;  // Still needed for MessageInput (via props now)
isCompacting: boolean;
compactionReason: string | null;
extensionUIRequest: ExtensionUIRequest | null;
sessionInfo: SessionStats | null;
contextPercent: number;
contextUsed: number;
contextWindow: number;
```

**3. Update `session_event` handler**

Keep only the metadata-updating portions:

```typescript
case 'session_event': {
  const { sessionId, event } = msg;
  switch (event.type) {
    case 'agent_start':
      get().setSessionStatus(sessionId, 'streaming');
      if (get().currentSessionId === sessionId) set({ isStreaming: true });
      break;
    case 'agent_end':
      get().setSessionStatus(sessionId, 'idle');
      if (get().currentSessionId === sessionId) set({ isStreaming: false });
      break;
    case 'auto_compaction_start': ...
    case 'auto_compaction_end': ...
    case 'session_init': ...
    case 'rate_limit': ...
    // All message/tool events are now handled by useSessionStream
  }
  break;
}
```

**4. Update `switchSession` and `setCurrentSession`**

These no longer cache/restore messages — that's `useSessionStream`'s job via history replay:

```typescript
switchSession: (newSessionId) => {
  set({ currentSessionId: newSessionId, isStreaming: false });
  // Message loading happens via useSessionStream + server history replay
},
```

**5. Update persist config**

Remove messages from `partialize`:

```typescript
partialize: (state) => ({
  sessions: state.sessions,
  archivedSessionPaths: state.archivedSessionPaths,
  sessionDisplayNames: state.sessionDisplayNames,
}),
```

**6. Keep `sessionData` for sidebar**

The sidebar shows session status (idle/streaming/busy) from `sessionData[sessionId].status`. This is lightweight metadata — just a string and timestamp per session.

### Tests

| Test File | What to Test |
|-----------|-------------|
| `client/tests/unit/store/sessionStore.test.ts` (MAJOR UPDATE) | Remove all tests that assert `messages` state. Add tests for: 1. `switchSession` sets `currentSessionId` and resets `isStreaming`. 2. `session_event` with `message_start` does NOT modify store state. 3. `session_event` with `agent_start` updates `isStreaming` for current session. 4. `session_event` with `agent_start` for background session updates `sessionData` only. 5. Worker status updates work. 6. Archive/display name persistence works. |
| `client/tests/unit/store/sessionStore-dual.test.ts` (UPDATE) | Remove message-related assertions. Keep tests for: `session_init`, `rate_limit`, `claude_available`, session status routing. |

### Edge Cases

- **Sidebar reads `sessionData[sessionId].status`**: Must still work after cleanup.
- **Worker status events**: Must still update `workerStatus` record.
- **Extension UI requests**: Must still work (they're rare, handled via store).
- **Preferences persistence**: `archivedSessionPaths`, `sessionDisplayNames` must persist.

### Acceptance Criteria
- `sessionStore` has no `messages[]` state
- `sessionStore` has no message-related actions (`addMessage`, `updateMessage`)
- All session metadata operations work (status, model, workers, preferences)
- All store tests pass
- `npm run build` succeeds

---

## Module 7: Integration Testing + Edge Cases

### Goal
Comprehensive integration tests covering the full data flow, both SDK paths, and all identified edge cases.

### Files Changed

| File | Change |
|------|--------|
| `client/tests/unit/hooks/useSessionStream.integration.test.ts` (NEW) | Full integration test with mock WebSocket |
| `client/tests/unit/components/Chat/ChatView.integration.test.tsx` (NEW) | End-to-end ChatView rendering test |
| `client/tests/performance/message-rendering.test.ts` (UPDATE) | Update performance benchmarks |
| `tests/e2e/mobile.spec.ts` (UPDATE) | Add mobile typing latency test |

### Test Plan

#### 7A. `useSessionStream.integration.test.ts`

**Full streaming flow (Pi SDK path):**
1. Connect with sessionId
2. Receive `history_start` → replay events → `history_end`
3. Send prompt → receive `agent_start` → `message_start` → 50 × `message_update` (text_delta) → `message_end` → `agent_end`
4. Verify: only 2 `setMessages` calls (replay + commit), not 52
5. Verify: messages contain correct accumulated text

**Full streaming flow (Claude Direct path):**
1. Same test but with Claude-shaped events (includes `session_init`, `rate_limit`)
2. Verify `session_init` updates model in store
3. Verify `rate_limit` updates quotaInfo

**Session switching:**
1. Stream session A for 10 tokens
2. Switch to session B (new sessionId)
3. Verify session A's streaming continues in background (store gets status updates)
4. Verify session B's messages are empty until history replay
5. Switch back to session A — verify history replay restores messages

**WebSocket reconnect:**
1. Stream session A
2. Simulate WebSocket disconnect + reconnect
3. Verify hook re-registers listener
4. Verify server sends `switch_session` → history replay

**Rapid session switching:**
1. Switch between 5 sessions in rapid succession (within 100ms)
2. Verify no cross-session message leak
3. Verify identity guards prevent stale callbacks

**Background session updates:**
1. Stream session A (active)
2. Receive events for session B (background)
3. Verify session A's messages are NOT affected
4. Verify session B's status in `sessionData` IS updated

#### 7B. `ChatView.integration.test.tsx`

**Rendering with messages:**
1. Render ChatView with 100 messages
2. Verify VirtualizedMessageList renders only visible items
3. Verify no `messagesToLiveMessages` conversion

**Streaming state:**
1. Render ChatView with `isStreaming=true` and `streamingContent`
2. Verify streaming cursor appears
3. Verify MessageInput shows stop button

**Props passing:**
1. Verify all data flows from props, not store
2. Verify MessageInput receives `isStreaming`, `contextPercent`, etc.

#### 7C. Performance benchmarks

Update `client/tests/performance/message-rendering.test.ts`:

1. **Re-render count during streaming**: Stream 100 tokens → verify ChatView re-renders < 10 times (not 100)
2. **MessageInput re-render count**: Verify MessageInput does NOT re-render on token arrival
3. **MessageBubble re-render count**: Verify only the last message re-renders during streaming
4. **Memory snapshot**: Render 200 messages, take heap snapshot, verify < 10MB

#### 7D. E2E mobile tests

Update `tests/e2e/mobile.spec.ts`:

1. **Typing latency test**: Open long session (50+ messages), type in input, verify no perceptible delay
2. **Session switch on mobile**: Switch between sessions, verify smooth transition
3. **Streaming on mobile**: Start streaming, verify input remains responsive

### Edge Cases

| Case | Test |
|------|------|
| Session switch mid-stream | Switch sessionId during active streaming; verify old stream stops, new stream starts |
| WebSocket disconnect during stream | Simulate WS close; verify hook reconnects and replays history |
| Two browser tabs | Two hook instances with different sessionIds; verify isolation |
| Empty session | No messages; verify empty state renders |
| Very long message (50KB+) | Single message with 50KB text; verify renders without crash |
| 200+ messages session | Load large history; verify virtualization works |
| Tool-only turn (no text) | Turn with only tool calls; verify activity indicator shows |
| Thinking-only message | Message with only thinking content; verify auto-expand |
| Claude Direct quota event | Receive rate_limit event; verify quota badge updates |
| Claude Direct session_init | Receive session_init; verify model updates in store |
| Background session streaming | Session B streams while viewing session A; verify status in sidebar |
| Optimistic message insertion | Send prompt; verify user message appears immediately |
| Extension UI request during streaming | Receive extension_ui_request; verify modal shows |
| Auto-compaction during streaming | Receive auto_compaction_start; verify indicator shows |
| Session rename during streaming | Rename session while streaming; verify name updates |

### Acceptance Criteria
- All integration tests pass
- All edge case tests pass
- All E2E tests pass
- `npm run build && npm test` matches or exceeds baseline (735+ passing)
- No new test failures introduced

---

## Summary Checklist

| Module | What It Does | Estimated LOC Changed | Dependencies |
|--------|-------------|----------------------|-------------|
| 0 | Types + streamdown install | ~100 | None |
| 1 | useSessionStream overhaul | ~500 | Module 0 |
| 2 | ChatView wiring | ~200 | Module 1 |
| 3 | Streamdown migration | ~200 | Module 0 |
| 4 | MessageInput props-only | ~300 | Module 2 |
| 5 | MessageBubble memo + streaming | ~100 | Module 2, Module 3 |
| 6 | sessionStore cleanup | ~400 removed | Module 2, Module 4 |
| 7 | Integration + edge cases | ~600 new tests | All above |
| **Total** | | **~2400** | **4 waves** |

## Rollback Strategy

Each module is designed to be independently revertible. If a module introduces failures:
1. Revert the commit for that module
2. The previous module's commit should still pass `npm test`
3. Fix the issue and re-commit

The most risky module is **Module 1** (useSessionStream overhaul) because it changes the data flow. If it fails badly, the system can operate without it — just skip Modules 2, 4, 5, 6 and keep the current `sessionStore`-based path while Module 1 is fixed.
