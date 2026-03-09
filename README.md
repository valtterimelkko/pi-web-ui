# Pi Web UI

A persistent, security-hardened web interface for the Pi Coding Agent.

## Features

- 🔐 **Security-first**: JWT auth, CSRF protection, WebSocket origin validation
- 💬 **Real-time chat**: Streaming responses with markdown support
- 🛠️ **Tool execution**: Collapsible tool cards with syntax highlighting
- 📁 **Session management**: Web + CLI session visibility with tree navigation
- 🔌 **Extension support**: Full extension UI protocol (confirm/select/input/editor)
- 📂 **File browser**: Secure file browsing and preview
- 🎨 **Beautiful UI**: Dark theme with animations and micro-interactions

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

## Deployment

See [DEPLOYMENT.md](./DEPLOYMENT.md) for production deployment instructions.

## License

MIT License - see LICENSE file
