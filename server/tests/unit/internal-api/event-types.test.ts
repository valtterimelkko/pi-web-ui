import { describe, it, expect } from 'vitest';
import type { ServerResponse } from 'http';
import { SSE_EVENT_TYPES } from '../../../src/internal-api/types.js';
import {
  EVENT_TYPE_REGISTRY,
  REGISTRY_EVENT_TYPES,
  registryCoversSseEventTypes,
} from '../../../src/internal-api/event-types.js';
import { createEventTypesRoutes } from '../../../src/internal-api/routes/event-types.js';

function mockRes(): ServerResponse & { statusCode: number; body: string } {
  const r = { statusCode: 0, body: '' } as unknown as ServerResponse & { statusCode: number; body: string };
  (r as Record<string, unknown>).writeHead = (code: number) => { r.statusCode = code; return r; };
  (r as Record<string, unknown>).end = (data?: string) => { r.body = typeof data === 'string' ? data : ''; return r; };
  return r;
}

describe('event-type registry (Task 12)', () => {
  it('covers every contracted SSE_EVENT_TYPES value (drift guard)', () => {
    expect(registryCoversSseEventTypes()).toBe(true);
    for (const t of Object.values(SSE_EVENT_TYPES)) {
      expect(REGISTRY_EVENT_TYPES).toContain(t);
    }
  });

  it('every entry has type/description/category/verbosity', () => {
    for (const e of EVENT_TYPE_REGISTRY) {
      expect(e.type.length).toBeGreaterThan(0);
      expect(e.description.length).toBeGreaterThan(0);
      expect(['agent', 'message', 'tool', 'control']).toContain(e.category);
      expect(e.verbosity.length).toBeGreaterThan(0);
      expect(e.verbosity.every((v) => v === 'full' || v === 'tasks')).toBe(true);
    }
  });

  it('includes the core lifecycle events an agent relies on', () => {
    const types = REGISTRY_EVENT_TYPES;
    expect(types).toContain('agent_start');
    expect(types).toContain('agent_end');
    expect(types).toContain('message_update');
    expect(types).toContain('tool_execution_start');
    expect(types).toContain('tool_execution_end');
  });

  it('GET /events/types returns the registry as JSON', async () => {
    const routes = createEventTypesRoutes();
    const res = mockRes();
    await routes.handleGetEventTypes({} as never, res);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.eventTypes)).toBe(true);
    expect(body.eventTypes.length).toBe(EVENT_TYPE_REGISTRY.length);
    expect(body.eventTypes[0]).toHaveProperty('type');
    expect(body.eventTypes[0]).toHaveProperty('description');
  });
});
