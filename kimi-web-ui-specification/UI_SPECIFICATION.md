# Kimi Web UI - Comprehensive UI Specification

**Version**: 1.0.0  
**Date**: 2026-03-14  
**Source**: Automated testing via Playwright  
**Total Snapshots**: 33  
**Video Recording**: Available at `videos/full-session.webm`

---

## Table of Contents

1. [Overview](#overview)
2. [Layout Architecture](#layout-architecture)
3. [Sessions List View](#sessions-list-view)
4. [Session Creation Flow](#session-creation-flow)
5. [Chat Interface](#chat-interface)
6. [Slash Commands System](#slash-commands-system)
7. [Modal Dialogs](#modal-dialogs)
8. [Component Library](#component-library)
9. [Interaction Patterns](#interaction-patterns)
10. [Visual Design System](#visual-design-system)

---

## Overview

The Kimi Web UI is a browser-based interface for the Kimi Code CLI agent. It provides a chat-based interaction model with a session management system, slash command interface, and directory-based workspace management.

### Key Characteristics

- **Two-pane layout**: Fixed sidebar + dynamic main content area
- **Session-centric**: All work is organized into discrete sessions
- **Directory-backed**: Each session is tied to a working directory
- **Command-driven**: Extensive slash command system for control
- **Modal-heavy**: Uses modal dialogs for configuration and selection
- **Minimalist aesthetic**: Clean, light-themed interface with subtle shadows

---

## Layout Architecture

### Overall Structure

```
┌─────────────────────────────────────────────────────────────────┐
│  HEADER (fixed, full width)                                     │
│  ├─ Logo: "K" icon + "Kimi Code" + version tag                  │
│  └─ Height: ~50px                                               │
├──────────────────┬──────────────────────────────────────────────┤
│                  │                                              │
│  SIDEBAR         │  MAIN CONTENT AREA                           │
│  (fixed, left)   │  (scrollable)                                │
│  Width: ~280px   │                                              │
│                  │                                              │
│  ├─ SECTION:     │  Content varies by view:                     │
│  │   SESSIONS    │  • Sessions list placeholder                 │
│  │               │  • Chat interface                            │
│  │               │  • Empty state                               │
│  ├─ Search box   │                                              │
│  ├─ Session list │                                              │
│  ├─ View toggles │                                              │
│  └─ Footer       │                                              │
│      controls    │                                              │
│                  │                                              │
└──────────────────┴──────────────────────────────────────────────┘
```

### Header Component

**Position**: Fixed top, full width  
**Height**: Approximately 50-60px  
**Background**: White (#ffffff) with subtle bottom border

**Elements** (left to right):
1. **Logo Icon**: Square "K" icon with rounded corners, black background, white text
2. **Brand Name**: "Kimi Code" in bold sans-serif font
3. **Version Tag**: Small, muted text showing version (e.g., "v1.19.0")

**Visual Treatment**:
- Clean, minimal header
- No navigation links in header
- Logo serves as home/session list link

### Sidebar Component

**Position**: Fixed left, below header  
**Width**: ~280px (fixed)  
**Height**: Full viewport minus header  
**Background**: White (#ffffff)

**Structure** (top to bottom):

```
┌──────────────────────────────┐
│  SECTION HEADER: "SESSIONS"  │
│  Uppercase, muted gray text  │
│  Small font size (11-12px)   │
├──────────────────────────────┤
│  TOOLBAR                     │
│  ├─ Refresh button (circular)│
│  ├─ "+" New session button   │
│  └─ View toggle buttons      │
├──────────────────────────────┤
│  SEARCH BOX                  │
│  ├─ Magnifying glass icon    │
│  ├─ Placeholder: "Search..." │
│  └─ Rounded border           │
├──────────────────────────────┤
│  SESSION LIST (scrollable)   │
│  ├─ Session name             │
│  ├─ Timestamp                │
│  └─ Hover highlight          │
├──────────────────────────────┤
│  FOOTER                      │
│  ├─ "Archived" expander      │
│  └─ Bottom action buttons    │
└──────────────────────────────┘
```

**Session List Items**:
- **Name**: Session title or "Untitled"
- **Timestamp**: Relative time (e.g., "Just now", "44m ago", "4h ago", "2d ago")
- **Layout**: Flex row, space-between
- **Hover State**: Light gray background highlight
- **Active State**: Subtle left border or background tint

**Footer Controls**:
- **Archived Expander**: Collapsible section showing archived sessions
- **Count Badge**: Shows number of archived sessions (e.g., "102")
- **Bottom Buttons**: Theme toggle, settings (gear icon)

### Main Content Area

**Position**: Right of sidebar  
**Width**: Flexible (viewport - sidebar width)  
**Background**: White (#ffffff)

**Views**:
1. **Empty State**: When no session selected
2. **Chat Interface**: Active conversation view
3. **Loading States**: Transition overlays

---

## Sessions List View

### Empty State (No Session Selected)

When the user lands on the page or hasn't selected a session:

**Visual Design**:
- Centered content vertically and horizontally
- Large, muted icon (sparkles/star icon)
- Primary heading: "Create a session to begin"
- Secondary text: "Click the + button in the sidebar to start a new session"
- Prominent CTA button: "+ Create new session"

**Button Style**:
- Dark background (near black: #1a1a1a or similar)
- White text
- Rounded corners (6-8px radius)
- Plus icon + text
- Hover: Slight opacity change or lighter background

**Snapshot Reference**: `01-initial-landing.png`, `02-sessions-list.png`

### Session List Behavior

**Sorting**: Chronological (newest first)  
**Max Visible**: Scrollable, no pagination apparent  
**Selection**: Single select, click to open session

**Session Item Structure**:
```
┌────────────────────────────────────┐
│ Session Name        │ Timestamp    │
│ (e.g., "/yolo")     │ (e.g., "4h  │
│                     │   ago")      │
└────────────────────────────────────┘
```

**States**:
- **Default**: White background, dark text
- **Hover**: Light gray background (#f5f5f5 or similar)
- **Active**: May have left border accent or different background

**Snapshot Reference**: `01-initial-landing.png` (shows 7 sessions)

---

## Session Creation Flow

### Trigger Points

1. Click "+" button in sidebar header
2. Click "+ Create new session" button in empty state
3. Use `/new` slash command

### Directory Selection Modal

When creating a new session, a modal dialog appears for directory selection:

**Modal Structure**:
```
┌─────────────────────────────────────────────┐
│  Search directories or type a path...      │
│  [Search icon] [Input field]               │
├─────────────────────────────────────────────┤
│  Current Directory                          │
│  ┌─────────────────────────────────────┐   │
│  │ [Home icon] /root              [→] │   │
│  └─────────────────────────────────────┘   │
├─────────────────────────────────────────────┤
│  Recent Directories                         │
│  ┌─────────────────────────────────────┐   │
│  │ [Folder icon] /root/happykimi       │   │
│  │ [Folder icon] /root/.skills-global  │   │
│  │ [Folder icon] /root/n8n-docker-caddy│   │
│  │ [Folder icon] /root/opari           │   │
│  └─────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
```

**Modal Characteristics**:
- **Position**: Centered, modal overlay
- **Width**: ~450-500px
- **Background**: White with rounded corners (8-12px)
- **Shadow**: Soft drop shadow (0 4px 20px rgba(0,0,0,0.15))
- **Backdrop**: Semi-transparent dark overlay (rgba(0,0,0,0.5))

**Elements**:
1. **Search Input**: 
   - Full width within modal
   - Magnifying glass icon (left)
   - Placeholder text
   - Clear button (X) on right when text entered

2. **Current Directory Section**:
   - Section header: "Current Directory"
   - Home/root icon
   - Path display
   - Arrow/chevron indicating clickability

3. **Recent Directories Section**:
   - Section header: "Recent Directories"
   - List of folder icons + paths
   - Hover highlight on items
   - Scrollable if many items

**Interaction Flow**:
1. Modal opens with search focused
2. User can:
   - Type a custom path
   - Click "Current Directory" to select root
   - Click a recent directory
   - Search to filter directories
3. Selection creates session and opens chat

**Snapshot Reference**: `04-new-session-view.png`

---

## Chat Interface

### Layout (Active Session)

```
┌─────────────────────────────────────────────────────────────────┐
│  Chat Header (optional, context-dependent)                     │
│  ├─ Session name                                               │
│  ├─ Current directory path                                     │
│  └─ Action buttons                                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  MESSAGE LIST (scrollable, bottom-aligned)                    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ [Previous messages...]                                  │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌────────────────────────────────────────┐  ← User message    │
│  │ Hello! Can you help me...              │  (right-aligned)   │
│  └────────────────────────────────────────┘                    │
│                                                                 │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ 🤖 AI Response                                          │   │
│  │                                                         │   │
│  │ I'd be happy to help...                                 │   │
│  │                                                         │   │
│  │ [Copy] [Regenerate] [Continue]                         │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  INPUT AREA (fixed bottom)                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ Type a message...                              [Send]   │   │
│  └─────────────────────────────────────────────────────────┘   │
│  [Slash command hint: "Press / for commands"]                  │
└─────────────────────────────────────────────────────────────────┘
```

### Message Bubbles

**User Messages**:
- **Alignment**: Right side
- **Background**: Primary brand color or dark gray
- **Text Color**: White
- **Shape**: Rounded rectangle, more rounded on left side (speech bubble style)
- **Max Width**: ~70-80% of container
- **Padding**: 12-16px

**AI Messages**:
- **Alignment**: Left side
- **Background**: Light gray (#f5f5f5) or white with border
- **Text Color**: Dark gray/black
- **Shape**: Rounded rectangle
- **Header**: May include model name/avatar
- **Max Width**: ~85-90% of container

**Message Metadata**:
- Timestamp (optional)
- Token usage indicator (optional)

**Snapshot Reference**: `05-typing-message.png`, `06-message-sent.png`, `08-ai-response-complete.png`

### Input Area

**Position**: Fixed bottom of chat area  
**Background**: White with top border or shadow  
**Padding**: 16-20px

**Structure**:
```
┌─────────────────────────────────────────────────────────────────┐
│  ┌─────────────────────────────────────────────────────────┐   │
│  │  [Input text...]                               [Send ▲] │   │
│  └─────────────────────────────────────────────────────────┘   │
│  Press / for commands                                          │
└─────────────────────────────────────────────────────────────────┘
```

**Input Field**:
- **Type**: Single-line text input (may auto-expand)
- **Placeholder**: "Type a message..."
- **Border**: Light gray, rounded (8px)
- **Focus**: Blue border highlight
- **Multiline**: Shift+Enter for new lines (if supported)

**Send Button**:
- **Position**: Right side of input
- **Icon**: Paper airplane or arrow up
- **State**: Disabled when empty, enabled with content
- **Submit**: Enter key or click

**Hint Text**: Below input, small gray text: "Press / for commands"

---

## Slash Commands System

### Trigger Mechanism

**Activation**: Type `/` character in input field  
**Response**: Command palette/modal appears  
**Navigation**: Arrow keys to select, Enter to execute  
**Filter**: Continue typing to filter commands (fuzzy match)

### Command Palette UI

The command palette appears to use the same modal component as directory selection:

```
┌─────────────────────────────────────────────┐
│  /                                          │
│  [Search icon] [Input showing "/"]         │
├─────────────────────────────────────────────┤
│  Custom Path                                │
│  ┌─────────────────────────────────────┐   │
│  │ [Folder icon] /                [→] │   │
│  └─────────────────────────────────────┘   │
├─────────────────────────────────────────────┤
│  Current Directory                          │
│  ┌─────────────────────────────────────┐   │
│  │ [Home icon] /root              [→] │   │
│  └─────────────────────────────────────┘   │
├─────────────────────────────────────────────┤
│  Recent Directories                         │
│  └─ [List of recent dirs]                  │
└─────────────────────────────────────────────┘
```

**Note**: The observed behavior shows that typing `/` in a new session context brings up the directory picker, suggesting the slash command system may be context-dependent or the test triggered the wrong input mode.

### Complete Slash Command Reference

Based on Kimi CLI documentation, the following commands should be supported:

#### Help & Info (4 commands)
| Command | Aliases | Description | UI Response |
|---------|---------|-------------|-------------|
| `/help` | `/h`, `/?` | Display help information | Full-screen pager overlay |
| `/version` | - | Show version number | Toast/inline message |
| `/changelog` | `/release-notes` | Show recent changes | Modal/pager with changelog |
| `/feedback` | - | Open GitHub Issues | External link or embedded form |

#### Account & Config (7 commands)
| Command | Aliases | Description | UI Response |
|---------|---------|-------------|-------------|
| `/login` | `/setup` | Configure API platform | Multi-step modal wizard |
| `/logout` | - | Clear credentials | Confirmation dialog |
| `/model` | - | Switch AI model | Selection modal with list |
| `/editor` | - | Set external editor | Input modal or selection |
| `/reload` | - | Reload configuration | Toast notification |
| `/debug` | - | Show debug context | Expandable debug panel |
| `/usage` | `/status` | Show API quota | Progress bars + stats |
| `/mcp` | - | Show MCP servers | Server list with status |

#### Session Management (6 commands)
| Command | Aliases | Description | UI Response |
|---------|---------|-------------|-------------|
| `/new` | - | Create new session | Directory picker modal |
| `/sessions` | `/resume` | List and switch sessions | Session list modal |
| `/export` | - | Export to Markdown | File save dialog |
| `/import` | - | Import from file/session | File picker/session list |
| `/clear` | `/reset` | Clear conversation | Confirmation dialog |
| `/compact` | - | Compact context | Progress/confirmation |

#### Skills & Flows (2+ commands)
| Command | Description | UI Response |
|---------|-------------|-------------|
| `/skill:<name>` | Load skill | Skill loaded notification |
| `/flow:<name>` | Execute flow | Flow execution UI |

#### Workspace (1 command)
| Command | Description | UI Response |
|---------|-------------|-------------|
| `/add-dir` | Add workspace directory | Directory picker modal |

#### Mode Toggles (4 commands)
| Command | Description | UI Response |
|---------|-------------|-------------|
| `/init` | Generate AGENTS.md | Progress modal |
| `/plan` | Toggle plan mode | Mode badge appears |
| `/yolo` | Toggle YOLO mode | Mode badge appears |
| `/web` | Open in Web UI | New tab/window |

**Total Commands**: 25+ built-in commands

**Snapshot Reference**: `10-slash-trigger-popup.png`, `11-slash-help-typed.png`, `12-slash-help-executed.png`

---

## Modal Dialogs

### Common Modal Characteristics

All modals share consistent styling:

**Container**:
- **Background**: White (#ffffff)
- **Border Radius**: 8-12px
- **Shadow**: 0 4px 20px rgba(0,0,0,0.15)
- **Max Width**: 450-500px (compact dialogs), wider for content
- **Padding**: 20-24px

**Backdrop**:
- **Color**: rgba(0,0,0,0.5)
- **Behavior**: Click to dismiss (optional)
- **Animation**: Fade in/out

**Header** (when present):
- **Title**: Bold, 16-18px
- **Close Button**: X icon, top-right

**Buttons**:
- **Primary**: Dark background, white text
- **Secondary**: Light/transparent background, dark text
- **Danger**: Red background (for destructive actions)

### Directory Selection Modal

**Purpose**: Select working directory for new session  
**Trigger**: New session creation, `/add-dir`

**Components**:
1. Search input
2. Current directory section
3. Recent directories list
4. Custom path option

**Snapshot Reference**: `04-new-session-view.png`

### Confirmation Dialogs

**Purpose**: Confirm destructive actions  
**Examples**: `/clear`, `/logout`, delete session

**Structure**:
```
┌─────────────────────────────────────────────┐
│  Title (e.g., "Clear Conversation")        │
├─────────────────────────────────────────────┤
│  Are you sure you want to clear...         │
│                                             │
│  [Cancel]    [Clear Conversation]          │
└─────────────────────────────────────────────┘
```

### Alert/Error Dialogs

**Purpose**: Show errors or important information

**Example - Directory Not Found**:
```
┌─────────────────────────────────────────────┐
│  Directory Not Found                        │
├─────────────────────────────────────────────┤
│  The directory /help does not exist.        │
│  Would you like to create it?               │
│                                             │
│  [Cancel]    [Create Directory]            │
└─────────────────────────────────────────────┘
```

**Snapshot Reference**: `08-ai-response-complete.png`, `12-slash-help-executed.png`

---

## Component Library

### Buttons

**Primary Button** (e.g., "Create new session"):
- **Background**: #1a1a1a (near black)
- **Text**: White, 14-15px, medium weight
- **Padding**: 10px 16px
- **Border Radius**: 6-8px
- **Hover**: Lighten background to #333333
- **Icon**: Optional, left-aligned, 16px

**Secondary Button** (e.g., "Cancel"):
- **Background**: Transparent or #f5f5f5
- **Text**: #1a1a1a, 14px
- **Border**: 1px solid #e0e0e0
- **Padding**: 10px 16px
- **Border Radius**: 6-8px
- **Hover**: Background #e8e8e8

**Icon Button** (e.g., refresh, settings):
- **Background**: Transparent
- **Icon**: 18-20px, gray (#666666)
- **Padding**: 8px
- **Border Radius**: 6px
- **Hover**: Background #f0f0f0

### Input Fields

**Text Input**:
- **Background**: White or #fafafa
- **Border**: 1px solid #e0e0e0
- **Border Radius**: 6-8px
- **Padding**: 10px 12px
- **Font**: 14-15px, system font stack
- **Focus**: Border color #0066cc or brand color
- **Placeholder**: #999999, 14px

**Search Input**:
- **Icon**: Magnifying glass, left side, gray
- **Clear Button**: X icon, right side, appears on input
- **Padding-left**: 36px (room for icon)

### Icons

**Style**: Outlined, minimal, 1.5px stroke  
**Size**: 18-20px for buttons, 16px for inline  
**Color**: Gray (#666666) default, dark (#1a1a1a) on hover

**Common Icons**:
- Plus (+) for new
- Magnifying glass for search
- Refresh/circular arrow
- Settings/gear
- Folder
- Home
- Chevron/arrow for navigation
- Close (X)

### Lists

**Session List Item**:
- **Height**: ~44px
- **Padding**: 12px 16px
- **Layout**: Flex, space-between
- **Left**: Session name (truncate with ellipsis)
- **Right**: Timestamp (muted gray)

**Recent Directories List Item**:
- **Icon**: Folder icon, 20px, left
- **Text**: Path string
- **Hover**: Light gray background

---

## Interaction Patterns

### Creating a Session

1. **Trigger**: Click "+" or "Create new session"
2. **Modal**: Directory picker appears
3. **Select**: Choose or type directory path
4. **Result**: Modal closes, chat interface loads
5. **Loading**: Brief transition state

### Sending a Message

1. **Focus**: Click input area or start typing
2. **Compose**: Type message (Shift+Enter for multiline)
3. **Submit**: Press Enter or click send button
4. **Display**: Message appears in chat (right-aligned)
5. **Response**: AI response loads (left-aligned, streaming)
6. **Complete**: Response fully rendered with action buttons

### Using Slash Commands

1. **Trigger**: Type "/" in input
2. **Palette**: Command picker modal appears
3. **Filter**: Type more characters to filter
4. **Navigate**: Use arrow keys to select
5. **Execute**: Press Enter
6. **Result**: Varies by command (may open another modal, change mode, etc.)

### Switching Sessions

1. **Click**: Select session from sidebar list
2. **Transition**: Current session saved, new session loads
3. **Display**: Chat interface updates with selected session history

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `/` | Open command palette (when input focused) |
| `Enter` | Send message / Select command |
| `Shift+Enter` | New line in message |
| `Escape` | Close modal / Cancel action |
| `Ctrl+O` | Open external editor |
| `Up/Down` | Navigate history or list items |

---

## Visual Design System

### Color Palette

**Primary Colors**:
- **Brand Black**: #1a1a1a (buttons, text)
- **Brand White**: #ffffff (backgrounds)
- **Brand Gray**: #666666 (secondary text, icons)

**Neutral Colors**:
- **Gray 100**: #f5f5f5 (hover states, light backgrounds)
- **Gray 200**: #e0e0e0 (borders, dividers)
- **Gray 300**: #cccccc (disabled states)
- **Gray 400**: #999999 (placeholders, muted text)
- **Gray 500**: #666666 (secondary text)
- **Gray 600**: #333333 (body text)
- **Gray 900**: #1a1a1a (headings, primary buttons)

**Accent Colors** (inferred):
- **Focus Blue**: #0066cc or similar
- **Success Green**: For success states
- **Error Red**: For errors and destructive actions
- **Warning Yellow/Orange**: For warnings

### Typography

**Font Family**: System font stack
```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", 
             Roboto, "Helvetica Neue", Arial, sans-serif;
```

**Scale**:
- **XS**: 11-12px (section headers, timestamps)
- **SM**: 13-14px (body text, buttons)
- **MD**: 15-16px (input text, important body)
- **LG**: 18-20px (modal titles)
- **XL**: 24-28px (empty state headings)

**Weights**:
- **Regular**: 400 (body text)
- **Medium**: 500 (emphasis, labels)
- **Bold**: 600-700 (headings, buttons)

### Spacing

**Base Unit**: 4px or 8px

**Common Values**:
- **XS**: 4px
- **SM**: 8px
- **MD**: 16px
- **LG**: 24px
- **XL**: 32px
- **2XL**: 48px

**Component Spacing**:
- **Button Padding**: 10px 16px
- **Input Padding**: 10px 12px
- **List Item Padding**: 12px 16px
- **Modal Padding**: 20-24px
- **Card Gap**: 0 (border-bottom for separation)

### Border Radius

- **SM**: 4px (small buttons, tags)
- **MD**: 6-8px (buttons, inputs, cards)
- **LG**: 12px (modals, large containers)

### Shadows

- **Input Focus**: 0 0 0 3px rgba(0,102,204,0.1)
- **Modal**: 0 4px 20px rgba(0,0,0,0.15)
- **Dropdown/Popover**: 0 2px 10px rgba(0,0,0,0.1)

---

## Responsive Behavior

### Desktop (1920x1080 - tested)

- Sidebar: Fixed 280px width
- Main content: Flexible, minimum ~800px
- All features visible

### Smaller Screens (inferred)

- **Tablet**: Sidebar may collapse to icons or overlay
- **Mobile**: Single column, sidebar becomes drawer

---

## Animation & Transitions

### Timing

- **Fast**: 150ms (button hovers, small UI changes)
- **Normal**: 200-250ms (modal open/close)
- **Slow**: 300-400ms (page transitions)

### Easing

- **Default**: ease-out or cubic-bezier(0.4, 0, 0.2, 1)
- **Bounce**: For playful elements (if any)

### Common Animations

1. **Modal Open**: Fade in backdrop + scale up content (0.95 to 1)
2. **Modal Close**: Reverse of open
3. **List Item Hover**: Background color transition
4. **Message Appear**: Fade in + slight translate Y
5. **Button Press**: Scale down to 0.97

---

## Appendix A: Snapshot Inventory

| # | Filename | Description |
|---|----------|-------------|
| 1 | `01-initial-landing.png` | Initial sessions list view |
| 2 | `02-sessions-list.png` | Sessions list with entries |
| 3 | `03-before-click-new-session.png` | Before creating new session |
| 4 | `04-new-session-view.png` | Directory picker modal |
| 5 | `05-typing-message.png` | Typing in chat input |
| 6 | `06-message-sent.png` | Message sent, loading state |
| 7 | `07-ai-response-loading.png` | AI response loading |
| 8 | `08-ai-response-complete.png` | Error: Directory Not Found dialog |
| 9 | `09-conversation-flow.png` | Conversation with follow-up |
| 10 | `10-slash-trigger-popup.png` | Slash trigger showing directory picker |
| 11-12 | `11-12-slash-help-*.png` | /help command execution |
| 13-14 | `13-14-slash-version-*.png` | /version command |
| 15-16 | `15-16-slash-sessions-*.png` | /sessions command |
| 17-18 | `17-18-slash-new-*.png` | /new command |
| 19-20 | `19-20-slash-model-*.png` | /model command |
| 21-22 | `21-22-slash-plan-*.png` | /plan command |
| 23-24 | `23-24-slash-yolo-*.png` | /yolo command |
| 25-26 | `25-26-slash-debug-*.png` | /debug command |
| 27-28 | `27-28-slash-export-*.png` | /export command |
| 29-30 | `29-30-slash-clear-*.png` | /clear command |
| 31 | `31-multiline-input.png` | Multiline input test |
| 32 | `32-tool-execution.png` | Tool execution request |
| 33 | `33-updated-sessions-list.png` | Return to sessions list |

**Total Snapshots**: 33 PNG files + 33 HTML files

---

## Appendix B: Video Recording

**File**: `videos/full-session.webm`  
**Duration**: ~2 minutes  
**Resolution**: 1920x1080  
**Content**: Complete automated testing session

---

*This specification was generated through automated UI testing using Playwright. All measurements, colors, and behaviors are inferred from the test snapshots and may require verification against the actual implementation.*
