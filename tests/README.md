# Pi Web UI Testing Suite

This directory contains comprehensive tests for the Pi Web UI project.

## Test Structure

```
tests/
├── server/                     # Server-side tests
│   └── unit/
│       ├── security/          # Security function tests
│       │   ├── auth.test.ts
│       │   ├── input-validation.test.ts
│       │   └── prompt-injection.test.ts
│       ├── websocket/         # WebSocket tests
│       │   └── connection.test.ts
│       ├── routes/            # API route tests
│       │   └── sessions.test.ts
│       └── pi-service.test.ts # Pi service tests
└── client/                     # Client-side tests
    ├── setup.ts               # Test setup and mocks
    └── unit/
        ├── components/        # Component tests
        │   └── Chat/
        │       └── MessageBubble.test.tsx
        └── store/             # State management tests
            └── sessionStore.test.ts
```

## Running Tests

### Run all tests
```bash
npm test
```

### Run server tests only
```bash
npm run test --workspace=server
```

### Run client tests only
```bash
npm run test --workspace=client
```

### Run tests with coverage
```bash
npm run test:coverage
```

### Run E2E tests
```bash
npm run test:e2e
```

### Manual testing (servers only)
```bash
./scripts/test-e2e.sh --manual
```

## Test Coverage Goals

| Module | Target Coverage |
|--------|-----------------|
| Security | 90%+ |
| Pi Service | 85%+ |
| WebSocket | 85%+ |
| API Routes | 80%+ |
| Frontend Components | 70%+ |

## Writing Tests

### Server Tests

Server tests use Vitest with Node.js environment:

```typescript
import { describe, it, expect } from 'vitest';
import { myFunction } from '../../../src/my-module.js';

describe('My Module', () => {
  it('should do something', () => {
    const result = myFunction();
    expect(result).toBe(true);
  });
});
```

### Client Tests

Client tests use Vitest with jsdom environment and React Testing Library:

```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MyComponent } from '../../../src/components/MyComponent';

describe('MyComponent', () => {
  it('renders correctly', () => {
    render(<MyComponent />);
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });
});
```

## Configuration

- Server: `server/vitest.config.ts`
- Client: `client/vitest.config.ts`

Both configs include coverage reporting with v8 provider.
