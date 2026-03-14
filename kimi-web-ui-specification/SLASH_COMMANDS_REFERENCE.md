# Kimi Web UI - Slash Commands Reference

**Complete documentation of all slash commands and their UI behaviors.**

---

## Command Summary

| Category | Count | Commands |
|----------|-------|----------|
| Help & Info | 4 | `/help`, `/version`, `/changelog`, `/feedback` |
| Account & Config | 7 | `/login`, `/logout`, `/model`, `/editor`, `/reload`, `/debug`, `/usage`, `/mcp` |
| Session Management | 6 | `/new`, `/sessions`, `/export`, `/import`, `/clear`, `/compact` |
| Skills & Flows | 2+ | `/skill:<name>`, `/flow:<name>` |
| Workspace | 1 | `/add-dir` |
| Mode Toggles | 4 | `/init`, `/plan`, `/yolo`, `/web` |
| **Total** | **25+** | |

---

## Detailed Command Reference

### Help & Info Commands

#### `/help` (Aliases: `/h`, `/?`)

**Purpose**: Display comprehensive help information

**UI Behavior**:
- Opens fullscreen pager overlay
- Shows keyboard shortcuts
- Lists all available slash commands
- Shows loaded skills
- Press `q` or `Escape` to exit

**Snapshot**: `12-slash-help-executed.png`

**Output Format**:
```
┌─────────────────────────────────────────────────────────────────┐
│  KIMI CODE CLI - Help                                          X│
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  KEYBOARD SHORTCUTS                                             │
│  ─────────────────                                              │
│  Ctrl+O          Open external editor                           │
│  Up/Down         Navigate history                               │
│  ...                                                            │
│                                                                 │
│  SLASH COMMANDS                                                 │
│  ─────────────                                                  │
│  /help, /h, /?   Display this help                              │
│  /version        Show version                                   │
│  ...                                                            │
│                                                                 │
│  LOADED SKILLS                                                  │
│  ─────────────                                                  │
│  • skill-name-1                                                 │
│  • skill-name-2                                                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

#### `/version`

**Purpose**: Display Kimi Code CLI version number

**UI Behavior**:
- Displays inline message or toast notification
- Shows version string (e.g., "v1.19.0")

**Snapshot**: `14-slash-version-executed.png`

---

#### `/changelog` (Alias: `/release-notes`)

**Purpose**: Display changelog for recent versions

**UI Behavior**:
- Opens pager or modal with changelog content
- Shows version history
- Lists new features, fixes, and changes

---

#### `/feedback`

**Purpose**: Open GitHub Issues page to submit feedback

**UI Behavior**:
- Opens external link in new tab
- Or shows embedded feedback form

---

### Account & Configuration Commands

#### `/login` (Alias: `/setup`)

**Purpose**: Log in or configure an API platform

**UI Behavior**:
- Multi-step modal wizard:
  1. Platform selection (Kimi Code, Other platforms)
  2. For Kimi Code: Opens browser for OAuth
  3. For other: API key input field
  4. Model selection

**Flow**:
```
[Platform Select] → [Auth Method] → [Credentials] → [Model Select] → [Complete]
```

---

#### `/logout`

**Purpose**: Log out from current platform

**UI Behavior**:
- Confirmation dialog appears
- "Are you sure you want to log out?"
- Buttons: [Cancel] [Logout]
- On confirm: Clears credentials, shows success message

---

#### `/model`

**Purpose**: Switch models and thinking mode

**UI Behavior**:
- Selection modal with available models
- Refresh button to fetch latest models
- Model cards with name, description
- Thinking mode toggle (if supported)

**Snapshot**: `20-slash-model-executed.png`

**Modal Structure**:
```
┌─────────────────────────────────────────────────────────┐
│  Select Model                                    [⟳]   │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────┐   │
│  │ ● kimi-k2-llm-20250224                          │   │
│  │   Standard model for general use                │   │
│  └─────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────┐   │
│  │ ○ kimi-k2-llm-20250224-thinking                 │   │
│  │   Enhanced reasoning capabilities               │   │
│  └─────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────┤
│  [x] Enable thinking mode                               │
├─────────────────────────────────────────────────────────┤
│           [Cancel]      [Select Model]                  │
└─────────────────────────────────────────────────────────┘
```

---

#### `/editor`

**Purpose**: Set external editor for Ctrl+O shortcut

**UI Behavior**:
- Input modal or dropdown selection
- Common editors pre-listed (vim, nano, code, etc.)
- Custom path input option

---

#### `/reload`

**Purpose**: Reload configuration file without exiting

**UI Behavior**:
- Toast notification: "Configuration reloaded"
- No modal, quick feedback

---

#### `/debug`

**Purpose**: Display debug information for current context

**UI Behavior**:
- Expandable panel or pager
- Shows:
  - Number of messages and tokens
  - Number of checkpoints
  - Complete message history (collapsed)

**Snapshot**: `26-slash-debug-executed.png`

---

#### `/usage` (Alias: `/status`)

**Purpose**: Display API usage and quota information

**UI Behavior**:
- Modal with progress bars
- Shows:
  - Total quota
  - Used amount with progress bar
  - Remaining percentage
  - Usage breakdown by feature

**Note**: Only works with Kimi Code platform

---

#### `/mcp`

**Purpose**: Display connected MCP servers and loaded tools

**UI Behavior**:
- List view modal
- Shows:
  - Server connection status (green = connected)
  - List of tools per server
  - Tool descriptions

---

### Session Management Commands

#### `/new`

**Purpose**: Create new session and switch to it

**UI Behavior**:
- Directory picker modal opens
- Select or type working directory
- On confirm: New session created, chat loads

**Snapshot**: `18-slash-new-executed.png`

**Flow**:
```
[/new] → [Directory Picker] → [Select/Type Path] → [New Session Created]
```

---

#### `/sessions` (Alias: `/resume`)

**Purpose**: List all sessions and switch to another

**UI Behavior**:
- Session list modal
- Shows all sessions with metadata
- Arrow keys or click to select
- Enter to switch

**Snapshot**: `16-slash-sessions-executed.png`

**Modal Structure**:
```
┌─────────────────────────────────────────────────────────┐
│  Select Session                                         │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────┐   │
│  │ Current Session                                 │   │
│  │ ● /yolo                                 Just now│   │
│  └─────────────────────────────────────────────────┘   │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Other Sessions                                  │   │
│  │ ○ /help                                 44m ago │   │
│  │ ○ Untitled                              4h ago  │   │
│  │ ○ /yolo                                 2d ago  │   │
│  └─────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────┤
│           [Cancel]      [Switch Session]                │
└─────────────────────────────────────────────────────────┘
```

---

#### `/export`

**Purpose**: Export current session to Markdown file

**UI Behavior**:
- File save dialog or path input modal
- Default filename: `kimi-export-<session-id>-<timestamp>.md`
- Shows export progress
- Success notification when complete

**Export Format**:
```markdown
# Session Export

**Session ID**: <id>  
**Export Time**: <timestamp>  
**Working Directory**: <path>  
**Messages**: <count>  
**Tokens**: <count>

---

## Conversation Overview

**Topic**: <auto-generated>  
**Turns**: <count>  
**Tool Calls**: <count>

---

## Messages

### Turn 1

**User**: <message>

**Assistant**: <response>

**Tool Calls**:
- <tool name>: <result>

### Turn 2
...
```

---

#### `/import`

**Purpose**: Import context from file or another session

**UI Behavior**:
- Two-tab modal:
  - **From File**: File picker
  - **From Session**: Session list (excluding current)

**Supported Formats**:
- Markdown (.md)
- Plain text (.txt)
- Source code files
- Configuration files
- (Binary files not supported)

---

#### `/clear` (Alias: `/reset`)

**Purpose**: Clear current session context and start fresh

**UI Behavior**:
- Confirmation dialog:
  - Title: "Clear Conversation"
  - Message: "This will clear all messages. Continue?"
  - Buttons: [Cancel] [Clear]
- On confirm: Chat area empties, new conversation starts

**Snapshot**: `30-slash-clear-executed.png`

---

#### `/compact`

**Purpose**: Manually compact context to reduce token usage

**UI Behavior**:
- Progress indicator during compaction
- Can include custom instructions: `/compact preserve database discussions`
- Shows before/after token count
- Success notification

---

### Skills & Flows Commands

#### `/skill:<name>`

**Purpose**: Load a specific skill as context

**Syntax**: `/skill:<skill-name> [additional text]`

**UI Behavior**:
- Loads SKILL.md content into context
- Shows notification: "Skill '<name>' loaded"
- Additional text appended to skill prompt

**Examples**:
- `/skill:code-style` - Load code style guidelines
- `/skill:pptx` - Load presentation creation workflow
- `/skill:git-commits fix login issue` - Load with task

**Note**: Flow skills loaded this way don't auto-execute the flow

---

#### `/flow:<name>`

**Purpose**: Execute a flow skill from start to finish

**Syntax**: `/flow:<flow-name>`

**UI Behavior**:
- Agent starts from BEGIN node
- Processes each node according to flow diagram
- UI updates to show current node/step
- Continues until END node reached

**Examples**:
- `/flow:code-review` - Execute code review workflow
- `/flow:release` - Execute release workflow

---

### Workspace Commands

#### `/add-dir`

**Purpose**: Add additional directory to workspace scope

**Syntax**:
- `/add-dir <path>` - Add specific directory
- `/add-dir` - List currently added directories

**UI Behavior**:
- Directory picker modal (if path not provided)
- Shows confirmation with path
- Added directories accessible to all file tools
- Persisted with session state

---

### Mode Toggle Commands

#### `/init`

**Purpose**: Analyze project and generate AGENTS.md file

**UI Behavior**:
- Progress modal:
  1. "Analyzing codebase structure..."
  2. "Generating project documentation..."
  3. "AGENTS.md created successfully"
- Creates/overwrites AGENTS.md in working directory

---

#### `/plan`

**Purpose**: Toggle plan mode

**Syntax**:
- `/plan` - Toggle on/off
- `/plan on` - Enable plan mode
- `/plan off` - Disable plan mode
- `/plan view` - View current plan
- `/plan clear` - Clear plan file

**UI Behavior**:
- **Enable**: 
  - Prompt changes to `📋`
  - Blue "plan" badge appears in status bar
  - AI enters read-only analysis mode
- **Disable**: Returns to normal mode

**Snapshot**: `22-slash-plan-executed.png`

---

#### `/yolo`

**Purpose**: Toggle YOLO (auto-approve) mode

**UI Behavior**:
- **Enable**:
  - Yellow "YOLO" badge appears in status bar
  - All operations auto-approved
  - Warning indicator
- **Disable**: Returns to confirmation mode

**Snapshot**: `24-slash-yolo-executed.png`

**Warning Display**:
```
┌─────────────────────────────────┐
│ ⚠️ YOLO Mode Active             │
│ All operations auto-approved    │
└─────────────────────────────────┘
```

---

#### `/web`

**Purpose**: Switch to Web UI (opens current session in browser)

**UI Behavior**:
- Opens new browser tab/window
- URL: `https://kimi.letsautomate.work/?token=<token>&session=<id>`
- Seamless transition from CLI to Web

---

## Command Completion System

### Trigger

Type `/` in input field to trigger command completion palette.

### Fuzzy Matching

The system supports fuzzy matching:
- `/ses` matches `/sessions`
- `/clog` matches `/changelog`
- `/h` matches `/help` (via alias)

### Navigation

| Key | Action |
|-----|--------|
| `↓` / `↑` | Navigate through filtered commands |
| `Enter` | Execute selected command |
| `Escape` | Close palette without selection |
| `Tab` | Auto-complete current selection |

### UI Component

```
┌─────────────────────────────────────────────────────────┐
│  /                                                      │
├─────────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────┐   │
│  │ /help       Display help information            │ ▲ │
│  │ /sessions   List and switch sessions            │   │
│  │ /new        Create new session                  │   │
│  │ ...                                             │ ▼ │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## Command Contexts

### Shell Mode Available Commands

Some commands work in both chat and shell mode:
- `/help`, `/h`, `/?`
- `/exit`
- `/version`
- `/editor`
- `/changelog`, `/release-notes`
- `/feedback`
- `/export`
- `/import`

### Configuration File Restrictions

Some commands only work with default config file:
- `/login` / `/setup`
- `/model`

If using `--config` or `--config-file` options, these commands are disabled.

---

## Visual Indicators

### Mode Badges

| Badge | Color | Meaning |
|-------|-------|---------|
| `plan` | Blue | Plan mode active - AI in read-only analysis |
| `YOLO` | Yellow | YOLO mode active - Auto-approve enabled |

### Status Indicators

| Indicator | Meaning |
|-----------|---------|
| ● Green dot | MCP server connected |
| ○ Gray dot | MCP server disconnected |

---

## Command Execution Feedback

### Success Patterns

1. **Toast Notification**: Brief message at bottom
2. **Modal with Result**: For complex outputs
3. **Inline Update**: UI changes without notification
4. **New View/Page**: Navigation to different interface

### Error Patterns

1. **Modal Dialog**: For errors requiring action
   ```
   ┌─────────────────────────────────┐
   │ Error                           │
   │                                 │
   │ <Error message>                 │
   │                                 │
   │              [OK]               │
   └─────────────────────────────────┘
   ```

2. **Inline Error**: Red text below input
3. **Toast Error**: Red notification

---

*This reference documents all slash commands as of Kimi Code CLI v1.19.0*
