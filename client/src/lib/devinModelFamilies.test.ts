import { describe, it, expect } from 'vitest';
import { groupDevinModelsByFamily, resolveDevinVariantId, type DevinCatalogModel } from './devinModelFamilies';

/**
 * Lane D3 (devin-parity): one model choice per Devin family. The catalogue
 * arrives as one entry per level variant, each carrying the server-derived
 * `family` / `familyName` fields; the browser groups them so the New Session
 * modal and the session header show one entry per family plus a level
 * dropdown, and send the resolved variant id.
 */

const catalogue: DevinCatalogModel[] = [
  { id: 'swe-2-flash-medium', name: 'SWE-2 Flash Medium', pricing: { free: true, raw: 'Free' }, thinkingLevels: ['medium', 'high', 'max'], family: 'swe-2-flash', familyName: 'SWE-2 Flash' },
  { id: 'swe-2-flash-high', name: 'SWE-2 Flash High', pricing: { free: true, raw: 'Free' }, thinkingLevels: ['medium', 'high', 'max'], family: 'swe-2-flash', familyName: 'SWE-2 Flash' },
  { id: 'swe-2-flash-max', name: 'SWE-2 Flash Max', pricing: { free: true, raw: 'Free' }, thinkingLevels: ['medium', 'high', 'max'], family: 'swe-2-flash', familyName: 'SWE-2 Flash' },
  { id: 'swe-2-medium', name: 'SWE-2 Medium', pricing: { free: true, raw: 'Free' }, thinkingLevels: ['medium', 'high', 'max'], family: 'swe-2', familyName: 'SWE-2' },
  { id: 'swe-2-high', name: 'SWE-2 High', pricing: { free: true, raw: 'Free' }, thinkingLevels: ['medium', 'high', 'max'], family: 'swe-2', familyName: 'SWE-2' },
  { id: 'swe-2-max', name: 'SWE-2 Max', pricing: { free: true, raw: 'Free' }, thinkingLevels: ['medium', 'high', 'max'], family: 'swe-2', familyName: 'SWE-2' },
  { id: 'claude-opus-5-5-low', name: 'Claude Opus 5.5 Low', pricing: { free: false, raw: '$1 / 1M' }, thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'], family: 'claude-opus-5-5', familyName: 'Claude Opus 5.5' },
  { id: 'claude-opus-5-5-high', name: 'Claude Opus 5.5 High', pricing: { free: false, raw: '$1 / 1M' }, thinkingLevels: ['low', 'medium', 'high', 'xhigh', 'max'], family: 'claude-opus-5-5', familyName: 'Claude Opus 5.5' },
  { id: 'claude-opus-5-5-low-fast', name: 'Claude Opus 5.5 Low Fast', pricing: { free: false, raw: '$1 / 1M' }, thinkingLevels: [], family: 'claude-opus-5-5-low-fast', familyName: 'Claude Opus 5.5 Low Fast' },
  { id: 'kimi-k2-6', name: 'Kimi K2.6', pricing: { free: false, raw: '$1 / 1M' }, thinkingLevels: [], family: 'kimi-k2-6', familyName: 'Kimi K2.6' },
];

describe('groupDevinModelsByFamily', () => {
  it('collapses level variants into one entry per family, first-seen order', () => {
    const families = groupDevinModelsByFamily(catalogue);
    expect(families.map((f) => f.family)).toEqual([
      'swe-2-flash',
      'swe-2',
      'claude-opus-5-5',
      'claude-opus-5-5-low-fast',
      'kimi-k2-6',
    ]);
    expect(families[0].name).toBe('SWE-2 Flash');
    expect(families[2].name).toBe('Claude Opus 5.5');
  });

  it('collects the family levels in canonical low→max order, de-duplicated', () => {
    const families = groupDevinModelsByFamily(catalogue);
    const flash = families.find((f) => f.family === 'swe-2-flash');
    expect(flash?.levels).toEqual(['medium', 'high', 'max']);
    const opus = families.find((f) => f.family === 'claude-opus-5-5');
    expect(opus?.levels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('axis-less models are single-variant families with no levels', () => {
    const families = groupDevinModelsByFamily(catalogue);
    const kimi = families.find((f) => f.family === 'kimi-k2-6');
    expect(kimi?.levels).toEqual([]);
    expect(kimi?.defaultLevel).toBeNull();
    const fast = families.find((f) => f.family === 'claude-opus-5-5-low-fast');
    expect(fast?.levels).toEqual([]);
  });

  it('defaults the level to medium where the family has it, else the lowest', () => {
    const families = groupDevinModelsByFamily(catalogue);
    expect(families.find((f) => f.family === 'swe-2-flash')?.defaultLevel).toBe('medium');
    const lowHigh = groupDevinModelsByFamily([
      { id: 'p-low', name: 'P Low', thinkingLevels: ['low', 'high'], family: 'p', familyName: 'P' },
      { id: 'p-high', name: 'P High', thinkingLevels: ['low', 'high'], family: 'p', familyName: 'P' },
    ]);
    expect(lowHigh[0].defaultLevel).toBe('low');
  });

  it('a family is free only when every variant is free', () => {
    const families = groupDevinModelsByFamily(catalogue);
    expect(families.find((f) => f.family === 'swe-2-flash')?.free).toBe(true);
    expect(families.find((f) => f.family === 'kimi-k2-6')?.free).toBe(false);
    const mixed = groupDevinModelsByFamily([
      { id: 'm-low', name: 'M Low', pricing: { free: true, raw: 'Free' }, thinkingLevels: ['low', 'high'], family: 'm', familyName: 'M' },
      { id: 'm-high', name: 'M High', pricing: { free: false, raw: '$1' }, thinkingLevels: ['low', 'high'], family: 'm', familyName: 'M' },
    ]);
    expect(mixed[0].free).toBe(false);
  });

  it('is safe on an empty catalogue and tolerates entries without family fields (falls back to the id)', () => {
    expect(groupDevinModelsByFamily([])).toEqual([]);
    const legacy = groupDevinModelsByFamily([
      { id: 'swe-2-flash-medium', name: 'SWE-2 Flash Medium', thinkingLevels: ['medium', 'high'] },
    ]);
    expect(legacy).toHaveLength(1);
    expect(legacy[0].family).toBe('swe-2-flash-medium');
    expect(legacy[0].name).toBe('SWE-2 Flash Medium');
  });
});

describe('resolveDevinVariantId', () => {
  it('joins the family base with the chosen level', () => {
    const flash = groupDevinModelsByFamily(catalogue)[0];
    expect(resolveDevinVariantId(flash, 'high')).toBe('swe-2-flash-high');
    expect(resolveDevinVariantId(flash, 'medium')).toBe('swe-2-flash-medium');
  });

  it('returns the family id itself for an axis-less family (level null)', () => {
    const kimi = groupDevinModelsByFamily(catalogue).find((f) => f.family === 'kimi-k2-6');
    expect(resolveDevinVariantId(kimi!, null)).toBe('kimi-k2-6');
  });
});
