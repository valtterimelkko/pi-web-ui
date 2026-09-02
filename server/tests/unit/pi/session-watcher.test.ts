import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionWatcher } from '../../../src/pi/session-watcher.js';

describe('SessionWatcher canonical metadata', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('preserves the canonical id when add is immediately followed by unlink', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'session-watcher-race-'));
    const sessionPath = path.join(tempDir, 'timestamp_filename.jsonl');
    await writeFile(sessionPath, JSON.stringify({ type: 'session', id: 'canonical-race-id', cwd: '/tmp/race' }));
    const watcher = new SessionWatcher(tempDir);
    const events: Array<{ type: string; sessionId?: string }> = [];
    watcher.on('session_update', (event) => events.push(event));
    const invoke = watcher as unknown as { handleChange(type: 'add' | 'unlink', filePath: string): void };

    invoke.handleChange('add', sessionPath);
    await rm(sessionPath);
    invoke.handleChange('unlink', sessionPath);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(events.find((event) => event.type === 'unlink')?.sessionId).toBe('canonical-race-id');
    await watcher.stop();
  });

  it('upserts an exact registry entry on add without triggering a directory-wide scan', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'session-watcher-registry-'));
    const sessionPath = path.join(tempDir, '2026-07-29T00-00-00_canonical-add-id.jsonl');
    await writeFile(sessionPath, JSON.stringify({ type: 'session', id: 'canonical-add-id', cwd: '/tmp/add', timestamp: 1 }));
    const registry = {
      upsert: vi.fn().mockResolvedValue(undefined),
      rebuildFromPiSessions: vi.fn().mockResolvedValue(undefined),
    };
    const watcher = new SessionWatcher(tempDir, registry);
    const invoke = watcher as unknown as { emitChange(type: 'add', filePath: string): Promise<void> };

    await invoke.emitChange('add', sessionPath);

    expect(registry.upsert).toHaveBeenCalledWith(expect.objectContaining({
      id: 'canonical-add-id',
      sdkType: 'pi',
      path: sessionPath,
      cwd: '/tmp/add',
    }));
    expect(registry.rebuildFromPiSessions).not.toHaveBeenCalled();
    await watcher.stop();
  });

  it("tags genuinely-new add events as native-discovered and leaves known/changed sessions' origin alone", async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'session-watcher-origin-'));
    const newPath = path.join(tempDir, '2026-07-29T00-00-00_new-cli-session.jsonl');
    const knownPath = path.join(tempDir, '2026-07-29T00-00-00_known-session.jsonl');
    await writeFile(newPath, JSON.stringify({ type: 'session', id: 'new-cli-session', cwd: '/tmp/new', timestamp: 1 }));
    await writeFile(knownPath, JSON.stringify({ type: 'session', id: 'known-session', cwd: '/tmp/known', timestamp: 1 }));
    const registry = {
      upsert: vi.fn().mockResolvedValue(undefined),
      getByPath: vi.fn(async (p: string) => (p === knownPath ? { id: 'known-session', sdkType: 'pi' } : undefined)),
    };
    const watcher = new SessionWatcher(tempDir, registry);
    const invoke = watcher as unknown as { emitChange(type: 'add' | 'change', filePath: string): Promise<void> };

    await invoke.emitChange('add', newPath);
    expect(registry.upsert).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-cli-session', origin: 'native-discovered' }));

    await invoke.emitChange('add', knownPath);
    const knownCall = registry.upsert.mock.calls.find((c) => c[0]?.id === 'known-session')?.[0];
    expect(knownCall).toBeTruthy();
    expect(knownCall.origin).toBeUndefined();

    await invoke.emitChange('change', newPath);
    const changeCall = registry.upsert.mock.calls.filter((c) => c[0]?.id === 'new-cli-session').pop()?.[0];
    expect(changeCall).toBeTruthy();
    expect(changeCall.origin).toBeUndefined();

    await watcher.stop();
  });

  it('uses the JSONL session header id and cwd rather than the filename fallback', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'session-watcher-'));
    const sessionPath = path.join(tempDir, 'timestamp_filename.jsonl');
    await writeFile(sessionPath, [
      JSON.stringify({ type: 'session', id: 'canonical-session-id', cwd: '/tmp/canonical-workspace', timestamp: 1 }),
      JSON.stringify({ type: 'message', id: 'm1', timestamp: 2, message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } }),
    ].join('\n'));

    const info = await new SessionWatcher(tempDir).readSessionInfo(sessionPath);

    expect(info.id).toBe('canonical-session-id');
    expect(info.cwd).toBe('/tmp/canonical-workspace');
    expect(info.firstMessage).toBe('hello');
  });

  it('firstMessage stays the original prompt when the prompt merely references a SKILL.md path (Agent OS envelopes)', async () => {
    // Defect 11 (Part 3 iteration run): three turns in one child session left the
    // registry firstMessage pointing at correction 1 instead of the dispatch
    // envelope. Cause: the skill-content heuristic skipped any user message
    // containing the substring 'SKILL.md', and every Agent OS envelope embeds
    // the skill body verbatim with its canonical path (pivot 6.2 mandatory
    // delivery). The envelope is a genuine user prompt, not a /skill injection.
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'session-watcher-envelope-'));
    const sessionPath = path.join(tempDir, 'envelope_three_turns.jsonl');
    const envelope = '# Agent OS child operating instructions (mandatory delivery — pivot §6.2)\n\nagent-os-child: /root/.skills-global/skills-global/agent-os-child/SKILL.md (sha256 4f0c…)\n\n<the full mandatory skill body follows>\n\n## Agent OS Confirmed Dispatch Envelope\ngoal: format durations as H:MM:SS…';
    await writeFile(sessionPath, [
      JSON.stringify({ type: 'session', id: 'envelope-session', cwd: '/tmp/worktree', timestamp: 1 }),
      JSON.stringify({ type: 'message', id: 'm1', timestamp: 2, message: { role: 'user', content: [{ type: 'text', text: envelope }] } }),
      JSON.stringify({ type: 'message', id: 'm2', timestamp: 3, message: { role: 'assistant', content: [{ type: 'text', text: 'done, committed' }] } }),
      JSON.stringify({ type: 'message', id: 'm3', timestamp: 4, message: { role: 'user', content: [{ type: 'text', text: 'Continue with the same child. The formatter must now return H:MM:SS for durations of one hour or longer.' }] } }),
    ].join('\n'));

    const info = await new SessionWatcher(tempDir).readSessionInfo(sessionPath);

    expect(info.firstMessage).toMatch(/Agent OS child operating instructions/);
  });

  it('still skips genuine <skill name=...> injected bodies for firstMessage', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'session-watcher-skillinject-'));
    const sessionPath = path.join(tempDir, 'skill_injection.jsonl');
    await writeFile(sessionPath, [
      JSON.stringify({ type: 'session', id: 'skill-session', cwd: '/tmp/x', timestamp: 1 }),
      JSON.stringify({ type: 'message', id: 'm1', timestamp: 2, message: { role: 'user', content: [{ type: 'text', text: '<skill name="web-search">\n…full skill body…\n</skill>' }] } }),
      JSON.stringify({ type: 'message', id: 'm2', timestamp: 3, message: { role: 'user', content: [{ type: 'text', text: 'find the docs for X' }] } }),
    ].join('\n'));

    const info = await new SessionWatcher(tempDir).readSessionInfo(sessionPath);

    expect(info.firstMessage).toBe('find the docs for X');
  });
});
