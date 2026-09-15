/**
 * Stops nobody can account for (2026-09-15).
 *
 * `scripts/systemd-stop-audit.sh` and the repo-owned restart paths record who
 * asked for a stop, and `docs/PRODUCTION-STOP-ROBUSTNESS.md` used to invite the
 * inference that a stop with no record is "not one of ours". The 14:27:05Z
 * restart falsified that: it was repository code (a Vitest run of
 * `restart-drainage.test.ts` exercising a `git stash`-ed revision of
 * `scripts/restart-pi-web-ui.sh`), and it still left no record in production's
 * durable file, because the suite pointed the script's audit seam at its own
 * temp path. A self-reported audit lane can always be redirected.
 *
 * So the honest instrument is a cross-check between two lanes that are written
 * by different things: the stops **systemd** logged, and the requester records
 * the **repository** claims. Every stop with no nearby claim is reported.
 *
 * This prevents nothing. It makes a silent restart loud, which is what turns a
 * month-long "who did that?" into a same-minute question. The CLI wrapper is
 * `scripts/check-unexplained-stops.ts`.
 */

export interface RequesterRecord {
  /** ISO instant of the record. */
  at: string;
  reason: string;
  /** The recorded line, verbatim, for the report. */
  line: string;
}

export interface UnexplainedStop {
  /** ISO instant of the stop systemd logged. */
  at: string;
  /** Seconds to the nearest requester record, or null when there is none. */
  nearestRequesterSeconds: number | null;
  /**
   * A bounded heuristic, not a verdict:
   *  - `systemd-restart-policy`: the same stop window shows a failed/killed
   *    result or a scheduled restart — systemd acted on the unit's own policy;
   *  - `unclaimed-request`: a stop with no claim and no systemd-side cause, i.e.
   *    something asked for it and did not say so.
   */
  likelyCause: 'systemd-restart-policy' | 'unclaimed-request';
  /** Non-empty journal lines surrounding the stop, for a human to judge. */
  context: string[];
}

const STOP_MARKER = /Stopping pi-web-ui\.service/;
const ISO_AT_LINE_START = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?/;
const REQUESTER_LINE = /^RESTART-REQUESTED ts=(\S+)/;
const SYSTEMD_SIDE_CAUSE = /Failed with result|Main process exited|Scheduled restart job|restart counter is at|watchdog/i;

function toIso(value: string): string {
  const match = ISO_AT_LINE_START.exec(value);
  if (!match) return value;
  const [, seconds, offset] = match;
  const parsed = new Date(`${seconds}${offset === 'Z' ? 'Z' : (offset ?? 'Z')}`);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/** Stop events, from `journalctl -u pi-web-ui.service -o short-iso` output. */
export function parseStopTimes(journal: string): string[] {
  const stops: string[] = [];
  for (const line of journal.split('\n')) {
    if (!STOP_MARKER.test(line)) continue;
    const at = toIso(line.trim());
    if (at !== line.trim()) stops.push(at);
  }
  return stops;
}

/** Requester records, from the durable stop-audit file. */
export function parseRequesterRecords(audit: string): RequesterRecord[] {
  const records: RequesterRecord[] = [];
  for (const raw of audit.split('\n')) {
    const line = raw.trim();
    const match = REQUESTER_LINE.exec(line);
    if (!match) continue;
    records.push({
      at: toIso(match[1] as string),
      reason: /reason=(\S+)/.exec(line)?.[1] ?? '',
      line,
    });
  }
  return records;
}

export interface FindUnexplainedStopsInput {
  /** Journal text (`journalctl ... -o short-iso`). */
  journal: string;
  /** Durable stop-audit text. */
  audit: string;
  /** How close a requester record must be, in seconds. Default 120. */
  windowSeconds?: number;
  /** How many surrounding journal lines to keep as context. Default 4. */
  contextLines?: number;
}

export function findUnexplainedStops(input: FindUnexplainedStopsInput): UnexplainedStop[] {
  const window = input.windowSeconds ?? 120;
  const contextLines = input.contextLines ?? 4;
  const journalLines = input.journal.split('\n').filter((line) => line.trim().length > 0);
  const records = parseRequesterRecords(input.audit).map((record) => Date.parse(record.at)).filter((at) => !Number.isNaN(at));
  const findings: UnexplainedStop[] = [];
  journalLines.forEach((line, index) => {
    if (!STOP_MARKER.test(line)) return;
    const at = toIso(line.trim());
    if (at === line.trim()) return;
    const stopAt = Date.parse(at);
    if (Number.isNaN(stopAt)) return;
    let nearest: number | null = null;
    for (const recordAt of records) {
      const distance = Math.abs(stopAt - recordAt) / 1000;
      if (nearest === null || distance < nearest) nearest = distance;
    }
    if (nearest !== null && nearest <= window) return;
    const context = journalLines.slice(Math.max(0, index - 1), index + contextLines);
    findings.push({
      at,
      nearestRequesterSeconds: nearest === null ? null : Math.round(nearest),
      likelyCause: context.some((entry) => SYSTEMD_SIDE_CAUSE.test(entry)) ? 'systemd-restart-policy' : 'unclaimed-request',
      context,
    });
  });
  return findings;
}
