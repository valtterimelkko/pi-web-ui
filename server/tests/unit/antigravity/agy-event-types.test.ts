import { describe, it, expect } from 'vitest';
import {
  parseAgyLine,
  helpTextSupportsStream,
} from '../../../src/antigravity/agy-event-types.js';

/**
 * Fixtures are trimmed from real live captures on agy 1.1.27 (2026-09-08):
 * see /root/pi-enhancement/docs/research/2026-09-08-agy-json-headless-live-validation.md
 * and the plan docs/plans/ANTIGRAVITY-JSON-STREAM-INTEGRATION-PLAN.md §3.
 */

const INIT_LINE =
  '{"event":"init","conversation_id":"f6bea8d6-1ed9-49b9-ab15-c068a7d188ff","init":{"cwd":"/tmp/agy-lv","tools":["ask_permission","run_command","write_to_file"],"permission_mode":"always-proceed","model":"gemini-3.6-flash-low"}}';

const USER_INPUT_LINE =
  '{"event":"step_update","step_update":{"conversation_id":"f6bea8d6-1ed9-49b9-ab15-c068a7d188ff","step_index":0,"state":"DONE","step_type":"user_input"}}';

const UNKNOWN_STEP_LINE =
  '{"event":"step_update","step_update":{"conversation_id":"f6bea8d6-1ed9-49b9-ab15-c068a7d188ff","step_index":1,"state":"DONE","step_type":"unknown","duration_seconds":0.000097743}}';

const AGENT_RESPONSE_LINE =
  '{"event":"step_update","step_update":{"conversation_id":"f6bea8d6-1ed9-49b9-ab15-c068a7d188ff","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"ok\\n","duration_seconds":3.38,"usage":{"input_tokens":19531,"output_tokens":886,"thinking_tokens":885,"cache_read_tokens":8161,"total_tokens":20417}}}';

const AGENT_RESPONSE_ACTIVE_LINE =
  '{"event":"step_update","step_update":{"conversation_id":"x","step_index":84,"state":"ACTIVE","step_type":"agent_response","text_delta":"Tide pools form"}}';

const TOOL_ACTIVE_LINE =
  '{"event":"step_update","step_update":{"conversation_id":"x","step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"run_command"}}';

const TOOL_DONE_LINE =
  '{"event":"step_update","step_update":{"conversation_id":"edb1c8c1-50ba-4f3f-87eb-412d0e9d47c3","step_index":4,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.07,"tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hello_headless_demo"},"output":"hello_headless_demo\\r\\n"}}}';

const TOOL_ERROR_LINE =
  '{"event":"step_update","step_update":{"conversation_id":"x","step_index":5,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"false"},"error":{"type":"exit","message":"exited 1"}}}}';

const SYSTEM_MESSAGE_LINE =
  '{"event":"step_update","step_update":{"conversation_id":"x","step_index":11,"state":"DONE","step_type":"system_message"}}';

const RESULT_LINE =
  '{"event":"result","result":{"conversation_id":"f6bea8d6-1ed9-49b9-ab15-c068a7d188ff","status":"SUCCESS","response":"ok\\n","duration_seconds":5.259,"num_turns":1,"usage":{"input_tokens":19531,"output_tokens":886,"thinking_tokens":885,"cache_read_tokens":8161,"total_tokens":20417}}}';

const RESULT_ERROR_LINE =
  '{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"invalid model selection (--model \\"bogus-model-x\\" --effort \\"\\"): model bogus-model-x is not recognized","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":0}}}';

describe('parseAgyLine (agy 1.1.27 stream-json wire schemas)', () => {
  it('parses a real init line (top-level conversation_id, model echo)', () => {
    const parsed = parseAgyLine(INIT_LINE);
    expect(parsed.kind).toBe('init');
    if (parsed.kind !== 'init') return;
    expect(parsed.conversationId).toBe('f6bea8d6-1ed9-49b9-ab15-c068a7d188ff');
    expect(parsed.init.cwd).toBe('/tmp/agy-lv');
    expect(parsed.init.permission_mode).toBe('always-proceed');
    expect(parsed.init.model).toBe('gemini-3.6-flash-low');
    expect(parsed.init.tools).toContain('run_command');
  });

  it('parses user_input step (conversation_id inside payload)', () => {
    const parsed = parseAgyLine(USER_INPUT_LINE);
    expect(parsed.kind).toBe('step');
    if (parsed.kind !== 'step') return;
    expect(parsed.step.step_type).toBe('user_input');
    expect(parsed.step.state).toBe('DONE');
    expect(parsed.step.conversation_id).toBe('f6bea8d6-1ed9-49b9-ab15-c068a7d188ff');
  });

  it('is lenient: undocumented step_type "unknown" parses', () => {
    const parsed = parseAgyLine(UNKNOWN_STEP_LINE);
    expect(parsed.kind).toBe('step');
    if (parsed.kind !== 'step') return;
    expect(parsed.step.step_type).toBe('unknown');
  });

  it('is lenient: undocumented step_type "system_message" parses', () => {
    const parsed = parseAgyLine(SYSTEM_MESSAGE_LINE);
    expect(parsed.kind).toBe('step');
    if (parsed.kind !== 'step') return;
    expect(parsed.step.step_type).toBe('system_message');
  });

  it('parses agent_response DONE with text_delta and per-step usage', () => {
    const parsed = parseAgyLine(AGENT_RESPONSE_LINE);
    expect(parsed.kind).toBe('step');
    if (parsed.kind !== 'step') return;
    expect(parsed.step.text_delta).toBe('ok\n');
    expect(parsed.step.usage?.total_tokens).toBe(20417);
  });

  it('parses agent_response ACTIVE streaming delta (no usage, no duration)', () => {
    const parsed = parseAgyLine(AGENT_RESPONSE_ACTIVE_LINE);
    expect(parsed.kind).toBe('step');
    if (parsed.kind !== 'step') return;
    expect(parsed.step.state).toBe('ACTIVE');
    expect(parsed.step.text_delta).toBe('Tide pools form');
    expect(parsed.step.usage).toBeUndefined();
  });

  it('parses tool ACTIVE step (no tool_info yet)', () => {
    const parsed = parseAgyLine(TOOL_ACTIVE_LINE);
    expect(parsed.kind).toBe('step');
    if (parsed.kind !== 'step') return;
    expect(parsed.step.step_type).toBe('tool');
    expect(parsed.step.tool_name).toBe('run_command');
    expect(parsed.step.tool_info).toBeUndefined();
  });

  it('parses tool DONE step with full tool_info (parameters + output)', () => {
    const parsed = parseAgyLine(TOOL_DONE_LINE);
    expect(parsed.kind).toBe('step');
    if (parsed.kind !== 'step') return;
    expect(parsed.step.tool_info?.name).toBe('run_command');
    expect((parsed.step.tool_info?.parameters as { CommandLine?: string })?.CommandLine).toBe(
      'echo hello_headless_demo',
    );
    expect(parsed.step.tool_info?.output).toContain('hello_headless_demo');
    expect(parsed.step.tool_info?.error).toBeUndefined();
  });

  it('parses tool DONE step with a tool error', () => {
    const parsed = parseAgyLine(TOOL_ERROR_LINE);
    expect(parsed.kind).toBe('step');
    if (parsed.kind !== 'step') return;
    expect(parsed.step.tool_info?.error?.message).toBe('exited 1');
  });

  it('parses a SUCCESS result envelope', () => {
    const parsed = parseAgyLine(RESULT_LINE);
    expect(parsed.kind).toBe('result');
    if (parsed.kind !== 'result') return;
    expect(parsed.conversationId).toBe('f6bea8d6-1ed9-49b9-ab15-c068a7d188ff');
    expect(parsed.result.status).toBe('SUCCESS');
    expect(parsed.result.response).toBe('ok\n');
    expect(parsed.result.num_turns).toBe(1);
    expect(parsed.result.usage.input_tokens).toBe(19531);
  });

  it('parses an ERROR result envelope (loud model failure)', () => {
    const parsed = parseAgyLine(RESULT_ERROR_LINE);
    expect(parsed.kind).toBe('result');
    if (parsed.kind !== 'result') return;
    expect(parsed.result.status).toBe('ERROR');
    expect(parsed.result.error).toContain('not recognized');
    expect(parsed.result.usage.total_tokens).toBe(0);
  });

  it('routes unrecognized event names to kind "unknown" (protocol forward-compat)', () => {
    const parsed = parseAgyLine('{"event":"future_thing","data":{"x":1}}');
    expect(parsed.kind).toBe('unknown');
    if (parsed.kind !== 'unknown') return;
    expect(parsed.event).toBe('future_thing');
  });

  it('rejects invalid JSON as kind "invalid" (reader must not crash)', () => {
    const parsed = parseAgyLine('this is not json');
    expect(parsed.kind).toBe('invalid');
  });

  it('rejects non-object JSON as kind "invalid"', () => {
    expect(parseAgyLine('42').kind).toBe('invalid');
    expect(parseAgyLine('"a string"').kind).toBe('invalid');
    expect(parseAgyLine('null').kind).toBe('invalid');
  });

  it('rejects structurally wrong payloads (missing envelope fields) as "invalid"', () => {
    // result without usage: schema-drift guard
    const parsed = parseAgyLine(
      '{"event":"result","result":{"conversation_id":"x","status":"SUCCESS","response":"a","duration_seconds":1,"num_turns":1}}',
    );
    expect(parsed.kind).toBe('invalid');
  });
});

describe('helpTextSupportsStream (T0.1 capability probe)', () => {
  it('is true for agy 1.1.27 help (both --output-format and --input-format present)', () => {
    const help = [
      'Usage of agy:',
      '  --input-format                  Input format for print mode (text, stream-json).',
      '  --output-format                 Output format for print mode (text, json, stream-json) (default text)',
    ].join('\n');
    expect(helpTextSupportsStream(help)).toBe(true);
  });

  it('is false for a legacy agy help without the stream flags', () => {
    const help = [
      'Usage of agy:',
      '  --print                         Run a single prompt non-interactively and print the response',
      '  --print-timeout                 Timeout for print mode wait (default 5m0s)',
    ].join('\n');
    expect(helpTextSupportsStream(help)).toBe(false);
  });

  it('is false for empty help text', () => {
    expect(helpTextSupportsStream('')).toBe(false);
  });
});
