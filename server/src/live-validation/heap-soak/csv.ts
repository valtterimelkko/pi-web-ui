/**
 * CSV append/resume helpers for the heap soak sampler.
 *
 * The sampler process may restart mid-run (supervisor crash, `systemctl kill`
 * exercise in Gate 1). Every write is a single self-contained line appended to
 * an existing file — resuming after a restart means simply opening the same
 * path in append mode again, never truncating or rewriting history. Splitting
 * the pure formatting/parsing (this file) from the actual `fs` calls (done by
 * the caller, e.g. scripts/heap-soak/sampler.ts) keeps this fully unit-testable
 * without a real filesystem.
 */

export type CsvRow = Record<string, string | number | boolean | undefined>;

function csvEscape(value: string | number | boolean | undefined): string {
  if (value === undefined || value === null) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/** Render the header line (no trailing content) for a fresh CSV file. */
export function formatCsvHeader(columns: readonly string[]): string {
  return columns.join(',');
}

/** Render one data row in column order, filling missing fields with ''. */
export function formatCsvRow(columns: readonly string[], row: CsvRow): string {
  return columns.map((column) => csvEscape(row[column])).join(',');
}

/**
 * Parse a minimal CSV (RFC4180-ish; enough for our own header + own escaping)
 * into an array of column arrays. Tolerates a trailing newline and blank
 * lines (skipped), so a partially-written last line from a crashed process
 * does not blow up parsing of everything before it.
 */
export function parseCsv(content: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const push = () => { row.push(field); field = ''; };
  const endRow = () => {
    push();
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  while (i < content.length) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === ',') { push(); i += 1; continue; }
    if (ch === '\r') { i += 1; continue; }
    if (ch === '\n') { endRow(); i += 1; continue; }
    field += ch; i += 1;
  }
  if (field !== '' || row.length > 0) endRow();
  return rows;
}

/** Parse a CSV whose first row is a header into an array of objects. */
export function parseCsvWithHeader(content: string): { header: string[]; rows: Record<string, string>[] } {
  const table = parseCsv(content);
  if (table.length === 0) return { header: [], rows: [] };
  const [header, ...rest] = table;
  const rows = rest
    // A truncated last line (crash mid-write) has fewer fields than the
    // header; drop it rather than mis-align columns.
    .filter((cols) => cols.length === header.length)
    .map((cols) => Object.fromEntries(header.map((name, idx) => [name, cols[idx]])));
  return { header, rows };
}

export interface AppendPlan {
  /** Bytes/text that should be written (header + row, or just row). */
  textToAppend: string;
  /** Whether the destination file needs to be created with a header first. */
  needsHeader: boolean;
}

/**
 * Decide what to append given the current file content (or undefined if the
 * file does not exist yet) — pure so the "resume" behaviour is unit-testable
 * without touching a real file. The caller does the actual open/append/fsync.
 */
export function planCsvAppend(
  columns: readonly string[],
  row: CsvRow,
  existingContent: string | undefined,
): AppendPlan {
  const rowLine = formatCsvRow(columns, row);
  if (existingContent === undefined || existingContent.length === 0) {
    return { textToAppend: `${formatCsvHeader(columns)}\n${rowLine}\n`, needsHeader: true };
  }
  const firstLine = existingContent.split('\n', 1)[0];
  const existingHeader = parseCsv(firstLine)[0] ?? [];
  if (existingHeader.join(',') !== columns.join(',')) {
    throw new Error(
      `heap-soak CSV header mismatch: existing file has [${existingHeader.join(',')}], expected [${columns.join(',')}]. `
      + 'Refusing to append — start a new run-id instead of corrupting history.',
    );
  }
  // If the existing content does not end with a newline (crash mid-write of
  // the previous row), start the new row on its own line without assuming
  // the previous partial row is valid.
  const needsLeadingNewline = !existingContent.endsWith('\n');
  return { textToAppend: `${needsLeadingNewline ? '\n' : ''}${rowLine}\n`, needsHeader: false };
}
