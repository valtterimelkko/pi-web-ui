# Pi Web UI

A persistent, security-hardened web interface for the Pi Coding Agent.

## Project Summary

Pi Web UI is a full-featured web interface that provides all the capabilities of the Pi coding agent in a browser-based application. Built with security-first principles, it offers real-time chat, session management, tool execution visualization, and extension support.

### What Was Built

This project was developed in 6 waves over approximately 5 weeks:

**Wave 1: Foundation & Security Infrastructure**
- Monorepo workspace structure (server/, client/, shared/)
- JWT authentication with httpOnly cookies
- CSRF protection with double-submit pattern
- WebSocket origin validation (CSWSH prevention)
- Rate limiting and prompt injection detection
- Input validation with Zod schemas

**Wave 2: Core Backend & Pi SDK Integration**
- Pi SDK service layer (PiService, SessionPool, EventForwarder)
- WebSocket protocol with bidirectional communication
- REST API endpoints (sessions, models, files, extensions)
- File-based session persistence shared with CLI
- Real-time event streaming from Pi SDK

**Wave 3: Frontend Core**
- React SPA with Vite and TailwindCSS
- WebSocket client with auto-reconnection
- Zustand state management (sessionStore, chatStore, uiStore)
- Chat interface with markdown and syntax highlighting
- Message input with drag-drop file support
- Tool execution display (bash, diff, file tree)

**Wave 4: Session Management**
- Session sidebar with real-time updates
- Session tree navigation for branching conversations
- CLI session watcher (file watching with chokidar)
- Session filtering by project (cwd) and search
- Create, switch, and delete sessions

**Wave 5: Extensions & Advanced Features**
- Extension UI protocol (confirm/select/input/editor dialogs)
- Model selector with provider grouping
- Thinking level selector (none/low/medium/high)
- Settings modal with theme toggle
- Status bar with connection and context usage
- File browser with secure path validation
- **4 Custom Extensions:**
  - Enhanced Plan Mode with wave-based analysis
  - Subagent delegation tool
  - Todo management system
  - Web search and fetch tools

**Wave 6: Polish, Testing & Documentation**
- Toast notifications and loading states
- Error boundary for crash handling
- CSS animations and micro-interactions
- Comprehensive test suite (100% pass rate)
- Full documentation (README, SECURITY, API, DEPLOYMENT, AGENTS)

### Key Capabilities

- **Full Pi Feature Parity**: All terminal features available in the browser
- **Real-time Streaming**: Character-by-character response streaming
- **Session Visibility**: See and manage both web and CLI sessions
- **Extension Support**: Full extension UI protocol for custom dialogs
- **Security Hardened**: JWT, CSRF, origin validation, rate limiting
- **Production Ready**: systemd, Nginx, and Docker deployment configs

## Recent Changes

### Process-per-Session Architecture (March 2026)
Refactored to isolate each session in its own worker process:
- **Memory Isolation** - 512MB heap per worker, one session can't crash others
- **Crash Resilience** - Worker OOMs only affect that session; auto-restart preserves state
- **Worker Pool** - Lazy spawning, idle cleanup (30min), max 15 concurrent workers
- **RPC Protocol Bridge** - JSON-RPC over stdin/stdout to worker processes

### Architecture Overhaul (March 2026)
Complete architectural refactor for mobile performance:
- **JSON-RPC 2.0 Protocol** - Structured WebSocket communication with request/response correlation
- **Per-Session WebSockets** - `/ws/sessions/:sessionId` endpoints for isolated connections
- **Ref-Based Streaming** - Content accumulated in refs, no re-renders during streaming
- **Identity Guards** - Prevents stale callbacks after rapid session switches
- **Atomic Teardown** - useLayoutEffect ensures cleanup before next render
- **LRU Cache** - Max 5 sessions kept in memory to prevent memory bloat
- **GZip Compression** - Responses > 1KB compressed for bandwidth efficiency

**Performance Targets:**
- Mobile session switch: 60-120s → <1s
- Mobile typing latency: 2-5s → <100ms
- Memory per session: ~15MB → ~5MB

### Test Suite - 571 Tests Passing (March 2026)
- **Shared Package**: 98 tests - JSON-RPC protocol types
- **Server**: 280+ tests - Protocol, WebSocket, Pi service
- **Client**: 190+ tests - Hooks, components, stores
- **E2E**: 9 tests - Authentication, core functionality

### Security Hardening (March 2026)
Production deployment now requires secure configuration:
- `JWT_SECRET` environment variable required in production (no defaults)
- `AUTH_PASSWORD` must be bcrypt hash in production (plain text rejected)
- Added comprehensive error handling and logging
- ESLint configuration for code quality enforcement

### UI Performance Optimizations (March 2026)
Major performance improvements based on Kimi Web UI benchmark:
- **Message Virtualization**: react-virtuoso for smooth scrolling with 100+ messages
- **Collapsible Tool Cards**: Kimi-style verbosity - collapsed by default, expandable details
- **Background Session Support**: Messages cached per session, streaming state tracked
- **Component Memoization**: MessageBubble with custom comparison, reduced re-renders

### UI/UX Improvements (March 2026)
- **Subagent Hierarchical Display**: CLI-style view showing subagent execution with internal tool operations (read, edit, etc.) - visible while other tools remain hidden for cleanliness
- **Thinking Previews**: Shows preview of thinking content when collapsed
- **Activity Indicators**: Brief summary when assistant has no visible text content
- **Auto-expand Thinking**: When message has only thinking (no text), auto-expands
- **Mobile UX**: Restored sidebar toggle, visible header buttons, no zoom on input focus
- **Light/Teal Theme**: Complete redesign from dark/violet to light/teal Kimi-style

### Session Management Features (March 2026)
- **Session Archiving**: Mark sessions as archived, syncs across devices
- **Session Renaming**: Display names with server-side persistence
- **Session Export**: Export sessions in Markdown, JSON, or HTML formats
- **Context Window Fix**: Fixed percentage mismatch between CLI and Web UI
- **File Upload Sanitization**: URL-encoded filenames decoded, spaces replaced with underscores

### Infrastructure Features (March 2026)
- **Health Endpoints**: `/api/health/live` and `/api/health/ready` for K8s/Docker orchestration
- **Config Validation**: `/api/config/validate` endpoint for troubleshooting configuration
- **Token Usage Tracking**: Per-session token/cost tracking with historical dashboard

### Model Support (March 2026)
- **Antigravity Models**: Google Antigravity provider with distinct indigo/purple styling
- **Anthropic Models**: Added Claude model support
- **GLM Models**: Added GLM-5.1 and other GLM model support
- **Model Selector**: Provider grouping with search functionality

#### Adding New Models

To add new models (e.g., when new GLM or other provider models are released), edit the Pi CLI models configuration file:

```bash
# Edit the models configuration
nano ~/.pi/agent/models.json
```

Add your new model to the `models` array:

```json
{
  "models": [
    {
      "id": "provider/model-name",
      "name": "Display Name",
      "provider": "provider-name",
      "contextWindow": 128000,
      "maxTokens": 8192
    }
  ]
}
```

Save the file and the model will appear in both the Pi CLI and the Web UI model selectors immediately. No restart required.

## Dual-SDK Architecture (April 2026)

Pi Web UI supports two AI runtime paths that can be selected when creating a new session:

### Pi SDK Sessions
- Uses Pi Coding Agent's SDK for AI interaction  
- All Pi extensions active (Enhanced Plan Mode, Subagent, Todo, Web Tools, Agent Discovery, etc.)
- Supports all providers: Anthropic, GitHub Copilot, Google, Kimi, OpenRouter, and more
- Full model switching between providers mid-session
- Session files stored in: `~/.pi/agent/sessions/`

### Claude Direct Sessions  
- Uses Claude Code CLI (`claude -p`) as a subprocess for AI interaction
- Uses Claude Code's built-in tools (Read, Edit, Write, Bash, Glob, Grep, WebSearch, WebFetch, Plan mode, Skills, Tasks, etc.)
- **Uses Claude subscription's normal quota** (not extra use, not pay-per-use API)
- Claude models only: Opus, Sonnet, Haiku (model alias switching supported)
- Permissionless operation: `--permission-mode acceptEdits`
- Session files stored in: `~/.pi-web-ui/claude-sessions/`

**Prerequisite for Claude Direct:** Claude Code must be installed and authenticated with a subscription:
```bash
# Install Claude Code
npm install -g @anthropic-ai/claude-code

# Authenticate with subscription
claude auth login
```

### Session Registry
Both Pi and Claude session types are indexed in a unified registry at `~/.pi-web-ui/session-registry.json`. This enables the sidebar to show sessions from both SDKs in a single list.

### Choosing Between SDKs

| Criteria | Pi SDK | Claude Direct |
|---|---|---|
| Need Pi extensions (Plan Mode, Subagent, etc.) | ✅ | ❌ |
| Need non-Claude models (GPT, Gemini, Kimi, etc.) | ✅ | ❌ |
| Want Claude subscription's **normal quota** | Via Copilot | ✅ |
| Need GitHub Copilot integration | ✅ | ❌ |
| Want Claude Code's native tools & skills | ❌ | ✅ |
| Need mid-session provider switching | ✅ | ❌ |

## Features

- 🔐 **Security-first**: JWT auth, CSRF protection, WebSocket origin validation
- 💬 **Real-time chat**: Streaming responses with markdown support
- 🛠️ **Tool execution**: Collapsible tool cards with syntax highlighting
- 📁 **Session management**: Web + CLI session visibility with tree navigation
- 🔌 **Extension support**: Full extension UI protocol (confirm/select/input/editor)
- 📂 **File browser**: Secure file browsing and preview
- 🎨 **Beautiful UI**: Light theme with animations and micro-interactions
- 🤖 **AI-powered tools**: Web search, subagent delegation, todo management, and planning mode
- 📱 **Mobile-friendly**: Responsive design with touch interactions

## Installed Extensions

The Pi Web UI comes with four powerful extensions pre-installed and ready to use:

### 1. Enhanced Plan Mode (`/plan`)

A comprehensive planning mode for complex tasks requiring careful analysis and execution planning.

**Slash Commands:**

| Command | Alias | Description |
|---------|-------|-------------|
| `/plan [description]` | - | Enter planning mode with wave-based analysis |
| `/approve` | `/a` | Approve the current plan |
| `/modify` | `/m` | Request plan modifications |
| `/reject` | `/r` | Cancel planning mode |
| `/execute` | - | Start execution after approval |
| `/cancel` | - | Abort planning |
| `/status` | - | Show current plan status |
| `/plans` | - | List all saved plans |
| `/continue` | - | Continue from a saved plan |
| `/done` | - | Mark plan as complete |

**Features:**
- Wave-based analysis using subagent tool
- YAML frontmatter plan schema
- Risk assessment matrix
- 4-option execution selection
- Plan lifecycle management

### 2. Subagent Tool

Delegate tasks to specialized agents with isolated context windows.

**Tool:** `subagent`

**Usage:**
```json
// Single task
{ "agent": "coder", "task": "Refactor the auth module" }

// Parallel tasks
{ "tasks": [
  { "agent": "coder", "task": "Fix bug A" },
  { "agent": "coder", "task": "Fix bug B" }
]}

// Chained tasks
{ "chain": [
  { "agent": "analyst", "task": "Analyze codebase" },
  { "agent": "coder", "task": "Implement based on: {previous}" }
]}
```

**Features:**
- Single, parallel, and chain execution modes
- Isolated context windows for each subagent
- JSON mode for structured output
- Usage statistics tracking (tokens, cost)
- **Agent Discovery**: Automatically discovers available agents from `~/.pi/agent/agents/` and injects them into the system prompt

### 3. Todo Management (`/todos`)

Manage tasks and todos within your sessions.

**Slash Command:**

| Command | Description |
|---------|-------------|
| `/todos` | Open the todo list viewer |

**Tool:** `todo`

**Actions:**
- `list` - Show all todos
- `add` - Create a new todo (requires `text` parameter)
- `toggle` - Mark todo as done/undone (requires `id` parameter)
- `clear` - Remove all completed todos

**Features:**
- State stored in session entries (branching-aware)
- Visual todo list with completion tracking
- Keyboard shortcuts (Esc to close)

### 4. Web Tools

Search and fetch web content directly from the chat.

**Slash Command:**

| Command | Description |
|---------|-------------|
| `/webtools-clear-cache` | Clear the web tools cache |

**Tools:**

| Tool | Description |
|------|-------------|
| `web_search` | Search the web using DuckDuckGo |
| `web_fetch` | Fetch web pages and convert to markdown |

**Features:**
- 15-minute result caching
- HTML to Markdown conversion
- Private IP blocking for security
- Truncation for large content (50KB/2000 lines)

### 5. Parallel Orchestrator (Experimental)

Verdent-like parallel agent orchestration using git worktrees for isolated development.

**Slash Commands:**

| Command | Description |
|---------|-------------|
| `/worktrees` | List all git worktrees with status |
| `/orchestrate <plan-file>` | Start orchestration from a modular plan |
| `/merge <worktree-id>` | Merge a worktree's changes |
| `/abort-worktree <id>` | Abort and cleanup a worktree |

**Tools:**

| Tool | Description |
|------|-------------|
| `worktree` | Manage git worktrees (create/list/delete/status) |
| `orchestrate` | Start orchestration from a plan file |
| `merge_worktree` | Merge worktree branch with merge/squash/rebase |

**Features:**
- Git worktree isolation for parallel development
- Plan parsing with dependency analysis
- Parallel task identification
- Multiple merge strategies
- Worktree status tracking

**Usage:**
```bash
# List worktrees
/worktrees

# Start orchestration from a plan
/orchestrate path/to/plan.md

# Merge completed work
/merge wt-abc123
```

## Development Environment

### VNC Environment with Google Chrome

This project includes a VNC (Virtual Network Computing) environment with **Google Chrome** browser pre-installed for browser automation and testing tasks.

**Chrome Installation:**
- **Binary location**: `/usr/bin/google-chrome`
- **Stable link**: `/usr/bin/google-chrome-stable` → `/opt/google/chrome/google-chrome`
- **Process**: Chrome runs with `--no-sandbox --disable-setuid-sandbox` flags for container compatibility

**Interacting with Chrome:**

Agents should use the **`chrome-cdp`** skill to interact with the live Chrome session:

```bash
# 1. List open tabs/pages
/root/.pi/agent/skills/chrome-cdp/scripts/cdp.mjs list

# 2. Take a screenshot of a page
/root/.pi/agent/skills/chrome-cdp/scripts/cdp.mjs shot <target-id> /tmp/screenshot.png

# 3. Navigate to a URL
/root/.pi/agent/skills/chrome-cdp/scripts/cdp.mjs nav <target-id> https://example.com

# 4. Click an element
/root/.pi/agent/skills/chrome-cdp/scripts/cdp.mjs click <target-id> 'button#submit'

# 5. Type text
/root/.pi/agent/skills/chrome-cdp/scripts/cdp.mjs type <target-id> 'Hello World'

# 6. Execute JavaScript
/root/.pi/agent/skills/chrome-cdp/scripts/cdp.mjs eval <target-id> 'document.title'

# 7. Get page HTML
/root/.pi/agent/skills/chrome-cdp/scripts/cdp.mjs html <target-id>
```

**Key Points:**
- Chrome must have **remote debugging enabled** (`chrome://inspect/#remote-debugging`)
- First connection to a tab requires clicking "Allow" in Chrome's debugging prompt
- Reuse the same approved tab for multiple operations to avoid repeated prompts
- The skill automatically creates per-tab daemons for stable connections

**Skill Documentation:** See `/root/.pi/agent/skills/chrome-cdp/SKILL.md` for complete details.

## Quick Start

### Prerequisites

- Node.js 20+
- npm or yarn
- Git
- Google Chrome (for browser automation tasks in VNC)

### Installation

```bash
# Clone the repository
git clone https://github.com/valtterimelkko/pi-web-ui.git
cd pi-web-ui

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your settings (see Configuration section)

# Build the project
npm run build

# Start the server
npm start
```

### Environment Configuration

Before running, you must configure the environment:

```bash
# Required in all environments
JWT_SECRET=your-random-secret-key-here    # Generate with: openssl rand -base64 32
CSRF_SECRET=your-csrf-secret-here         # Generate with: openssl rand -base64 32

# Required in production (bcrypt hash recommended)
AUTH_PASSWORD=$2b$10$...                  # Generate with: node -e "console.log(require('bcrypt').hashSync('password', 10))"

# Optional
PORT=3000                                 # Server port
ALLOWED_ORIGINS=http://localhost:5173     # CORS origins (comma-separated)
```

### Development

```bash
# Start development servers (both client and server)
npm run dev

# Run tests
npm test

# Run tests with coverage
npm run test:coverage

# Run E2E tests (requires production server running)
npm run test:e2e
```

### Updating the Pi SDK

The Web UI depends on `@mariozechner/pi-coding-agent` (the Pi SDK). This is a **separate dependency** from the Pi CLI tool installed globally — updating the CLI (`npm update -g @mariozechner/pi-coding-agent`) does **not** update the Web UI's copy.

To update the SDK in the Web UI:

```bash
cd pi-web-ui

# Check current versions
grep "pi-coding-agent" server/package.json  # server workspace dependency
grep "pi-coding-agent" package.json         # root workspace dependency

# Update both workspaces to latest
npm install @mariozechner/pi-coding-agent@latest -w server
npm install @mariozechner/pi-coding-agent@latest -w .

# Rebuild and check for type errors
npm run build

# If there are TypeScript errors, the SDK may have changed event types
# or API signatures. Check the changelog and fix accordingly.

# Run tests to verify
npm test

# Restart the service
sudo systemctl restart pi-web-ui
```

**Common issues after SDK updates:**
- **TypeScript errors** — Event type names may change (e.g., `auto_compaction_start` → `compaction_start`). Check `server/src/pi/event-forwarder.ts`.
- **API changes** — The `SessionManager` or `AgentSession` API may change. Check `server/src/pi/pi-service.ts`.
- **The Web UI calls `(sessionManager as any)._rewriteFile()`** to force immediate session file creation. If the SDK adds a public `flush()` method in the future, switch to that instead.

## How to Use

### Getting Started

1. **Login**: Open `http://localhost:5173` (dev) or your deployed URL
   - Default credentials: `admin` / `admin`
   - Change these in production!

2. **Create a Session**: Click the + button in the sidebar or start typing

3. **Send Messages**: Type in the input box and press Ctrl+Enter (or click Send)
   - Drag and drop files to attach them
   - Use @filename to reference files

### Interface Guide

**Chat Area (Center)**
- Messages appear with syntax highlighting for code
- Tool executions show as collapsible cards (click to expand)
- Thinking blocks can be toggled on/off
- Click the 🤖 icon to view the conversation tree

**Sidebar (Left)**
- Lists all sessions (web + CLI)
- Filter by project (cwd) or search by first message
- Archive sessions to declutter (syncs across devices)
- Rename sessions for better organization
- Active session highlighted in violet
- Click any session to switch
- Collapse with the ← button

**Status Bar (Bottom)**
- Connection status (green = ready, amber = thinking)
- Current model (click to change)
- Context usage bar
- Message count for current session

**Settings (Gear Icon)**
- Model selection with search
- Thinking level (none/low/medium/high)
- Toggle thinking blocks visibility

### Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl + Enter` | Send message |
| `Esc` | Close modals |
| `Ctrl + B` | Toggle sidebar |

### Using Extensions

Extensions add powerful capabilities to your conversations:

**Planning Complex Tasks:**
```
/plan Create a user authentication system with JWT tokens
```
The agent will enter plan mode, analyze the task in waves, and present a structured plan with risk assessment.

**Delegating to Subagents:**
Simply ask the agent to use subagents:
```
Analyze this codebase for security issues using subagents
```

**Managing Todos:**
```
Add a todo: Review the authentication middleware
```
View all todos with `/todos`

**Web Search:**
```
Search for the latest React best practices
```

**Fetching Web Pages:**
```
Fetch and summarize https://example.com/docs
```

### Session Management

**Creating Sessions**
- Click + in sidebar
- Or: type a message (auto-creates if none active)

**Switching Sessions**
- Click any session in sidebar
- Sessions are sorted by last activity
- Background sessions preserve their messages in cache

**Tree Navigation**
- Click the 🤖 icon in chat header
- Visual tree shows conversation branches
- Click any node to navigate there
- Fork button creates new branch

**Archiving Sessions**
- Hover session in sidebar
- Click 📁 icon to archive/unarchive
- Archived sessions are hidden but preserved
- Archive state syncs across devices

**Renaming Sessions**
- Hover session in sidebar
- Click ✏️ icon to rename
- Display name is persisted server-side

**Deleting Sessions**
- Hover session in sidebar
- Click 🗑️ icon
- Confirm deletion (cannot be undone)

**Exporting Sessions**
- Hover session in sidebar
- Click ⬇️ (download) icon
- Choose format: Markdown (.md), JSON (.json), or HTML (.html)

### File Operations

**File Browser**
- Browse button in chat (if implemented)
- Navigate directories with click
- Up arrow to go to parent
- Click file to preview (50KB limit)

**Attaching Files**
- Drag and drop into message input
- Or click paperclip icon
- Images are displayed inline
- Filenames are sanitized (spaces → underscores)

### Extension Interactions

When an extension requests UI input:
1. A modal appears automatically
2. Types: confirm (yes/no), select (dropdown), input (text), editor (multi-line)
3. Respond within 30 seconds (or request times out)
4. Click Cancel to abort

## Configuration

### Environment Variables

| Variable | Description | Required | Example |
|----------|-------------|----------|---------|
| `NODE_ENV` | Environment mode | No | `development` |
| `PORT` | Server port | No | `3000` |
| `JWT_SECRET` | JWT signing secret | Yes* | (generate) |
| `CSRF_SECRET` | CSRF token secret | Yes* | (generate) |
| `AUTH_PASSWORD` | Login password | Yes* | (bcrypt hash) |
| `ALLOWED_ORIGINS` | CORS origins | No | `http://localhost:5173` |

*Required in production mode

### Authentication

The web UI uses JWT-based authentication with httpOnly cookies:

1. Default credentials: `admin` / `admin` (change in production!)
2. Token expires after 15 minutes
3. CSRF token required for state-changing operations
4. In production, passwords must be bcrypt hashed

**Generate bcrypt hash:**
```bash
node -e "console.log(require('bcrypt').hashSync('your-password', 10))"
```

## Architecture

Pi Web UI uses a JSON-RPC 2.0 based WebSocket protocol for real-time communication with a **process-per-session** architecture for memory isolation and crash resilience.

### Key Features
- **Process-per-Session Architecture** - Each session runs in an isolated worker process
- **Per-session WebSocket connections** - Each session has its own WebSocket endpoint
- **Ref-based streaming** - Minimal re-renders during content streaming
- **Identity guards** - Prevents stale callbacks after session switches
- **LRU cache** - Automatic memory management for session data

### Process-per-Session Architecture

Each AI session runs in an isolated Node.js worker process:

```
┌─────────────────────────────────────────────────────────────────────┐
│                     MAIN SERVER PROCESS                              │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────┐     │
│  │ HTTP Server  │  │   Session    │  │  Worker Process       │     │
│  │ (Express)    │  │   Manager    │  │  Manager              │     │
│  │ WebSocket   │  │ (lifecycle)   │  │  (spawn/kill)         │     │
│  └──────┬───────┘  └──────────────┘  └───────────────────────┘     │
│         │                          │                                 │
│         │  spawns per-session worker processes                      │
│         ▼                                                            │
├─────────────────────────────────────────────────────────────────────┤
│                    WORKER PROCESS (one per session)                  │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────────┐ │
│  │ Pi SDK RPC   │  │   Event      │  │   stdin/stdout            │ │
│  │ Mode         │  │  Forwarder   │  │   (JSON-RPC protocol)      │ │
│  └──────────────┘  └──────────────┘  └───────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
```

**Benefits:** Memory isolation (512MB per worker), crash resilience, persistent sessions.

**Adjusting Worker Memory:**
```bash
# Edit systemd service
sudo systemctl edit pi-web-ui

# Add/modify:
[Service]
Environment="PI_WORKER_MEMORY=768"  # Increase to 768MB per worker
MemoryMax=8G                         # Increase total limit

# Apply
sudo systemctl daemon-reload
sudo systemctl restart pi-web-ui
```

### WebSocket Endpoints
- `/ws/sessions/:sessionId` - JSON-RPC 2.0 protocol
- `/ws` - Legacy protocol (deprecated)

See [docs/PROTOCOL.md](docs/PROTOCOL.md) for full protocol specification.
See [docs/PROCESS-ISOLATION-DESIGN.md](docs/PROCESS-ISOLATION-DESIGN.md) for detailed design documentation.

### Technology Stack

**Backend:**
- Node.js 20+ with Express
- WebSocket (ws library)
- Pi SDK (@mariozechner/pi-coding-agent)
- JWT + bcrypt for auth
- Vitest for testing

**Frontend:**
- React 18 with TypeScript
- Vite for building
- TailwindCSS for styling
- Zustand for state management
- react-virtuoso for virtualization
- Vitest for testing

**Testing:**
- Vitest for unit tests
- Playwright for E2E tests
- 100% test pass rate maintained

### Security

See [SECURITY.md](./SECURITY.md) for detailed security documentation.

### Architecture Documentation

For comprehensive architecture details, see:
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) - Full system architecture
- [docs/PROTOCOL.md](docs/PROTOCOL.md) - WebSocket protocol specification

## API

See [API.md](./API.md) for WebSocket protocol and REST API documentation.

## Testing

### Test Coverage

All tests currently passing:

```bash
# Run all tests
npm test

# Server tests (93 tests)
npm test -- --workspace=server

# Client tests (62 tests)
npm test -- --workspace=client

# E2E tests (9 tests)
npm run test:e2e
```

### Test Structure

```
tests/
├── e2e/                          # Playwright E2E tests
│   ├── auth.spec.ts             # Authentication flows
│   ├── smoke.spec.ts            # Critical path tests
│   └── core.spec.ts             # Core functionality
├── server/tests/unit/            # Server unit tests
│   ├── security/                # Auth, CSRF, rate limiting
│   ├── pi/                      # Pi service, session pool
│   └── websocket/               # Connection, handlers
└── client/tests/unit/            # Client unit tests
    ├── components/              # React components
    └── store/                   # Zustand stores
```

## Production Deployment

### Current Production Setup

The Pi Web UI is deployed at: **https://pi.letsautomate.work**

**Server Configuration:**
- Runs as systemd service (`pi-web-ui.service`)
- Port: 3456 (internal)
- Reverse proxy: Caddy (Docker container)
- Auto-restart on crash and system reboot

### Service Management

The application runs as a systemd service. Here are the commands to manage it:

```bash
# Check service status
sudo systemctl status pi-web-ui

# Start the service
sudo systemctl start pi-web-ui

# Stop the service
sudo systemctl stop pi-web-ui

# Restart the service
sudo systemctl restart pi-web-ui

# View logs
sudo journalctl -u pi-web-ui -f

# Enable auto-start on boot
sudo systemctl enable pi-web-ui

# Disable auto-start on boot
sudo systemctl disable pi-web-ui
```

### Security Requirements for Production

Before deploying to production:

1. **Generate secure secrets:**
   ```bash
   # JWT_SECRET
   openssl rand -base64 32
   
   # CSRF_SECRET
   openssl rand -base64 32
   ```

2. **Hash the password:**
   ```bash
   node -e "console.log(require('bcrypt').hashSync('your-password', 10))"
   ```

3. **Configure .env.production:**
   ```bash
   NODE_ENV=production
   PORT=3456
   JWT_SECRET=your-generated-secret
   CSRF_SECRET=your-generated-secret
   AUTH_PASSWORD=your-bcrypt-hash
   ALLOWED_ORIGINS=https://your-domain.com
   ```

### Default Login Credentials

**URL:** https://pi.letsautomate.work

**Password:** See your `.env.production` file

⚠️ **IMPORTANT:** Never commit `.env.production` to git!

### Updating the Application

To update the application after code changes:

```bash
cd /root/pi-web-ui

# Pull latest changes (if using git)
git pull origin master

# Rebuild the application
npm run build

# Restart the service
sudo systemctl restart pi-web-ui

# Check status
sudo systemctl status pi-web-ui
```

### Caddy Configuration

The Caddy reverse proxy configuration is located at:
`/root/n8n-docker-caddy/caddy_config/Caddyfile`

The Pi Web UI is configured with WebSocket support and security headers. To reload Caddy after configuration changes:

```bash
docker exec n8n-docker-caddy-caddy-1 caddy reload --config /etc/caddy/Caddyfile
```

### Troubleshooting Production

**Service won't start:**
```bash
# Check logs
sudo journalctl -u pi-web-ui -n 50

# Verify build exists
ls -la /root/pi-web-ui/server/dist/
ls -la /root/pi-web-ui/client/dist/

# Check port availability
sudo lsof -i :3456

# Verify environment variables
cat /root/pi-web-ui/.env.production

# Validate configuration via API
curl http://localhost:3456/api/config/validate
```

**Health check endpoints (for K8s/Docker):**
```bash
# Liveness probe - is server running?
curl http://localhost:3456/api/health/live

# Readiness probe - is server ready for traffic?
curl http://localhost:3456/api/health/ready
```

The readiness probe checks:
- Pi agent directory accessibility
- Required environment variables in production
- Memory usage (warns if > 90% heap)

**WebSocket connection issues:**
- Check Caddy logs: `docker logs n8n-docker-caddy-caddy-1`
- Verify ALLOWED_ORIGINS includes your domain

**Authentication failures:**
- Check JWT_SECRET is set and valid
- Verify AUTH_PASSWORD is bcrypt hash (not plain text)

**Permission errors:**
- Ensure service runs as root (for Pi SDK access): `User=root` in service file

---

See [DEPLOYMENT.md](./DEPLOYMENT.md) for additional deployment instructions.

## Troubleshooting

### WebSocket Connection Issues
- Check browser console for connection errors
- Verify `ALLOWED_ORIGINS` includes your URL
- Ensure JWT cookie is set (check Application tab in DevTools)

### Authentication Failures
- Default credentials: `admin` / `admin`
- Clear cookies and try again
- Check JWT_SECRET is set in .env
- In production, ensure password is bcrypt hash

### CLI Sessions Not Appearing
- Verify `~/.pi/agent/sessions/` exists
- Check server logs for file watcher errors
- Ensure Pi CLI has created sessions

### Monitoring Worker Crashes

Each session runs in an isolated worker process. If workers are crashing (especially due to OOM), you can monitor this via the API:

**Check worker health (no auth required):**
```bash
curl http://localhost:3456/api/health/workers
```

**View crash statistics (requires auth):**
```bash
curl -b cookies.txt http://localhost:3456/api/sessions/workers/crashes/stats
```

**View recent crashes (requires auth):**
```bash
curl -b cookies.txt http://localhost:3456/api/sessions/workers/crashes/recent?limit=10
```

**Crash types detected:**
| Type | Description | Action |
|------|-------------|--------|
| `oom_killed` | Out of memory (SIGKILL) | Increase `PI_WORKER_MEMORY` env var |
| `crashed` | Non-zero exit code | Check server logs for errors |
| `spawn_failed` | Worker failed to start | Verify `pi` CLI is in PATH |
| `signal_terminated` | Terminated by signal | Usually graceful shutdown |

**Adjusting worker memory:**
```bash
# Edit systemd service
sudo systemctl edit pi-web-ui

# Add/modify:
[Service]
Environment="PI_WORKER_MEMORY=768"  # Increase from 512MB to 768MB

# Apply
sudo systemctl daemon-reload
sudo systemctl restart pi-web-ui
```

### Build Errors
```bash
# Clean and rebuild
rm -rf node_modules server/node_modules client/node_modules
npm install
npm run build
```

### Test Failures
```bash
# Run specific test with verbose output
npm test -- --reporter=verbose server/tests/unit/security/auth.test.ts

# Run E2E tests in headed mode for debugging
npx playwright test --headed tests/e2e/auth.spec.ts
```

## Project Statistics

- **Total Files**: 80+ TypeScript/React files
- **Lines of Code**: ~15,000
- **Test Coverage**: Security (90%+), Backend (85%+), Frontend (70%+)
- **Dependencies**: 50+ production packages
- **Development Time**: 6 waves over 5 weeks

## Contributing

This project was built using the Pi Coding Agent with the following approach:
1. Security-first architecture design
2. Wave-based development (6 sequential waves)
3. Subagent delegation for parallel work
4. Continuous testing and documentation

See [AGENTS.md](./AGENTS.md) for architecture decisions and patterns.

## License

MIT License - see LICENSE file
