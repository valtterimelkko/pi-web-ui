import { describe, it, expect } from 'vitest';
import {
  DEFAULT_NOTIFICATION_ACTION_HANDLERS,
  NOTIFICATION_ACTION_HANDLERS_ENV,
  NOTIFICATION_ACTION_HANDLER_TIMEOUT_MS,
  ActionHandlerRegistry,
  loadNotificationActionHandlers,
  parseHandlerDefinitionsJson,
  resolveHandlerArgv,
  runNotificationActionHandler,
  type ExecFileFn,
} from '../../../src/notifications/action-handlers.js';

const REF = 'req-2026-10-18-01';
const ACTION = 'approve';

describe('notification action handlers (CHANNEL.md §7)', () => {
  describe('built-in defaults', () => {
    it('registers agent-os-channel with the exact §7 argv', () => {
      expect(DEFAULT_NOTIFICATION_ACTION_HANDLERS['agent-os-channel']).toEqual({
        command: '/root/.npm-global/bin/agent-os',
        args: ['channel', 'decide', '--request', '{ref}', '--decision', '{action}', '--by', 'telegram', '--json'],
      });
    });

    it('registers agent-os-inbox with the exact §7 argv', () => {
      expect(DEFAULT_NOTIFICATION_ACTION_HANDLERS['agent-os-inbox']).toEqual({
        command: '/root/.npm-global/bin/agent-os',
        args: ['inbox', 'release', '--id', '{ref}', '--decision', '{action}', '--by', 'telegram', '--json'],
      });
    });
  });

  describe('registry', () => {
    it('has/get/names over the definitions it is built from', () => {
      const registry = new ActionHandlerRegistry({
        one: { command: '/bin/echo', args: ['{ref}'] },
        two: { command: '/bin/true', args: [] },
      });
      expect(registry.has('one')).toBe(true);
      expect(registry.has('missing')).toBe(false);
      expect(registry.get('one')).toEqual({ command: '/bin/echo', args: ['{ref}'] });
      expect(registry.get('missing')).toBeUndefined();
      expect(registry.names().sort()).toEqual(['one', 'two']);
    });
  });

  describe('environment override', () => {
    it('replaces the whole handler map when the env var holds valid JSON', () => {
      const env = {
        [NOTIFICATION_ACTION_HANDLERS_ENV]: JSON.stringify({
          'test-handler': { command: '/bin/echo', args: ['{ref}', '{action}'] },
        }),
      };
      const handlers = loadNotificationActionHandlers(env);
      expect(Object.keys(handlers)).toEqual(['test-handler']);
      expect(handlers['test-handler']).toEqual({ command: '/bin/echo', args: ['{ref}', '{action}'] });
    });

    it('falls back to the built-ins when the env var is unset', () => {
      expect(loadNotificationActionHandlers({})).toEqual(DEFAULT_NOTIFICATION_ACTION_HANDLERS);
    });

    it('throws a clear error on invalid JSON', () => {
      expect(() => loadNotificationActionHandlers({ [NOTIFICATION_ACTION_HANDLERS_ENV]: '{nope' }))
        .toThrow(/NOTIFICATION_ACTION_HANDLERS/);
    });

    it('throws a clear error on an entry without a command and args array', () => {
      const env = { [NOTIFICATION_ACTION_HANDLERS_ENV]: JSON.stringify({ broken: { command: '/bin/echo' } }) };
      expect(() => loadNotificationActionHandlers(env)).toThrow(/NOTIFICATION_ACTION_HANDLERS\[broken\]\.args/);
      const missingCommand = { [NOTIFICATION_ACTION_HANDLERS_ENV]: JSON.stringify({ noCmd: { args: [] } }) };
      expect(() => loadNotificationActionHandlers(missingCommand)).toThrow(/NOTIFICATION_ACTION_HANDLERS\[noCmd\]\.command/);
    });
  });

  describe('parseHandlerDefinitionsJson', () => {
    it('parses a well-formed map', () => {
      expect(parseHandlerDefinitionsJson('{"a":{"command":"/bin/echo","args":["x"]}}')).toEqual({
        a: { command: '/bin/echo', args: ['x'] },
      });
    });

    it('rejects a non-object map and a non-string command', () => {
      expect(() => parseHandlerDefinitionsJson('["a"]')).toThrow();
      expect(() => parseHandlerDefinitionsJson('{"a":{"command":42,"args":[]}}')).toThrow();
      expect(() => parseHandlerDefinitionsJson('{"a":{"command":"/bin/echo","args":"x"}}')).toThrow();
    });
  });

  describe('resolveHandlerArgv — whole-element substitution only', () => {
    const def = { command: '/bin/agent-os', args: ['channel', 'decide', '--request', '{ref}', '--decision', '{action}', '--json'] };

    it('substitutes {ref} and {action} as whole argv elements', () => {
      expect(resolveHandlerArgv(def, REF, ACTION)).toEqual([
        'channel', 'decide', '--request', REF, '--decision', ACTION, '--json',
      ]);
    });

    it('never interpolates into a partial element', () => {
      expect(resolveHandlerArgv({ command: '/bin/x', args: ['{ref}-suffix', 'pre{action}', 'plain'] }, 'R', 'A'))
        .toEqual(['{ref}-suffix', 'pre{action}', 'plain']);
    });

    it('replaces every occurrence', () => {
      expect(resolveHandlerArgv({ command: '/bin/x', args: ['{ref}', '{ref}', '{action}'] }, 'R', 'A'))
        .toEqual(['R', 'R', 'A']);
    });
  });

  describe('runNotificationActionHandler — fake exec', () => {
    const def = { command: '/root/.npm-global/bin/agent-os', args: ['channel', 'decide', '--request', '{ref}', '--decision', '{action}', '--json'] };

    it('execs the command with the resolved argv and parses the JSON stdout message', async () => {
      const calls: Array<{ file: string; args: readonly string[]; options: { timeout: number; shell?: boolean } }> = [];
      const execFile: ExecFileFn = (file, args, options, callback) => {
        calls.push({ file, args, options });
        callback(null, JSON.stringify({ message: 'Decision recorded' }), '');
        return undefined;
      };
      const result = await runNotificationActionHandler(def, REF, ACTION, { execFile });

      expect(result).toEqual({ ok: true, message: 'Decision recorded' });
      expect(calls).toHaveLength(1);
    });

    it('runs argv-only: passes { timeout } options and never a shell string', async () => {
      const calls: Array<{ file: string; args: readonly string[]; options: { timeout: number; shell?: boolean } }> = [];
      const execFile: ExecFileFn = (file, args, options, callback) => {
        calls.push({ file, args, options });
        callback(null, '{"message":"ok"}', '');
        return undefined;
      };
      await runNotificationActionHandler(def, REF, ACTION, { execFile });

      expect(calls).toHaveLength(1);
      expect(calls[0].file).toBe('/root/.npm-global/bin/agent-os');
      expect(calls[0].args).toEqual(['channel', 'decide', '--request', REF, '--decision', ACTION, '--json']);
      expect(calls[0].options.timeout).toBe(NOTIFICATION_ACTION_HANDLER_TIMEOUT_MS);
      expect(calls[0].options.shell === undefined || calls[0].options.shell === false).toBe(true);
    });

    it('maps a non-zero exit with stderr to "Could not apply: <first stderr line>"', async () => {
      const execFile: ExecFileFn = (_file, _args, _options, callback) => {
        const error = Object.assign(new Error('Command failed'), { code: 1 });
        callback(error, '', 'refusal: no such request\nsecond line\n');
        return undefined;
      };
      const result = await runNotificationActionHandler(def, REF, ACTION, { execFile });
      expect(result).toEqual({ ok: false, message: 'Could not apply: refusal: no such request' });
    });

    it('maps bad stdout (not JSON) to the failure message even on exit 0', async () => {
      const execFile: ExecFileFn = (_file, _args, _options, callback) => {
        callback(null, 'not json at all', '');
        return undefined;
      };
      const result = await runNotificationActionHandler(def, REF, ACTION, { execFile });
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/^Could not apply: /);
    });

    it('maps JSON without a string message to the failure message', async () => {
      const execFile: ExecFileFn = (_file, _args, _options, callback) => {
        callback(null, '{"other":"field"}', '');
        return undefined;
      };
      const result = await runNotificationActionHandler(def, REF, ACTION, { execFile });
      expect(result).toEqual({ ok: false, message: 'Could not apply: handler failed' });
    });

    it('falls back to a stable message when stderr is empty', async () => {
      const execFile: ExecFileFn = (_file, _args, _options, callback) => {
        const error = Object.assign(new Error('Command failed'), { code: 2 });
        callback(error, '', '');
        return undefined;
      };
      const result = await runNotificationActionHandler(def, REF, ACTION, { execFile });
      expect(result).toEqual({ ok: false, message: 'Could not apply: handler failed' });
    });

    it('honours a custom timeout', async () => {
      const calls: Array<{ options: { timeout: number } }> = [];
      const execFile: ExecFileFn = (file, args, options, callback) => {
        calls.push({ options });
        callback(null, '{"message":"ok"}', '');
        return undefined;
      };
      await runNotificationActionHandler(def, REF, ACTION, { execFile, timeoutMs: 1234 });
      expect(calls[0].options.timeout).toBe(1234);
    });
  });
});
