import { describe, expect, it } from 'vitest';
import {
  assertDisposableTarget,
  chooseValidationModel,
  containsAssistantMarker,
  parseValidationArgs,
  redactValidationReport,
  withValidationCleanup,
} from '../src/validation-safety.js';

const productionSocket = '/home/operator/.pi-web-ui/internal-api.sock';
const productionToken = '/home/operator/.pi-web-ui/internal-api-token';

describe('MCP validator target safety', () => {
  it('requires explicit socket and token paths', () => {
    expect(() => parseValidationArgs([], '/home/operator')).toThrow(/socket.*token|explicit/i);
    expect(() => parseValidationArgs(['--socket', '/tmp/socket'], '/home/operator')).toThrow(/token/i);
    expect(() => parseValidationArgs(['--token-path', '/tmp/token'], '/home/operator')).toThrow(/socket/i);
  });

  it('refuses canonical production paths with no override escape hatch', () => {
    expect(() => assertDisposableTarget(productionSocket, productionToken, '/home/operator')).toThrow(/production/i);
    expect(() => parseValidationArgs([
      '--socket', productionSocket,
      '--token-path', productionToken,
      '--allow-production',
    ], '/home/operator')).toThrow(/production|allow-production/i);
  });

  it('rejects validation paths outside the operating system temporary root', () => {
    expect(() => assertDisposableTarget('/home/operator/socket', '/home/operator/token', '/home/operator')).toThrow(/temporary|disposable|validation/i);
  });

  it('requires the socket and token to share one disposable directory', () => {
    expect(() => assertDisposableTarget('/tmp/validation/internal-api.sock', '/tmp/other/internal-api-token', '/home/operator')).toThrow(/same|directory/i);
  });

  it('accepts explicit temporary paths and parses a disposable runtime', () => {
    const result = parseValidationArgs([
      '--socket', '/tmp/validation/internal-api.sock',
      '--token-path', '/tmp/validation/internal-api-token',
      '--runtime', 'pi',
    ], '/home/operator');
    expect(result).toEqual({
      socketPath: '/tmp/validation/internal-api.sock',
      tokenPath: '/tmp/validation/internal-api-token',
      runtime: 'pi',
    });
  });

  it('attempts cleanup on success, assertion failure, and timeout-style rejection', async () => {
    const outcomes: string[] = [];
    await withValidationCleanup(async () => { outcomes.push('success-cleanup'); }, async () => { outcomes.push('success'); return 'ok'; });
    await expect(withValidationCleanup(async () => { outcomes.push('failure-cleanup'); }, async () => { throw new Error('assertion'); })).rejects.toThrow('assertion');
    await expect(withValidationCleanup(async () => { outcomes.push('timeout-cleanup'); }, async () => { throw new Error('timeout'); })).rejects.toThrow('timeout');
    expect(outcomes).toEqual(['success', 'success-cleanup', 'failure-cleanup', 'timeout-cleanup']);
  });

  it('uses the documented Pi default when the live catalogue lacks a reliable create selector', () => {
    expect(chooseValidationModel('pi', [{ id: 'meta-llama/llama-4' }, { id: 'claude-fable-5' }])).toBeUndefined();
    expect(chooseValidationModel('claude', [{ id: 'profile:native' }, { id: 'sonnet' }])).toBe('profile:native');
  });

  it('only accepts a marker in assistant transcript output', () => {
    expect(containsAssistantMarker({ items: [{ kind: 'user', text: 'marker-123' }] }, 'marker-123')).toBe(false);
    expect(containsAssistantMarker({ items: [{ kind: 'assistant', text: 'marker-123 completed' }] }, 'marker-123')).toBe(true);
  });

  it('redacts tokens and transcript bodies from reports', () => {
    const report = redactValidationReport(
      'token=sentinel-token transcript=SECRET_TRANSCRIPT body=private',
      ['sentinel-token'],
      ['SECRET_TRANSCRIPT', 'private'],
    );
    expect(report).not.toContain('sentinel-token');
    expect(report).not.toContain('SECRET_TRANSCRIPT');
    expect(report).not.toContain('private');
    expect(report).toContain('[REDACTED]');
  });
});
