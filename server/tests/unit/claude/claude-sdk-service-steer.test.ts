import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: mockQuery }));

import { ClaudeSdkService } from '../../../src/claude/claude-sdk-service.js';

/**
 * Mock query that models streaming-input semantics: it consumes the prompt
 * AsyncIterable the service passes, and for each INPUT message yields the
 * scripted OUTPUT messages. When the input stream ends (the service's
 * scheduled-end grace fires), the output generator ends — exactly how the real
 * CLI terminates once stdin closes.
 */
function scriptMock(script: Array<{ match: RegExp; outputs: any[] }>) {
  mockQuery.mockImplementation(({ prompt }: { prompt: AsyncIterable<any> }) => {
    return (async function* () {
      for await (const inputMessage of prompt) {
        const text = JSON.stringify(inputMessage);
        const entry = script.find((s) => s.match.test(text));
        if (!entry) throw new Error(`unexpected input message: ${text}`);
        for (const out of entry.outputs) yield out;
      }
    })();
  });
}

const SID = 'native-session-1';
const initMsg = { type: 'system', subtype: 'init', model: 'opus', session_id: SID, tools: ['Read'], apiKeySource: 'none' };
const resultMsg = { type: 'result', subtype: 'success', is_error: false, result: 'OK', usage: { input_tokens: 10, output_tokens: 2 }, session_id: SID, num_turns: 1 };
const resultMsg2 = { ...resultMsg, result: 'PIVOTED', num_turns: 2 };
const assistantText = (t: string) => ({ type: 'assistant', message: { id: `m-${t}`, content: [{ type: 'text', text: t }] }, session_id: SID });

describe('ClaudeSdkService steering', () => {
  let tmpDir: string;
  let svc: ClaudeSdkService;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claude-sdk-steer-'));
    const profilesPath = join(tmpDir, 'profiles.json');
    writeFileSync(profilesPath, JSON.stringify({ profiles: [], defaultProfileId: undefined }));
    svc = new ClaudeSdkService({
      claudeSessionDir: join(tmpDir, 'sessions'),
      registryPath: join(tmpDir, 'registry.json'),
      profilesPath,
    });
    mockQuery.mockReset();
    savedEnv.CLAUDE_STEER_END_GRACE_MS = process.env.CLAUDE_STEER_END_GRACE_MS;
    process.env.CLAUDE_STEER_END_GRACE_MS = '60';
  });

  afterEach(() => {
    if (savedEnv.CLAUDE_STEER_END_GRACE_MS === undefined) delete process.env.CLAUDE_STEER_END_GRACE_MS;
    else process.env.CLAUDE_STEER_END_GRACE_MS = savedEnv.CLAUDE_STEER_END_GRACE_MS;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function startRun(sessionId: string, prompt: string) {
    const events: any[] = [];
    let done!: () => void;
    const completion = new Promise<void>((resolve) => { done = resolve; });
    let completionError: Error | undefined;
    svc.sendPrompt(sessionId, prompt, (e) => events.push(e), (err) => { completionError = err; done(); })
      .catch((err) => { completionError = err; done(); });
    return { events, completion, getCompletionError: () => completionError };
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('waitFor timeout');
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  it('steer pushes a priority:next user message and emits a persisted user message event', async () => {
    const { sessionId } = await svc.createSession(join(tmpDir, 'cwd'), 'opus');
    const seenInputs: any[] = [];
    mockQuery.mockImplementation(({ prompt }: { prompt: AsyncIterable<any> }) => {
      return (async function* () {
        for await (const m of prompt) {
          seenInputs.push(m);
          yield initMsg;
          if (seenInputs.length === 1) yield assistantText('working');
          if (seenInputs.length >= 2) { yield assistantText('PIVOTED'); yield resultMsg2; }
          if (seenInputs.length === 1) yield resultMsg;
        }
      })();
    });
    const { events, completion } = startRun(sessionId, 'review the repo');
    await waitFor(() => events.some((e) => e.type === 'message_update'));

    expect(svc.steer(sessionId, 'pivot now')).toBe(true);
    await completion;

    // The pushed steer message carries steering semantics on the wire.
    expect(seenInputs.length).toBe(2);
    const steerMsg = seenInputs[1];
    expect(steerMsg.type).toBe('user');
    expect(steerMsg.priority).toBe('next');
    expect(steerMsg.origin).toEqual({ kind: 'human' });
    const content = steerMsg.message.content;
    expect(Array.isArray(content) && content[0]?.text).toBe('pivot now');

    // A synthetic user message reached the live event stream.
    const userStart = events.filter((e) => e.type === 'message_start' && e.data?.role === 'user');
    expect(userStart.length).toBe(1);
    expect(userStart[0].data.content).toBe('pivot now');

    // ...and was persisted for replay.
    const journal = readFileSync(join(tmpDir, 'sessions', `${sessionId}.jsonl`), 'utf8');
    expect(journal).toContain('pivot now');

    expect(svc.isRunning(sessionId)).toBe(false);
  });

  it('followUp pushes a priority:later user message', async () => {
    const { sessionId } = await svc.createSession(join(tmpDir, 'cwd'), 'opus');
    const seenInputs: any[] = [];
    mockQuery.mockImplementation(({ prompt }: { prompt: AsyncIterable<any> }) => {
      return (async function* () {
        for await (const m of prompt) {
          seenInputs.push(m);
          yield initMsg;
          yield resultMsg;
        }
      })();
    });
    const { events, completion } = startRun(sessionId, 'review the repo');
    await waitFor(() => events.some((e) => e.type === 'claude_result'));

    expect(svc.followUp(sessionId, 'and then this')).toBe(true);
    await completion;

    expect(seenInputs.length).toBe(2);
    expect(seenInputs[1].priority).toBe('later');
    const userStart = events.filter((e) => e.type === 'message_start' && e.data?.role === 'user');
    expect(userStart.length).toBe(1);
    expect(userStart[0].data.content).toBe('and then this');
  });

  it('steer returns false when the session has no live run', async () => {
    const { sessionId } = await svc.createSession(join(tmpDir, 'cwd'), 'opus');
    expect(svc.steer(sessionId, 'nope')).toBe(false);
    expect(svc.followUp(sessionId, 'nope')).toBe(false);
  });

  it('keeps the query alive for a follow-up pushed during the end-grace window', async () => {
    const { sessionId } = await svc.createSession(join(tmpDir, 'cwd'), 'opus');
    let inputCount = 0;
    mockQuery.mockImplementation(({ prompt }: { prompt: AsyncIterable<any> }) => {
      return (async function* () {
        for await (const _m of prompt) {
          inputCount += 1;
          yield initMsg;
          if (inputCount === 1) yield resultMsg;
          else { yield assistantText('SECOND TURN'); yield resultMsg2; }
        }
      })();
    });
    const { events, completion } = startRun(sessionId, 'review the repo');
    // Wait for the first result; the scheduled end-grace (60ms) starts then.
    await waitFor(() => events.some((e) => e.type === 'claude_result'));
    // Push inside the grace window — must cancel the scheduled end.
    expect(svc.followUp(sessionId, 'right after')).toBe(true);
    await completion;

    expect(inputCount).toBe(2);
    const texts = events.filter((e) => e.type === 'message_update').map((e: any) => e.data?.assistantMessageEvent?.delta).join('');
    expect(texts).toContain('SECOND TURN');
    // Two results happened inside ONE query: isRunning stayed true throughout.
    expect(events.filter((e) => e.type === 'agent_end')).toHaveLength(1);
  });

  it('the query finishes on its own after the grace window when nothing is pushed', async () => {
    const { sessionId } = await svc.createSession(join(tmpDir, 'cwd'), 'opus');
    let inputCount = 0;
    mockQuery.mockImplementation(({ prompt }: { prompt: AsyncIterable<any> }) => {
      return (async function* () {
        for await (const _m of prompt) {
          inputCount += 1;
          yield initMsg;
          yield resultMsg;
        }
      })();
    });
    const { events, completion } = startRun(sessionId, 'review the repo');
    await completion;
    expect(inputCount).toBe(1);
    expect(events.some((e) => e.type === 'agent_end')).toBe(true);
    expect(svc.isRunning(sessionId)).toBe(false);
  });
});
