/** Tiny numeric helper shared by the parsing modules. */
export function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
