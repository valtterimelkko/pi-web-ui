#!/usr/bin/env npx tsx
/**
 * Claude Profile Validation Runner
 *
 * Drives the Pi Web UI Internal API to validate Claude provider profiles
 * end-to-end: SDK backend, direct CLI backend, tool visibility, skills,
 * follow-up, and concurrency — all through a disposable validation server.
 *
 * Usage:
 *   npm run validate:server -- --dir "$VAL_DIR" --port 0 ...
 *   npx tsx scripts/validate-claude-profiles.ts --socket <sock> --token-path <token> [--glm-profile <id>] [--native-profile <id>]
 *
 * Exit non-zero if any required scenario fails.
 */

import { InternalApiClient } from '../server/src/live-validation/internal-api-client.js';
import { resolveValidationTarget } from '../server/src/live-validation/validation-safety.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ─── Args ────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    socketPath: get('--socket'),
    tokenPath: get('--token-path'),
    glmProfile: get('--glm-profile'),
    nativeProfile: get('--native-profile'),
    directProfile: get('--direct-profile'),
    cwd: get('--cwd') || '/tmp/claude-profile-validate',
    artifactsDir: get('--artifacts-dir') || `/tmp/claude-profile-validate-${Date.now()}`,
    list: argv.includes('--list'),
    only: argv.includes('--only') ? get('--only')?.split(',') : undefined,
    allowProduction: argv.includes('--allow-production'),
  };
}

// ─── Scenario framework ──────────────────────────────────────────────────────

interface Assertion {
  name: string;
  passed: boolean;
  details?: string;
}

interface ScenarioResult {
  scenario: string;
  passed: boolean;
  skipped: boolean;
  reason?: string;
  assertions: Assertion[];
  durationMs: number;
}

function makeResult(scenario: string): ScenarioResult {
  return { scenario, passed: true, skipped: false, assertions: [], durationMs: 0 };
}

function assert(result: ScenarioResult, name: string, passed: boolean, details?: string): void {
  result.assertions.push({ name, passed, details });
  if (!passed) result.passed = false;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const target = resolveValidationTarget({
    socketPath: args.socketPath,
    tokenPath: args.tokenPath,
    allowProduction: args.allowProduction,
  });

  const client = new InternalApiClient({
    socketPath: target.socketPath,
    tokenPath: target.tokenPath,
  });

  // Prepare artifacts dir
  fs.mkdirSync(args.artifactsDir, { recursive: true });
  fs.mkdirSync(args.cwd, { recursive: true });

  const capabilities = await client.getCapabilities();
  const modelsResp = await client.getModels();

  // Save capabilities and models
  fs.writeFileSync(path.join(args.artifactsDir, 'capabilities.json'), JSON.stringify(capabilities, null, 2));
  fs.writeFileSync(path.join(args.artifactsDir, 'models.json'), JSON.stringify(modelsResp, null, 2));

  const results: ScenarioResult[] = [];
  const startTime = Date.now();

  // ─── Scenario 1: capabilities/models expose profiles ─────────────────────
  results.push(await scenario1_exposeProfiles(capabilities, modelsResp, args));

  // ─── Scenario 2: SDK native Claude smoke ─────────────────────────────────
  if (!args.only || args.only.includes('2')) {
    results.push(await scenario2_sdkNativeSmoke(client, args));
  }

  // ─── Scenario 3: SDK GLM profile smoke ───────────────────────────────────
  if (!args.only || args.only.includes('3')) {
    results.push(await scenario3_sdkGlmSmoke(client, args));
  }

  // ─── Scenario 4: direct CLI GLM smoke ────────────────────────────────────
  if (!args.only || args.only.includes('4')) {
    results.push(await scenario4_directCliGlm(client, args));
  }

  // ─── Scenario 6: follow-up and profile persistence ───────────────────────
  if (!args.only || args.only.includes('6')) {
    results.push(await scenario6_followUp(client, args));
  }

  // ─── Scenario 8: real-ish skill workflow ─────────────────────────────────
  if (!args.only || args.only.includes('8')) {
    results.push(await scenario8_skillWorkflow(client, args));
  }

  // ─── Print results ────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log(' Claude Profile Validation Results');
  console.log('══════════════════════════════════════════════════════');
  for (const r of results) {
    const badge = r.skipped ? '⏭️' : r.passed ? '✅' : '❌';
    console.log(`${badge} ${r.scenario} (${r.durationMs}ms)`);
    for (const a of r.assertions) {
      console.log(`   ${a.passed ? '✓' : '✗'} ${a.name}${a.details ? ` — ${a.details}` : ''}`);
    }
    if (r.reason) console.log(`   reason: ${r.reason}`);
  }

  const totalDuration = Date.now() - startTime;
  const passed = results.filter((r) => r.passed && !r.skipped).length;
  const failed = results.filter((r) => !r.passed && !r.skipped).length;
  const skipped = results.filter((r) => r.skipped).length;
  console.log('──────────────────────────────────────────────────────');
  console.log(` ${passed} passed | ${failed} failed | ${skipped} skipped | ${totalDuration}ms total`);
  console.log(` Artifacts: ${args.artifactsDir}`);
  console.log('══════════════════════════════════════════════════════\n');

  // Save report
  fs.writeFileSync(
    path.join(args.artifactsDir, 'validation-report.md'),
    buildReport(results, totalDuration, args),
  );

  process.exit(failed > 0 ? 1 : 0);
}

// ─── Scenarios ───────────────────────────────────────────────────────────────

async function scenario1_exposeProfiles(
  capabilities: any,
  modelsResp: any,
  args: ReturnType<typeof parseArgs>,
): Promise<ScenarioResult> {
  const r = makeResult('Scenario 1: capabilities/models expose profiles');
  const start = Date.now();

  // Claude runtime available
  assert(r, 'claude runtime available', capabilities.runtimes?.claude?.available === true);

  // Model list includes Claude entries
  const claudeModels = modelsResp.models?.claude ?? [];
  assert(r, 'Claude models listed', claudeModels.length > 0, `${claudeModels.length} entries`);

  // Profile entries visible (if profiles are configured)
  const profileModels = claudeModels.filter((m: any) => m.id?.startsWith('profile:'));
  if (args.glmProfile || args.nativeProfile) {
    assert(r, 'Profile-backed model entries visible', profileModels.length > 0,
      profileModels.map((m: any) => m.id).join(', '));
  } else {
    assert(r, 'No profiles configured (skipped)', true);
  }

  // Capabilities may expose claudeProfiles
  if ((capabilities as any).claudeProfiles) {
    assert(r, 'claudeProfiles in capabilities', true,
      `${(capabilities as any).claudeProfiles.length} profiles`);
  }

  r.durationMs = Date.now() - start;
  return r;
}

async function scenario2_sdkNativeSmoke(
  client: InternalApiClient,
  args: ReturnType<typeof parseArgs>,
): Promise<ScenarioResult> {
  const r = makeResult('Scenario 2: SDK native Claude smoke');
  if (!args.nativeProfile) {
    r.skipped = true;
    r.reason = 'No native profile specified (--native-profile)';
    return r;
  }
  const start = Date.now();

  try {
    const cwd = path.join(args.cwd, 's2-native');
    fs.mkdirSync(cwd, { recursive: true });
    const session = await client.createSession({
      runtime: 'claude',
      cwd,
      model: `profile:${args.nativeProfile}`,
    });

    assert(r, 'session created', !!session.sessionId);

    // Use full verbosity to capture model identity from events
    const events = await client.promptStream(session.sessionId, {
      message: 'This is a validation smoke test. In your assigned cwd only, create sdk-native-smoke.txt containing the words SDK_NATIVE_OK, read it back, and report the exact file path.',
      verbosity: 'full',
    });

    // ── Model identity verification ─────────────────────────────────────────
    const initEvent = events.find((e: any) => e.type === 'session_init');
    const resultEvent = events.find((e: any) => e.type === 'claude_result' || e.type === 'result');
    const initData = initEvent?.data as Record<string, unknown> | undefined;
    const modelInInit = initData?.model as string | undefined;
    const apiKeySource = initData?.apiKeySource as string | undefined;
    const modelUsageKeys = resultEvent
      ? Object.keys((resultEvent.data as Record<string, unknown>)?.modelUsage as Record<string, unknown> ?? {})
      : [];

    assert(r, 'session_init event present', !!initEvent);
    assert(r, 'model is a Claude model (not GLM)',
      !!modelInInit && modelInInit.toLowerCase().includes('claude'),
      `init model=${modelInInit}`);
    assert(r, 'model is NOT glm',
      !modelInInit?.toLowerCase().includes('glm'),
      `init model=${modelInInit}`);
    assert(r, 'apiKeySource is none (subscription, not pay-per-use)',
      apiKeySource === 'none',
      `apiKeySource=${apiKeySource}`);

    // Extract the final answer text
    const textEvents = events.filter((e: any) => e.type === 'message_update');
    const answerText = textEvents.map((e: any) => {
      const d = e.data as { assistantMessageEvent?: { delta?: string } };
      return d?.assistantMessageEvent?.delta ?? '';
    }).join('');

    assert(r, 'answer mentions file creation', answerText.includes('SDK_NATIVE_OK') || answerText.includes('sdk-native-smoke'),
      answerText.slice(0, 200));

    const fileExists = fs.existsSync(path.join(cwd, 'sdk-native-smoke.txt'));
    assert(r, 'file exists in cwd', fileExists);

    // Check session info for profile metadata
    const info = await client.getSessionInfo(session.sessionId);
    assert(r, 'session has profile metadata', (info as any).claudeProfileId === args.nativeProfile,
      `profileId=${(info as any).claudeProfileId ?? '(none)'}`);

    // Save event stream with model identity
    fs.writeFileSync(
      path.join(args.artifactsDir, 's2-native-events.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n'),
    );

    await client.deleteSession(session.sessionId).catch(() => {});
  } catch (err) {
    assert(r, 'no exception', false, err instanceof Error ? err.message : String(err));
  }

  r.durationMs = Date.now() - start;
  return r;
}

async function scenario3_sdkGlmSmoke(
  client: InternalApiClient,
  args: ReturnType<typeof parseArgs>,
): Promise<ScenarioResult> {
  const r = makeResult('Scenario 3: SDK GLM profile smoke');
  if (!args.glmProfile) {
    r.skipped = true;
    r.reason = 'No GLM profile specified (--glm-profile)';
    return r;
  }
  const start = Date.now();

  try {
    const cwd = path.join(args.cwd, 's3-glm');
    fs.mkdirSync(cwd, { recursive: true });
    const session = await client.createSession({
      runtime: 'claude',
      cwd,
      model: `profile:${args.glmProfile}`,
    });
    assert(r, 'session created', !!session.sessionId);

    // Stream full events to check tool visibility
    const events = await client.promptStream(session.sessionId, {
      message: 'This is a validation smoke test for GLM via Claude SDK profile. In your assigned cwd only, create sdk-glm-smoke.txt containing SDK_GLM_OK, read it back. Then load the uk-home-diy-product-search skill and summarise the canonical script path from the skill. Do not browse websites.',
      verbosity: 'full',
    });

    const toolStarts = events.filter((e) => e.type === 'tool_execution_start');
    const toolEnds = events.filter((e) => e.type === 'tool_execution_end');
    const textEvents = events.filter((e) => e.type === 'message_update');

    // ── Model identity verification (the critical check) ────────────────────
    const initEvent = events.find((e: any) => e.type === 'session_init');
    const resultEvent = events.find((e: any) => e.type === 'claude_result' || e.type === 'result');
    const initData = initEvent?.data as Record<string, unknown> | undefined;
    const modelInInit = initData?.model as string | undefined;
    const apiKeySource = initData?.apiKeySource as string | undefined;

    assert(r, 'session_init event present', !!initEvent);
    assert(r, 'model is GLM 5.2 (not Claude)',
      !!modelInInit && modelInInit.toLowerCase().includes('glm'),
      `init model=${modelInInit}`);
    assert(r, 'model is NOT a Claude model',
      !modelInInit?.toLowerCase().includes('claude'),
      `init model=${modelInInit}`);
    assert(r, 'apiKeySource is none (subscription token, not pay-per-use)',
      apiKeySource === 'none',
      `apiKeySource=${apiKeySource}`);
    assert(r, 'apiKeySource is NOT environment_key (would mean pay-per-use)',
      apiKeySource !== 'environment_key',
      `apiKeySource=${apiKeySource}`);

    assert(r, 'tool_execution_start events visible', toolStarts.length > 0,
      `${toolStarts.length} tool starts: ${toolStarts.map((e) => (e.data as any)?.toolName).join(',')}`);
    assert(r, 'tool_execution_end events visible', toolEnds.length > 0,
      `${toolEnds.length} tool ends`);
    assert(r, 'assistant text events visible', textEvents.length > 0);

    // Check file was created
    const fileExists = fs.existsSync(path.join(cwd, 'sdk-glm-smoke.txt'));
    assert(r, 'file created', fileExists);

    // Check skill was loaded
    const skillTool = toolStarts.find((e) => (e.data as any)?.toolName === 'Skill');
    assert(r, 'Skill tool used', !!skillTool);

    // Save event stream
    fs.writeFileSync(
      path.join(args.artifactsDir, 's3-glm-events.jsonl'),
      events.map((e) => JSON.stringify(e)).join('\n'),
    );

    await client.deleteSession(session.sessionId).catch(() => {});
  } catch (err) {
    assert(r, 'no exception', false, err instanceof Error ? err.message : String(err));
  }

  r.durationMs = Date.now() - start;
  return r;
}

async function scenario4_directCliGlm(
  client: InternalApiClient,
  args: ReturnType<typeof parseArgs>,
): Promise<ScenarioResult> {
  const r = makeResult('Scenario 4: direct CLI GLM smoke');
  if (!args.directProfile) {
    r.skipped = true;
    r.reason = 'No direct CLI profile specified (--direct-profile)';
    return r;
  }
  const start = Date.now();

  try {
    const cwd = path.join(args.cwd, 's4-direct');
    fs.mkdirSync(cwd, { recursive: true });
    const session = await client.createSession({
      runtime: 'claude',
      cwd,
      model: `profile:${args.directProfile}`,
    });
    assert(r, 'session created', !!session.sessionId);

    // Use full verbosity to capture model identity
    const events = await client.promptStream(session.sessionId, {
      message: 'Create direct-cli-smoke.txt containing DIRECT_CLI_OK and read it back.',
      verbosity: 'full',
    });

    // ── Model identity verification ─────────────────────────────────────────
    const initEvent = events.find((e: any) => e.type === 'session_init');
    const initData = initEvent?.data as Record<string, unknown> | undefined;
    const modelInInit = initData?.model as string | undefined;
    const apiKeySource = initData?.apiKeySource as string | undefined;

    assert(r, 'model is GLM (direct CLI path)',
      !!modelInInit && modelInInit.toLowerCase().includes('glm'),
      `init model=${modelInInit}`);
    assert(r, 'apiKeySource is none (direct CLI also uses subscription token)',
      apiKeySource === 'none',
      `apiKeySource=${apiKeySource}`);

    // Extract answer text
    const textEvents = events.filter((e: any) => e.type === 'message_update');
    const answerText = textEvents.map((e: any) => {
      const d = e.data as { assistantMessageEvent?: { delta?: string } };
      return d?.assistantMessageEvent?.delta ?? '';
    }).join('');

    assert(r, 'prompt completed', !!answerText);
    const fileExists = fs.existsSync(path.join(cwd, 'direct-cli-smoke.txt'));
    assert(r, 'file created', fileExists);

    await client.deleteSession(session.sessionId).catch(() => {});
  } catch (err) {
    assert(r, 'no exception', false, err instanceof Error ? err.message : String(err));
  }

  r.durationMs = Date.now() - start;
  return r;
}

async function scenario6_followUp(
  client: InternalApiClient,
  args: ReturnType<typeof parseArgs>,
): Promise<ScenarioResult> {
  const r = makeResult('Scenario 6: follow-up and profile persistence');
  if (!args.glmProfile) {
    r.skipped = true;
    r.reason = 'No GLM profile specified';
    return r;
  }
  const start = Date.now();

  try {
    const cwd = path.join(args.cwd, 's6-followup');
    fs.mkdirSync(cwd, { recursive: true });

    // Turn 1
    const session = await client.createSession({
      runtime: 'claude',
      cwd,
      model: `profile:${args.glmProfile}`,
    });
    assert(r, 'session created', !!session.sessionId);

    const result1 = await client.prompt(session.sessionId, {
      message: 'Create profile-memory.txt with the text FIRST_TURN_OK and tell me the file name only.',
      verbosity: 'answers',
    });
    assert(r, 'turn 1 completed', !!result1.content);

    // Turn 2 (follow-up)
    const result2 = await client.prompt(session.sessionId, {
      message: 'Read the file you created in the previous turn and append SECOND_TURN_OK. Then read it back.',
      verbosity: 'answers',
    });
    assert(r, 'turn 2 completed', !!result2.content);

    // Check file contains both markers
    const fileContent = fs.readFileSync(path.join(cwd, 'profile-memory.txt'), 'utf-8');
    assert(r, 'file has FIRST_TURN_OK', fileContent.includes('FIRST_TURN_OK'));
    assert(r, 'file has SECOND_TURN_OK', fileContent.includes('SECOND_TURN_OK'));

    // Check profile persisted across turns
    const info = await client.getSessionInfo(session.sessionId);
    assert(r, 'same profile on follow-up', (info as any).claudeProfileId === args.glmProfile);

    await client.deleteSession(session.sessionId).catch(() => {});
  } catch (err) {
    assert(r, 'no exception', false, err instanceof Error ? err.message : String(err));
  }

  r.durationMs = Date.now() - start;
  return r;
}

async function scenario8_skillWorkflow(
  client: InternalApiClient,
  args: ReturnType<typeof parseArgs>,
): Promise<ScenarioResult> {
  const r = makeResult('Scenario 8: real-ish skill workflow');
  if (!args.glmProfile) {
    r.skipped = true;
    r.reason = 'No GLM profile specified';
    return r;
  }
  const start = Date.now();

  try {
    const cwd = path.join(args.cwd, 's8-skill');
    fs.mkdirSync(cwd, { recursive: true });
    const session = await client.createSession({
      runtime: 'claude',
      cwd,
      model: `profile:${args.glmProfile}`,
    });

    const result = await client.prompt(session.sessionId, {
      message: 'A user asks: find live UK options for a cordless drill from Screwfix/Wickes. For validation, do not contact retail sites. Instead, load the skill you would use, identify the exact command template you would run, and explain what JSON evidence you would require before claiming success.',
      verbosity: 'answers',
    });

    assert(r, 'prompt completed', !!result.content);

    const content = result.content.toLowerCase();
    assert(r, 'mentions uk-home-diy-product-search or the script',
      content.includes('uk-home-diy') || content.includes('scrape_uk_shops') || content.includes('screwfix'),
      result.content.slice(0, 300));
    assert(r, 'mentions JSON evidence requirement',
      content.includes('json') || content.includes('evidence'),
      'looking for JSON/evidence mention');

    await client.deleteSession(session.sessionId).catch(() => {});
  } catch (err) {
    assert(r, 'no exception', false, err instanceof Error ? err.message : String(err));
  }

  r.durationMs = Date.now() - start;
  return r;
}

// ─── Report builder ──────────────────────────────────────────────────────────

function buildReport(results: ScenarioResult[], totalDuration: number, args: ReturnType<typeof parseArgs>): string {
  const lines: string[] = [
    '# Claude Profile Validation Report',
    '',
    `**Date:** ${new Date().toISOString()}`,
    `**Duration:** ${totalDuration}ms`,
    `**Profiles:** glm=${args.glmProfile || '(none)'}, native=${args.nativeProfile || '(none)'}, direct=${args.directProfile || '(none)'}`,
    '',
    '## Results',
    '',
    '| Scenario | Status | Duration |',
    '|---|---|---|',
  ];

  for (const r of results) {
    const status = r.skipped ? '⏭️ SKIP' : r.passed ? '✅ PASS' : '❌ FAIL';
    lines.push(`| ${r.scenario} | ${status} | ${r.durationMs}ms |`);
  }

  lines.push('', '## Details', '');
  for (const r of results) {
    lines.push(`### ${r.scenario}`, '');
    if (r.reason) lines.push(`_Skipped: ${r.reason}_`, '');
    for (const a of r.assertions) {
      lines.push(`- ${a.passed ? '✓' : '✗'} **${a.name}**${a.details ? ` — ${a.details}` : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Entry ───────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('[validate-claude-profiles] Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
