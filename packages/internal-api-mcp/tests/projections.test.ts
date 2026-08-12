import { describe, expect, it } from 'vitest';
import {
  projectCapabilities,
  projectCreateSession,
  projectDispatch,
  projectModels,
  projectRun,
  projectSessions,
  projectTranscript,
} from '../src/projections.js';
import type {
  CapabilitiesResponse,
  CreateSessionResponse,
  DispatchResponse,
  ModelsResponse,
  RunReceipt,
  SessionsResponse,
  TranscriptResponse,
} from '../src/internal-api-types.js';

const baseCapabilities: CapabilitiesResponse = {
  status: 'ok',
  contract: {
    name: 'pi-web-ui-internal-api',
    routePrefix: '/api/v1',
    majorVersion: 'v1',
    contractVersion: '1.19.0',
    stability: 'beta',
    contractDoc: 'docs/INTERNAL-API-CONTRACT.md',
    bearerToken: 'should-not-escape',
  },
  features: {
    piProviderPolicy: { blockedProviders: ['openai', 'openrouter', 'secret-provider'] },
    commandCode: { enabled: true },
  },
  runtimes: {
    pi: { available: true, enabled: true, backendMode: 'native', secret: 'no' },
    claude: { available: true, enabled: true, backendMode: 'sdk' },
    opencode: { available: false, enabled: false, backendMode: 'server' },
    antigravity: { available: false, enabled: false, backendMode: 'subprocess' },
    commandcode: { available: true, enabled: true },
  },
};

describe('MCP output projections', () => {
  it('projects only the four ordinary runtime capabilities and provider policy', () => {
    const result = projectCapabilities(baseCapabilities);
    expect(Object.keys(result.runtimes)).toEqual(['pi', 'claude', 'opencode', 'antigravity']);
    expect(result.providerPolicy.blockedProviders).toEqual(['openai', 'openrouter', 'secret-provider']);
    expect(JSON.stringify(result)).not.toContain('commandCode');
    expect(JSON.stringify(result)).not.toContain('bearerToken');
    expect(JSON.stringify(result)).not.toContain('futureSecret');
  });

  it('projects models through an allowlist and excludes Command Code entries', () => {
    const response: ModelsResponse = {
      models: {
        pi: [{ id: 'pi/model', displayName: 'Pi', provider: 'openai-codex', contextWindow: 1000, secret: 'token' }],
        claude: [{ id: 'profile:glm52', displayName: 'GLM', backend: 'sdk-subscription', claudeModel: 'sonnet' }],
        commandcode: [{ id: 'qwen/qwen3.8-max', displayName: 'must-not-appear' }],
      },
    };

    const result = projectModels(response);
    expect(Object.keys(result.models)).toEqual(['pi', 'claude']);
    expect(result.models.pi).toEqual([{ id: 'pi/model', displayName: 'Pi', provider: 'openai-codex', contextWindow: 1000 }]);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('qwen');
  });

  it('bounds and projects session metadata without native paths or unknown fields', () => {
    const response: SessionsResponse = {
      sessions: [{
        sessionId: 'canonical-1',
        sessionPath: '/home/operator/.pi/agent/sessions/native.jsonl',
        runtime: 'pi',
        status: 'idle',
        model: 'model-1',
        modelSelector: 'model-1',
        executionInstanceId: 'pi-local-default',
        createdAt: '2026-01-01T00:00:00.000Z',
        lastActivity: '2026-01-01T00:00:01.000Z',
        firstMessage: 'First prompt',
        messageCount: 2,
        cwd: '/secret/worktree',
        tokenPath: '/secret/token',
      }],
    };

    const result = projectSessions(response);
    expect(result).toEqual({ sessions: [{
      sessionId: 'canonical-1',
      runtime: 'pi',
      status: 'idle',
      model: 'model-1',
      modelSelector: 'model-1',
      executionInstanceId: 'pi-local-default',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastActivity: '2026-01-01T00:00:01.000Z',
      firstMessage: 'First prompt',
      messageCount: 2,
    }] });
    expect(JSON.stringify(result)).not.toContain('native.jsonl');
    expect(JSON.stringify(result)).not.toContain('secret/token');
  });

  it('projects create and dispatch responses without paths or arbitrary fields', () => {
    const session: CreateSessionResponse = {
      sessionId: 'session-1',
      sessionPath: '/native/path',
      runtime: 'pi',
      model: 'model-1',
      modelSelector: 'model-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      cwd: '/secret',
      token: 'secret-token',
    };
    const dispatch: DispatchResponse = {
      sessionId: 'session-1',
      runId: 'run-1',
      detached: true,
      duplicate: false,
      status: 'accepted',
      raw: 'secret',
    };

    expect(projectCreateSession(session)).toEqual({
      sessionId: 'session-1',
      runtime: 'pi',
      model: 'model-1',
      modelSelector: 'model-1',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(projectDispatch(dispatch)).toEqual({
      sessionId: 'session-1',
      runId: 'run-1',
      detached: true,
      duplicate: false,
      status: 'accepted',
    });
    expect(JSON.stringify({ session: projectCreateSession(session), dispatch: projectDispatch(dispatch) })).not.toContain('secret-token');
  });

  it('preserves failure, output evidence, and liveness distinctions in run projections', () => {
    const receipt: RunReceipt = {
      runId: 'run-1',
      sessionId: 'session-1',
      runtime: 'pi',
      model: 'model-1',
      status: 'failed',
      terminalAt: '2026-01-01T00:00:02.000Z',
      errorCode: 'TURN_STALLED',
      outputEvidence: { disposition: 'unknown', assistantMessages: 0, assistantTextChars: 0 },
      liveness: { cessation: { state: 'unknown', basis: 'watchdog' }, idleTimeoutMs: 2000 },
      prompt: 'must-not-appear',
      token: 'must-not-appear',
    };

    const result = projectRun(receipt);
    expect(result.status).toBe('failed');
    expect(result.errorCode).toBe('TURN_STALLED');
    expect(result.outputEvidence?.disposition).toBe('unknown');
    expect(result.liveness?.cessation?.state).toBe('unknown');
    expect(JSON.stringify(result)).not.toContain('must-not-appear');
  });

  it('rejects run and transcript projections for excluded runtimes', () => {
    expect(() => projectRun({ runId: 'run-1', sessionId: 'session-1', runtime: 'commandcode', status: 'completed' })).toThrow(/unsupported runtime/i);
    expect(() => projectTranscript({ sessionId: 'session-1', runtime: 'commandcode', items: [] }, 4096)).toThrow(/unsupported runtime/i);
  });

  it('returns valid explicit UTF-8-safe truncation metadata after post-parse projection', () => {
    const response: TranscriptResponse = {
      sessionId: 'session-1',
      runtime: 'pi',
      scope: 'visible_full',
      itemCount: 2,
      truncated: false,
      items: [
        { kind: 'user', text: '🙂'.repeat(100) },
        { kind: 'assistant', text: 'Answer with café and more text.' },
      ],
    };

    const result = projectTranscript(response, 300);
    expect(result.outputTruncated).toBe(true);
    expect(result.projectedByteCount).toBeGreaterThan(300);
    expect(typeof result.excerpt).toBe('string');
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    expect(result.excerpt).not.toContain('\ufffd');
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8')).toBeLessThanOrEqual(300);
  });

  it('keeps a small transcript intact and reports its exact projected byte count', () => {
    const response: TranscriptResponse = {
      sessionId: 'session-1',
      runtime: 'pi',
      scope: 'visible_recent',
      itemCount: 1,
      truncated: false,
      items: [{ kind: 'assistant', text: 'Done.' }],
    };
    const result = projectTranscript(response, 4096);
    expect(result.outputTruncated).toBe(false);
    expect(result.projectedByteCount).toBe(Buffer.byteLength(JSON.stringify({
      sessionId: 'session-1',
      runtime: 'pi',
      scope: 'visible_recent',
      itemCount: 1,
      truncated: false,
      items: [{ kind: 'assistant', text: 'Done.' }],
    }), 'utf8'));
    expect(result.items).toHaveLength(1);
  });

  it('bounds session and model lists deterministically', () => {
    const sessions: SessionsResponse = { sessions: Array.from({ length: 1200 }, (_, index) => ({ sessionId: `session-${index}`, runtime: 'pi' })) };
    const models: ModelsResponse = { models: { pi: Array.from({ length: 300 }, (_, index) => ({ id: `model-${index}` })) } };
    expect(projectSessions(sessions).sessions).toHaveLength(200);
    expect(projectModels(models).models.pi).toHaveLength(200);
  });
});
