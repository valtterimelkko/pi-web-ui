#!/usr/bin/env node
/**
 * agent-os stub binary for the heap soak harness.
 *
 * The copied `agent-os-inject` Pi extension spawns the real `agent-os` CLI
 * for every child turn (packet/vault reads, usage logging, board heartbeats).
 * Kept loaded (its in-process code is part of the realistic heap profile),
 * but pointed at THIS stub via `AGENT_OS_BIN` so no real `agent-os` process
 * ever runs for a soak child: logs the invocation (argv + timestamp) to
 * `AGENT_OS_STUB_LOG` and exits 0 with EMPTY stdout — the extension's own
 * fail-soft design (see ~/.pi/agent/extensions/agent-os-inject/inject-client.ts
 * `classifyOutcome`/`callAgentEndDecision`) already treats empty output as a
 * safe no-op ('empty' / 'empty-output'), never an error surfaced to the model.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const logPath = process.env.AGENT_OS_STUB_LOG;
if (logPath) {
  try {
    mkdirSync(path.dirname(logPath), { recursive: true });
    appendFileSync(logPath, `${JSON.stringify({ ts: new Date().toISOString(), argv: process.argv.slice(2) })}\n`);
  } catch {
    // Logging must never block or fail the no-op — the whole point is a safe stub.
  }
}
process.exit(0);
