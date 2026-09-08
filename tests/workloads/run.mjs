#!/usr/bin/env node

/*
 * Small, dependency-light measurement runner for the Node-side performance
 * witnesses.  This is intentionally a plain node script: run it with
 * `node --import tsx tests/workloads/run.mjs --json` from the repository root.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = fileURLToPath(new URL('../../', import.meta.url));
const jsonOutput = process.argv.includes('--json');

// Server configuration is imported by the real modules.  Supplying local-only
// fallbacks keeps the measurement command self-contained without overwriting
// any operator-provided environment values.
for (const name of ['AUTH_PASSWORD', 'AUTH_USERNAME', 'COOKIE_SECRET', 'AUTH_SECRET', 'JWT_SECRET']) {
  if (!process.env[name]) process.env[name] = 'pi-workload-local-only';
}

// Some real modules log progress with console.info/log.  With --json stdout
// must remain a parseable result document, so keep runtime diagnostics on
// stderr where the summary also goes.
if (jsonOutput) {
  for (const method of ['log', 'info', 'warn', 'debug']) {
    console[method] = (...args) => process.stderr.write(`${args.map(String).join(' ')}\n`);
  }
}

const immediate = () => new Promise((resolve) => setImmediate(resolve));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function p95(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

function timed(work) {
  const started = performance.now();
  const value = work();
  return Promise.resolve(value).then((result) => ({
    elapsed: performance.now() - started,
    result,
  }));
}

async function waitUntil(predicate, label, attempts = 500) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return;
    await immediate();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function gate(expected, actual, passed) {
  return { expected, actual, passed };
}

function workloadRecord(fixture, samples, gates) {
  return {
    fixture,
    samples: samples.map((sample) => Number(sample.toFixed(3))),
    medianMs: Number(median(samples).toFixed(3)),
    p95Ms: Number(p95(samples).toFixed(3)),
    gates,
  };
}

async function loadModule(relativePath) {
  return import(pathToFileURL(join(root, relativePath)).href);
}

function revision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

function seedRegistryFile(pathname) {
  writeFileSync(pathname, JSON.stringify({
    version: 1,
    updatedAt: '2026-09-08T00:00:00.000Z',
    entries: [],
  }, null, 2));
}

async function registrySample(SessionRegistryManager) {
  const rootDir = mkdtempSync(join(tmpdir(), 'pi-registry-workload-'));
  const pathname = join(rootDir, 'registry.json');
  seedRegistryFile(pathname);
  try {
    const manager = new SessionRegistryManager(pathname);
    await manager.load();

    let tmpWrites = 0;
    let releaseFirst;
    const firstWriteGate = new Promise((resolve) => { releaseFirst = resolve; });
    attachRegistrySeams(manager, async (path, data) => {
      if (!path.endsWith('.tmp')) return;
      tmpWrites += 1;
      if (tmpWrites === 1) await firstWriteGate;
      writeFileSync(path, data);
    });

    const started = performance.now();
    const promises = [manager.upsert({ sdkType: 'pi', cwd: '/w', path: '/sessions/s0' })];
    await waitUntil(() => tmpWrites > 0, 'the first registry write latch');
    for (let index = 1; index < 100; index++) {
      promises.push(manager.upsert({ sdkType: 'pi', cwd: '/w', path: `/sessions/s${index}` }));
    }
    releaseFirst();
    await Promise.all(promises);

    // A newly constructed manager exercises the persisted snapshot reload,
    // matching the performance fixture rather than trusting in-memory state.
    const reloaded = new SessionRegistryManager(pathname);
    const reloadCount = (await reloaded.listAll()).length;
    return {
      elapsed: performance.now() - started,
      tmpWrites,
      reloadCount,
    };
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
}

function attachRegistrySeams(manager, writeFile, rename = async (from, to) => {
  renameSync(from, to);
}) {
  // These are the supported injectable seams used by the unit performance
  // fixture.  The cast is needed only in TypeScript; this runner is JS.
  manager.writeFile = writeFile;
  manager.rename = rename;
}

async function runRegistry() {
  const { SessionRegistryManager } = await loadModule('server/src/session-registry.ts');
  const samples = [];
  let maxTmpWrites = 0;
  let reloadCount = 0;
  for (let iteration = 0; iteration < 12; iteration++) {
    const sample = await registrySample(SessionRegistryManager);
    if (iteration >= 2) {
      samples.push(sample.elapsed);
      maxTmpWrites = Math.max(maxTmpWrites, sample.tmpWrites);
      reloadCount = sample.reloadCount;
    }
  }
  return workloadRecord(
    { concurrentUpserts: 100, warmups: 2, measuredSamples: 10 },
    samples,
    {
      tmpWrites: gate(2, maxTmpWrites, maxTmpWrites <= 2),
      reloadCount: gate(100, reloadCount, reloadCount === 100),
    },
  );
}

function watcherInfo(filePath) {
  return {
    id: 'watcher-workload-session',
    path: filePath,
    cwd: '/workload',
    firstMessage: 'workload fixture',
    messageCount: 2,
    createdAt: new Date('2026-09-08T15:00:00.000Z'),
    lastActivity: new Date('2026-09-08T15:00:01.000Z'),
  };
}

async function watcherSample(SessionWatcher) {
  const rootDir = mkdtempSync(join(tmpdir(), 'pi-watcher-workload-'));
  const filePath = join(rootDir, 'session.jsonl');
  writeFileSync(filePath, `${JSON.stringify({ type: 'session', id: 'watcher-workload-session', cwd: '/workload' })}\n`);

  const pendingReads = [];
  let updates = 0;
  const watcher = new SessionWatcher(rootDir, undefined, {
    debounceDelay: 0,
    readSessionInfo: async () => new Promise((resolve) => {
      pendingReads.push(() => resolve(watcherInfo(filePath)));
    }),
  });
  watcher.on('session_update', () => { updates += 1; });

  try {
    const started = performance.now();
    for (let burst = 0; burst < 10; burst++) {
      for (let notification = 0; notification < 10; notification++) {
        // handleChange is the real watcher path; the unit test reaches this
        // private method through the same runtime seam after a chokidar event.
        watcher.handleChange('change', filePath);
      }

      // The first notification owns one in-flight read.  The remaining nine
      // set one revalidation bit, so releasing reads as they appear exercises
      // the bounded trailing-read behaviour without a real clock dependency.
      for (let spin = 0; spin < 20; spin++) {
        while (pendingReads.length > 0) pendingReads.shift()();
        await immediate();
        if (pendingReads.length === 0) break;
      }
      // Give the zero-delay debounce timer a timers-phase turn before the
      // immediate-based guard below (a tight check-phase loop can otherwise
      // starve a timer on a fast machine).
      await sleep(2);
      await waitUntil(() => updates >= burst + 1, `watcher burst ${burst + 1}`, 250);
    }
    return {
      elapsed: performance.now() - started,
      fullReads: watcher.debugFullReadCount,
      headerReads: watcher.debugHeaderReadCount,
    };
  } finally {
    await watcher.stop();
    await rm(rootDir, { recursive: true, force: true });
  }
}

async function runWatcher() {
  const { SessionWatcher } = await loadModule('server/src/pi/session-watcher.ts');
  const samples = [];
  let maxFullReads = 0;
  let headerReads = 0;
  for (let iteration = 0; iteration < 6; iteration++) {
    const sample = await watcherSample(SessionWatcher);
    if (iteration >= 1) {
      samples.push(sample.elapsed);
      maxFullReads = Math.max(maxFullReads, sample.fullReads);
      headerReads = sample.headerReads;
    }
  }
  return workloadRecord(
    { bursts: 10, notificationsPerBurst: 10, warmups: 1, measuredSamples: 5 },
    samples,
    {
      fullReads: gate(20, maxFullReads, maxFullReads <= 20),
      headerReads: gate(100, headerReads, headerReads === 100),
    },
  );
}

function brokerEvent(type, data = {}) {
  return {
    type,
    timestamp: '2026-09-08T15:00:00.000Z',
    data: { [type]: true, ...data },
  };
}

async function brokerSample(InternalApiEventBroker, OperationalMetrics) {
  const budget = 16 * 1024;
  const coldKeyLimit = 64;
  const metrics = new OperationalMetrics({ now: () => 0 });
  const broker = new InternalApiEventBroker({
    metrics,
    replayBufferMaxBytes: 4 * 1024,
    replayBudgetMaxBytes: budget,
    coldKeyLimit,
  });

  const started = performance.now();
  for (let index = 0; index < 2_000; index++) {
    const key = `cold-${index}`;
    broker.publish(key, brokerEvent('message_update', { text: `x${index}` }));
    broker.publish(key, brokerEvent('message_update', { text: `y${index}` }));

    // Churn a subscriber independently of the cold-key population.  Both
    // supported cleanup shapes are handled so this remains a plain JS runner
    // across broker revisions.
    const owner = `workload-subscriber-${index}`;
    const unsubscribe = broker.subscribe('subscriber-churn', () => {}, true, owner);
    if (typeof unsubscribe === 'function') unsubscribe();
    else if (typeof broker.unsubscribe === 'function') broker.unsubscribe('subscriber-churn', owner);
  }
  const pipeline = metrics.snapshot().pipeline;
  const retainedBytes = Number(pipeline.brokerReplayRetainedBytes ?? 0);
  const coldKeys = Number(broker.debugColdKeyCount ?? 0);
  return {
    elapsed: performance.now() - started,
    retainedBytes,
    coldKeys,
    budget,
    coldKeyLimit,
  };
}

async function runBroker() {
  const [{ InternalApiEventBroker }, { OperationalMetrics }] = await Promise.all([
    loadModule('server/src/internal-api/event-broker.ts'),
    loadModule('server/src/observability/operational-metrics.ts'),
  ]);
  const samples = [];
  let retainedBytes = 0;
  let coldKeys = 0;
  let budget = 16 * 1024;
  let coldKeyLimit = 64;
  for (let iteration = 0; iteration < 4; iteration++) {
    const sample = await brokerSample(InternalApiEventBroker, OperationalMetrics);
    if (iteration >= 1) samples.push(sample.elapsed);
    retainedBytes = sample.retainedBytes;
    coldKeys = sample.coldKeys;
    budget = sample.budget;
    coldKeyLimit = sample.coldKeyLimit;
  }
  return workloadRecord(
    { distinctKeys: 2_000, eventsPerKey: 2, coldKeyLimit, replayBudgetBytes: budget, warmups: 1, measuredSamples: 3 },
    samples,
    {
      retainedBytes: gate(budget, retainedBytes, retainedBytes <= budget),
      coldKeys: gate(coldKeyLimit, coldKeys, coldKeys <= coldKeyLimit),
    },
  );
}

function replayEnvelope(sessionId, replayEvent) {
  return { type: 'session_event', sessionId, event: replayEvent };
}

function messageStart(sessionId, id, role = 'assistant') {
  return replayEnvelope(sessionId, { type: 'message_start', message: { id, role } });
}

function messageUpdate(sessionId, id, delta, type = 'text_delta') {
  return replayEnvelope(sessionId, {
    type: 'message_update',
    ...(id === undefined ? {} : { message: { id } }),
    assistantMessageEvent: { type, delta },
  });
}

function toolStart(sessionId, id) {
  return replayEnvelope(sessionId, {
    type: 'tool_execution_start',
    toolCallId: id,
    toolName: 'bash',
    args: { command: `printf ${id}` },
  });
}

function toolEnd(sessionId, id, output) {
  return replayEnvelope(sessionId, {
    type: 'tool_execution_end',
    toolCallId: id,
    result: { content: [{ type: 'text', text: output }] },
    isError: false,
  });
}

function cloneMessage(message) {
  return {
    ...message,
    content: Array.isArray(message.content)
      ? message.content.map((part) => ({ ...part }))
      : message.content,
  };
}

// The pre-indexed-fold oracle copied from the Step-7B fixture.  It is kept in
// the runner so equality is checked against an independent implementation.
function foldOld(events, base = [], chunkSize = 1_000) {
  let messages = base.map(cloneMessage);
  let linearScans = 0;
  let allocationCollisions = 0;
  for (let offset = 0; offset < events.length; offset += chunkSize) {
    const chunk = events.slice(offset, offset + chunkSize);
    const usedIds = new Set(messages.map((message) => message.id));
    const latestByWireId = new Map();
    let activeMessageId;
    const storageIdForStart = (wireId) => {
      if (!usedIds.has(wireId)) return wireId;
      allocationCollisions++;
      let n = 2;
      while (usedIds.has(`${wireId}#${n}`)) n++;
      return `${wireId}#${n}`;
    };
    const lookupId = (wireId) => latestByWireId.get(wireId) ?? wireId;
    const findTarget = (id) => {
      if (id) {
        const mapped = lookupId(id);
        linearScans++;
        return messages.find((message) => message.id === mapped)
          ?? (linearScans++, messages.find((message) => message.id === id));
      }
      linearScans++;
      for (let index = messages.length - 1; index >= 0; index--) {
        if (messages[index].role === 'assistant') return messages[index];
      }
      return undefined;
    };
    for (const buffered of chunk) {
      const replayEvent = buffered.event;
      switch (replayEvent.type) {
        case 'message_start': {
          const message = replayEvent.message ?? {};
          const wireId = message.id || `msg_${Date.now()}_${messages.length}`;
          const id = storageIdForStart(wireId);
          usedIds.add(id);
          latestByWireId.set(wireId, id);
          activeMessageId = wireId;
          messages.push({
            id,
            role: message.role ?? 'assistant',
            content: message.content ?? (message.role === 'user' ? '' : []),
            timestamp: Date.now(),
          });
          break;
        }
        case 'message_update': {
          const message = replayEvent.message;
          const target = findTarget(message?.id || activeMessageId);
          if (!target) break;
          const assistantEvent = replayEvent.assistantMessageEvent;
          if (!assistantEvent || typeof assistantEvent.delta !== 'string') break;
          const contentArray = Array.isArray(target.content)
            ? target.content
            : typeof target.content === 'string' && target.content
              ? [{ type: 'text', text: target.content }]
              : [];
          const lastEntry = contentArray[contentArray.length - 1];
          if (assistantEvent.type === 'text_delta') {
            if (lastEntry?.type === 'text') lastEntry.text = (lastEntry.text || '') + assistantEvent.delta;
            else contentArray.push({ type: 'text', text: assistantEvent.delta });
          } else if (assistantEvent.type === 'thinking_delta') {
            if (lastEntry?.type === 'thinking') lastEntry.thinking = (lastEntry.thinking || '') + assistantEvent.delta;
            else contentArray.push({ type: 'thinking', thinking: assistantEvent.delta });
          }
          target.content = contentArray;
          break;
        }
        case 'message_end':
          activeMessageId = undefined;
          break;
        case 'tool_execution_start': {
          const id = replayEvent.toolCallId || `tool_${Date.now()}_${messages.length}`;
          messages.push({
            id,
            role: 'tool',
            content: '',
            timestamp: Date.now(),
            toolCall: { id, name: replayEvent.toolName || 'unknown', args: replayEvent.args },
          });
          break;
        }
        case 'tool_execution_end': {
          const id = replayEvent.toolCallId;
          const target = findTarget(id);
          if (!target || target.role !== 'tool') break;
          const result = replayEvent.result;
          const content = typeof result === 'object' && result && Array.isArray(result.content)
            ? result.content.map((part) => part.text ?? '').join('')
            : typeof result === 'string' ? result : '';
          target.content = content;
          target.toolResult = { output: content, isError: replayEvent.isError === true };
          break;
        }
      }
    }
  }
  return { messages, linearScans, allocationCollisions };
}

function makeLargeFixture(sessionId, messageCount) {
  const events = [];
  for (let index = 0; index < messageCount; index++) events.push(messageStart(sessionId, `message-${index}`));
  for (let index = 0; index < messageCount; index++) events.push(messageUpdate(sessionId, `message-${index}`, `chunk-${index}`));
  for (let index = 0; index < Math.floor(messageCount / 10); index++) events.push(toolStart(sessionId, `tool-${index}`));
  for (let index = 0; index < Math.floor(messageCount / 10); index++) events.push(toolEnd(sessionId, `tool-${index}`, `result-${index}`));
  return events;
}

function comparable(messages) {
  return messages.map(({ timestamp: _timestamp, ...message }) => message);
}

function resetStore(useSessionStore, currentSessionId = 'foreground') {
  useSessionStore.setState({
    currentSessionId,
    currentSessionSdkType: 'commandcode',
    messages: [],
    sessionData: {},
    sessionMessages: {},
    sessionCache: new Map(),
    sessionCacheMeta: {},
    historyReplayActive: {},
    streamingSessions: {},
    debugSizeScanCount: 0,
    debugStorageLookupLinearScans: 0,
    debugStorageIdAllocationCollisions: 0,
  });
}

function replay(useSessionStore, sessionId, events) {
  const state = useSessionStore.getState();
  state.handleServerMessage({ type: 'history_start', sessionId });
  for (const replayEvent of events) state.handleServerMessage(replayEvent);
  state.handleServerMessage({ type: 'history_end', sessionId });
  return useSessionStore.getState().sessionMessages[sessionId] ?? [];
}

async function runReplay() {
  // Vite supplies the import.meta.env object expected by the client modules;
  // the server modules above remain direct tsx imports.  No browser is started.
  const { createServer } = await import('vite');
  const viteServer = await createServer({
    root,
    configFile: false,
    logLevel: 'silent',
    server: { middlewareMode: true },
    appType: 'custom',
  });
  try {
    const { useSessionStore } = await viteServer.ssrLoadModule('/client/src/store/sessionStore.ts');
    const messageCount = 1_000;
    const sessionId = 'workload-replay-fold';
    const events = makeLargeFixture(sessionId, messageCount);
    const old = foldOld(events);
    const samples = [];
    let foldedEqual = false;
    let linearScans = -1;

    for (let iteration = 0; iteration < 4; iteration++) {
      resetStore(useSessionStore);
      const measured = await timed(() => replay(useSessionStore, sessionId, events));
      const messages = measured.result;
      const debug = useSessionStore.getState();
      foldedEqual = JSON.stringify(comparable(messages)) === JSON.stringify(comparable(old.messages));
      linearScans = Number(debug.debugStorageLookupLinearScans ?? -1);
      if (iteration >= 1) samples.push(measured.elapsed);
    }

    return workloadRecord(
      { messageCount, eventCount: events.length, warmups: 1, measuredSamples: 3 },
      samples,
      {
        foldedEquality: gate(true, foldedEqual, foldedEqual === true),
        debugStorageLookupLinearScans: gate(0, linearScans, linearScans === 0),
      },
    );
  } finally {
    await viteServer.close();
  }
}

function printSummary(result) {
  const lines = ['Measurement summary'];
  for (const [name, workload] of Object.entries(result.workloads)) {
    const gateText = Object.entries(workload.gates)
      .map(([gateName, value]) => `${gateName}=${value.actual}/${value.expected}${value.passed ? ' ✓' : ' ✗'}`)
      .join(', ');
    lines.push(`- ${name}: median=${workload.medianMs}ms p95=${workload.p95Ms}ms (${gateText})`);
  }
  process.stderr.write(`${lines.join('\n')}\n`);
}

async function main() {
  const result = {
    schemaVersion: 1,
    revision: revision(),
    nodeVersion: process.version,
    cpuCount: availableParallelism(),
    generatedAt: new Date().toISOString(),
    workloads: {},
  };

  result.workloads['registry-100-concurrent'] = await runRegistry();
  result.workloads['watcher-burst'] = await runWatcher();
  result.workloads['broker-churn'] = await runBroker();
  result.workloads['replay-fold'] = await runReplay();

  const outputPath = join(here, 'results', 'latest.json');
  await mkdir(join(here, 'results'), { recursive: true });
  // The results FILE is authoritative and always written directly; stdout is
  // informational only (real modules may log to it), so consumers must read
  // results/latest.json rather than parsing redirected stdout.
  writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  printSummary(result);
  if (jsonOutput) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`Results written to ${outputPath}\n`);

  const passed = Object.values(result.workloads).every((workload) =>
    Object.values(workload.gates).every((measurement) => measurement.passed));
  process.exitCode = passed ? 0 : 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
