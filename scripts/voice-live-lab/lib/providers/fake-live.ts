/**
 * Scripted fake Live provider (L0, plan §23).
 *
 * This is the hermetic stand-in for Gemini Live. It replays a hand-written
 * `serverContent` sequence — audio parts, transcripts, turn completion,
 * interruption and `usageMetadata` — through the same event log the real
 * adapter will use, so the measuring equipment (driver, log, verifier,
 * playback) can be proved against known input before any API key is spent.
 *
 * It is deliberately a *provider*, not a simulation of the candidate's
 * behaviour: it invents no final transcripts, no idle signals and no usage
 * figures that were not written into the script. Whatever the script says is
 * what the equipment sees.
 */

import { EVENT, type EventLog } from '../scheduler.js';
import type { PcmInputFormat, ProviderInputSink } from '../speech-driver.js';

export interface FakeInlineData {
  mimeType: string;
  /** Base64 PCM, exactly as the wire carries it. */
  data: string;
}

export interface FakeServerContent {
  inputTranscription?: { text: string };
  outputTranscription?: { text: string };
  modelTurn?: { parts: Array<{ inlineData?: FakeInlineData }> };
  turnComplete?: boolean;
  interrupted?: boolean;
}

export interface FakeScriptStep {
  /** Wall-clock offset from the start of `run()`, in milliseconds. */
  atMs: number;
  serverContent?: FakeServerContent;
  usageMetadata?: Record<string, number>;
  toolCall?: { name: string; args: Record<string, unknown> };
}

export interface FakeLiveProviderOptions {
  script: FakeScriptStep[];
  log: EventLog;
  sleep?: (ms: number) => Promise<void>;
}

export interface FakeInputFrame {
  sequence: number;
  bytes: number;
  sampleRate: number;
  channels: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function base64Bytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

export class FakeLiveProvider implements ProviderInputSink {
  readonly inputFrames: FakeInputFrame[] = [];
  readonly activityMarkers: string[] = [];
  private readonly script: FakeScriptStep[];
  private readonly log: EventLog;
  private readonly sleep: (ms: number) => Promise<void>;
  private closed = false;

  constructor(options: FakeLiveProviderOptions) {
    this.script = options.script;
    this.log = options.log;
    this.sleep = options.sleep ?? defaultSleep;
  }

  get receivedFrames(): number {
    return this.inputFrames.length;
  }

  get receivedBytes(): number {
    return this.inputFrames.reduce((sum, frame) => sum + frame.bytes, 0);
  }

  pushAudio(frame: Buffer, format: PcmInputFormat, inputSequence: number): void {
    if (this.closed) throw new Error('Cannot push audio to a closed provider');
    this.inputFrames.push({
      sequence: inputSequence,
      bytes: frame.byteLength,
      sampleRate: format.sampleRate,
      channels: format.channels,
    });
  }

  activityStart(): void {
    this.activityMarkers.push('activityStart');
    this.log.append({ source: 'provider', kind: EVENT.INPUT_ACTIVITY, payload: { marker: 'activityStart' } });
  }

  activityEnd(): void {
    this.activityMarkers.push('activityEnd');
    this.log.append({ source: 'provider', kind: EVENT.INPUT_ACTIVITY, payload: { marker: 'activityEnd' } });
  }

  /** Replay the script. Timing is relative to the first step; the injected
   *  sleep makes the replay deterministic in tests. */
  async run(): Promise<void> {
    let elapsed = 0;
    for (let index = 0; index < this.script.length; index += 1) {
      const step = this.script[index];
      const wait = step.atMs - elapsed;
      if (wait > 0) await this.sleep(wait);
      elapsed = Math.max(elapsed, step.atMs);

      if (step.toolCall) {
        this.log.append({
          source: 'provider',
          kind: EVENT.PROVIDER_CONTENT,
          id: `provider:toolCall:${index}`,
          payload: { toolCall: { name: step.toolCall.name, args: step.toolCall.args } },
        });
      }

      if (step.serverContent) {
        const content = step.serverContent;
        const parts = (content.modelTurn?.parts ?? []).map((part) =>
          part.inlineData
            ? { mimeType: part.inlineData.mimeType, audioBytes: base64Bytes(part.inlineData.data) }
            : {}
        );
        this.log.append({
          source: 'provider',
          kind: EVENT.PROVIDER_CONTENT,
          id: `provider:content:${index}`,
          payload: {
            atMs: step.atMs,
            inputTranscription: content.inputTranscription?.text,
            outputTranscription: content.outputTranscription?.text,
            parts,
            turnComplete: content.turnComplete ?? false,
            interrupted: content.interrupted ?? false,
          },
        });
      }

      if (step.usageMetadata) {
        this.log.append({
          source: 'provider',
          kind: EVENT.PROVIDER_USAGE,
          id: `provider:usage:${index}`,
          payload: { ...step.usageMetadata },
        });
      }
    }
  }

  close(reason = 'script-complete'): void {
    this.closed = true;
    this.log.append({ source: 'provider', kind: EVENT.LIFECYCLE, payload: { event: 'close', reason } });
  }
}
