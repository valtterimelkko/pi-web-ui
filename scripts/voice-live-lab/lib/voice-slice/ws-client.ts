/**
 * Voice Mode vertical slice (plan Phase 5 / Track F) — authenticated voice
 * WebSocket client.
 *
 * This is the *client half of the real wire*: the same cookie login, CSRF
 * handshake and `/ws` socket the browser uses (see
 * `scripts/live-validate-steer.mjs` for the established idiom). It is NOT a
 * stub: the operator audio it streams is real spoken PCM, the frames are the
 * contract's own client messages, and every inbound frame is recorded verbatim
 * for the evidence record.
 */

import { WebSocket } from 'ws';
import type {
  VoiceClientMessage,
  VoiceReceiptEventMessage,
  VoiceServerMessage,
} from '@pi-web-ui/shared/dist/types/voice-messages.js';

export const SLICE_ORIGIN = 'https://pi.letsautomate.work';

export interface VoiceFrameRecord {
  atMs: number;
  /** 'in' for server→client, 'out' for client→server. */
  direction: 'in' | 'out';
  frame: Record<string, unknown>;
}

export interface LoginSession {
  cookie: string;
  csrfToken: string;
}

export async function login(httpPort: number, password: string): Promise<LoginSession> {
  const response = await fetch(`http://127.0.0.1:${httpPort}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: SLICE_ORIGIN },
    body: JSON.stringify({ password }),
  });
  if (!response.ok) {
    throw new Error(`slice login failed: HTTP ${response.status} ${await response.text()}`);
  }
  const setCookie = response.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0];
  if (!cookie) throw new Error('slice login returned no cookie');
  const body = (await response.json()) as { csrfToken?: string };
  if (!body.csrfToken) throw new Error('slice login returned no CSRF token');
  return { cookie, csrfToken: body.csrfToken };
}

export interface FrameWait {
  predicate: (frame: VoiceServerMessage & Record<string, unknown>) => boolean;
  timeoutMs: number;
  label: string;
}

export class VoiceWireClient {
  private readonly socket: WebSocket;
  private readonly records: VoiceFrameRecord[] = [];
  private readonly waiters: Array<{
    wait: FrameWait;
    resolve: (frame: VoiceServerMessage & Record<string, unknown>) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    afterIndex?: number;
  }> = [];
  private readonly log: (line: string) => void;
  private seqCounter = 0;
  private closed = false;

  private constructor(socket: WebSocket, log: (line: string) => void) {
    this.socket = socket;
    this.log = log;
    socket.on('message', (data: Buffer) => {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(data.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      this.records.push({ atMs: Date.now(), direction: 'in', frame });
      if (frame.type !== 'voice_audio_chunk' && frame.type !== 'session_status') {
        this.log(`<- ${String(frame.type)}`);
      }
      this.deliver(frame as VoiceServerMessage & Record<string, unknown>);
    });
    socket.on('close', () => {
      this.closed = true;
    });
    socket.on('error', (error: Error) => {
      this.log(`slice socket error: ${error.message}`);
    });
  }

  static async connect(
    httpPort: number,
    session: LoginSession,
    log: (line: string) => void = () => {}
  ): Promise<VoiceWireClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${httpPort}/ws`, {
      headers: { Cookie: session.cookie, Origin: SLICE_ORIGIN },
    });
    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    const client = new VoiceWireClient(socket, log);
    client.sendRaw({ type: 'auth', csrfToken: session.csrfToken });
    await client.waitFor({
      label: 'authenticated connection_status',
      timeoutMs: 15_000,
      predicate: (frame) => {
        const record = frame as unknown as Record<string, unknown>;
        return record.type === 'connection_status' && record.status === 'authenticated';
      },
    });
    return client;
  }

  /** Raw send (auth only; everything else goes through typed helpers). */
  private sendRaw(frame: Record<string, unknown>): void {
    this.records.push({ atMs: Date.now(), direction: 'out', frame });
    this.socket.send(JSON.stringify(frame));
  }

  /** Send one typed voice frame with its envelope (seq managed by the caller). */
  send(frame: Record<string, unknown>): void {
    this.records.push({ atMs: Date.now(), direction: 'out', frame });
    this.socket.send(JSON.stringify(frame));
  }

  /** Send a contract client message (already enveloped). */
  sendVoice(frame: VoiceClientMessage): void {
    this.records.push({ atMs: Date.now(), direction: 'out', frame: frame as unknown as Record<string, unknown> });
    this.socket.send(JSON.stringify(frame));
  }

  nextAudioSeq(): number {
    return this.seqCounter++;
  }

  get received(): VoiceFrameRecord[] {
    return [...this.records];
  }

  waitFor(wait: FrameWait): Promise<VoiceServerMessage & Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((entry) => entry.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`timed out after ${wait.timeoutMs}ms waiting for ${wait.label}`));
      }, wait.timeoutMs);
      this.waiters.push({ wait, resolve, reject, timer });
    });
  }

  /** A position marker in the receive log; `waitForNew` never matches earlier frames. */
  mark(): number {
    return this.records.length;
  }

  /**
   * Wait for a frame that arrives AFTER `mark`. This is what makes a waiter
   * immune to a same-shaped frame from an earlier turn (e.g. the previous
   * turn's final transcript, which would otherwise satisfy the predicate
   * immediately).
   */
  waitForNew(
    mark: number,
    wait: Omit<FrameWait, 'predicate'> & {
      predicate: (frame: VoiceServerMessage & Record<string, unknown>) => boolean;
    }
  ): Promise<VoiceServerMessage & Record<string, unknown>> {
    // A frame that already arrived after the mark satisfies the wait (the
    // caller may have been waiting on something else when it landed). Without
    // this scan, a waiter can miss the very frame it was created for.
    const existing = this.records
      .slice(mark)
      .find(
        (record) =>
          record.direction === 'in' &&
          wait.predicate(record.frame as VoiceServerMessage & Record<string, unknown>)
      );
    if (existing) {
      return Promise.resolve(existing.frame as VoiceServerMessage & Record<string, unknown>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((entry) => entry.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`timed out after ${wait.timeoutMs}ms waiting for ${wait.label}`));
      }, wait.timeoutMs);
      this.waiters.push({
        wait,
        resolve,
        reject,
        timer,
        afterIndex: mark,
      });
    });
  }

  private deliver(frame: VoiceServerMessage & Record<string, unknown>): void {
    const frameIndex = this.records.length - 1;
    for (const waiter of [...this.waiters]) {
      if (waiter.afterIndex !== undefined && frameIndex < waiter.afterIndex) continue;
      if (!waiter.wait.predicate(frame)) continue;
      clearTimeout(waiter.timer);
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(frame);
    }
  }

  framesOfType(type: string): Array<Record<string, unknown>> {
    return this.records.filter((record) => record.direction === 'in' && record.frame.type === type).map((r) => r.frame);
  }

  receipts(): VoiceReceiptEventMessage['receipt'][] {
    return this.framesOfType('receipt_event').map(
      (frame) => (frame as unknown as VoiceReceiptEventMessage).receipt
    );
  }

  isClosed(): boolean {
    return this.closed;
  }

  close(): void {
    if (!this.closed) {
      try {
        this.socket.close();
      } catch {
        /* best effort */
      }
      this.closed = true;
    }
  }
}
