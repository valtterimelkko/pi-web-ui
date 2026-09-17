/**
 * L0 scheduler / event-log / pump tests.
 *
 * The event log is the substrate every later measurement is read from, so the
 * tests attack the properties the verifier will rely on:
 *   - the clock is monotonic and independent of wall-clock steps;
 *   - seq is a dense 1..N counter (a gap is damage, not a gap to skip);
 *   - appending to an existing file continues the sequence instead of
 *     truncating evidence;
 *   - a failing pump cannot take its siblings down with it.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  EVENT,
  EventLog,
  createMonotonicClock,
  createPump,
  createPumpSet,
  parseEventLog,
} from '../../../scripts/voice-live-lab/lib/scheduler.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'voice-live-scheduler-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('monotonic clock', () => {
  it('never goes backwards even when the wall clock is stepped', async () => {
    const clock = createMonotonicClock();
    const first = clock.nowMs();
    await sleep(5);
    const second = clock.nowMs();
    expect(second).toBeGreaterThanOrEqual(first);
    expect(second).toBeGreaterThan(first);
  });

  it('records a wall-clock origin for provenance only', () => {
    const clock = createMonotonicClock();
    expect(() => new Date(clock.originIso())).not.toThrow();
    expect(clock.nowMs()).toBeLessThan(60_000);
  });
});

describe('event log', () => {
  it('assigns dense, strictly increasing sequence numbers and monotonic times', () => {
    const clock = createMonotonicClock();
    const log = new EventLog({ clock });
    log.append({ source: 'input', kind: EVENT.INPUT_FRAME, payload: { index: 0 } });
    log.append({ source: 'input', kind: EVENT.INPUT_FRAME, payload: { index: 1 } });
    log.append({ source: 'provider', kind: EVENT.PROVIDER_USAGE, payload: { totalTokenCount: 7 } });

    const events = log.events();
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(events.map((event) => event.payload.index)).toEqual([0, 1, undefined]);
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index].tMs).toBeGreaterThanOrEqual(events[index - 1].tMs);
    }
    expect(events[2].kind).toBe(EVENT.PROVIDER_USAGE);
  });

  it('derives a stable id when none is supplied and keeps optional fields out when absent', () => {
    const clock = createMonotonicClock();
    const log = new EventLog({ clock });
    const event = log.append({ source: 'receiver', kind: EVENT.PROVIDER_CONTENT });
    expect(event.id).toBe('receiver:provider_content:1');
    expect('causedBy' in event).toBe(false);
    expect('mediaOffsetMs' in event).toBe(false);
  });

  it('appends JSONL durably and continues the sequence from an existing file', () => {
    const clock = createMonotonicClock();
    const filePath = path.join(dir, 'events.jsonl');
    const first = new EventLog({ clock, filePath });
    first.append({ source: 'input', kind: EVENT.INPUT_FRAME, payload: { index: 0 } });

    const second = new EventLog({ clock, filePath });
    second.append({ source: 'input', kind: EVENT.INPUT_FRAME, payload: { index: 1 } });

    const lines = readFileSync(filePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]).seq).toBe(2);
  });

  it('parses a clean log and reports malformed lines without throwing', () => {
    const clean = '{"seq":1,"tMs":0,"source":"input","kind":"input_frame","id":"a","payload":{}}\n';
    const parsed = parseEventLog(`${clean}not-json\n{"seq":"x"}\n`);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.problems).toHaveLength(2);
  });
});

describe('independent pumps', () => {
  it('runs siblings independently and converts a failure into a pump_error event', async () => {
    const clock = createMonotonicClock();
    const log = new EventLog({ clock });
    const errors: string[] = [];

    const good = createPump('world', async () => {
      await sleep(5);
    }, { log });
    const bad = createPump('receiver', async () => {
      throw new Error('provider socket closed');
    }, { log, onError: (error, name) => errors.push(`${name}:${(error as Error).message}`) });

    good.start();
    bad.start();
    await Promise.all([good.done, bad.done]);

    expect(good.state).toBe('stopped');
    expect(bad.state).toBe('failed');
    expect(errors).toEqual(['receiver:provider socket closed']);

    const kinds = log.events().map((event) => event.kind);
    expect(kinds).toContain(EVENT.PUMP_START);
    expect(kinds).toContain(EVENT.PUMP_END);
    expect(kinds).toContain(EVENT.PUMP_ERROR);
    const errorEvent = log.events().find((event) => event.kind === EVENT.PUMP_ERROR);
    expect(errorEvent?.payload.message).toBe('provider socket closed');
  });

  it('exposes a stopping flag so a body can exit promptly', async () => {
    const clock = createMonotonicClock();
    const log = new EventLog({ clock });
    let sawStopping = false;
    const pump = createPump('input', async (control) => {
      await sleep(5);
      sawStopping = control.stopping;
    }, { log });
    pump.start();
    pump.stop();
    await pump.done;
    expect(sawStopping).toBe(true);
  });

  it('refuses to start the same pump twice', () => {
    const clock = createMonotonicClock();
    const log = new EventLog({ clock });
    const pump = createPump('world', async () => {}, { log });
    pump.start();
    expect(() => pump.start()).toThrow(/already started/);
  });

  it('runs receiver, input pump and world driver as one independent pump set', async () => {
    const clock = createMonotonicClock();
    const log = new EventLog({ clock });
    const set = createPumpSet(log);
    const failures: string[] = [];

    set.add('receiver', async () => {
      await sleep(5);
    });
    set.add(
      'input',
      async () => {
        throw new Error('input sink closed');
      },
      (error, name) => failures.push(`${name}:${(error as Error).message}`)
    );
    set.add('world', async () => {
      await sleep(5);
    });

    set.startAll();
    expect(set.handles().every((handle) => handle.state === 'running')).toBe(true);
    await set.done();

    expect(set.handles().map((handle) => handle.state)).toEqual(['stopped', 'failed', 'stopped']);
    expect(failures).toEqual(['input:input sink closed']);
    expect(log.events().filter((event) => event.kind === EVENT.PUMP_ERROR)).toHaveLength(1);
  });
});
