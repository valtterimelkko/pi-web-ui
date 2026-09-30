/**
 * C3a (contract 1.58.0): the child completion block — schema and parser.
 *
 * The block is a fenced code block whose info string names the schema:
 *
 *   ```completion
 *   {"schema":"pi-completion/v1", ...}
 *   ```
 *
 * The parser is strict, bounded and pure: it finds the LAST complete block,
 * validates it, and returns the parsed block or a typed error. It never
 * throws on model output.
 */
import { describe, expect, it } from 'vitest';

import {
  COMPLETION_BLOCK_MAX_CHARS,
  COMPLETION_FENCE_INFO,
  COMPLETION_PARSE_WINDOW_CHARS,
  COMPLETION_SCHEMA_NAME,
  type CompletionBlock,
} from '../../../src/internal-api/completion/completion-schema.js';
import { parseCompletionBlock } from '../../../src/internal-api/completion/completion-parser.js';

function block(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 'pi-completion/v1',
    status: 'done',
    summary: 'All gates green.',
    commands: [{ command: 'npm test', exitCode: 0 }],
    commits: [{ sha: 'abcdef1234567', repo: '/root/.worktrees/orch-scaling/c3a-pi-web-ui', subject: 'fix: thing' }],
    filesChanged: ['server/src/example.ts'],
    openIssues: [],
    ...overrides,
  });
}

function fenced(content: string, info = COMPLETION_FENCE_INFO): string {
  return `\`\`\`${info}\n${content}\n\`\`\``;
}

function expectOk(text: string): CompletionBlock {
  const result = parseCompletionBlock(text);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.block;
}

function expectError(text: string): { code: string; message: string; fieldPath?: string } {
  const result = parseCompletionBlock(text);
  if (result.ok) throw new Error(`expected error, got ${JSON.stringify(result.block)}`);
  return result.error;
}

describe('completion parser — happy path', () => {
  it('accepts the canonical block and echoes the parsed fields', () => {
    const text = `Work done.\n\n${fenced(block())}\n`;
    const result = parseCompletionBlock(text);
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
    const parsed = result.block;
    expect(parsed.schema).toBe('pi-completion/v1');
    expect(parsed.status).toBe('done');
    expect(parsed.commands).toEqual([{ command: 'npm test', exitCode: 0 }]);
    expect(parsed.commits?.[0]?.sha).toBe('abcdef1234567');
    expect(parsed.filesChanged).toEqual(['server/src/example.ts']);
    expect(result.delimiter).toBe('completion');
  });

  it('accepts a minimal block (schema + status only)', () => {
    const parsed = expectOk(fenced(JSON.stringify({ schema: 'pi-completion/v1', status: 'blocked', blockedReason: 'no tools' })));
    expect(parsed.status).toBe('blocked');
    expect(parsed.blockedReason).toBe('no tools');
  });

  it('accepts an indented fence and surrounding prose', () => {
    const text = `Intro\n\n  ${fenced(block())}\n\nOutro`;
    expect(expectOk(text).status).toBe('done');
  });

  it('accepts a four-backtick fence and closes it on a fence of at least equal length', () => {
    const text = `\`\`\`\`completion\n${block()}\n\`\`\`\`\n`;
    expect(expectOk(text).status).toBe('done');
  });
});

describe('completion parser — absence and placement', () => {
  it('returns NO_BLOCK for empty, undefined and block-free text', () => {
    expect(expectError('').code).toBe('NO_BLOCK');
    expect(expectError(undefined as unknown as string).code).toBe('NO_BLOCK');
    expect(expectError('plain answer, no block').code).toBe('NO_BLOCK');
  });

  it('ignores a different fence info string (correction 01: `json` with the schema tag is the one tolerance)', () => {
    expect(expectError(fenced(block(), 'completion-v2')).code).toBe('NO_BLOCK');
    expect(expectError(fenced(block(), 'jsonc')).code).toBe('NO_BLOCK');
    expect(expectError(fenced(block(), 'Json')).code).toBe('NO_BLOCK');
  });

  it('the last complete block wins', () => {
    const text = [
      fenced(block({ status: 'partial' })),
      'middle prose',
      fenced(block({ status: 'done', summary: 'final' })),
    ].join('\n');
    const parsed = expectOk(text);
    expect(parsed.status).toBe('done');
    expect(parsed.summary).toBe('final');
  });

  it('a block quoted inside a JSON string (backticks not at line start) is not an opening', () => {
    const text = [
      fenced(block()),
      'For C3b, dispatch this template: "```completion\\n{...}\\n```" inline.',
    ].join('\n');
    expect(expectOk(text).status).toBe('done');
  });

  it('a block inside a four-backtick outer fence still parses (inner fence wins)', () => {
    const text = [
      '````md',
      fenced(block()),
      '````',
    ].join('\n');
    expect(expectOk(text).status).toBe('done');
  });
});

describe('completion parser — malformed blocks', () => {
  it('MALFORMED_JSON for unparsable JSON', () => {
    const error = expectError(fenced('{"schema": "pi-completion/v1", status: done}'));
    expect(error.code).toBe('MALFORMED_JSON');
    expect(error.message).toMatch(/json/i);
  });

  it('MALFORMED_JSON for parsable JSON that is not an object', () => {
    expect(expectError(fenced('[1,2,3]')).code).toBe('MALFORMED_JSON');
    expect(expectError(fenced('"a string"')).code).toBe('MALFORMED_JSON');
  });

  it('UNCLOSED_FENCE when the last opening never closes', () => {
    const error = expectError(`prose\n${COMPLETION_FENCE_INFO}: \n\`\`\`completion\n{"schema":"pi-completion/v1"}\n`);
    expect(error.code).toBe('UNCLOSED_FENCE');
  });

  it('a complete later block wins over an earlier unclosed opening', () => {
    const text = [
      '```completion',
      '{"schema": "pi-completion/v1", oops',
      fenced(block({ summary: 'recovered' })),
    ].join('\n');
    expect(expectOk(text).summary).toBe('recovered');
  });

  it('OVERSIZED_BLOCK when the block exceeds the cap', () => {
    const big = JSON.stringify({
      schema: 'pi-completion/v1',
      status: 'done',
      filesChanged: Array.from({ length: 1200 }, (_, i) => `path/to/file-${i}.ts`),
    });
    expect(big.length).toBeGreaterThan(COMPLETION_BLOCK_MAX_CHARS);
    // Still inside the parse window: the opening fence must be reachable.
    expect(big.length).toBeLessThan(COMPLETION_PARSE_WINDOW_CHARS);
    expect(expectError(fenced(big)).code).toBe('OVERSIZED_BLOCK');
  });
});

describe('completion parser — schema violations name the field path', () => {
  it('missing schema field', () => {
    const error = expectError(fenced(JSON.stringify({ status: 'done' })));
    expect(error.code).toBe('SCHEMA_VIOLATION');
    expect(error.fieldPath).toBe('schema');
  });

  it('wrong schema name', () => {
    const error = expectError(fenced(JSON.stringify({ schema: 'pi-completion/v2', status: 'done' })));
    expect(error.code).toBe('SCHEMA_VIOLATION');
    expect(error.fieldPath).toBe('schema');
  });

  it('missing status', () => {
    const error = expectError(fenced(JSON.stringify({ schema: 'pi-completion/v1' })));
    expect(error.code).toBe('SCHEMA_VIOLATION');
    expect(error.fieldPath).toBe('status');
  });

  it('wrong status value', () => {
    const error = expectError(fenced(JSON.stringify({ schema: 'pi-completion/v1', status: 'finished' })));
    expect(error.code).toBe('SCHEMA_VIOLATION');
    expect(error.fieldPath).toBe('status');
  });

  it('wrong type on a nested field', () => {
    const error = expectError(fenced(block({ commands: [{ command: 'npm test', exitCode: 'zero' }] })));
    expect(error.code).toBe('SCHEMA_VIOLATION');
    expect(error.fieldPath).toBe('commands.0.exitCode');
  });

  it('commit without repo path', () => {
    const error = expectError(fenced(block({ commits: [{ sha: 'abcdef1234567' }] })));
    expect(error.code).toBe('SCHEMA_VIOLATION');
    expect(error.fieldPath).toBe('commits.0.repo');
  });

  it('commit with a non-sha value', () => {
    const error = expectError(fenced(block({ commits: [{ sha: 'not-a-sha', repo: '/repo' }] })));
    expect(error.code).toBe('SCHEMA_VIOLATION');
    expect(error.fieldPath).toBe('commits.0.sha');
  });

  it('blocked status requires blockedReason', () => {
    const error = expectError(fenced(JSON.stringify({ schema: 'pi-completion/v1', status: 'blocked' })));
    expect(error.code).toBe('SCHEMA_VIOLATION');
    expect(error.fieldPath).toBe('blockedReason');
  });

  it('unknown fields are rejected (strict schema)', () => {
    const error = expectError(fenced(block({ surprise: true })));
    expect(error.code).toBe('SCHEMA_VIOLATION');
    expect(error.fieldPath).toBe('surprise');
  });

  it('array bounds are schema violations', () => {
    const error = expectError(fenced(block({
      filesChanged: Array.from({ length: 201 }, (_, i) => `f-${i}.ts`),
    })));
    expect(error.code).toBe('SCHEMA_VIOLATION');
    expect(error.fieldPath).toBe('filesChanged');
  });
});

describe('completion parser — json-tagged tolerance (correction 01, parent decision)', () => {
  const taggedJson = (content: string) => fenced(content, 'json');

  it('a json fence whose object carries exactly the schema tag is parsed, with the json-tagged delimiter', () => {
    const body = JSON.stringify({ schema: 'pi-completion/v1', status: 'done' });
    const result = parseCompletionBlock(`${'prose'}\n\n${taggedJson(body)}\n`);
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
    expect(result.block.status).toBe('done');
    expect(result.delimiter).toBe('json-tagged');
  });

  it('an untagged fence whose object carries the schema tag is parsed (json-tagged delimiter)', () => {
    const body = JSON.stringify({ schema: 'pi-completion/v1', status: 'partial', blockedReason: undefined });
    const result = parseCompletionBlock(`\`\`\`\n${body}\n\`\`\``);
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
    expect(result.block.status).toBe('partial');
    expect(result.delimiter).toBe('json-tagged');
  });

  it('an untagged fence with plain JSON (no schema tag) is not a block', () => {
    expect(expectError(fenced(JSON.stringify({ status: 'done' }), '')).code).toBe('NO_BLOCK');
  });

  it('a json fence without the schema tag is not a block', () => {
    expect(expectError(fenced(JSON.stringify({ result: 'ok', items: [1, 2] }), 'json')).code).toBe('NO_BLOCK');
  });

  it('a json fence carrying a different schema value is not a block', () => {
    expect(expectError(fenced(JSON.stringify({ schema: 'other/v1', status: 'done' }), 'json')).code).toBe('NO_BLOCK');
  });

  it('a completion fence wins over an earlier tagged json fence (last protocol block wins)', () => {
    const body = JSON.stringify({ schema: 'pi-completion/v1', status: 'partial' });
    const parsed = expectOk(`${taggedJson(body)}\nmiddle\n${fenced(block({ status: 'done' }))}`);
    expect(parsed.status).toBe('done');
  });

  it('a later tagged json fence is the fallback over an earlier completion fence only by position (last wins)', () => {
    const body = JSON.stringify({ schema: 'pi-completion/v1', status: 'blocked', blockedReason: 'later' });
    const result = parseCompletionBlock(`${fenced(block({ status: 'done' }))}\n${taggedJson(body)}`);
    if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
    expect(result.block.status).toBe('blocked');
    expect(result.block.blockedReason).toBe('later');
    expect(result.delimiter).toBe('json-tagged');
  });

  it('a malformed tagged json fence gives the typed MALFORMED_JSON error', () => {
    const error = expectError(`${'prose'}\n${taggedJson('{"schema": "pi-completion/v1", oops')}`);
    expect(error.code).toBe('MALFORMED_JSON');
  });

  it('a tagged json fence with the schema tag but an invalid body gives SCHEMA_VIOLATION', () => {
    const error = expectError(taggedJson(JSON.stringify({ schema: 'pi-completion/v1', status: 'finished' })));
    expect(error.code).toBe('SCHEMA_VIOLATION');
    expect(error.fieldPath).toBe('status');
  });

  it('a trailing malformed json example AFTER a valid completion block does not produce an error', () => {
    const text = `${fenced(block())}\nExample output:\n${taggedJson('{not json')}`;
    expect(expectOk(text).status).toBe('done');
  });

  it('the completion delimiter is recorded on the canonical block', () => {
    const result = parseCompletionBlock(fenced(block()));
    if (!result.ok) throw new Error('expected ok');
    expect(result.delimiter).toBe('completion');
  });
});

describe('completion parser — boundedness', () => {
  it('exports the stated caps', () => {
    expect(COMPLETION_SCHEMA_NAME).toBe('pi-completion/v1');
    expect(COMPLETION_FENCE_INFO).toBe('completion');
    expect(COMPLETION_BLOCK_MAX_CHARS).toBe(16_384);
    expect(COMPLETION_PARSE_WINDOW_CHARS).toBeGreaterThanOrEqual(COMPLETION_BLOCK_MAX_CHARS * 4);
  });

  it('scans only the bounded tail window of very long text', () => {
    // The window keeps the last COMPLETION_PARSE_WINDOW_CHARS characters; a
    // complete block near the end still parses, and the huge prefix never
    // reaches the regex scanner.
    const prefix = 'x'.repeat(COMPLETION_PARSE_WINDOW_CHARS + 10_000);
    const parsed = expectOk(`${prefix}\n${fenced(block())}`);
    expect(parsed.status).toBe('done');
  });

  it('never throws on adversarial input', () => {
    const adversarial = [
      '```completion',
      '```completion',
      '{"schema":"pi-completion/v1","status":"done"}',
      '``',
      '`````',
      '```completion',
      '\u0000\ufffd'.repeat(100),
      '```',
    ].join('\n');
    expect(() => parseCompletionBlock(adversarial)).not.toThrow();
  });
});
