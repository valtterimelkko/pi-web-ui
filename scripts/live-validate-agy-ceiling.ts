#!/usr/bin/env npx tsx
/**
 * Live proof for the Antigravity turn-ceiling fix, using the REAL AntigravityService
 * and the REAL `agy` binary with scaled-down watchdog windows (set via env by the
 * caller). It never touches the production server: it builds its own service with
 * a temp session dir and registry.
 *
 *   ANTIGRAVITY_STALL_TIMEOUT_MS=20000 ANTIGRAVITY_TOOL_STALL_TIMEOUT_MS=120000 \
 *     npx tsx scripts/live-validate-agy-ceiling.ts tool-silence 60
 *
 * Scenarios:
 *   tool-silence <sleepSeconds>   one turn whose only tool is a silent `sleep N`
 *   hung-resume  <sleepSeconds>   same, then a follow-up on the same session (resume after a cut-off)
 *   goal-build   <buildSeconds>   a goal whose build step is silent; real sweeper + verifyCommand
 *
 * Output: one JSON line per observation; exit 0 always (the caller reads the verdicts).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [scenario = 'tool-silence', arg = '60'] = process.argv.slice(2);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-ceiling-'));
process.env.ANTIGRAVITY_ENABLED = 'true';
process.env.ANTIGRAVITY_SESSION_DIR = path.join(root, 'sessions');
process.env.ANTIGRAVITY_MAX_ATTEMPTS = '1';
const work = path.join(root, 'work');
fs.mkdirSync(work, { recursive: true });

const out = (o: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), ...o }));

async function main(): Promise<void> {
  const { AntigravityService } = await import('../server/src/antigravity/antigravity-service.js');
  const goal = await import('../server/src/internal-api/goal/antigravity-goal.js');
  const svc = new AntigravityService({ registryPath: path.join(root, 'registry.json') });
  const { sessionId } = await svc.createSession(work, 'gemini-3.8-flash-low');
  out({ scenario, sessionId, work, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => /^ANTIGRAVITY_(STALL|TOOL_STALL|PROMPT)/.test(k))) });

  const turn = (prompt: string) =>
    new Promise<void>((resolve) => {
      let events = 0;
      void svc.sendPrompt(sessionId, prompt, () => { events++; }, (err) => { out({ turnComplete: true, events, err: err?.message }); resolve(); });
    });
  const summary = async (label: string) => {
    const t = await svc.getLastCompletedTurn(sessionId);
    out({ label, status: t?.status, error: t?.error ?? null, response: (t?.response ?? '').slice(0, 160) });
  };

  if (scenario === 'tool-silence') {
    const t0 = Date.now();
    await turn(`Run this exact shell command with your shell tool and wait for it to finish: sleep ${arg}; echo SLEPT. Then reply with the single word done.`);
    out({ elapsedS: Math.round((Date.now() - t0) / 1000) });
    await summary('after-turn');
  } else if (scenario === 'hung-resume') {
    const t0 = Date.now();
    await turn(`Run this exact shell command with your shell tool and wait for it to finish: sleep ${arg}; echo SLEPT. Then reply with the single word done.`);
    out({ elapsedS: Math.round((Date.now() - t0) / 1000) });
    await summary('after-cutoff');
    await turn('Reply with exactly: RESUMED-OK. Do not run any tools.');
    await summary('after-resume');
  } else if (scenario === 'goal-build') {
    const script = path.join(work, 'build.sh');
    fs.writeFileSync(script, `#!/bin/sh\nsleep ${arg}\necho built > ${work}/built.txt\n`, { mode: 0o755 });
    const verify = `test -f ${work}/ok.txt`;
    const objective = `Run ${script} (it is a build, takes about ${arg} seconds and prints nothing), then once ${work}/built.txt exists create ${work}/ok.txt containing the word ok.`;
    const store = new goal.AntigravityGoalControlStore(path.join(root, 'goal-control'));
    await store.patch(sessionId, { objective, verifyCommand: verify, maxRuns: 6, status: 'running', runs: 0, createdAt: Date.now(), autoContinue: true });
    const dispatched: string[] = [];
    const sweeper = goal.createAgyGoalSweeper({
      config: { enabled: true, sweepIntervalMs: 3000, maxRuns: 6, verifyTimeoutMs: 10_000 },
      listGoalSessions: () => store.listSessionIds(),
      isRunning: (id) => svc.isRunning(id),
      getStore: () => store,
      readLastCompletedTurn: (id) => svc.getLastCompletedTurn(id),
      sessionCwd: (id) => svc.getSessionCwd(id),
      dispatch: async (id, message) => {
        dispatched.push(message);
        out({ dispatched: message.slice(0, 80), cutOffNote: /cut off/i.test(message) });
        void svc.sendPrompt(id, message, () => {}, () => {});
      },
    });
    sweeper.start();
    void svc.sendPrompt(sessionId, goal.buildAgyGoalStartPrompt(objective, true), () => {}, () => {});
    const deadline = Date.now() + 14 * 60_000;
    for (;;) {
      await new Promise((r) => setTimeout(r, 5000));
      const rec = await store.get(sessionId);
      out({ goal: rec?.status, runs: rec?.runs, strikes: rec?.consecutiveErrors ?? 0, lastReason: (rec?.lastReason ?? '').slice(0, 120), okFile: fs.existsSync(path.join(work, 'ok.txt')) });
      if (rec && rec.status !== 'running') break;
      if (Date.now() > deadline) { out({ timedOut: true }); break; }
    }
    sweeper.stop();
    out({ dispatchedCount: dispatched.length, cutOffNotes: dispatched.filter((m) => /cut off/i.test(m)).length });
  }
  await svc.shutdown();
  process.exit(0);
}
void main().catch((e) => { out({ fatal: String(e) }); process.exit(1); });
