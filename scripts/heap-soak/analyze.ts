import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseSampleCsv, buildReport, renderReportMarkdown } from '../../server/src/live-validation/heap-soak/report.js';
import { readLaneEvents } from './events-log.js';
import { FULL_SCHEDULE, MICRO_SCHEDULE } from '../../server/src/live-validation/heap-soak/phases.js';
import { runDir } from './paths.js';
import { snapshotComparisonSection } from './snapshot-diff.js';

/**
 * `report` command: works on any prefix of the CSV, so a partial/in-progress
 * run is still usable. Reads samples.csv + events.jsonl from a run directory
 * and prints the markdown report (also writing report.md/report.json there).
 */
export async function runAnalyze(runId: string, mode: 'micro' | 'full' = 'full'): Promise<string> {
  const dir = runDir(runId);
  const csvPath = path.join(dir, 'samples.csv');
  const eventsPath = path.join(dir, 'events.jsonl');
  if (!existsSync(csvPath)) throw new Error(`No samples.csv found for run ${runId} at ${csvPath}`);
  const rows = parseSampleCsv(readFileSync(csvPath, 'utf8'));
  const events = readLaneEvents(eventsPath);
  const schedule = mode === 'micro' ? MICRO_SCHEDULE : FULL_SCHEDULE;
  const report = buildReport(rows, events, schedule, 'A');
  const snapshotSection = await snapshotComparisonSection(dir);
  const markdown = `${renderReportMarkdown(report, runId)}\n\n${snapshotSection}`;
  writeFileSync(path.join(dir, 'report.md'), markdown);
  writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  return markdown;
}
