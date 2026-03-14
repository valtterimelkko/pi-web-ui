# Kimi Web UI Comprehensive Testing Plan

**Created**: 2026-03-14T19:47:48Z  
**Target URL**: https://kimi.letsautomate.work/?token=EFydwGvlqcZW0M7DL37VJHQIbWwxVERi  
**Tool**: playwright-cli  
**Goal**: Create comprehensive UI specification for agent web UI development

---

## Overview

This plan systematically tests and documents the Kimi Web UI to create a comprehensive specification that can be used to improve another agent web UI. The testing covers:

1. Sessions list view - all buttons and interactions
2. Chat interface - message boxes, response formatting, all controls
3. Slash commands - all 25+ commands and their pop-up behaviors
4. UI components - modals, dropdowns, menus, pop-ups
5. State transitions and animations

---

## Pre-Testing Setup

```bash
# Start playwright-cli session
playwright-cli open "https://kimi.letsautomate.work/?token=EFydwGvlqcZW0M7DL37VJHQIbWwxVERi"

# Start video recording for entire session
playwright-cli video-start /root/pi-web-ui/kimi-web-ui-specification/videos/full-session.webm

# Set viewport for consistent snapshots
playwright-cli resize 1920 1080
```

---

## Phase 1: Initial Landing & Sessions List

**Objective**: Document the sessions list view completely.

### Steps:

1. **Initial Landing Page Snapshot**
   - Take full-page snapshot
   - Document all visible elements
   - Screenshot: `snapshots/01-initial-landing.yml/png`

2. **Sessions List Analysis**
   - Document session cards (if any exist)
   - Identify the "+" button for creating new sessions
   - Document any existing session entries with their metadata
   - Screenshot: `snapshots/02-sessions-list.yml/png`

3. **Sessions List Buttons & Controls**
   - Document every interactive element:
     - New session button (plus icon)
     - Session cards (if any)
     - Any settings/menu buttons
     - Search functionality
     - Filter options
   - Screenshot per button hover state: `snapshots/03-sessions-buttons.yml/png`

4. **Header/Navigation Elements**
   - Logo/brand element
   - Any top navigation
   - User profile/settings area
   - Screenshot: `snapshots/04-header-elements.yml/png`

---

## Phase 2: Creating a New Session

**Objective**: Document the new session creation flow.

### Steps:

1. **Click New Session Button**
   - Click the "+" or "New Session" button
   - Document any transition animation
   - Screenshot: `snapshots/05-click-new-session.yml/png`

2. **New Session View**
   - Document the initial empty chat state
   - Input area appearance
   - Placeholder text
   - Welcome message (if any)
   - Screenshot: `snapshots/06-new-session-view.yml/png`

3. **Chat Interface Layout**
   - Document overall layout structure:
     - Sidebar (if visible)
     - Main chat area
     - Input area
     - Toolbar/controls
   - Screenshot: `snapshots/07-chat-layout.yml/png`

---

## Phase 3: Chat Interaction & Response Boxes

**Objective**: Test chat functionality and document response formatting.

### Steps:

1. **Send Initial Message**
   - Type: "Hello, can you help me understand your interface?"
   - Document input area behavior while typing
   - Screenshot: `snapshots/08-typing-message.yml/png`

2. **Submit Message**
   - Press Enter or click send
   - Document user message bubble appearance
   - Screenshot: `snapshots/09-message-sent.yml/png`

3. **AI Response Analysis**
   - Wait for response
   - Document response box:
     - Header with model name
     - Response content formatting
     - Code blocks (if any)
     - Action buttons on response
   - Screenshot: `snapshots/10-ai-response.yml/png`

4. **Response Box Buttons**
   - Identify and document buttons on AI responses:
     - Copy button
     - Regenerate button
     - Edit/continue button
     - Any other action buttons
   - Screenshot per button: `snapshots/11-response-buttons.yml/png`

5. **Continue Conversation**
   - Send follow-up: "What slash commands do you support?"
   - Document conversation flow
   - Screenshot: `snapshots/12-conversation-flow.yml/png`

---

## Phase 4: Slash Commands Testing

**Objective**: Test ALL slash commands and document their pop-up behaviors.

### Slash Commands List (25+ commands):

#### Help & Info Commands:
1. `/help` or `/h` or `/?`
2. `/version`
3. `/changelog` or `/release-notes`
4. `/feedback`

#### Account & Configuration:
5. `/login` or `/setup`
6. `/logout`
7. `/model`
8. `/editor`
9. `/reload`
10. `/debug`
11. `/usage` or `/status`
12. `/mcp`

#### Session Management:
13. `/new`
14. `/sessions` or `/resume`
15. `/export`
16. `/import`
17. `/clear` or `/reset`
18. `/compact`

#### Skills & Flows:
19. `/skill:<name>` (e.g., `/skill:code-style`)
20. `/flow:<name>` (e.g., `/flow:code-review`)

#### Workspace:
21. `/add-dir`

#### Mode Toggles:
22. `/init`
23. `/plan`
24. `/yolo`
25. `/web`

### Testing Steps per Command:

For each command:
1. Type `/` to trigger command completion pop-up
2. Type first few letters to filter
3. Document the completion dropdown
4. Select command
5. Document any pop-up/modal/dialog that appears
6. Document any multi-step flow
7. Screenshot: `snapshots/slash-XX-command-name.yml/png`

### Command Testing Sequence:

**Wave 1: Non-destructive Info Commands**
- `/help` - Document fullscreen pager
- `/version` - Document version display
- `/changelog` - Document changelog view
- `/debug` - Document debug info display
- `/mcp` - Document MCP server list

**Wave 2: Session Management (Safe)**
- `/sessions` - Document session list popup
- `/new` - Document new session creation
- `/export` - Document export flow (cancel after)
- `/clear` - Document clear confirmation

**Wave 3: Interactive Commands**
- `/model` - Document model selection UI
- `/plan` - Document plan mode toggle
- `/yolo` - Document YOLO mode toggle
- `/skill:code-style` - Document skill loading
- `/add-dir` - Document directory addition UI

**Wave 4: Command Completion**
- Test partial typing: `/ses` → matches `/sessions`
- Test alias: `/h` → matches `/help`
- Document fuzzy matching behavior

---

## Phase 5: Input Area Features

**Objective**: Document all input area functionality.

### Steps:

1. **Multi-line Input**
   - Test Shift+Enter for new lines
   - Document input area expansion
   - Screenshot: `snapshots/50-multiline-input.yml/png`

2. **Slash Command Trigger**
   - Type `/` character
   - Document command completion dropdown
   - Document fuzzy matching behavior
   - Screenshot: `snapshots/51-slash-trigger.yml/png`

3. **Input History**
   - Test Up/Down arrow for history
   - Document history navigation UI
   - Screenshot: `snapshots/52-input-history.yml/png`

4. **Input Buttons**
   - Document send button
   - Document any attachment/file buttons
   - Document any other input controls
   - Screenshot: `snapshots/53-input-buttons.yml/png`

---

## Phase 6: Sidebar Navigation

**Objective**: Document sidebar functionality.

### Steps:

1. **Sidebar Toggle**
   - Test sidebar collapse/expand
   - Document toggle button
   - Screenshot: `snapshots/60-sidebar-toggle.yml/png`

2. **Session List in Sidebar**
   - Document session entries
   - Document active session indicator
   - Screenshot: `snapshots/61-sidebar-sessions.yml/png`

3. **Session Actions**
   - Right-click/long-press on session (if applicable)
   - Document context menu
   - Screenshot: `snapshots/62-session-context-menu.yml/png`

---

## Phase 7: Tool Execution Display

**Objective**: Document how tool executions are displayed.

### Steps:

1. **Trigger Tool Execution**
   - Send: "Read the README.md file"
   - Document tool call visualization
   - Screenshot: `snapshots/70-tool-execution.yml/png`

2. **Tool Result Display**
   - Document tool result formatting
   - Document expandable/collapsible sections
   - Screenshot: `snapshots/71-tool-result.yml/png`

---

## Phase 8: Return to Sessions List

**Objective**: Document navigation back to sessions list.

### Steps:

1. **Navigate Back**
   - Click back button or navigate to sessions list
   - Document transition
   - Screenshot: `snapshots/80-back-to-sessions.yml/png`

2. **Updated Sessions List**
   - Document new session in list
   - Document session metadata (message count, time)
   - Screenshot: `snapshots/81-updated-sessions.yml/png`

3. **Session Actions in List**
   - Document any action buttons on session cards
   - Test delete/archive if available
   - Screenshot: `snapshots/82-session-card-actions.yml/png`

---

## Snapshot Naming Convention

```
snapshots/
├── 01-initial-landing.yml
├── 02-sessions-list.yml
├── 03-sessions-buttons.yml
├── 04-header-elements.yml
├── 05-click-new-session.yml
├── 06-new-session-view.yml
├── 07-chat-layout.yml
├── 08-typing-message.yml
├── 09-message-sent.yml
├── 10-ai-response.yml
├── 11-response-buttons.yml
├── 12-conversation-flow.yml
├── slash-01-help.yml
├── slash-02-version.yml
├── slash-03-changelog.yml
├── slash-04-debug.yml
├── slash-05-mcp.yml
├── slash-06-sessions.yml
├── slash-07-new.yml
├── slash-08-export.yml
├── slash-09-clear.yml
├── slash-10-model.yml
├── slash-11-plan.yml
├── slash-12-yolo.yml
├── slash-13-skill.yml
├── slash-14-add-dir.yml
├── 50-multiline-input.yml
├── 51-slash-trigger.yml
├── 52-input-history.yml
├── 53-input-buttons.yml
├── 60-sidebar-toggle.yml
├── 61-sidebar-sessions.yml
├── 62-session-context-menu.yml
├── 70-tool-execution.yml
├── 71-tool-result.yml
├── 80-back-to-sessions.yml
├── 81-updated-sessions.yml
└── 82-session-card-actions.yml
```

---

## Post-Testing Documentation

After completing all phases, compile the comprehensive specification document:

1. **UI_SPECIFICATION.md** - Main specification document
2. **COMPONENT_INVENTORY.md** - List of all UI components
3. **INTERACTION_PATTERNS.md** - Documented interaction patterns
4. **SLASH_COMMANDS_REFERENCE.md** - Complete slash command documentation

---

## Success Criteria

- [ ] All 25+ slash commands tested
- [ ] All UI buttons documented
- [ ] All pop-ups/modals captured
- [ ] 80+ snapshots captured
- [ ] Video recording of full session
- [ ] Comprehensive specification document created
