import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenCodeEventAdapter } from '../../../src/opencode/opencode-event-adapter.js';
import type { OpenCodeSSEEvent } from '../../../src/opencode/opencode-types.js';

describe('OpenCode Permission Bridge', () => {
  let adapter: OpenCodeEventAdapter;

  beforeEach(() => {
    adapter = new OpenCodeEventAdapter();
  });

  describe('SSE permission events → normalized permission_request events', () => {
    it('maps permission.asked with top-level id and nested permission metadata to permission_request', () => {
      const event: OpenCodeSSEEvent = {
        type: 'permission.asked',
        properties: {
          sessionID: 'oc-sess-1',
          id: 'perm-top-level',
          permission: {
            tool: 'bash',
            metadata: {
              toolName: 'bash',
              input: { command: 'npm test' },
            },
          },
        },
      };

      const normalized = adapter.adaptSSEEvent(event, 'pi-session-1');

      expect(normalized.length).toBe(1);
      expect(normalized[0].type).toBe('permission_request');
      expect(normalized[0].data).toMatchObject({
        permissionId: 'perm-top-level',
        toolName: 'bash',
        args: { command: 'npm test' },
      });
    });

    it('maps permission.asked with top-level fields to permission_request', () => {
      const event: OpenCodeSSEEvent = {
        type: 'permission.asked',
        properties: {
          sessionID: 'oc-sess-1',
          id: 'perm-flat',
          tool: 'edit',
          args: { filePath: '/tmp/a.txt' },
        },
      };

      const normalized = adapter.adaptSSEEvent(event, 'pi-session-1');

      expect(normalized.length).toBe(1);
      expect(normalized[0].data).toMatchObject({
        permissionId: 'perm-flat',
        toolName: 'edit',
        args: { filePath: '/tmp/a.txt' },
      });
    });

    it('ignores permission.asked without any permission id', () => {
      const event: OpenCodeSSEEvent = {
        type: 'permission.asked',
        properties: {
          sessionID: 'oc-sess-1',
          permission: {
            tool: 'bash',
          },
        },
      };

      const normalized = adapter.adaptSSEEvent(event, 'pi-session-1');

      expect(normalized).toEqual([]);
    });

    it('maps permission.updated with status=pending to permission_request', () => {
      const event: OpenCodeSSEEvent = {
        type: 'permission.updated',
        properties: {
          sessionId: 'oc-sess-1',
          permission: {
            id: 'perm-123',
            status: 'pending',
            tool: 'bash',
            metadata: {
              toolName: 'bash',
              input: { command: 'rm -rf /tmp/test' },
            },
          },
        },
      };

      const normalized = adapter.adaptSSEEvent(event, 'pi-session-1');

      expect(normalized.length).toBe(1);
      expect(normalized[0].type).toBe('permission_request');
      expect(normalized[0].data).toMatchObject({
        permissionId: 'perm-123',
        toolName: 'bash',
        args: { command: 'rm -rf /tmp/test' },
        title: 'Allow bash?',
      });
    });

    it('maps permission.updated with undefined status to permission_request', () => {
      const event: OpenCodeSSEEvent = {
        type: 'permission.updated',
        properties: {
          sessionId: 'oc-sess-1',
          permission: {
            id: 'perm-456',
            tool: 'write_file',
          },
        },
      };

      const normalized = adapter.adaptSSEEvent(event, 'pi-session-1');

      expect(normalized.length).toBe(1);
      expect(normalized[0].type).toBe('permission_request');
      expect(normalized[0].data).toMatchObject({
        permissionId: 'perm-456',
        toolName: 'write_file',
      });
    });

    it('ignores permission.updated with status=approved', () => {
      const event: OpenCodeSSEEvent = {
        type: 'permission.updated',
        properties: {
          sessionId: 'oc-sess-1',
          permission: {
            id: 'perm-789',
            status: 'approved',
            tool: 'bash',
          },
        },
      };

      const normalized = adapter.adaptSSEEvent(event, 'pi-session-1');
      expect(normalized).toEqual([]);
    });

    it('ignores permission.updated with status=denied', () => {
      const event: OpenCodeSSEEvent = {
        type: 'permission.updated',
        properties: {
          sessionId: 'oc-sess-1',
          permission: {
            id: 'perm-789',
            status: 'denied',
            tool: 'bash',
          },
        },
      };

      const normalized = adapter.adaptSSEEvent(event, 'pi-session-1');
      expect(normalized).toEqual([]);
    });

    it('ignores permission.updated with no permission object', () => {
      const event: OpenCodeSSEEvent = {
        type: 'permission.updated',
        properties: {},
      };

      const normalized = adapter.adaptSSEEvent(event, 'pi-session-1');
      expect(normalized).toEqual([]);
    });

    it('uses metadata.toolName over permission.tool for toolName', () => {
      const event: OpenCodeSSEEvent = {
        type: 'permission.updated',
        properties: {
          sessionId: 'oc-sess-1',
          permission: {
            id: 'perm-100',
            status: 'pending',
            tool: 'generic_tool',
            metadata: {
              toolName: 'specific_bash_command',
              input: { command: 'ls' },
            },
          },
        },
      };

      const normalized = adapter.adaptSSEEvent(event, 'pi-session-1');

      expect(normalized[0].data).toMatchObject({
        toolName: 'specific_bash_command',
      });
    });

    it('falls back to unknown toolName when neither metadata nor tool is set', () => {
      const event: OpenCodeSSEEvent = {
        type: 'permission.updated',
        properties: {
          sessionId: 'oc-sess-1',
          permission: {
            id: 'perm-200',
            status: 'pending',
          },
        },
      };

      const normalized = adapter.adaptSSEEvent(event, 'pi-session-1');

      expect(normalized[0].data).toMatchObject({
        toolName: 'unknown',
      });
    });

    it('includes args from metadata.input when available', () => {
      const event: OpenCodeSSEEvent = {
        type: 'permission.updated',
        properties: {
          sessionId: 'oc-sess-1',
          permission: {
            id: 'perm-300',
            status: 'pending',
            metadata: {
              toolName: 'edit_file',
              input: { path: '/foo/bar.ts', content: 'hello' },
            },
          },
        },
      };

      const normalized = adapter.adaptSSEEvent(event, 'pi-session-1');

      expect(normalized[0].data).toMatchObject({
        args: { path: '/foo/bar.ts', content: 'hello' },
      });
    });

    it('includes description with tool name and args formatted', () => {
      const event: OpenCodeSSEEvent = {
        type: 'permission.updated',
        properties: {
          sessionId: 'oc-sess-1',
          permission: {
            id: 'perm-400',
            status: 'pending',
            tool: 'bash',
            metadata: {
              toolName: 'bash',
              input: { command: 'npm test' },
            },
          },
        },
      };

      const normalized = adapter.adaptSSEEvent(event, 'pi-session-1');

      const description = (normalized[0].data as Record<string, unknown>).description as string;
      expect(description).toContain('bash');
      expect(description).toContain('npm test');
    });
  });

  describe('permission tracking in service context', () => {
    it('permission_request events have the correct session ID', () => {
      const event: OpenCodeSSEEvent = {
        type: 'permission.updated',
        properties: {
          sessionId: 'oc-sess-abc',
          permission: {
            id: 'perm-x',
            status: 'pending',
            tool: 'bash',
          },
        },
      };

      const normalized = adapter.adaptSSEEvent(event, 'my-pi-session-id');

      expect(normalized[0].sessionId).toBe('my-pi-session-id');
      expect(normalized[0].timestamp).toBeDefined();
    });
  });

  describe('permission reply flow via client', () => {
    it('replyPermission sends approved=true as always to reduce repeat prompts', async () => {
      const { OpenCodeClient } = await import('../../../src/opencode/opencode-client.js');

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', mockFetch);

      try {
        const client = new OpenCodeClient('http://localhost:4096', {});
        await client.replyPermission('sess-1', '/root', 'perm-1', true);

        const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('http://localhost:4096/session/sess-1/permissions/perm-1?directory=%2Froot');
        expect(opts.method).toBe('POST');
        expect(JSON.parse(opts.body as string)).toEqual({ response: 'always' });
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('replyPermission sends approved=false when rejected', async () => {
      const { OpenCodeClient } = await import('../../../src/opencode/opencode-client.js');

      const mockFetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      vi.stubGlobal('fetch', mockFetch);

      try {
        const client = new OpenCodeClient('http://localhost:4096', {});
        await client.replyPermission('sess-1', '/root', 'perm-2', false);

        const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
        expect(JSON.parse(opts.body as string)).toEqual({ response: 'reject' });
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
