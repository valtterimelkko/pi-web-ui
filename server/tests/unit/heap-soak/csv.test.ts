import { describe, expect, it } from 'vitest';
import { formatCsvHeader, formatCsvRow, parseCsv, parseCsvWithHeader, planCsvAppend } from '../../../src/live-validation/heap-soak/csv.js';

describe('heap-soak csv helpers', () => {
  it('formats a header and row in column order, quoting fields with commas', () => {
    const columns = ['a', 'b', 'c'];
    expect(formatCsvHeader(columns)).toBe('a,b,c');
    expect(formatCsvRow(columns, { a: 1, b: 'x,y', c: undefined })).toBe('1,"x,y",');
  });

  it('round-trips through parseCsv, including quoted commas and embedded quotes', () => {
    const header = formatCsvHeader(['a', 'b']);
    const row = formatCsvRow(['a', 'b'], { a: 'has "quotes"', b: 'has,comma' });
    const table = parseCsv(`${header}\n${row}\n`);
    expect(table).toEqual([['a', 'b'], ['has "quotes"', 'has,comma']]);
  });

  it('parseCsvWithHeader drops a truncated trailing row (crash mid-write)', () => {
    const content = 'a,b,c\n1,2,3\n4,5'; // last row missing a column, no trailing newline
    const { header, rows } = parseCsvWithHeader(content);
    expect(header).toEqual(['a', 'b', 'c']);
    expect(rows).toEqual([{ a: '1', b: '2', c: '3' }]);
  });

  it('parseCsvWithHeader on empty content returns empty header/rows', () => {
    expect(parseCsvWithHeader('')).toEqual({ header: [], rows: [] });
  });

  describe('planCsvAppend (resume logic)', () => {
    const columns = ['ts', 'value'];

    it('writes header + row when the file does not exist', () => {
      const plan = planCsvAppend(columns, { ts: '1', value: 42 }, undefined);
      expect(plan.needsHeader).toBe(true);
      expect(plan.textToAppend).toBe('ts,value\n1,42\n');
    });

    it('writes header + row when the file exists but is empty', () => {
      const plan = planCsvAppend(columns, { ts: '1', value: 42 }, '');
      expect(plan.needsHeader).toBe(true);
    });

    it('appends only the row when the header already matches', () => {
      const existing = 'ts,value\n0,1\n';
      const plan = planCsvAppend(columns, { ts: '1', value: 2 }, existing);
      expect(plan.needsHeader).toBe(false);
      expect(plan.textToAppend).toBe('1,2\n');
    });

    it('inserts a leading newline if the previous write was truncated mid-row', () => {
      const existing = 'ts,value\n0,1'; // no trailing newline
      const plan = planCsvAppend(columns, { ts: '1', value: 2 }, existing);
      expect(plan.textToAppend).toBe('\n1,2\n');
    });

    it('refuses to append when the existing header does not match (different columns)', () => {
      const existing = 'ts,other\n0,1\n';
      expect(() => planCsvAppend(columns, { ts: '1', value: 2 }, existing)).toThrow(/header mismatch/);
    });
  });
});
