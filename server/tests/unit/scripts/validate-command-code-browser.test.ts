import { describe, expect, it } from 'vitest';
import {
  assertBrowserInternalApiIsolation,
  assertBrowserWebSocketEvidence,
} from '../../../../scripts/command-code-browser-validation.mjs';

const model = {
  id: 'qwen/qwen3.8-max',
  provider: 'command-code',
  supportsEffort: true,
  effortLevels: ['low', 'medium', 'xhigh'],
  defaultEffort: 'medium',
  effortCapabilityHash: 'a'.repeat(64),
};

const validEvidence = {
  availability: { type: 'commandcode_available', available: true, enabled: true, models: [model], error: null },
  created: { type: 'session_created', sessionId: 'commandcode-1', sessionPath: 'commandcode-1', sdkType: 'commandcode', model: model.id, effort: 'medium', requestedEffort: 'medium', acceptedEffort: 'medium', effortSource: 'explicit', defaultEffort: 'medium' },
  events: [{ type: 'agent_start' }, { type: 'message_update' }, { type: 'message_end' }, { type: 'agent_end' }],
  assistantText: 'COMMAND-CODE-BROWSER-LIVE-OK',
  replayAssistantText: 'COMMAND-CODE-BROWSER-LIVE-OK',
};

const museEvidence = {
  availability: {
    type: 'commandcode_available', available: true, enabled: true,
    models: [{ id: 'meta/muse-spark-1.2-contributor', provider: 'command-code', supportsEffort: false, effortLevels: [], browserRunnable: true }],
    error: null,
  },
  created: {
    type: 'session_created', sessionId: 'commandcode-muse', sessionPath: 'commandcode-muse',
    sdkType: 'commandcode', model: 'meta/muse-spark-1.2-contributor', effortSource: 'none', effortCapabilityHash: 'b'.repeat(64),
  },
  replaySession: {
    type: 'session_switched', sessionId: 'commandcode-muse', sessionPath: 'commandcode-muse',
    sdkType: 'commandcode', model: 'meta/muse-spark-1.2-contributor', effortSource: 'none', effortCapabilityHash: 'b'.repeat(64),
  },
  events: [{ type: 'agent_start' }, { type: 'message_update' }, { type: 'message_end' }, { type: 'agent_end' }],
  assistantText: 'MUSE-LIVE-OK',
  replayAssistantText: 'MUSE-LIVE-OK',
};

describe('Command Code browser validation evidence', () => {
  it('requires the exact availability, session, lifecycle, and assistant-output evidence', () => {
    expect(() => assertBrowserWebSocketEvidence(validEvidence)).not.toThrow();
    expect(() => assertBrowserWebSocketEvidence({ ...validEvidence, assistantText: '' })).toThrow(/assistant output/i);
    expect(() => assertBrowserWebSocketEvidence({ ...validEvidence, created: { ...validEvidence.created, model: 'qwen/alias' } })).toThrow(/exact model/i);
  });

  it('requires explicit Qwen provenance and rejects all Muse effort metadata', () => {
    expect(() => assertBrowserWebSocketEvidence({
      ...validEvidence,
      created: { ...validEvidence.created, effortSource: 'explicit', defaultEffort: 'medium' },
      replaySession: { type: 'session_switched', sessionId: 'commandcode-1', sessionPath: 'commandcode-1', sdkType: 'commandcode', model: model.id, effort: 'medium', requestedEffort: 'medium', acceptedEffort: 'medium', effortSource: 'explicit', defaultEffort: 'medium' },
    })).not.toThrow();
    expect(() => assertBrowserWebSocketEvidence({
      ...museEvidence,
      created: { ...museEvidence.created, acceptedEffort: 'medium' },
    }, { model: 'meta/muse-spark-1.2-contributor', effort: undefined, expectedText: 'MUSE-LIVE-OK' })).toThrow(/effort/i);
    expect(() => assertBrowserWebSocketEvidence({
      ...museEvidence,
      replaySession: { ...museEvidence.replaySession, effortEvidenceMethod: 'provider-event' },
    }, { model: 'meta/muse-spark-1.2-contributor', effort: undefined, expectedText: 'MUSE-LIVE-OK' })).toThrow(/effort/i);
  });

  it('accepts Muse browser evidence without inventing native effort', () => {
    expect(() => assertBrowserWebSocketEvidence(museEvidence, {
      model: 'meta/muse-spark-1.2-contributor', effort: undefined, expectedText: 'MUSE-LIVE-OK',
    })).not.toThrow();
    expect(() => assertBrowserWebSocketEvidence({ ...museEvidence, created: { ...museEvidence.created, effort: 'medium' } }, {
      model: 'meta/muse-spark-1.2-contributor', effort: undefined, expectedText: 'MUSE-LIVE-OK',
    })).toThrow(/effort/i);
    expect(() => assertBrowserWebSocketEvidence({ ...museEvidence, replaySession: { ...museEvidence.replaySession, effort: 'medium' } }, {
      model: 'meta/muse-spark-1.2-contributor', effort: undefined, expectedText: 'MUSE-LIVE-OK',
    })).toThrow(/effort/i);
  });

  it('requires the browser session to stay outside the Internal API shadow surface', () => {
    expect(() => assertBrowserInternalApiIsolation({
      sessionId: 'commandcode-1',
      capabilities: { runtimes: { commandcode: { available: false, enabled: false } } },
      models: { models: { commandcode: [] } },
      sessions: { sessions: [] },
      sessionRootStatus: 404,
      sessionInfoStatus: 404,
      hiddenSurfaceStatuses: { history: 404, transcript: 404, evidence: 404, diagnostics: 404, notifications: 404, approvals: 404, transfer: 404, receipt: 404 },
    })).not.toThrow();
    expect(() => assertBrowserInternalApiIsolation({
      sessionId: 'commandcode-1',
      capabilities: { runtimes: { commandcode: { available: true, enabled: true } } },
      models: { models: { commandcode: [model] } },
      sessions: { sessions: [] },
      sessionRootStatus: 404,
      sessionInfoStatus: 404,
      hiddenSurfaceStatuses: { history: 404, transcript: 404, evidence: 404, diagnostics: 404, notifications: 404, approvals: 404, transfer: 404, receipt: 404 },
    })).toThrow(/shadow.*disabled|models/i);
  });
});
