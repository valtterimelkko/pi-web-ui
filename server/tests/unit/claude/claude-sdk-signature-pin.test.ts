import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';

/**
 * Regression pins for the `@anthropic-ai/claude-agent-sdk` `query()` signature.
 *
 * Background (2026-09-04 incident, full analysis in
 * `docs/2026-09-04-SDK-QUERY-LOOP-ABORT-VERDICT.md`): SDK 0.3.x takes a single
 * `{ prompt, options }` object parameter. A pre-0.3 positional call
 * `query(promptString, optionsObject)` is silently accepted: the options
 * object is discarded, `prompt` destructures to `undefined`, and
 * `streamInput(undefined)` throws a `TypeError` that the SDK converts into an
 * abort at construction. The surfaced error ~1–2s later ("Claude Code process
 * aborted by user" / "Operation aborted") points at the child process, not at
 * the actual misuse — which cost a full bisect session to diagnose.
 *
 * These pins are test-only (no production change was needed — the server call
 * site `claude-sdk-service.ts` already uses the object form). They exist so a
 * future SDK upgrade that changes either the signature or the failure mode
 * fails loudly here instead of in production smoke scripts. TypeScript types
 * alone do not protect JavaScript callers or `as never` casts, and a
 * `npm update` that flips the underlying behaviour would otherwise be
 * invisible until a real session misbehaves.
 */

/** Captures every AbortController.abort() reason while `fn` runs. */
async function withCapturedAbortReasons(fn: () => Promise<void>): Promise<string[]> {
  const reasons: unknown[] = [];
  const originalAbort = AbortController.prototype.abort;
  AbortController.prototype.abort = function patchedAbort(reason?: unknown) {
    reasons.push(reason);
    return originalAbort.call(this, reason);
  };
  try {
    await fn();
  } finally {
    AbortController.prototype.abort = originalAbort;
  }
  return reasons.map((r) => (r instanceof Error ? r.message : String(r)));
}

/** Query construction fires its abort on a microtask; give it a moment. */
const SETTLE_MS = 250;

const MISUSE_MARKER = 'Symbol(Symbol.asyncIterator)';

describe('claude-agent-sdk query() signature pin', () => {
  const configDirs: string[] = [];

  afterEach(() => {
    for (const dir of configDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
    delete process.env.CLAUDE_CONFIG_DIR;
  });

  /** Fresh disposable CLAUDE_CONFIG_DIR so a spawned child touches nothing user-level. */
  function isolateChildConfig(): void {
    const dir = mkdtempSync(join(tmpdir(), 'piwebui-sdk-pin-'));
    configDirs.push(dir);
    process.env.CLAUDE_CONFIG_DIR = dir;
  }

  it('exposes the 0.3.x single-object signature (arity 1)', () => {
    expect(typeof query).toBe('function');
    // Object-parameter signature: `query({ prompt, options })`.
    // The pre-0.3 positional signature `query(prompt, options)` had arity 2.
    expect(query.length).toBe(1);
  });

  it('positional query(prompt, options) misuse self-aborts with the undefined-prompt TypeError', async () => {
    // Pins the CURRENT failure mode of the misuse. RED evidence for this pin
    // is the 2026-09-04 incident itself: nine smoke scripts hit exactly this
    // abort. If this test goes red after an SDK bump, the SDK changed its
    // failure behaviour (e.g. added a fail-fast TypeError) — re-verify
    // server/src/claude/claude-sdk-service.ts and any smoke tooling against
    // the new behaviour before trusting green.
    isolateChildConfig();
    const reasons = await withCapturedAbortReasons(async () => {
      const q = query('PIN positional misuse' as never, {} as never);
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      await q.return(undefined); // deterministically tear down the spawned child
    });
    expect(
      reasons.some((message) => message.includes(MISUSE_MARKER)),
      `expected the misuse abort reason containing ${MISUSE_MARKER}, got: ${JSON.stringify(reasons)}`,
    ).toBe(true);
  });

  it('object-signature query() does not trigger the misuse abort', async () => {
    // Control for the pin above: the documented object signature must NOT
    // produce the undefined-asyncIterator abort. A deliberately nonexistent
    // binary isolates signature behaviour from spawn success (the resulting
    // spawn error is a normal async failure, not the misuse abort).
    isolateChildConfig();
    const reasons = await withCapturedAbortReasons(async () => {
      const q = query({
        prompt: 'PIN object signature',
        options: { cwd: '/tmp', pathToClaudeCodeExecutable: '/nonexistent/piwebui-pin-claude' },
      });
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      await q.return(undefined);
    });
    expect(
      reasons.some((message) => message.includes(MISUSE_MARKER)),
      `object signature must not abort with ${MISUSE_MARKER}, got: ${JSON.stringify(reasons)}`,
    ).toBe(false);
  });
});
