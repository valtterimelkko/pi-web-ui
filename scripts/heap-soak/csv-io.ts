import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { planCsvAppend, type CsvRow } from '../../server/src/live-validation/heap-soak/csv.js';

export function appendSampleRow(csvPath: string, columns: readonly string[], row: CsvRow): void {
  mkdirSync(path.dirname(csvPath), { recursive: true });
  const existing = existsSync(csvPath) ? readFileSync(csvPath, 'utf8') : undefined;
  const plan = planCsvAppend(columns, row, existing);
  appendFileSync(csvPath, plan.textToAppend);
  const fd = openSync(csvPath, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
