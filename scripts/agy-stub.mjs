#!/usr/bin/env node
/**
 * Deterministic agy stream-json stub for disposable-server validation.
 *
 * Stands in for the real `agy` binary via the AGY_BINARY environment override
 * (read by server/src/antigravity/agy-stream-process.ts and antigravity-service.ts),
 * so antigravity can be exercised end-to-end on a disposable validation server
 * with no credentials and no real model calls.
 *
 * Wire behaviour mirrors agy 1.1.27 headless stream-json (live-validated):
 *   stdout: NDJSON `init` once, then `step_update` lines, then a `result`
 *           envelope per turn. stdin: one `{"event":"user","message":{...}}`
 *           line per turn.
 *
 * Scenarios (env AGY_STUB_SCENARIO):
 *   tools      (default) text + write_to_file (empty output) + delayed run_command + result
 *   plain      text deltas only + result
 *   background run_command + command_status (agy background-command lifecycle) + result
 *   bg-task    REAL background-task wire (live capture, 2026-09-10): run_command demoted to a
 *              background task group — a GENERIC/RUNNING step announces
 *              "Tool is running as a background task with task id: <conv>/task-N" +
 *              "Task Description: <command>" + "Task logs are available at: file://...". The turn
 *              then ENDS while the task still runs (headless agy never re-prompts). After
 *              AGY_STUB_BG_TASK_DELAY_MS (default 8000) the stub writes the completion receipt
 *              JSON into <AGY_STUB_BRAIN_DIR>/<conv>/.system_generated/messages/ exactly like
 *              real agy, so the server's background-task completion watcher can observe it.
 *   slow       like tools but run_command stalls AGY_STUB_DELAY_MS (default 5000)
 *
 * Usage in tests/scripts:
 *   AGY_BINARY=/root/pi-web-ui/scripts/agy-stub.mjs npm run validate:server
 *   chmod +x required (spawned directly).
 */

const SCENARIOS = new Set(['tools', 'plain', 'background', 'bg-task', 'slow']);

const scenario = process.env.AGY_STUB_SCENARIO && SCENARIOS.has(process.env.AGY_STUB_SCENARIO)
  ? process.env.AGY_STUB_SCENARIO
  : 'tools';
const delayMs = Number.parseInt(process.env.AGY_STUB_DELAY_MS ?? '', 10);

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const model = argValue('--model') ?? 'gemini-3.6-flash-medium';
const convArg = argValue('--conversation');
const conversationId = convArg?.trim() || 'stub-conv-0001-aaaa-bbbb-cccc-dddd00000000';

// The 57-tool inventory captured live from a real agy 1.1.27 init event
// (2026-09-09) — frozen here so fixtures and assertions stay honest.
const TOOL_INVENTORY = [
  'ask_custom_permission', 'ask_permission', 'ask_question', 'browser_click_element',
  'browser_drag_pixel_to_pixel', 'browser_get_dom', 'browser_get_network_request',
  'browser_input', 'browser_list_network_requests', 'browser_mouse_down',
  'browser_mouse_up', 'browser_move_mouse', 'browser_press_key', 'browser_refresh_page',
  'browser_resize_window', 'browser_scroll', 'browser_scroll_dom', 'browser_select_option',
  'browser_subagent', 'call_mcp_tool', 'capture_browser_console_logs',
  'capture_browser_screenshot', 'click_browser_pixel', 'command_status', 'define_subagent',
  'delete_knowledge', 'execute_browser_javascript', 'find_by_name', 'finish',
  'generate_image', 'grep_search', 'invoke_subagent', 'list_browser_pages', 'list_dir',
  'list_permissions', 'list_resources', 'manage_inbox', 'manage_subagents', 'manage_task',
  'multi_replace_file_content', 'notebook_edit', 'notebook_execution', 'open_browser_url',
  'read_browser_page', 'read_resource', 'read_url_content', 'replace_file_content',
  'run_command', 'schedule', 'search_web', 'sed_file', 'send_command_input',
  'send_message', 'view_file', 'wait', 'wait_5_seconds', 'write_to_file',
];

// Real usage captured from a live two-turn conversation (2026-09-09 A/B run).
// agy semantics: total = input + output; cacheRead is ADDITIONAL (the real
// request size is input + cacheRead). Later turns grow accordingly.
const USAGE_BY_TURN = [
  { input_tokens: 42445, output_tokens: 2259, thinking_tokens: 1531, cache_read_tokens: 106044, total_tokens: 44704 },
  { input_tokens: 66273, output_tokens: 2718, thinking_tokens: 1931, cache_read_tokens: 114196, total_tokens: 68991 },
];

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function step(index, state, extra) {
  emit({
    event: 'step_update',
    step_update: { conversation_id: conversationId, step_index: index, state, ...extra },
  });
}

function resultEnvelope(turnIndex, status = 'SUCCESS') {
  const usage = USAGE_BY_TURN[Math.min(turnIndex, USAGE_BY_TURN.length - 1)];
  emit({
    event: 'result',
    result: {
      conversation_id: conversationId,
      status,
      response: 'Stub turn complete.',
      duration_seconds: 1 + turnIndex,
      num_turns: turnIndex + 1,
      usage,
    },
  });
}

let turnCount = 0;

/** Real background-task lifecycle (plan Phase 1 E2E). Faithful to the live
 *  2026-09-10 capture: the turn ends while the task runs, and the receipt
 *  lands in the conversation brain's messages dir (the server's watcher
 *  polls there — see AntigravityService.pollBackgroundCompletions). */
function runBgTaskTurn(prompt) {
  const t = turnCount;
  if (t > 0) {
    // Follow-up turns: plain reply (the receipt was already delivered).
    turnCount += 1;
    step(90 + t, 'ACTIVE', { step_type: 'agent_response', text_delta: 'The background task already finished.' });
    step(90 + t, 'DONE', { step_type: 'agent_response' });
    resultEnvelope(t);
    return;
  }
  turnCount += 1;

  const taskId = `${conversationId}/task-${process.pid}`;
  const command = 'python3 verify_bg_e2e.py';
  const brainDir = process.env.AGY_STUB_BRAIN_DIR;
  const logPath = `${brainDir}/${conversationId}/.system_generated/tasks/task-${process.pid}.log`;
  const messagesDir = `${brainDir}/${conversationId}/.system_generated/messages`;

  let idx = 1;
  step(idx++, 'ACTIVE', { step_type: 'agent_response', text_delta: 'Running the verification script.' });
  step(idx++, 'DONE', { step_type: 'agent_response' });
  step(idx++, 'ACTIVE', { step_type: 'tool', tool_name: 'run_command' });
  step(idx++, 'DONE', {
    step_type: 'tool',
    tool_name: 'run_command',
    tool_info: { name: 'run_command', parameters: { CommandLine: command }, output: 'demoted to background' },
  });
  // The announcement step (real shape: GENERIC/RUNNING, content field).
  emit({
    event: 'step_update',
    step_update: {
      conversation_id: conversationId,
      step_index: idx++,
      state: 'RUNNING',
      step_type: 'GENERIC',
      content: [
        'Created At: 2026-09-10T07:08:35Z',
        `Tool is running as a background task with task id: ${taskId}`,
        `Task Description: ${command}`,
        `Task logs are available at: file://${logPath}`,
        'YOU MUST TAKE ONE OF THE FOLLOWING TWO ACTIONS: A) either proceed to other relevant work or, B) simply update the user and end the turn.',
      ].join('\n'),
    },
  });
  step(idx++, 'ACTIVE', { step_type: 'agent_response', text_delta: 'I launched the command in the background and will report when it finishes.' });
  step(idx++, 'DONE', { step_type: 'agent_response' });
  resultEnvelope(t);

  // Simulate the task finishing: agy writes a MESSAGE_PRIORITY_HIGH receipt
  // into the conversation's messages dir (no stream traffic — the server's
  // completion watcher must notice the file).
  const delayMs = Number.parseInt(process.env.AGY_STUB_BG_TASK_DELAY_MS ?? '', 10);
  const wait = Number.isFinite(delayMs) ? Math.max(0, Math.min(delayMs, 120_000)) : 8_000;
  setTimeout(() => {
    try {
      mkdirSync(messagesDir, { recursive: true });
      writeFileSync(
        join(messagesDir, `receipt-task-${process.pid}.json`),
        JSON.stringify({
          id: `receipt-${process.pid}`,
          recipient: conversationId,
          sender: taskId,
          priority: 'MESSAGE_PRIORITY_HIGH',
          timestamp: new Date().toISOString(),
          renderDetails: { messageTitle: 'Background command finished' },
          content: `Task id "${taskId}" finished with result:\n\nThe command exited with code 0.\nOutput:\nBG-TASK-PROOF`,
        }),
      );
    } catch (err) {
      process.stderr.write(`agy-stub: failed to write completion receipt: ${err}\n`);
    }
  }, wait);
}
function runScenarioTurn(prompt) {
  if (scenario === 'bg-task') {
    runBgTaskTurn(prompt);
    return;
  }
  const t = turnCount++;
  let idx = 1;
  if (scenario === 'plain') {
    step(idx++, 'ACTIVE', { step_type: 'agent_response', text_delta: 'Stub plain reply' });
    step(idx++, 'DONE', { step_type: 'agent_response' });
    resultEnvelope(t);
    return;
  }
  if (scenario === 'background') {
    step(idx++, 'ACTIVE', { step_type: 'tool', tool_name: 'run_command' });
    step(idx++, 'DONE', {
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'npm test --watch &' }, output: 'started background job 42' },
    });
    step(idx++, 'ACTIVE', { step_type: 'tool', tool_name: 'command_status' });
    step(idx++, 'DONE', {
      step_type: 'tool',
      tool_name: 'command_status',
      tool_info: { name: 'command_status', parameters: { JobId: '42' }, output: 'job 42: running\njob 42: passed' },
    });
    step(idx++, 'ACTIVE', { step_type: 'agent_response', text_delta: 'Background suite finished.' });
    step(idx++, 'DONE', { step_type: 'agent_response' });
    resultEnvelope(t);
    return;
  }
  // tools | slow
  step(idx++, 'ACTIVE', { step_type: 'agent_response', text_delta: 'Creating files' });
  step(idx++, 'DONE', { step_type: 'agent_response' });
  step(idx++, 'ACTIVE', { step_type: 'tool', tool_name: 'write_to_file' });
  step(idx++, 'DONE', {
    step_type: 'tool',
    tool_name: 'write_to_file',
    tool_info: { name: 'write_to_file', parameters: { TargetFile: '/tmp/agy-stub/hello.txt', Content: 'hello\n' }, output: '' },
  });
  step(idx++, 'ACTIVE', { step_type: 'tool', tool_name: 'run_command' });
  const finish = () => {
    step(idx + 1, 'DONE', {
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'python3 -m unittest -v' }, output: 'test_add ... ok\nOK' },
    });
    step(idx + 2, 'ACTIVE', { step_type: 'agent_response', text_delta: '. All tests passed.' });
    step(idx + 3, 'DONE', { step_type: 'agent_response' });
    resultEnvelope(t);
  };
  const stall = Number.isFinite(delayMs) ? delayMs : scenario === 'slow' ? 5000 : 300;
  inFlight++;
  setTimeout(() => {
    finish();
    inFlight--;
    if (stdinEnded && inFlight === 0) process.exit(0);
  }, Math.max(0, Math.min(stall, 60_000)));
}

function main() {
  emit({
    event: 'init',
    conversation_id: conversationId,
    init: {
      cwd: process.cwd(),
      tools: TOOL_INVENTORY,
      permission_mode: 'always-proceed',
      model,
    },
  });

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.event === 'user') {
        const prompt = parsed.message?.content ?? '';
        runScenarioTurn(typeof prompt === 'string' ? prompt : '');
      }
    }
  });
  process.stdin.on('end', () => {
    stdinEnded = true;
    if (inFlight === 0) process.exit(0);
  });
  process.stdin.resume();
}

let inFlight = 0;
let stdinEnded = false;

main();
