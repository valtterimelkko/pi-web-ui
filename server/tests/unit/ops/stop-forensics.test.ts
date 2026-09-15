import { describe, expect, it } from 'vitest';

import { findUnexplainedStops, parseRequesterRecords, parseStopTimes } from '../../../src/ops/stop-forensics.js';

/**
 * Forensics for stops nobody can account for (2026-09-15).
 *
 * The 14:27:05Z restart was performed by repository code — a Vitest run of
 * `restart-drainage.test.ts` exercising a `git stash`-ed revision of
 * `scripts/restart-pi-web-ui.sh` — yet production's durable stop-audit file
 * contains no `RESTART-REQUESTED` record for it: the suite pointed the script's
 * audit file at its own temp path. So "no requester in the record" does NOT
 * prove "not one of ours", which is exactly the inference
 * docs/PRODUCTION-STOP-ROBUSTNESS.md used to invite.
 *
 * This module closes that gap in the honest direction: it compares the stop
 * events systemd logged against the requester records the repository claims, and
 * reports every stop with no matching claim. It prevents nothing; it makes a
 * silent restart loud.
 *
 * The fixtures below are the real lines from that event and from a clean,
 * recorded restart, so the test cannot drift into fiction.
 */

// journalctl -u pi-web-ui.service -o short-iso, around the incident
const INCIDENT_JOURNAL = [
  '2026-09-15T14:27:05+0000 docker-ce-ubuntu-4gb-hel1-2 systemd[1]: Stopping pi-web-ui.service - Pi Web UI - Web Interface for Pi Coding Agent...',
  '2026-09-15T14:27:05+0000 docker-ce-ubuntu-4gb-hel1-2 pi-web-ui[2424828]: [SessionWatcher] SessionWatcher stopped',
  '2026-09-15T14:27:07+0000 docker-ce-ubuntu-4gb-hel1-2 systemd[1]: Stopped pi-web-ui.service - Pi Web UI - Web Interface for Pi Coding Agent.',
  '2026-09-15T14:27:07+0000 docker-ce-ubuntu-4gb-hel1-2 systemd[1]: Started pi-web-ui.service - Pi Web UI - Web Interface for Pi Coding Agent.',
].join('\n');

// production's durable record around the incident: the 10:36 deploy, and nothing at 14:27
const INCIDENT_AUDIT = [
  'RESTART-REQUESTED ts=2026-09-15T10:36:28Z uid=0 user=root pid=2424736 ppid=2424210 tty=not a tty cwd=/root/pi-web-ui reason=contract\\ 1.43.0 argv=--reason\\ contract\\ 1.43.0 ancestors=2424736:bash>2424210:bash>2244152:pi',
].join('\n');

// a clean recorded restart: the wrapper announced itself two seconds before the stop
const RECORDED_AUDIT = [
  ...INCIDENT_AUDIT.split('\n'),
  'RESTART-REQUESTED ts=2026-09-15T16:37:43Z uid=0 user=root pid=2999387 ppid=2999385 tty=not a tty cwd=/root/pi-web-ui reason=deploy\\ merged\\ master argv=--reason\\ deploy\\ merged\\ master ancestors=2999387:bash>2999385:timeout>2999329:bash>2244152:pi',
].join('\n');
const RECORDED_JOURNAL = '2026-09-15T16:37:44+0000 host systemd[1]: Stopping pi-web-ui.service - Pi Web UI - Web Interface for Pi Coding Agent...\n';

describe('parseStopTimes', () => {
  it('reads the stop events systemd logged, and nothing else', () => {
    expect(parseStopTimes(INCIDENT_JOURNAL)).toEqual(['2026-09-15T14:27:05.000Z']);
  });

  it('ignores unrelated shutdown chatter', () => {
    expect(parseStopTimes('2026-09-15T14:27:05+0000 host systemd[1]: Stopped pi-web-ui.service - Pi Web UI.\n')).toEqual([]);
  });
});

describe('parseRequesterRecords', () => {
  it('reads the requester records the repository wrote', () => {
    const records = parseRequesterRecords(RECORDED_AUDIT);
    expect(records.map((record) => record.at)).toEqual(['2026-09-15T10:36:28.000Z', '2026-09-15T16:37:43.000Z']);
    expect(records[1]?.reason).toContain('deploy');
  });
});

describe('findUnexplainedStops', () => {
  it('reports the 14:27 stop as unexplained — the record was redirected to a temp file', () => {
    const findings = findUnexplainedStops({ journal: INCIDENT_JOURNAL, audit: INCIDENT_AUDIT });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.at).toBe('2026-09-15T14:27:05.000Z');
    // The nearest claim in production's record is the unrelated 10:36 deploy —
    // hours away, which is why the 14:27 stop is reported as unclaimed.
    expect(findings[0]?.nearestRequesterSeconds).toBeGreaterThan(120);
    expect(findings[0]?.likelyCause).toBe('unclaimed-request');
  });

  it('reports a stop with no requester record at all, and flags it as having none', () => {
    const findings = findUnexplainedStops({ journal: INCIDENT_JOURNAL, audit: '' });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.nearestRequesterSeconds).toBeNull();
  });

  it('passes a restart whose requester record exists', () => {
    expect(findUnexplainedStops({ journal: RECORDED_JOURNAL, audit: RECORDED_AUDIT })).toEqual([]);
  });

  it('accepts a record written a little before or after the stop, inside the window', () => {
    const journal = '2026-09-15T16:37:44+0000 host systemd[1]: Stopping pi-web-ui.service - Pi Web UI - Web Interface for Pi Coding Agent...\n';
    const justBefore = 'RESTART-REQUESTED ts=2026-09-15T16:37:43Z uid=0 user=root pid=1 ppid=1 tty=none cwd=/x reason=x argv=x ancestors=x\n';
    const justAfter = 'RESTART-REQUESTED ts=2026-09-15T16:38:20Z uid=0 user=root pid=1 ppid=1 tty=none cwd=/x reason=x argv=x ancestors=x\n';
    expect(findUnexplainedStops({ journal, audit: justBefore })).toEqual([]);
    expect(findUnexplainedStops({ journal, audit: justAfter })).toEqual([]);
  });

  it('still reports a stop whose only nearby record is far outside the window', () => {
    const journal = '2026-09-15T16:37:44+0000 host systemd[1]: Stopping pi-web-ui.service - Pi Web UI - Web Interface for Pi Coding Agent...\n';
    const farAway = 'RESTART-REQUESTED ts=2026-09-15T10:36:28Z uid=0 user=root pid=1 ppid=1 tty=none cwd=/x reason=x argv=x ancestors=x\n';
    const findings = findUnexplainedStops({ journal, audit: farAway });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.nearestRequesterSeconds).toBeGreaterThan(120);
  });

  it('labels a stop that systemd itself caused, so an operator is not misled', () => {
    const journal = [
      '2026-09-15T08:30:26+0000 host systemd[1]: Stopping pi-web-ui.service - Pi Web UI - Web Interface for Pi Coding Agent...',
      '2026-09-15T08:30:26+0000 host systemd[1]: pi-web-ui.service: Main process exited, code=killed, status=9/KILL',
      "2026-09-15T08:30:26+0000 host systemd[1]: pi-web-ui.service: Failed with result 'timeout'.",
      '2026-09-15T08:30:36+0000 host systemd[1]: Scheduled restart job, restart counter is at 1.',
    ].join('\n');
    const findings = findUnexplainedStops({ journal, audit: '' });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.likelyCause).toBe('systemd-restart-policy');
  });

  it('labels a stop with no requester and no systemd cause as an unexplained external request', () => {
    const findings = findUnexplainedStops({ journal: INCIDENT_JOURNAL, audit: INCIDENT_AUDIT });
    expect(findings[0]?.likelyCause).toBe('unclaimed-request');
  });
});
