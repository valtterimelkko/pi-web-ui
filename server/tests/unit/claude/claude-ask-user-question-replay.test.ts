import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { historyToReplayEvents } from '../../../src/claude/claude-history-replay.js';
import type { ClaudeMessageEntry } from '../../../src/claude/claude-session-store.js';

const { mockQuery } = vi.hoisted(() => ({ mockQuery: vi.fn() }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: mockQuery,
}));

import { ClaudeSdkService } from '../../../src/claude/claude-sdk-service.js';

const QUESTIONS = [
  {
    question: 'Pick a colour?',
    header: 'Colour',
    multiSelect: false,
    options: [{ label: 'Red', description: 'r' }, { label: 'Blue', description: 'b' }],
  },
];

describe('AskUserQuestion persistence + replay', () => {
  describe('historyToReplayEvents: AskUserQuestion tool card', () => {
    it('replays an answered AskUserQuestion as a closed tool (start + end), not stuck Running', () => {
      const entries: ClaudeMessageEntry[] = [
        { type: 'meta', sessionId: 's', claudeSessionId: 'cs', cwd: '/', model: 'sonnet', createdAt: '2026-07-01T00:00:00.000Z', timestamp: 1 },
        { type: 'user', sessionId: 's', content: 'ask me', timestamp: 2 },
        {
          type: 'tool', sessionId: 's', toolName: 'AskUserQuestion', toolCallId: 'tu_1',
          toolInput: { questions: QUESTIONS }, timestamp: 3,
        },
        {
          type: 'tool_result', sessionId: 's', toolCallId: 'tu_1',
          toolOutput: 'Your questions have been answered: "Pick a colour?"="Blue".',
          isError: false, timestamp: 4,
        },
        { type: 'assistant', sessionId: 's', content: 'Got it, going with Blue.', timestamp: 5 },
      ];

      const events = historyToReplayEvents(entries);
      const starts = events.filter((e) => e.type === 'tool_execution_start' && e.toolName === 'AskUserQuestion');
      const ends = events.filter((e) => e.type === 'tool_execution_end' && e.toolCallId === 'tu_1');

      expect(starts).toHaveLength(1);
      // Full input (questions) is preserved on the replayed tool start.
      expect((starts[0] as any).args).toEqual({ questions: QUESTIONS });
      // A matching end exists → the card is closed, not left Running.
      expect(ends).toHaveLength(1);
      expect((ends[0] as any).isError).toBe(false);
    });

    it('replays a cancelled AskUserQuestion (no-answer result) as closed too', () => {
      const entries: ClaudeMessageEntry[] = [
        { type: 'meta', sessionId: 's', claudeSessionId: 'cs', cwd: '/', model: 'sonnet', createdAt: 't', timestamp: 1 },
        {
          type: 'tool', sessionId: 's', toolName: 'AskUserQuestion', toolCallId: 'tu_2',
          toolInput: { questions: QUESTIONS }, timestamp: 2,
        },
        {
          type: 'tool_result', sessionId: 's', toolCallId: 'tu_2',
          toolOutput: 'The user did not answer the questions.', isError: false, timestamp: 3,
        },
      ];

      const events = historyToReplayEvents(entries);
      expect(events.filter((e) => e.type === 'tool_execution_start' && e.toolName === 'AskUserQuestion')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'tool_execution_end' && e.toolCallId === 'tu_2')).toHaveLength(1);
    });
  });

  describe('ClaudeSdkService: AskUserQuestion tool_use/result are persisted', () => {
    let tmpDir: string;
    let svc: ClaudeSdkService;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'claude-auq-replay-'));
      const profilesPath = join(tmpDir, 'profiles.json');
      writeFileSync(profilesPath, JSON.stringify({
        profiles: [{
          id: 'sdk-profile',
          label: 'SDK',
          backend: 'sdk-subscription',
          launcherType: 'native-env',
          model: 'sonnet',
          settingSources: ['user', 'project'],
          skills: 'all',
          permissionMode: 'dontAsk',
          allowedTools: ['Read'],
          maxConcurrent: 2,
          enabled: true,
        }],
        defaultProfileId: 'sdk-profile',
      }));
      svc = new ClaudeSdkService({
        claudeSessionDir: join(tmpDir, 'sessions'),
        registryPath: join(tmpDir, 'registry.json'),
        profilesPath,
      });
      mockQuery.mockReset();
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('persists the AskUserQuestion tool_use with full input and the tool_result', async () => {
      const { sessionId, claudeSessionId } = await svc.createSession(join(tmpDir, 'cwd'), 'sonnet', undefined, 'sdk-profile');

      mockQuery.mockReturnValue((async function* () {
        yield { type: 'system', subtype: 'init', model: 'glm-5.2', session_id: claudeSessionId, tools: ['AskUserQuestion'], apiKeySource: 'none' };
        yield {
          type: 'assistant',
          message: { id: 'msg1', content: [{ type: 'tool_use', id: 'tu_9', name: 'AskUserQuestion', input: { questions: QUESTIONS } }] },
          session_id: claudeSessionId,
        };
        // The SDK injects this tool_result after canUseTool returns allow+answers.
        yield {
          type: 'user',
          message: { content: [{ type: 'tool_result', tool_use_id: 'tu_9', content: 'Your questions have been answered: "Pick a colour?"="Blue".', is_error: false }] },
          session_id: claudeSessionId,
        };
        yield { type: 'result', subtype: 'success', is_error: false, result: 'Done', usage: { input_tokens: 1, output_tokens: 1 }, session_id: claudeSessionId };
      })());

      await new Promise<void>((resolve) => {
        svc.sendPrompt(sessionId, 'ask me', () => {}, () => resolve()).catch(() => resolve());
      });

      const file = join(tmpDir, 'sessions', `${sessionId}.jsonl`);
      const entries = readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)) as ClaudeMessageEntry[];

      const toolEntry = entries.find((e) => e.type === 'tool' && e.toolName === 'AskUserQuestion');
      expect(toolEntry).toBeDefined();
      expect(toolEntry!.toolCallId).toBe('tu_9');
      expect(toolEntry!.toolInput).toEqual({ questions: QUESTIONS });

      const resultEntry = entries.find((e) => e.type === 'tool_result' && e.toolCallId === 'tu_9');
      expect(resultEntry).toBeDefined();
      expect(resultEntry!.toolOutput).toMatch(/answered/);
      expect(resultEntry!.isError).toBeFalsy();
    });
  });
});
