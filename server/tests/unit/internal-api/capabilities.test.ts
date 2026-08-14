import { describe, it, expect, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { Writable } from 'stream';
import { createCapabilitiesRoutes } from '../../../src/internal-api/routes/capabilities.js';

function createMockReq(url = '/api/v1/capabilities'): IncomingMessage {
  return {
    url,
    method: 'GET',
    headers: {},
  } as unknown as IncomingMessage;
}

function createMockRes(): ServerResponse & { body: string; statusCode: number } {
  const chunks: Buffer[] = [];
  const res = new Writable({
    write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void) {
      chunks.push(chunk);
      callback();
    },
  }) as unknown as ServerResponse & { body: string; statusCode: number };

  res.statusCode = 200;
  res.setHeader = vi.fn();
  res.writeHead = vi.fn(function (this: typeof res, code: number) {
    res.statusCode = code;
    return this;
  });
  res.end = vi.fn(function (this: typeof res, data?: string) {
    if (data) chunks.push(Buffer.from(data));
    res.body = Buffer.concat(chunks).toString();
    return this;
  });
  res.getHeader = vi.fn();

  return res;
}

describe('createCapabilitiesRoutes', () => {
  it('reports channel-backed Claude features and unavailable OpenCode', async () => {
    const routes = createCapabilitiesRoutes({
      claudeService: {
        isAvailable: vi.fn().mockResolvedValue(true),
        getBackendMode: vi.fn().mockResolvedValue('channel'),
        getProfiles: vi.fn().mockReturnValue([]),
      } as any,
      opencodeService: {
        isAvailable: vi.fn().mockResolvedValue(false),
        isEnabled: vi.fn().mockReturnValue(true),
      } as any,
      antigravityService: {
        isAvailable: vi.fn().mockResolvedValue(false),
      } as any,
      blockedPiProviders: ['openai', 'openrouter'],
    });

    const req = createMockReq();
    const res = createMockRes();

    await routes.handleGetCapabilities(req, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      status: 'ok',
      contract: {
        name: 'pi-web-ui-internal-api',
        majorVersion: 'v1',
        contractVersion: '1.19.0',
      },
      features: {
        retentionLeases: true,
        durableRetention: true,
        residentRetention: true,
        executionAdmission: true,
        runLivenessEvidence: true,
        sessionRecoveryEvidence: true,
        capacityEndpoint: '/api/v1/capacity',
        piProviderPolicy: {
          blockedProviders: ['openai', 'openrouter'],
        },
      },
      runtimes: {
        pi: {
          available: true,
          supportsFollowUp: true,
          followUpSemantics: 'queue_while_busy',
          supportsSteer: true,
          supportsSteerWhileBusy: true,
          supportsThinkingLevel: true,
        },
        claude: {
          available: true,
          backendMode: 'channel',
          supportsFollowUp: true,
          followUpSemantics: 'new_turn',
          supportsSteer: false,
          supportsSteerWhileBusy: false,
          supportsHeartbeat: true,
          supportsApprovals: true,
          supportsThinkingLevel: true,
        },
        opencode: {
          available: false,
          followUpSemantics: 'new_turn',
          supportsApprovals: true,
        },
      },
    });
  });

  /* eslint-disable @typescript-eslint/no-explicit-any -- focused service doubles expose only capability methods */
  it('27. reports structured interactive-question support only for the Claude SDK backend', async () => {
    const routes = createCapabilitiesRoutes({
      claudeService: {
        isAvailable: vi.fn().mockResolvedValue(true),
        getBackendMode: vi.fn().mockResolvedValue('sdk'),
        getProfiles: vi.fn().mockReturnValue([]),
      } as any,
      opencodeService: { isAvailable: vi.fn().mockResolvedValue(true), isEnabled: vi.fn().mockReturnValue(true) } as any,
      antigravityService: { isAvailable: vi.fn().mockResolvedValue(true) } as any,
    });
    const res = createMockRes();
    await routes.handleGetCapabilities(createMockReq(), res);
    const runtimes = JSON.parse(res.body).runtimes;
    expect(runtimes.claude).toMatchObject({
      followUpSemantics: 'new_turn',
      supportsInteractiveQuestions: true,
      supportsStructuredQuestionResponse: true,
    });
    expect(runtimes.pi.supportsInteractiveQuestions).toBe(false);
    expect(runtimes.opencode.supportsStructuredQuestionResponse).toBe(false);
    expect(runtimes.antigravity.followUpSemantics).toBe('new_turn');
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it('initializes Command Code before projecting its catalogue and effort capabilities', async () => {
    const init = vi.fn().mockResolvedValue(undefined);
    const routes = createCapabilitiesRoutes({
      claudeService: { isAvailable: vi.fn().mockResolvedValue(false), getBackendMode: vi.fn().mockResolvedValue('direct'), getProfiles: vi.fn().mockReturnValue([]) } as any,
      opencodeService: { isAvailable: vi.fn().mockResolvedValue(false), isEnabled: vi.fn().mockReturnValue(true) } as any,
      antigravityService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
      commandCodeService: {
        init,
        isEnabled: vi.fn().mockReturnValue(true),
        isShadowEnabled: vi.fn().mockReturnValue(true),
        isAvailable: vi.fn().mockReturnValue(true),
        getEffortCapabilities: vi.fn().mockReturnValue({}),
        getModels: vi.fn().mockReturnValue([]),
      } as any,
    });
    await routes.handleGetCapabilities(createMockReq(), createMockRes());
    expect(init).toHaveBeenCalledOnce();
  });

  it('advertises native effort support per Command Code model without enabling generic thinking levels', async () => {
    const routes = createCapabilitiesRoutes({
      claudeService: {
        isAvailable: vi.fn().mockResolvedValue(false),
        getBackendMode: vi.fn().mockResolvedValue('direct'),
        getProfiles: vi.fn().mockReturnValue([]),
      } as any,
      opencodeService: { isAvailable: vi.fn().mockResolvedValue(false), isEnabled: vi.fn().mockReturnValue(true) } as any,
      antigravityService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
      commandCodeService: {
        isEnabled: vi.fn().mockReturnValue(true),
        isAvailable: vi.fn().mockReturnValue(true),
        getEffortCapabilities: vi.fn().mockReturnValue({
          'qwen/qwen3.8-max': { supportsEffort: true, effortLevels: ['low', 'medium', 'xhigh'], defaultEffort: 'medium', source: 'live-preflight', capabilityHash: 'a'.repeat(64) },
          'meta/muse-spark-1.2-contributor': { supportsEffort: false, effortLevels: [], source: 'live-preflight', capabilityHash: 'b'.repeat(64) },
        }),
      } as any,
    });
    const res = createMockRes();
    await routes.handleGetCapabilities(createMockReq(), res);
    expect(JSON.parse(res.body).runtimes.commandcode).toMatchObject({
      supportsThinkingLevel: false,
      supportsEffort: true,
      effortCapabilities: {
        'qwen/qwen3.8-max': { supportsEffort: true, effortLevels: ['low', 'medium', 'xhigh'], defaultEffort: 'medium' },
        'meta/muse-spark-1.2-contributor': { supportsEffort: false, effortLevels: [] },
      },
    });
  });

  it('publishes the full Command Code model status projection alongside effort evidence', async () => {
    const routes = createCapabilitiesRoutes({
      claudeService: { isAvailable: vi.fn().mockResolvedValue(false), getBackendMode: vi.fn().mockResolvedValue('direct'), getProfiles: vi.fn().mockReturnValue([]) } as any,
      opencodeService: { isAvailable: vi.fn().mockResolvedValue(false), isEnabled: vi.fn().mockReturnValue(true) } as any,
      antigravityService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
      commandCodeService: {
        isEnabled: vi.fn().mockReturnValue(true),
        isShadowEnabled: vi.fn().mockReturnValue(true),
        isAvailable: vi.fn().mockReturnValue(true),
        isShadowAvailable: vi.fn().mockReturnValue(true),
        getModels: vi.fn().mockReturnValue([
          { id: 'qwen/qwen3.8-max', displayName: 'Qwen 3.8 Max', provider: 'command-code', reasoning: true, runnable: true, status: 'runnable', browserRunnable: true, supportsEffort: true, effortLevels: ['low', 'medium', 'xhigh'], defaultEffort: 'medium' },
          { id: 'meta/muse-spark-1.2-contributor', displayName: 'Muse Spark 1.2 Contributor', provider: 'command-code', reasoning: true, runnable: true, status: 'runnable', browserRunnable: false, supportsEffort: false, effortLevels: [] },
          { id: 'deepseek/deepseek-v4-pro', displayName: 'DeepSeek V4 Pro', provider: 'command-code', reasoning: true, runnable: false, status: 'evidence-only', browserRunnable: false, supportsEffort: true, effortLevels: ['high', 'max'] },
        ]),
        getEffortCapabilities: vi.fn().mockReturnValue({}),
      } as any,
    });
    const res = createMockRes();
    await routes.handleGetCapabilities(createMockReq(), res);
    expect(JSON.parse(res.body).runtimes.commandcode.modelCatalogue).toEqual([
      expect.objectContaining({ id: 'qwen/qwen3.8-max', status: 'runnable', browserRunnable: true }),
      expect.objectContaining({ id: 'meta/muse-spark-1.2-contributor', status: 'runnable', browserRunnable: false }),
      expect.objectContaining({ id: 'deepseek/deepseek-v4-pro', status: 'evidence-only', runnable: false }),
    ]);
  });

  it('keeps full discovered Command Code effort evidence separate from the shadow projection', async () => {
    const routes = createCapabilitiesRoutes({
      claudeService: { isAvailable: vi.fn().mockResolvedValue(false), getBackendMode: vi.fn().mockResolvedValue('direct'), getProfiles: vi.fn().mockReturnValue([]) } as any,
      opencodeService: { isAvailable: vi.fn().mockResolvedValue(false), isEnabled: vi.fn().mockReturnValue(true) } as any,
      antigravityService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
      commandCodeService: {
        isEnabled: vi.fn().mockReturnValue(true),
        isShadowEnabled: vi.fn().mockReturnValue(true),
        isAvailable: vi.fn().mockReturnValue(true),
        isShadowAvailable: vi.fn().mockReturnValue(true),
        getEffortCapabilities: vi.fn().mockReturnValue({
          'qwen/qwen3.8-max': { supportsEffort: true, effortLevels: ['low', 'medium', 'xhigh'], defaultEffort: 'medium', status: 'adjustable', source: 'live-preflight', capabilityHash: 'a'.repeat(64) },
          'meta/muse-spark-1.2-contributor': { supportsEffort: false, effortLevels: [], status: 'unavailable', source: 'live-preflight', capabilityHash: 'b'.repeat(64) },
          'deepseek/deepseek-v4-pro': { supportsEffort: true, effortLevels: ['high', 'max'], status: 'adjustable', source: 'live-preflight', capabilityHash: 'c'.repeat(64) },
        }),
        getShadowEffortCapabilities: vi.fn().mockReturnValue({
          'qwen/qwen3.8-max': { supportsEffort: true, effortLevels: ['low', 'medium', 'xhigh'], defaultEffort: 'medium', status: 'adjustable', source: 'live-preflight', capabilityHash: 'a'.repeat(64) },
          'meta/muse-spark-1.2-contributor': { supportsEffort: false, effortLevels: [], status: 'unavailable', source: 'live-preflight', capabilityHash: 'b'.repeat(64) },
        }),
      } as any,
    });
    const res = createMockRes();
    await routes.handleGetCapabilities(createMockReq(), res);
    expect(JSON.parse(res.body).runtimes.commandcode.effortCapabilities).toEqual(expect.objectContaining({
      'deepseek/deepseek-v4-pro': expect.objectContaining({ effortLevels: ['high', 'max'] }),
    }));
  });

  it('does not project browser-only Command Code catalogue evidence onto the shadow Internal API capability surface', async () => {
    const routes = createCapabilitiesRoutes({
      claudeService: { isAvailable: vi.fn().mockResolvedValue(false), getBackendMode: vi.fn().mockResolvedValue('direct'), getProfiles: vi.fn().mockReturnValue([]) } as any,
      opencodeService: { isAvailable: vi.fn().mockResolvedValue(false), isEnabled: vi.fn().mockReturnValue(true) } as any,
      antigravityService: { isAvailable: vi.fn().mockResolvedValue(false) } as any,
      commandCodeService: {
        isEnabled: vi.fn().mockReturnValue(true),
        isShadowEnabled: vi.fn().mockReturnValue(false),
        isAvailable: vi.fn().mockReturnValue(true),
        getModels: vi.fn().mockReturnValue([{ id: 'qwen/qwen3.8-max', status: 'evidence-only', runnable: false, browserRunnable: true }]),
        getEffortCapabilities: vi.fn().mockReturnValue({ 'qwen/qwen3.8-max': { supportsEffort: true, effortLevels: ['low', 'medium', 'xhigh'], status: 'adjustable', source: 'live-preflight', capabilityHash: 'a'.repeat(64) } }),
        getCatalogueMetadata: vi.fn().mockReturnValue({ availabilityStatus: 'available', checkedAt: '2026-08-08T03:00:00.000Z', source: 'live-discovery' }),
      } as any,
    });
    const res = createMockRes();
    await routes.handleGetCapabilities(createMockReq(), res);
    const runtime = JSON.parse(res.body).runtimes.commandcode;
    expect(runtime.enabled).toBe(false);
    expect(runtime.modelCatalogue).toEqual([]);
    expect(runtime.effortCapabilities).toEqual({});
    expect(runtime.catalogue).toBeUndefined();
  });

  it('downgrades Claude-specific capability flags in direct mode', async () => {
    const routes = createCapabilitiesRoutes({
      claudeService: {
        isAvailable: vi.fn().mockResolvedValue(true),
        getBackendMode: vi.fn().mockResolvedValue('direct'),
        getProfiles: vi.fn().mockReturnValue([]),
      } as any,
      opencodeService: {
        isAvailable: vi.fn().mockResolvedValue(true),
        isEnabled: vi.fn().mockReturnValue(true),
      } as any,
      antigravityService: {
        isAvailable: vi.fn().mockResolvedValue(true),
      } as any,
    });

    const req = createMockReq();
    const res = createMockRes();

    await routes.handleGetCapabilities(req, res);

    const body = JSON.parse(res.body);
    expect(body.runtimes.claude).toMatchObject({
      backendMode: 'direct',
      supportsHeartbeat: false,
      supportsApprovals: false,
      supportsReplayHistory: true,
    });
    expect(body.runtimes.opencode).toMatchObject({
      available: true,
      supportsFollowUp: true,
      supportsModelSwitch: true,
    });
  });

  // Phase 1.1 — disabled runtime must be advertised as enabled:false AND
  // available:false distinctly from "not installed", without silently
  // substituting another runtime. The opencode binary remains on PATH
  // (isAvailable() true) but OPENCODE_ENABLED=false (isEnabled() false).
  it('advertises OpenCode as enabled:false / available:false when disabled but installed', async () => {
    const routes = createCapabilitiesRoutes({
      claudeService: {
        isAvailable: vi.fn().mockResolvedValue(true),
        getBackendMode: vi.fn().mockResolvedValue('direct'),
        getProfiles: vi.fn().mockReturnValue([]),
      } as any,
      opencodeService: {
        isAvailable: vi.fn().mockResolvedValue(true),
        isEnabled: vi.fn().mockReturnValue(false),
      } as any,
      antigravityService: {
        isAvailable: vi.fn().mockResolvedValue(false),
      } as any,
    });

    const res = createMockRes();
    await routes.handleGetCapabilities(createMockReq(), res);

    const body = JSON.parse(res.body);
    expect(body.runtimes.opencode).toMatchObject({ enabled: false, available: false });
    // Other runtimes remain enabled and are not silently substituted.
    expect(body.runtimes.claude.enabled).toBe(true);
    expect(body.runtimes.pi.enabled).toBe(true);
    expect(body.runtimes.antigravity.enabled).toBe(true);
  });
});
