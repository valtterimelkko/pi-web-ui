/**
 * Monotonic scheduler and append-only event log (L0 equipment, plan §21).
 *
 * Everything the lab measures is an interval between two events, so the only
 * defensible timestamp is a monotonic one: `process.hrtime.bigint()` is immune
 * to wall-clock steps (NTP, suspend/resume, manual `date` changes) that would
 * silently reorder a trace. Wall-clock ISO strings are kept separately, and
 * only for provenance — never for measurement.
 *
 * The log is append-only JSONL. A record is written once and never rewritten,
 * so a re-run is a new attempt rather than an edit. Each line is one event:
 *
 *   { seq, tMs, source, kind, id, causedBy?, mediaOffsetMs?, payload }
 *
 * `seq` is a dense 1..N counter; a missing or repeated number is itself
 * evidence that a trace was damaged, which is why the offline verifier treats
 * gaps as a failure rather than skipping them (see record.ts).
 *
 * The three timelines of plan §21 (receiver, input pump, world driver) are
 * independent async pumps. One pump's failure must never stop the others —
 * that is the whole point of running them independently — so `createPump`
 * converts every rejection into a recorded event and a settled promise.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Event kinds the lab emits. Kept as constants so the verifier can require
 *  them by name without stringly-typed drift between modules. */
export const EVENT = {
  PUMP_START: 'pump_start',
  PUMP_END: 'pump_end',
  PUMP_ERROR: 'pump_error',
  INPUT_FRAME: 'input_frame',
  INPUT_ACTIVITY: 'input_activity',
  PROVIDER_CONTENT: 'provider_content',
  PROVIDER_USAGE: 'provider_usage',
  PLAYBACK_RECEIVED: 'playback_received',
  PLAYBACK_RENDERED: 'playback_rendered',
  PLAYBACK_DISCARDED: 'playback_discarded',
  PLAYBACK_GAIN: 'playback_gain',
  PLAYBACK_INTERRUPT: 'playback_interrupt',
  PLAYBACK_INTERRUPT_IGNORED: 'playback_interrupt_ignored',
  LIFECYCLE: 'lifecycle',
  /** Baseline cascade (L2): one normalised cascade turn finished. */
  TURN_COMPLETE: 'turn_complete',
  /** Baseline cascade (L2): an STT / talker-model / TTS leg failed. */
  PROVIDER_ERROR: 'provider_error',
  /** Baseline cascade (L2): harness-side mechanical transitions, logged so the
   *  scorer can assert gate behaviour from the trace alone. */
  HARNESS_DRAFT_APPEND: 'harness_draft_append',
  HARNESS_RELEASE: 'harness_release',
  HARNESS_RECEIPT: 'harness_receipt',
  HARNESS_MECHANICAL: 'harness_mechanical',
} as const;

export interface MonotonicClock {
  /** Milliseconds since this clock was created. Monotonic, never negative. */
  nowMs(): number;
  /** Wall-clock ISO instant when the clock was created (provenance only). */
  originIso(): string;
}

/** A clock whose zero is the moment of creation. */
export function createMonotonicClock(): MonotonicClock {
  const originNs = process.hrtime.bigint();
  const originIso = new Date().toISOString();
  return {
    nowMs(): number {
      return Number(process.hrtime.bigint() - originNs) / 1e6;
    },
    originIso(): string {
      return originIso;
    },
  };
}

export interface LabEvent {
  seq: number;
  tMs: number;
  source: string;
  kind: string;
  id: string;
  causedBy?: string;
  mediaOffsetMs?: number;
  payload: Record<string, unknown>;
}

export interface EventInput {
  source: string;
  kind: string;
  id?: string;
  causedBy?: string;
  mediaOffsetMs?: number;
  payload?: Record<string, unknown>;
}

export interface EventLogOptions {
  clock: MonotonicClock;
  /** Append-only JSONL destination. Omit for an in-memory log (tests). */
  filePath?: string;
  /** Observers are called after a line has been durably appended. */
  onEvent?: (event: LabEvent) => void;
}

/**
 * Append-only event log. Construction never truncates an existing file: if one
 * is present the sequence continues from its last valid line, so a restarted
 * pump appends rather than pretending the earlier events never happened.
 */
export class EventLog {
  private readonly clock: MonotonicClock;
  private readonly filePath?: string;
  private readonly onEvent?: (event: LabEvent) => void;
  private readonly buffer: LabEvent[] = [];
  private nextSeq = 1;

  constructor(options: EventLogOptions) {
    this.clock = options.clock;
    this.filePath = options.filePath;
    this.onEvent = options.onEvent;
    if (this.filePath && existsSync(this.filePath)) {
      const parsed = parseEventLog(readFileSync(this.filePath, 'utf8'));
      if (parsed.events.length > 0) {
        this.buffer.push(...parsed.events);
        this.nextSeq = parsed.events[parsed.events.length - 1].seq + 1;
      }
    }
  }

  append(input: EventInput): LabEvent {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    const event: LabEvent = {
      seq,
      tMs: this.clock.nowMs(),
      source: input.source,
      kind: input.kind,
      id: input.id ?? `${input.source}:${input.kind}:${seq}`,
      payload: input.payload ?? {},
    };
    if (input.causedBy !== undefined) event.causedBy = input.causedBy;
    if (input.mediaOffsetMs !== undefined) event.mediaOffsetMs = input.mediaOffsetMs;
    this.buffer.push(event);
    if (this.filePath) {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, `${JSON.stringify(event)}\n`);
    }
    this.onEvent?.(event);
    return event;
  }

  get length(): number {
    return this.buffer.length;
  }

  events(): LabEvent[] {
    return [...this.buffer];
  }
}

export interface ParsedEventLog {
  events: LabEvent[];
  problems: string[];
}

/**
 * Parse JSONL without throwing. A malformed line is returned as a problem so
 * the offline verifier can report *why* a trace is unusable instead of dying
 * with a stack trace (a crashed verifier is not a passing verifier).
 */
export function parseEventLog(text: string): ParsedEventLog {
  const events: LabEvent[] = [];
  const problems: string[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === '') continue;
    try {
      const value = JSON.parse(line) as LabEvent;
      if (typeof value !== 'object' || value === null || typeof value.seq !== 'number') {
        problems.push(`line ${index + 1}: event has no numeric seq`);
        continue;
      }
      if (typeof value.tMs !== 'number' || typeof value.source !== 'string' || typeof value.kind !== 'string') {
        problems.push(`line ${index + 1}: event is missing tMs/source/kind`);
        continue;
      }
      events.push({
        seq: value.seq,
        tMs: value.tMs,
        source: value.source,
        kind: value.kind,
        id: typeof value.id === 'string' ? value.id : `${value.source}:${value.kind}:${value.seq}`,
        causedBy: value.causedBy,
        mediaOffsetMs: value.mediaOffsetMs,
        payload: (value.payload ?? {}) as Record<string, unknown>,
      });
    } catch (error) {
      problems.push(`line ${index + 1}: not valid JSON (${String(error)})`);
    }
  }
  return { events, problems };
}

export type PumpState = 'idle' | 'running' | 'stopped' | 'failed';

export interface PumpControl {
  /** True once `stop()` has been called; bodies should return promptly. */
  readonly stopping: boolean;
}

export interface PumpHandle {
  readonly name: string;
  readonly state: PumpState;
  readonly error: unknown;
  /** Resolves when the body has finished, successfully or not. Never rejects. */
  readonly done: Promise<void>;
  start(): void;
  stop(): void;
}

export interface PumpOptions {
  log: EventLog;
  onError?: (error: unknown, name: string) => void;
}

/**
 * Run one independent timeline. The body is invoked once; its outcome is
 * always converted into a `pump_error` event (never an unhandled rejection),
 * and a failure in one pump cannot propagate to its siblings.
 */
export function createPump(
  name: string,
  body: (control: PumpControl) => Promise<void>,
  options: PumpOptions
): PumpHandle {
  let state: PumpState = 'idle';
  let error: unknown = null;
  let stopping = false;
  const control: PumpControl = { get stopping() { return stopping; } };
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  return {
    name,
    get state() {
      return state;
    },
    get error() {
      return error;
    },
    done,
    start(): void {
      if (state !== 'idle') throw new Error(`Pump ${name} already started`);
      state = 'running';
      options.log.append({ source: name, kind: EVENT.PUMP_START, payload: {} });
      body(control)
        .then(() => {
          state = 'stopped';
          options.log.append({ source: name, kind: EVENT.PUMP_END, payload: { stopped: stopping } });
        })
        .catch((caught: unknown) => {
          state = 'failed';
          error = caught;
          options.log.append({
            source: name,
            kind: EVENT.PUMP_ERROR,
            payload: { message: caught instanceof Error ? caught.message : String(caught) },
          });
          options.onError?.(caught, name);
        })
        .finally(() => {
          resolveDone();
        });
    },
    stop(): void {
      stopping = true;
    },
  };
}

/**
 * A set of independent timelines — receiver, input pump and world driver —
 * that are started together and settle together. One pump's failure is
 * recorded and cannot stop or reject the others.
 */
export interface PumpSet {
  add(
    name: string,
    body: (control: PumpControl) => Promise<void>,
    onError?: (error: unknown, name: string) => void
  ): PumpHandle;
  startAll(): void;
  stopAll(): void;
  handles(): PumpHandle[];
  /** Resolves when every pump has settled, successfully or not. */
  done(): Promise<void>;
}

export function createPumpSet(log: EventLog): PumpSet {
  const handles: PumpHandle[] = [];
  return {
    add(name, body, onError) {
      const handle = createPump(name, body, { log, onError });
      handles.push(handle);
      return handle;
    },
    startAll() {
      for (const handle of handles) {
        if (handle.state === 'idle') handle.start();
      }
    },
    stopAll() {
      for (const handle of handles) handle.stop();
    },
    handles() {
      return [...handles];
    },
    async done() {
      await Promise.all(handles.map((handle) => handle.done));
    },
  };
}
