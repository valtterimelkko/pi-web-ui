import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionWorker } from '../../src/workers/session-worker.js';
import { SessionRPCClient } from '../../src/workers/session-rpc-client.js';

const fixtureExecutable = fileURLToPath(new URL('../../../scripts/fixtures/phase6-worker-fixture.mjs', import.meta.url));

describe('worker-cgroup-conformance/v1 deterministic worker fixture', () => {
  const workers: SessionWorker[] = [];
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
    await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  async function startFixture() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'phase6-fixture-'));
    dirs.push(dir);
    const sessionPath = path.join(dir, 'session.jsonl');
    const worker = new SessionWorker(
      { sessionPath, maxOldSpaceSize: 128 },
      { executable: fixtureExecutable, commandTimeoutMs: 7_000, readinessFallbackMs: 250 },
    );
    workers.push(worker);
    await worker.spawn();
    const client = new SessionRPCClient(worker);
    return { dir, sessionPath, worker, client };
  }

  it('normal-turn uses real JSONL RPC framing and emits exactly one ordered terminal sequence', async () => {
    const { sessionPath, client } = await startFixture();
    const events: string[] = [];
    client.subscribe((event) => events.push(event.type));

    await client.prompt('normal-turn');

    expect(events).toEqual([
      'streaming_started',
      'agent_start',
      'tool_execution_start',
      'tool_execution_end',
      'message_start',
      'message_update',
      'message_end',
      'agent_end',
      'streaming_ended',
    ]);
    const marker = JSON.parse((await fs.readFile(sessionPath, 'utf8')).trim());
    expect(marker).toMatchObject({ scenario: 'normal-turn', status: 'completed' });
    client.dispose();
  });

  it('bounded-fanout creates exactly four finite helpers and completes once', async () => {
    const { sessionPath, client } = await startFixture();
    const toolResults: unknown[] = [];
    client.subscribe((event) => {
      if (event.type === 'tool_execution_end') toolResults.push(event.data);
    });

    await client.prompt('bounded-fanout');

    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({ result: { childCount: 4, maxDescendants: 4 }, isError: false });
    const marker = JSON.parse((await fs.readFile(sessionPath, 'utf8')).trim());
    expect(marker).toMatchObject({ scenario: 'bounded-fanout', childCount: 4, status: 'completed' });
    client.dispose();
  });

  it('memory-high touches 160 MiB for the frozen hold interval and reports bounded completion', async () => {
    const { sessionPath, client } = await startFixture();
    const startedAt = Date.now();
    await client.prompt('memory-high');
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeGreaterThanOrEqual(1_400);
    expect(elapsedMs).toBeLessThan(5_000);
    const marker = JSON.parse((await fs.readFile(sessionPath, 'utf8')).trim());
    expect(marker).toMatchObject({ scenario: 'memory-high', status: 'completed', allocatedMiB: 160, holdMs: 1500 });
    client.dispose();
  });

  it('cancel-drain aborts the finite helper and emits one cancelled terminal boundary', async () => {
    const { sessionPath, worker, client } = await startFixture();
    const events: string[] = [];
    client.subscribe((event) => events.push(event.type));
    const prompt = client.prompt('cancel-drain');
    await new Promise((resolve) => setTimeout(resolve, 250));

    await client.abort();
    await prompt;

    expect(worker.status).toBe('ready');
    expect(events.filter((type) => type === 'agent_end')).toHaveLength(1);
    const marker = JSON.parse((await fs.readFile(sessionPath, 'utf8')).trim());
    expect(marker).toMatchObject({ scenario: 'cancel-drain', status: 'cancelled' });
    client.dispose();
  });

  it('cancel-drain-late emits one delayed old terminal 500 ms after cancellation', async () => {
    const { client } = await startFixture();
    const agentEnds: number[] = [];
    client.subscribe((event) => {
      if (event.type === 'agent_end') agentEnds.push(Date.now());
    });
    const prompt = client.prompt('cancel-drain-late');
    await new Promise((resolve) => setTimeout(resolve, 250));
    const cancelledAt = Date.now();
    await client.abort();
    await prompt;
    await new Promise((resolve) => setTimeout(resolve, 550));

    expect(agentEnds).toHaveLength(2);
    expect(agentEnds[1] - cancelledAt).toBeGreaterThanOrEqual(450);
    client.dispose();
  });

  it('restart-unknown persists running evidence and remains active during the frozen 250 ms restart cut', async () => {
    const { sessionPath, worker, client } = await startFixture();
    const prompt = client.prompt('restart-unknown');
    void prompt.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(worker.status).toBe('streaming');
    const marker = JSON.parse((await fs.readFile(sessionPath, 'utf8')).trim());
    expect(marker).toMatchObject({ scenario: 'restart-unknown', status: 'running', durationMs: 3000 });
    await worker.terminate();
    await expect(prompt).rejects.toThrow(/exited|terminated/i);
    client.dispose();
  });

  it('intentional-crash persists its marker, emits no terminal success, and exits 42', async () => {
    const { sessionPath, worker, client } = await startFixture();
    const events: string[] = [];
    client.subscribe((event) => events.push(event.type));

    await expect(client.prompt('intentional-crash')).rejects.toThrow(/exited/i);

    expect(worker.status).toBe('terminated');
    expect(events).not.toContain('agent_end');
    const marker = JSON.parse((await fs.readFile(sessionPath, 'utf8')).trim());
    expect(marker).toMatchObject({ scenario: 'intentional-crash', status: 'crashed', exitCode: 42 });
    client.dispose();
  });
});
