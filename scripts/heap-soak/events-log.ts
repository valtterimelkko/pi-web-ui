import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import type { LaneEvent } from '../../server/src/live-validation/heap-soak/types.js';

/** Append one LaneEvent as a JSON line, fsync'd so a crash right after doesn't lose it. */
export function appendLaneEvent(filePath: string, event: LaneEvent): void {
  const line = `${JSON.stringify(event)}\n`;
  appendFileSync(filePath, line);
  const fd = openSync(filePath, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export function readLaneEvents(filePath: string): LaneEvent[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf8');
  const events: LaneEvent[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { events.push(JSON.parse(trimmed) as LaneEvent); } catch { /* tolerate a truncated last line from a crash */ }
  }
  return events;
}
