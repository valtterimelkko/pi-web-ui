import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  computeUnseenAdvertisedModels,
  classifyEligibilityProbe,
  renderCatalogueExclusions,
} from '../../../src/command-code/command-code-catalogue-maintenance.js';

describe('computeUnseenAdvertisedModels', () => {
  it('returns advertised ids that are neither known nor excluded, in advertised order', () => {
    const advertised = ['a/a', 'b/b', 'c/c', 'd/d'];
    const known = ['a/a', 'c/c'];
    const excluded = ['d/d'];
    expect(computeUnseenAdvertisedModels(advertised, known, excluded)).toEqual(['b/b']);
  });

  it('returns nothing when every advertised model is already known or excluded', () => {
    expect(computeUnseenAdvertisedModels(['a/a'], ['a/a'], [])).toEqual([]);
    expect(computeUnseenAdvertisedModels(['x/x'], [], ['x/x'])).toEqual([]);
    expect(computeUnseenAdvertisedModels([], [], [])).toEqual([]);
  });

  it('deduplicates repeated advertised rows', () => {
    expect(computeUnseenAdvertisedModels(['n/n', 'n/n'], [], [])).toEqual(['n/n']);
  });
});

describe('classifyEligibilityProbe', () => {
  it('marks a clean exit-0 probe eligible', () => {
    expect(classifyEligibilityProbe({ stdout: '{"result":"ok"}', stderr: '', exitCode: 0, timedOut: false })).toBe('eligible');
  });

  it('marks explicit plan/subscription rejections ineligible', () => {
    const stderr = 'This model is not included in your current plan. Upgrade to Pro to use it.';
    expect(classifyEligibilityProbe({ stdout: '', stderr, exitCode: 1, timedOut: false })).toBe('ineligible');
    expect(classifyEligibilityProbe({ stdout: 'subscription required', stderr: '', exitCode: 1, timedOut: false })).toBe('ineligible');
  });

  it('marks provider permission denials (exit 4) ineligible', () => {
    expect(classifyEligibilityProbe({ stdout: '', stderr: 'forbidden', exitCode: 4, timedOut: false })).toBe('ineligible');
  });

  it('never denylist on ambiguous evidence: timeouts, network and rate limits stay inconclusive', () => {
    expect(classifyEligibilityProbe({ stdout: '', stderr: '', exitCode: null, timedOut: true })).toBe('inconclusive');
    expect(classifyEligibilityProbe({ stdout: '', stderr: 'network unreachable', exitCode: 6, timedOut: false })).toBe('inconclusive');
    expect(classifyEligibilityProbe({ stdout: '', stderr: 'rate limited', exitCode: 5, timedOut: false })).toBe('inconclusive');
    expect(classifyEligibilityProbe({ stdout: '', stderr: 'provider exploded', exitCode: 7, timedOut: false })).toBe('inconclusive');
    expect(classifyEligibilityProbe({ stdout: '', stderr: 'unknown failure', exitCode: 1, timedOut: false })).toBe('inconclusive');
  });
});

describe('renderCatalogueExclusions', () => {
  const catalogueSource = readFileSync(
    path.join(__dirname, '..', '..', '..', 'src', 'command-code', 'command-code-model-catalog.ts'),
    'utf8',
  );

  it('inserts new exclusions into the committed catalogue source, one per line', () => {
    const updated = renderCatalogueExclusions(catalogueSource, ['newvendor/new-model-1']);
    expect(updated).toContain("  'newvendor/new-model-1',");
    // Insertion lands inside the array literal, before `] as const;`.
    expect(updated.indexOf("'newvendor/new-model-1'")).toBeLessThan(updated.indexOf('] as const;'));
  });

  it('appends after the last existing entry rather than reordering anything', () => {
    const updated = renderCatalogueExclusions(catalogueSource, ['zzz/last-one']);
    const lastExisting = updated.indexOf("'meta/muse-spark-1.1'");
    const added = updated.indexOf("'zzz/last-one'");
    expect(lastExisting).toBeGreaterThan(-1);
    expect(added).toBeGreaterThan(lastExisting);
  });

  it('skips additions that are already excluded and leaves the source unchanged', () => {
    const updated = renderCatalogueExclusions(catalogueSource, ['gpt-5.5']);
    expect(updated).toBe(catalogueSource);
  });

  it('rejects malformed ids rather than corrupting the source file', () => {
    expect(() => renderCatalogueExclusions(catalogueSource, ["evil'; DROP--"])).toThrow();
    expect(() => renderCatalogueExclusions(catalogueSource, ['UPPERCASE OK?'])).toThrow();
  });
});
