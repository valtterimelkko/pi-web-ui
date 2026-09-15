#!/usr/bin/env npx tsx
/**
 * Report pi-web-ui stops that no repository-owned requester claims.
 *
 *   npx tsx scripts/check-unexplained-stops.ts
 *   npx tsx scripts/check-unexplained-stops.ts --since "48 hours ago" --json
 *   npx tsx scripts/check-unexplained-stops.ts --fail-on-unclaimed
 *
 * Why this exists: see `server/src/ops/stop-forensics.ts`. The short version is
 * that the durable requester record is written by the requesting code itself, so
 * it can be redirected (it was, at 2026-09-15T14:27:05Z, into a test's temp
 * file) and "no record" therefore proves nothing on its own. This command
 * compares the two independent lanes — what systemd logged and what the
 * repository claims — and names the difference.
 *
 * It is a read-only checker: it never restarts, announces, or notifies anything.
 * Installing it on a timer (for example piping a non-zero result into
 * `scripts/notify.sh`) is the owner's decision, not this script's.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { findUnexplainedStops } from '../server/src/ops/stop-forensics.js';

interface Options {
  since: string;
  auditFile: string;
  windowSeconds: number;
  json: boolean;
  failOnUnclaimed: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    since: '24 hours ago',
    auditFile: process.env.PI_WEB_UI_STOP_AUDIT_FILE ?? '/root/.pi-web-ui/stop-audit.log',
    windowSeconds: 120,
    json: false,
    failOnUnclaimed: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--since') options.since = argv[++index] ?? options.since;
    else if (arg === '--audit-file') options.auditFile = argv[++index] ?? options.auditFile;
    else if (arg === '--window') options.windowSeconds = Number(argv[++index] ?? options.windowSeconds);
    else if (arg === '--json') options.json = true;
    else if (arg === '--fail-on-unclaimed') options.failOnUnclaimed = true;
    else {
      console.error(`check-unexplained-stops: unknown argument: ${arg}`);
      process.exit(64);
    }
  }
  return options;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const journal = spawnSync(
    'journalctl',
    ['-u', 'pi-web-ui.service', '--since', options.since, '-o', 'short-iso', '--no-pager'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (journal.error) {
    console.error(`check-unexplained-stops: could not read the journal: ${journal.error.message}`);
    process.exit(70);
  }
  let audit = '';
  try {
    audit = readFileSync(options.auditFile, 'utf8');
  } catch (error) {
    // A missing audit file is itself a finding, but not a crash: report it and
    // keep the journal evidence, which is the lane that cannot be redirected.
    console.error(`check-unexplained-stops: no requester record at ${options.auditFile} (${(error as Error).message})`);
  }

  const findings = findUnexplainedStops({
    journal: journal.stdout ?? '',
    audit,
    windowSeconds: options.windowSeconds,
  });
  const unclaimed = findings.filter((finding) => finding.likelyCause === 'unclaimed-request');

  if (options.json) {
    console.log(JSON.stringify({ since: options.since, auditFile: options.auditFile, findings }, null, 2));
  } else if (findings.length === 0) {
    console.log(`no unexplained stops since ${options.since} (requester record: ${options.auditFile})`);
  } else {
    for (const finding of findings) {
      const distance = finding.nearestRequesterSeconds === null
        ? 'no requester record at all'
        : `nearest requester record ${finding.nearestRequesterSeconds}s away`;
      console.log(`${finding.at}  ${finding.likelyCause}  (${distance})`);
      for (const line of finding.context) console.log(`    ${line}`);
      console.log('');
    }
    console.log(
      `${findings.length} unexplained stop(s): ${unclaimed.length} unclaimed request(s), `
      + `${findings.length - unclaimed.length} systemd-side restart(s).`,
    );
  }

  if (options.failOnUnclaimed && unclaimed.length > 0) process.exit(1);
}

main();
