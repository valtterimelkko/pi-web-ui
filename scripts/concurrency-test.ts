#!/usr/bin/env npx tsx
/**
 * Concurrency test: run native Claude + GLM sessions simultaneously.
 * Verifies no session lock conflicts, no cross-contamination, correct models.
 */
import { InternalApiClient } from '../server/src/live-validation/internal-api-client.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SOCKET = process.argv[2] || process.env.SOCKET_PATH;
const TOKEN_PATH = process.env.TOKEN_PATH;
const ARTIFACTS = '/tmp/concurrency-test-' + Date.now();

fs.mkdirSync(ARTIFACTS, { recursive: true });

async function main() {
  const client = new InternalApiClient({ socketPath: SOCKET, tokenPath: TOKEN_PATH });

  // Create separate working directories
  const cwdClaude = path.join(ARTIFACTS, 'native-claude');
  const cwdGlm = path.join(ARTIFACTS, 'glm');
  fs.mkdirSync(cwdClaude, { recursive: true });
  fs.mkdirSync(cwdGlm, { recursive: true });

  console.log('=== Creating two sessions ===');

  // Create both sessions
  const [claudeSession, glmSession] = await Promise.all([
    client.createSession({ runtime: 'claude' as any, cwd: cwdClaude, model: 'profile:claude-sonnet-sdk-subscription' }),
    client.createSession({ runtime: 'claude' as any, cwd: cwdGlm, model: 'profile:glm52-claude-sdk-native-profile' }),
  ]);

  console.log(`Native Claude session: ${claudeSession.sessionId}`);
  console.log(`GLM session: ${glmSession.sessionId}`);

  // Verify profile metadata
  const [claudeInfo, glmInfo] = await Promise.all([
    client.getSessionInfo(claudeSession.sessionId),
    client.getSessionInfo(glmSession.sessionId),
  ]);

  console.log(`Claude profileId: ${(claudeInfo as any).claudeProfileId}`);
  console.log(`GLM profileId: ${(glmInfo as any).claudeProfileId}`);

  // Run both prompts SIMULTANEOUSLY using full verbosity to capture model identity
  const claudePrompt = 'In your assigned cwd only, create concurrency-test.txt containing CLAUDE_CONCURRENT_OK, then read it back, then sleep 3 seconds via Bash, then report your model identity.';
  const glmPrompt = 'In your assigned cwd only, create concurrency-test.txt containing GLM_CONCURRENT_OK, then read it back, then sleep 3 seconds via Bash, then report your model identity.';

  console.log('\n=== Launching both prompts simultaneously ===');
  const startTime = Date.now();

  const [claudeResult, glmResult] = await Promise.all([
    client.promptStream(claudeSession.sessionId, { message: claudePrompt, verbosity: 'full' as any }).
      then(events => ({ success: true as const, events, error: undefined as string | undefined })).
      catch(err => ({ success: false as const, events: [] as any[], error: err instanceof Error ? err.message : String(err) })),
    client.promptStream(glmSession.sessionId, { message: glmPrompt, verbosity: 'full' as any }).
      then(events => ({ success: true as const, events, error: undefined as string | undefined })).
      catch(err => ({ success: false as const, events: [] as any[], error: err instanceof Error ? err.message : String(err) })),
  ]);

  const elapsed = Date.now() - startTime;
  console.log(`\nBoth completed in ${elapsed}ms`);

  // ── Assertions ────────────────────────────────────────────────────────────
  let allPass = true;
  function check(name: string, passed: boolean, details?: string) {
    const badge = passed ? '✓' : '✗';
    console.log(`  ${badge} ${name}${details ? ` — ${details}` : ''}`);
    if (!passed) allPass = false;
  }

  console.log('\n=== Concurrency Results ===');

  // Both completed successfully
  check('Native Claude prompt completed', claudeResult.success, claudeResult.error);
  check('GLM prompt completed', glmResult.success, glmResult.error);

  // Model identity (the critical check)
  if (claudeResult.events.length > 0) {
    const init = claudeResult.events.find((e: any) => e.type === 'session_init');
    const model = (init?.data as any)?.model;
    check('Claude session used Claude model', !!model && model.toLowerCase().includes('claude'), `model=${model}`);
    check('Claude session did NOT use GLM', !model?.toLowerCase().includes('glm'), `model=${model}`);
  }

  if (glmResult.events.length > 0) {
    const init = glmResult.events.find((e: any) => e.type === 'session_init');
    const model = (init?.data as any)?.model;
    check('GLM session used GLM model', !!model && model.toLowerCase().includes('glm'), `model=${model}`);
    check('GLM session did NOT use Claude', !model?.toLowerCase().includes('claude'), `model=${model}`);
  }

  // No cross-contamination
  const claudeFile = path.join(cwdClaude, 'concurrency-test.txt');
  const glmFile = path.join(cwdGlm, 'concurrency-test.txt');

  if (fs.existsSync(claudeFile)) {
    const content = fs.readFileSync(claudeFile, 'utf-8');
    check('Claude session wrote to its own directory', content.includes('CLAUDE_CONCURRENT_OK'), `content=${content.trim()}`);
    check('Claude directory NOT contaminated by GLM', !content.includes('GLM'), `content=${content.trim()}`);
  } else {
    check('Claude session wrote file', false, 'file missing');
  }

  if (fs.existsSync(glmFile)) {
    const content = fs.readFileSync(glmFile, 'utf-8');
    check('GLM session wrote to its own directory', content.includes('GLM_CONCURRENT_OK'), `content=${content.trim()}`);
    check('GLM directory NOT contaminated by Claude', !content.includes('CLAUDE'), `content=${content.trim()}`);
  } else {
    check('GLM session wrote file', false, 'file missing');
  }

  // Sessions overlapped (both were running at the same time)
  // If they ran sequentially, total time would be sum of both.
  // If concurrent, total time should be less than sum.
  console.log(`\n  Total elapsed: ${elapsed}ms (concurrent if < sum of individual)`);

  // Profile persistence
  check('Claude profile persisted', (claudeInfo as any).claudeProfileId === 'claude-sonnet-sdk-subscription');
  check('GLM profile persisted', (glmInfo as any).claudeProfileId === 'glm52-claude-sdk-native-profile');
  check('Different profiles used', (claudeInfo as any).claudeProfileId !== (glmInfo as any).claudeProfileId);

  // Save event streams
  if (claudeResult.events.length > 0) {
    fs.writeFileSync(path.join(ARTIFACTS, 'claude-events.jsonl'), claudeResult.events.map(e => JSON.stringify(e)).join('\n'));
  }
  if (glmResult.events.length > 0) {
    fs.writeFileSync(path.join(ARTIFACTS, 'glm-events.jsonl'), glmResult.events.map(e => JSON.stringify(e)).join('\n'));
  }

  // Cleanup
  await client.deleteSession(claudeSession.sessionId).catch(() => {});
  await client.deleteSession(glmSession.sessionId).catch(() => {});

  console.log(`\n${allPass ? '✅ ALL CONCURRENCY CHECKS PASSED' : '❌ SOME CHECKS FAILED'}`);
  console.log(`Artifacts: ${ARTIFACTS}`);
  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
