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
- Comprehensive test suite (security, backend, frontend)
- Full documentation (README, SECURITY, API, DEPLOYMENT, AGENTS)

### Key Capabilities

- **Full Pi Feature Parity**: All terminal features available in the browser
- **Real-time Streaming**: Character-by-character response streaming
- **Session Visibility**: See and manage both web and CLI sessions
- **Extension Support**: Full extension UI protocol for custom dialogs
- **Security Hardened**: JWT, CSRF, origin validation, rate limiting
- **Production Ready**: systemd, Nginx, and Docker deployment configs

## Features

- 🔐 **Security-first**: JWT auth, CSRF protection, WebSocket origin validation
- 💬 **Real-time chat**: Streaming responses with markdown support
- 🛠️ **Tool execution**: Collapsible tool cards with syntax highlighting
- 📁 **Session management**: Web + CLI session visibility with tree navigation
- 🔌 **Extension support**: Full extension UI protocol (confirm/select/input/editor)
- 📂 **File browser**: Secure file browsing and preview
- 🎨 **Beautiful UI**: Dark theme with animations and micro-interactions
- 🤖 **AI-powered tools**: Web search, subagent delegation, todo management, and planning mode

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

## Quick Start

### Prerequisites

- Node.js 20+
- npm or yarn
- Git

### Installation

```bash
# Clone the repository
git clone https://github.com/valtterimelkko/pi-web-ui.git
cd pi-web-ui

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your settings

# Build the project
npm run build

# Start the server
npm start
```

### Development

```bash
# Start development servers (both client and server)
npm run dev

# Run tests
npm test

# Run tests with coverage
npm run test:coverage
```

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
- Tool executions show as collapsible cards
- Thinking blocks can be toggled on/off
- Click the 🤖 icon to view the conversation tree

**Sidebar (Left)**
- Lists all sessions (web + CLI)
- Filter by project (cwd) or search by first message
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

**Tree Navigation**
- Click the 🤖 icon in chat header
- Visual tree shows conversation branches
- Click any node to navigate there
- Fork button creates new branch

**Deleting Sessions**
- Hover session in sidebar
- Click 🗑️ icon
- Confirm deletion (cannot be undone)

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

### Extension Interactions

When an extension requests UI input:
1. A modal appears automatically
2. Types: confirm (yes/no), select (dropdown), input (text), editor (multi-line)
3. Respond within 30 seconds (or request times out)
4. Click Cancel to abort

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `NODE_ENV` | Environment mode | `development` |
| `PI_WEB_UI_PORT` | Server port | `3000` |
| `JWT_SECRET` | JWT signing secret | (required) |
| `CSRF_SECRET` | CSRF token secret | (required) |
| `ALLOWED_ORIGINS` | CORS origins | `http://localhost:5173` |

### Authentication

The web UI uses JWT-based authentication with httpOnly cookies:

1. Default credentials: `admin` / `admin` (change in production!)
2. Token expires after 15 minutes
3. CSRF token required for state-changing operations

## Architecture

### Technology Stack

**Backend:**
- Node.js 20+ with Express
- WebSocket (ws library)
- Pi SDK (@mariozechner/pi-coding-agent)
- JWT + bcrypt for auth

**Frontend:**
- React 18 with TypeScript
- Vite for building
- TailwindCSS for styling
- Zustand for state management

### Security

See [SECURITY.md](./SECURITY.md) for detailed security documentation.

## API

See [API.md](./API.md) for WebSocket protocol and REST API documentation.

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

### Default Login Credentials

**URL:** https://pi.letsautomate.work

**Password:** `ChangeMeNow123!`

⚠️ **IMPORTANT:** Change the password immediately after first login by editing `/root/pi-web-ui/.env.production` and restarting the service.

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

### Environment Variables

Production environment variables are stored in:
`/root/pi-web-ui/.env.production`

Key variables:
- `PORT=3456` - Internal server port
- `NODE_ENV=production` - Production mode
- `AUTH_PASSWORD` - Login password (CHANGE THIS!)
- `ALLOWED_ORIGINS=https://pi.letsautomate.work` - CORS origins
- `JWT_SECRET` - JWT signing secret

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
```

**WebSocket connection issues:**
- Check Caddy logs: `docker logs n8n-docker-caddy-caddy-1`
- Verify ALLOWED_ORIGINS includes `https://pi.letsautomate.work`

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

### CLI Sessions Not Appearing
- Verify `~/.pi/agent/sessions/` exists
- Check server logs for file watcher errors
- Ensure Pi CLI has created sessions

### Build Errors
```bash
# Clean and rebuild
rm -rf node_modules server/node_modules client/node_modules
npm install
npm run build
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
