# Pi Web UI - Comprehensive Development Plan

---
task: "Build a fully functional web UI for Pi coding agent using the Pi SDK"
created: "2026-03-07T23:00:00Z"
status: "planning"
risk_level: "high"
estimated_effort: "epic"
estimated_tokens: "800K-1.2M Kimi CLI tokens"
---

## Executive Summary

This plan outlines the development of a comprehensive web-based interface for the Pi coding agent that provides full feature parity with the terminal UI while adding web-native enhancements. The solution uses Pi SDK for backend agent integration and a modern React frontend for the user interface.

**Scope**: Full-featured web UI covering all Pi functions including chat, tool execution, session management, model switching, file browser, and tree navigation.

**Architecture**: Express/WebSocket backend + React frontend + Pi SDK integration

**Estimated Effort**: Epic (3-4 weeks development + 1-2 weeks testing/deploy)

**Estimated Tokens**: 800,000 - 1,200,000 Kimi CLI tokens for complete implementation, testing, and deployment

---

## Analysis

### Current Pi Features to Replicate

| Feature | Terminal UI | Web UI Approach | Complexity |
|---------|-------------|-----------------|------------|
| Interactive chat | TUI with streaming | WebSocket streaming | Medium |
| Tool execution | Inline collapsible | Collapsible cards with progress | Medium |
| Session tree | ASCII tree view | Interactive D3/react-tree | High |
| File attachments | @file autocomplete | Drag-drop + file picker | Medium |
| Model switching | Ctrl+L selector | Dropdown with search | Low |
| Thinking blocks | Ctrl+T toggle | Collapsible sections | Low |
| Message queue | Alt+Enter queue | Pending message list | Medium |
| Keyboard shortcuts | Full bindings | Keyboard library + help modal | Medium |
| Cost tracking | Footer display | Real-time dashboard | Low |
| Session persistence | Auto-save | Auto-save + manual | Low |
| Image paste | Ctrl+V terminal | Paste + drag-drop | Medium |
| Custom editors | TUI replacement | Modal dialogs | High |

### Technical Architecture Decision

**Selected Approach: Full-Stack Web Application**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              CLIENT (Browser)                                │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                        React SPA                                     │   │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────────┐ │   │
│  │  │ Chat Interface│ │ File Browser │ │ Session Tree │ │ Status Bar │ │   │
│  │  └──────────────┘ └──────────────┘ └──────────────┘ └────────────┘ │   │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐               │   │
│  │  │ Tool Output  │ │ Model Select │ │ Settings     │               │   │
│  │  └──────────────┘ └──────────────┘ └──────────────┘               │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                              ↑ WebSocket/SSE                               │
└──────────────────────────────┼─────────────────────────────────────────────┘
                               │
┌──────────────────────────────┼─────────────────────────────────────────────┐
│                              ↓                                              │
│                           SERVER (Node.js)                                   │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                      Express + WebSocket Server                      │   │
│  │                                                                      │   │
│  │  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │   │
│  │  │ REST API     │←→→│ Session Mgr  │←→→│   Pi SDK             │  │   │
│  │  │ (HTTP)       │    │ (In-Memory/  │    │   createAgentSession │  │   │
│  │  └──────────────┘    │  Redis)      │    └──────────────────────┘  │   │
│  │  ┌──────────────┐    └──────────────┘               ↑               │   │
│  │  │ WebSocket    │←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←←┘               │   │
│  │  │ (Events)     │         ↑                                          │   │
│  │  └──────────────┘         └────── Pi Agent Runtime                   │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  External: Auth (JWT), File Storage (S3/Local), DB (Redis/Postgres)         │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Alternative Approaches Considered:**

| Approach | Pros | Cons | Verdict |
|----------|------|------|---------|
| Full Web App (Selected) | Complete control, scalable, feature-rich | More complex, requires backend | ✅ Best fit |
| Static + Pi RPC | Simpler, no backend | Limited features, no multi-user | ❌ Too limiting |
| VS Code Extension | Native feel, existing infra | Platform-specific, limited reach | ❌ Not web UI |
| Electron Desktop | Full Node access, offline | Heavy, not truly web | ❌ Not browser-based |

---

## Implementation Plan

### Phase 1: Project Setup & Infrastructure (Week 1)

**Step 1.1: Project Structure Setup**
- **Files to Create:**
  - `pi-web-ui/` (monorepo root)
  - `pi-web-ui/server/` (Express + WebSocket backend)
  - `pi-web-ui/client/` (React frontend)
  - `pi-web-ui/shared/` (shared types/interfaces)
  - `pi-web-ui/package.json` (workspace configuration)
- **Dependencies:**
  - Backend: `express`, `ws`, `@mariozechner/pi-coding-agent`, `cors`, `helmet`
  - Frontend: `react`, `react-dom`, `typescript`, `vite`, `tailwindcss`
  - Shared: `zod` (validation), shared TypeScript types
- **Estimated Tokens:** 50K

**Step 1.2: Backend Foundation**
- **Files:**
  - `server/src/index.ts` (Express server setup)
  - `server/src/websocket.ts` (WebSocket manager)
  - `server/src/pi-service.ts` (Pi SDK integration wrapper)
  - `server/src/session-store.ts` (Session persistence)
- **Functionality:**
  - Express HTTP server with CORS
  - WebSocket server for real-time events
  - Pi SDK wrapper with session management
  - Health check endpoints
- **Estimated Tokens:** 80K

**Step 1.3: Frontend Foundation**
- **Files:**
  - `client/src/main.tsx` (React entry)
  - `client/src/App.tsx` (Root component)
  - `client/src/store/` (Zustand/Redux state management)
  - `client/src/hooks/useWebSocket.ts` (WebSocket client hook)
  - `client/src/types/` (TypeScript interfaces)
- **Functionality:**
  - React app with TypeScript
  - WebSocket connection management
  - Global state for session/messages
  - Tailwind CSS theming (dark/light like Pi)
- **Estimated Tokens:** 70K

---

### Phase 2: Core Chat Interface (Week 1-2)

**Step 2.1: Message Streaming System**
- **Backend Files:**
  - `server/src/handlers/chat.ts` (chat message handler)
  - `server/src/stream-manager.ts` (manage Pi event streams)
- **Frontend Files:**
  - `client/src/components/Chat/MessageList.tsx` (message rendering)
  - `client/src/components/Chat/MessageInput.tsx` (input with markdown)
  - `client/src/components/Chat/StreamingText.tsx` (token-by-token display)
- **Features:**
  - WebSocket streaming from Pi SDK events
  - Message types: user, assistant, tool_call, tool_result, error
  - Markdown rendering with syntax highlighting
  - Auto-scroll to bottom
- **Estimated Tokens:** 100K

**Step 2.2: Tool Execution Display**
- **Frontend Files:**
  - `client/src/components/Tools/ToolCallCard.tsx` (collapsible tool UI)
  - `client/src/components/Tools/ToolOutput.tsx` (bash/read/edit/write display)
  - `client/src/components/Tools/ToolIcon.tsx` (tool type icons)
- **Features:**
  - Collapsible tool call cards (like Pi's Ctrl+O)
  - Syntax highlighting for code/output
  - Diff view for edit operations
  - File tree view for ls/find results
- **Estimated Tokens:** 80K

**Step 2.3: Message Input & Composition**
- **Frontend Files:**
  - `client/src/components/Input/Composer.tsx` (main input area)
  - `client/src/components/Input/FileAttachment.tsx` (file upload)
  - `client/src/components/Input/MentionAutocomplete.tsx` (@file support)
- **Features:**
  - Textarea with auto-resize
  - Drag-and-drop file attachment
  - @mention for file autocomplete
  - Keyboard shortcuts (Enter to send, Shift+Enter newline)
  - Image paste support
- **Estimated Tokens:** 70K

---

### Phase 3: Session Management (Week 2)

**Step 3.1: Session List & Persistence**
- **Backend Files:**
  - `server/src/routes/sessions.ts` (REST API for sessions)
  - `server/src/db/session-repo.ts` (session storage interface)
- **Frontend Files:**
  - `client/src/components/Sidebar/SessionList.tsx` (session sidebar)
  - `client/src/components/Sidebar/SessionItem.tsx` (individual session)
- **Features:**
  - List all sessions with metadata
  - Create / rename / delete sessions
  - Search/filter sessions
  - Auto-save indicator
- **Estimated Tokens:** 60K

**Step 3.2: Session Tree Navigation**
- **Frontend Files:**
  - `client/src/components/Tree/TreeView.tsx` (branching visualization)
  - `client/src/components/Tree/TreeNode.tsx` (tree node component)
  - `client/src/components/Tree/BranchLine.tsx` (visual connectors)
- **Features:**
  - D3.js or react-flow for tree visualization
  - Click to navigate to any point
  - Visual distinction of branches
  - Fork button at any node
- **Estimated Tokens:** 90K

**Step 3.3: Session Restoration**
- **Backend:** Extend Pi SDK session manager for web
- **Frontend:**
  - `client/src/hooks/useSessionRestore.ts`
- **Features:**
  - Restore previous session on reconnect
  - Export session to JSONL
  - Import session from file
- **Estimated Tokens:** 40K

---

### Phase 4: Model & Settings Management (Week 2)

**Step 4.1: Model Selector**
- **Frontend Files:**
  - `client/src/components/ModelSelector/ModelPicker.tsx` (Ctrl+L equivalent)
  - `client/src/components/ModelSelector/ModelCard.tsx` (model display)
  - `client/src/hooks/useModels.ts` (fetch available models)
- **Backend:**
  - `server/src/routes/models.ts` (list configured models)
- **Features:**
  - Dropdown/searchable model picker
  - Model details (context window, cost)
  - Thinking level selector (off/minimal/low/medium/high/xhigh)
  - Scoped models for cycling (Ctrl+P)
- **Estimated Tokens:** 50K

**Step 4.2: Settings Panel**
- **Frontend Files:**
  - `client/src/components/Settings/SettingsModal.tsx`
  - `client/src/components/Settings/ThemeSelector.tsx`
  - `client/src/components/Settings/ToolConfig.tsx`
- **Features:**
  - Theme selection (dark/light)
  - Tool enablement toggle
  - Extension management
  - Keyboard shortcuts help
- **Estimated Tokens:** 40K

**Step 4.3: Cost & Token Tracking**
- **Frontend Files:**
  - `client/src/components/StatusBar/TokenDisplay.tsx`
  - `client/src/components/StatusBar/CostTracker.tsx`
- **Features:**
  - Real-time token usage display
  - Cost estimation per model
  - Session total cost
  - Context usage percentage
- **Estimated Tokens:** 30K

---

### Phase 5: Advanced Features (Week 3)

**Step 5.1: File Browser Integration**
- **Frontend Files:**
  - `client/src/components/FileBrowser/FileTree.tsx`
  - `client/src/components/FileBrowser/FileNode.tsx`
  - `client/src/components/FileBrowser/FilePreview.tsx`
- **Backend:**
  - `server/src/routes/files.ts` (safe file access API)
- **Features:**
  - Tree view of working directory
  - File preview on click
  - Drag files to chat
  - @file autocomplete integration
- **Estimated Tokens:** 70K

**Step 5.2: Thinking Blocks & Compaction**
- **Frontend Files:**
  - `client/src/components/Thinking/ThinkingBlock.tsx` (collapsible)
  - `client/src/components/Thinking/ThinkingToggle.tsx` (Ctrl+T)
- **Features:**
  - Collapsible thinking blocks
  - Toggle all thinking (global/local)
  - Compaction notification
  - Token budget display
- **Estimated Tokens:** 40K

**Step 5.3: Message Queue & Steering**
- **Frontend Files:**
  - `client/src/components/Queue/MessageQueue.tsx`
  - `client/src/components/Queue/QueueItem.tsx`
- **Features:**
  - Pending message queue display
  - Steering vs follow-up distinction
  - Cancel queued messages
  - Edit queued messages (Alt+Up)
- **Estimated Tokens:** 35K

**Step 5.4: Extensions & Skills Panel**
- **Frontend Files:**
  - `client/src/components/Extensions/ExtensionList.tsx`
  - `client/src/components/Extensions/SkillViewer.tsx`
- **Backend:**
  - `server/src/routes/extensions.ts`
- **Features:**
  - List loaded extensions/skills
  - Toggle extensions on/off
  - View skill documentation
  - Install from git/npm
- **Estimated Tokens:** 45K

---

### Phase 6: Polish & Deployment (Week 3-4)

**Step 6.1: UI/UX Polish**
- **Tasks:**
  - Responsive design (mobile support)
  - Loading states & skeletons
  - Error boundaries
  - Toast notifications
  - Keyboard shortcut help modal
  - Onboarding/tutorial
- **Estimated Tokens:** 60K

**Step 6.2: Authentication & Security**
- **Files:**
  - `server/src/middleware/auth.ts` (JWT middleware)
  - `server/src/routes/auth.ts` (login/logout)
  - `client/src/components/Auth/Login.tsx`
- **Features:**
  - JWT-based authentication
  - API key storage (encrypted)
  - Session isolation per user
  - CORS & helmet security
- **Estimated Tokens:** 50K

**Step 6.3: Testing Suite**
- **Files:**
  - `server/src/__tests__/` (backend tests)
  - `client/src/__tests__/` (frontend tests)
- **Tests:**
  - WebSocket connection tests
  - Pi SDK integration tests
  - Component unit tests
  - E2E tests (Playwright)
- **Estimated Tokens:** 70K

**Step 6.4: Deployment Configuration**
- **Files:**
  - `docker-compose.yml` (full stack)
  - `Dockerfile.server` (backend container)
  - `Dockerfile.client` (frontend container)
  - `.env.example` (configuration template)
  - `nginx.conf` (reverse proxy config)
- **Features:**
  - Docker containerization
  - Environment configuration
  - Production build optimization
  - Health checks
- **Estimated Tokens:** 40K

---

## Token Estimation Breakdown

| Phase | Description | Estimated Tokens |
|-------|-------------|------------------|
| **Phase 1** | Project Setup & Infrastructure | 200K |
| **Phase 2** | Core Chat Interface | 250K |
| **Phase 3** | Session Management | 190K |
| **Phase 4** | Model & Settings | 120K |
| **Phase 5** | Advanced Features | 190K |
| **Phase 6** | Polish & Deployment | 220K |
| **Buffer** | Debugging & Iteration | 150K |
| **TOTAL** | | **~1.2M tokens** |

**Conservative Estimate:** 800K tokens (minimal viable features)
**Full Feature Estimate:** 1.2M tokens (complete implementation)

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Pi SDK limitations | Medium | High | Early proof-of-concept with SDK |
| WebSocket reliability | Medium | Medium | Reconnection logic, fallback to SSE |
| Session state sync | Medium | High | Comprehensive state management tests |
| File security | High | High | Strict path validation, sandboxing |
| Performance at scale | Low | Medium | Session pooling, Redis backend |
| Browser compatibility | Low | Low | Modern browser requirement |

---

## Technology Stack

### Backend
- **Runtime:** Node.js 20+
- **Framework:** Express.js
- **WebSocket:** `ws` library
- **AI SDK:** `@mariozechner/pi-coding-agent`
- **Validation:** Zod
- **Storage:** Redis (sessions), Local/S3 (files)
- **Auth:** JWT (jsonwebtoken)

### Frontend
- **Framework:** React 18
- **Language:** TypeScript
- **Build:** Vite
- **Styling:** Tailwind CSS
- **State:** Zustand
- **WebSocket:** Native WebSocket API
- **Icons:** Lucide React
- **Markdown:** react-markdown + remark-gfm
- **Tree Viz:** react-flow or D3.js

### DevOps
- **Container:** Docker + Docker Compose
- **Reverse Proxy:** Nginx
- **Process Manager:** PM2 (production)

---

## File Structure

```
pi-web-ui/
├── README.md
├── docker-compose.yml
├── package.json (workspace root)
├── .env.example
│
├── server/
│   ├── package.json
│   ├── Dockerfile
│   ├── src/
│   │   ├── index.ts (entry)
│   │   ├── websocket.ts
│   │   ├── pi-service.ts
│   │   ├── routes/
│   │   │   ├── sessions.ts
│   │   │   ├── models.ts
│   │   │   ├── files.ts
│   │   │   └── extensions.ts
│   │   ├── handlers/
│   │   │   └── chat.ts
│   │   ├── middleware/
│   │   │   ├── auth.ts
│   │   │   └── error.ts
│   │   ├── db/
│   │   │   ├── session-repo.ts
│   │   │   └── redis-client.ts
│   │   └── types/
│   │       └── index.ts
│   └── tests/
│
├── client/
│   ├── package.json
│   ├── Dockerfile
│   ├── vite.config.ts
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── Chat/
│   │   │   │   ├── MessageList.tsx
│   │   │   │   ├── MessageInput.tsx
│   │   │   │   ├── StreamingText.tsx
│   │   │   │   └── MessageBubble.tsx
│   │   │   ├── Tools/
│   │   │   │   ├── ToolCallCard.tsx
│   │   │   │   ├── ToolOutput.tsx
│   │   │   │   └── ToolIcon.tsx
│   │   │   ├── Sidebar/
│   │   │   │   ├── SessionList.tsx
│   │   │   │   └── SessionItem.tsx
│   │   │   ├── Tree/
│   │   │   │   ├── TreeView.tsx
│   │   │   │   └── TreeNode.tsx
│   │   │   ├── Input/
│   │   │   │   ├── Composer.tsx
│   │   │   │   └── FileAttachment.tsx
│   │   │   ├── ModelSelector/
│   │   │   │   └── ModelPicker.tsx
│   │   │   ├── StatusBar/
│   │   │   │   ├── TokenDisplay.tsx
│   │   │   │   └── CostTracker.tsx
│   │   │   └── Settings/
│   │   │       └── SettingsModal.tsx
│   │   ├── hooks/
│   │   │   ├── useWebSocket.ts
│   │   │   ├── useSession.ts
│   │   │   └── useModels.ts
│   │   ├── store/
│   │   │   ├── useChatStore.ts
│   │   │   └── useSessionStore.ts
│   │   ├── types/
│   │   │   └── index.ts
│   │   └── utils/
│   │       └── formatters.ts
│   └── tests/
│
└── shared/
    ├── package.json
    └── src/
        └── types.ts (shared interfaces)
```

---

## Success Criteria

### MVP (Minimum Viable Product)
- [ ] WebSocket connection to Pi SDK
- [ ] Basic chat interface with streaming
- [ ] Tool execution display
- [ ] Session persistence
- [ ] Model switching

### Full Feature Set
- [ ] All Pi terminal features replicated
- [ ] Session tree visualization
- [ ] File browser integration
- [ ] Cost/token tracking
- [ ] Extensions panel
- [ ] Mobile responsive
- [ ] Docker deployment

### Performance Targets
- [ ] Initial load < 3s
- [ ] Message latency < 100ms (client to Pi)
- [ ] Supports 100+ concurrent sessions
- [ ] Handles files up to 10MB

---

## Rollback Plan

If major issues encountered:
1. **Phase Gate Reviews:** After each phase, evaluate before proceeding
2. **Incremental Deployment:** Deploy phases independently
3. **Feature Flags:** Toggle features on/off
4. **Fallback to Terminal:** Users can always use `pi` CLI directly

---

## Next Steps

1. **User Review:** Approve/modify/reject this plan
2. **Proof of Concept:** Build minimal WebSocket + Pi SDK integration
3. **Architecture Validation:** Verify Pi SDK supports required features
4. **Stakeholder Sign-off:** Confirm scope and timeline
5. **Begin Phase 1:** Project setup upon approval

---

*Plan generated using kimi-planning skill methodology*
*Estimated tokens for implementation: 800K-1.2M Kimi CLI tokens*
