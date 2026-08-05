#!/usr/bin/env node

import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

const argv = process.argv.slice(2);
const sessionIndex = argv.indexOf('--session');
if (sessionIndex < 0 || !argv[sessionIndex + 1]) {
  process.stderr.write('phase6 fixture requires --session <path>\n');
  process.exit(2);
}
const sessionPath = path.resolve(argv[sessionIndex + 1]);
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let active;
const correlationStore = new AsyncLocalStorage();

function emitWithCorrelation(event, pilotCorrelation) {
  process.stdout.write(`${JSON.stringify(pilotCorrelation ? { ...event, pilotCorrelation } : event)}\n`);
}

function emit(event) {
  emitWithCorrelation(event, correlationStore.getStore());
}

function respond(id, command, success = true, error) {
  emit(success
    ? { id, type: 'response', command, success: true }
    : { id, type: 'response', command, success: false, error: error || `${command} failed` });
}

async function marker(scenario, status, detail = {}) {
  await mkdir(path.dirname(sessionPath), { recursive: true });
  await appendFile(sessionPath, `${JSON.stringify({
    fixture: 'worker-cgroup-conformance/v1',
    scenario,
    status,
    ...detail,
  })}\n`, { encoding: 'utf8', mode: 0o600 });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function normalTurn(id) {
  emit({ type: 'streaming_started' });
  emit({ type: 'agent_start' });
  emit({ type: 'tool_execution_start', id: 'tool-normal', name: 'fixture_wait', input: { durationMs: 100 } });
  await sleep(100);
  emit({ type: 'tool_execution_end', id: 'tool-normal', result: 'ok', isError: false });
  emit({ type: 'message_start', id: 'assistant-normal', role: 'assistant' });
  emit({ type: 'message_update', id: 'assistant-normal', delta: 'NORMAL_OK' });
  emit({ type: 'message_end', id: 'assistant-normal' });
  await marker('normal-turn', 'completed');
  emit({ type: 'agent_end' });
  emit({ type: 'streaming_ended' });
  respond(id, 'prompt');
}

function waitForChild(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

async function boundedFanout(id) {
  emit({ type: 'streaming_started' });
  emit({ type: 'agent_start' });
  emit({ type: 'tool_execution_start', id: 'tool-fanout', name: 'fixture_fanout', input: { childCount: 4, durationMs: 250 } });
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, [
    '-e', 'setTimeout(() => process.exit(0), 250)',
  ], { stdio: 'ignore' }));
  const results = await Promise.all(children.map(waitForChild));
  const failed = results.some((result) => result.code !== 0);
  const result = { childCount: children.length, maxDescendants: 4 };
  emit({ type: 'tool_execution_end', id: 'tool-fanout', result, isError: failed });
  if (!failed) {
    emit({ type: 'message_start', id: 'assistant-fanout', role: 'assistant' });
    emit({ type: 'message_update', id: 'assistant-fanout', delta: 'FANOUT_OK' });
    emit({ type: 'message_end', id: 'assistant-fanout' });
  }
  await marker('bounded-fanout', failed ? 'failed' : 'completed', result);
  emit({ type: 'agent_end' });
  emit({ type: 'streaming_ended' });
  respond(id, 'prompt', !failed, failed ? 'bounded helper failed' : undefined);
}

async function memoryHigh(id) {
  emit({ type: 'streaming_started' });
  emit({ type: 'agent_start' });
  emit({ type: 'tool_execution_start', id: 'tool-memory', name: 'fixture_memory', input: { allocatedMiB: 160, holdMs: 1500 } });
  const child = spawn(process.execPath, [
    '-e',
    'const b=Buffer.alloc(160*1024*1024,1); setTimeout(()=>{process.stdout.write(String(b.length));},1500)',
  ], { stdio: 'ignore' });
  let boundedTimeout = false;
  const pressureTimer = setTimeout(() => {
    boundedTimeout = true;
    child.kill('SIGTERM');
  }, 1750);
  const result = await waitForChild(child);
  clearTimeout(pressureTimer);
  const failed = result.code !== 0 || boundedTimeout;
  emit({ type: 'tool_execution_end', id: 'tool-memory', result: { allocatedMiB: 160, holdMs: 1500, exitCode: result.code, boundedTimeout }, isError: failed });
  await marker('memory-high', failed ? 'allocation-failed' : 'completed', { allocatedMiB: 160, holdMs: 1500, exitCode: result.code, boundedTimeout });
  emit({ type: 'agent_end' });
  emit({ type: 'streaming_ended' });
  respond(id, 'prompt', !failed, failed ? 'bounded allocation failure under memory pressure' : undefined);
}

async function pidPressure(id) {
  emit({ type: 'streaming_started' });
  emit({ type: 'agent_start' });
  emit({ type: 'tool_execution_start', id: 'tool-pids', name: 'fixture_pid_pressure', input: { maxAttempts: 64, holdMs: 500 } });
  const attempts = [];
  for (let index = 0; index < 64; index += 1) {
    attempts.push(new Promise((resolve) => {
      const child = spawn('/bin/sleep', ['0.5'], { stdio: 'ignore' });
      let settled = false;
      const finish = (outcome) => {
        if (settled) return;
        settled = true;
        resolve(outcome);
      };
      child.once('error', (error) => finish({ spawned: false, code: error.code || 'SPAWN_ERROR' }));
      child.once('exit', (code, signal) => finish({ spawned: true, exitCode: code, signal }));
    }));
  }
  const outcomes = await Promise.all(attempts);
  const spawnFailures = outcomes.filter((outcome) => !outcome.spawned).length;
  const eagainFailures = outcomes.filter((outcome) => outcome.code === 'EAGAIN').length;
  const result = { maxAttempts: 64, holdMs: 500, spawnFailures, eagainFailures };
  emit({ type: 'tool_execution_end', id: 'tool-pids', result, isError: spawnFailures > 0 });
  await marker('pid-pressure', spawnFailures > 0 ? 'pressure-observed' : 'completed', result);
  emit({ type: 'agent_end' });
  emit({ type: 'streaming_ended' });
  respond(
    id,
    'prompt',
    spawnFailures === 0,
    spawnFailures > 0 ? `pid pressure observed: ${spawnFailures} spawn failures (${eagainFailures} EAGAIN)` : undefined,
  );
}

async function cancelDrain(id, setAbort, emitLateTerminal = false) {
  emit({ type: 'streaming_started' });
  emit({ type: 'agent_start' });
  emit({ type: 'tool_execution_start', id: 'tool-cancel', name: 'fixture_hold', input: { durationMs: 5000 } });
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 5000)'], { stdio: 'ignore' });
  let cancelled = false;
  const originatingCorrelation = correlationStore.getStore();
  setAbort(() => {
    cancelled = true;
    child.kill('SIGTERM');
    if (emitLateTerminal) {
      setTimeout(() => emitWithCorrelation({ type: 'agent_end' }, originatingCorrelation), 500);
    }
  });
  await waitForChild(child);
  emit({ type: 'tool_execution_end', id: 'tool-cancel', result: cancelled ? 'cancelled' : 'completed', isError: cancelled });
  await marker(emitLateTerminal ? 'cancel-drain-late' : 'cancel-drain', cancelled ? 'cancelled' : 'completed');
  emit({ type: 'agent_end' });
  emit({ type: 'streaming_ended' });
  respond(id, 'prompt');
}

async function restartUnknown(id) {
  emit({ type: 'streaming_started' });
  emit({ type: 'agent_start' });
  emit({ type: 'tool_execution_start', id: 'tool-restart', name: 'fixture_restart_hold', input: { durationMs: 3000 } });
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => process.exit(0), 3000)'], { stdio: 'ignore' });
  await marker('restart-unknown', 'running', { durationMs: 3000 });
  await waitForChild(child);
  emit({ type: 'tool_execution_end', id: 'tool-restart', result: 'completed', isError: false });
  await marker('restart-unknown', 'completed', { durationMs: 3000 });
  emit({ type: 'message_start', id: 'assistant-restart', role: 'assistant' });
  emit({ type: 'message_update', id: 'assistant-restart', delta: 'RESTART_HOLD_COMPLETED' });
  emit({ type: 'message_end', id: 'assistant-restart' });
  emit({ type: 'agent_end' });
  emit({ type: 'streaming_ended' });
  respond(id, 'prompt');
}

async function intentionalCrash() {
  emit({ type: 'streaming_started' });
  emit({ type: 'agent_start' });
  await marker('intentional-crash', 'crashed', { exitCode: 42 });
  process.exit(42);
}

async function runPrompt(command, setAbort) {
  const scenario = command.message;
  if (scenario === 'normal-turn') return normalTurn(command.id);
  if (scenario === 'bounded-fanout') return boundedFanout(command.id);
  if (scenario === 'memory-high') return memoryHigh(command.id);
  if (scenario === 'pid-pressure') return pidPressure(command.id);
  if (scenario === 'cancel-drain') return cancelDrain(command.id, setAbort);
  if (scenario === 'cancel-drain-late') return cancelDrain(command.id, setAbort, true);
  if (scenario === 'intentional-crash') return intentionalCrash();
  if (scenario === 'restart-unknown') return restartUnknown(command.id);
  respond(command.id, 'prompt', false, `unknown frozen scenario: ${scenario}`);
}

rl.on('line', (line) => {
  let command;
  try {
    command = JSON.parse(line);
  } catch {
    return;
  }
  if (command.type === 'prompt') {
    if (active) {
      respond(command.id, 'prompt', false, 'fixture turn already active');
      return;
    }
    let abort = () => {};
    const promise = correlationStore.run(
      command.pilotCorrelation,
      () => runPrompt(command, (handler) => { abort = handler; }),
    ).finally(() => { active = undefined; });
    active = { promise, abort: () => abort() };
    return;
  }
  if (command.type === 'abort') {
    active?.abort();
    respond(command.id, 'abort');
    return;
  }
  respond(command.id, command.type, true);
});
