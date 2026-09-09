import type { AntigravityTurn, AgyStoredToolCall, AgyStoredUsage } from '../../../src/antigravity/antigravity-session-store.js';

/**
 * Fixtures mirrored from a live-validated A/B run on production
 * (2026-09-09, contract 1.38.0, agy 1.1.27 stream-json): an antigravity
 * session and a pi session given the same task (write two files, run a
 * unittest suite, run a slow command). Shapes are faithful to the wire and
 * store; content is synthetic. See
 * docs/plans/ANTIGRAVITY-FRONTEND-PARITY-AND-CONTEXT-HONESTY-PLAN.md.
 */

/** Real usage captured from turn 1 of the live A/B conversation. agy semantics:
 *  total = input + output; cacheRead is ADDITIONAL (real request size is
 *  input + cacheRead = 148,489 = 14.2% of the 1,048,576 flash window). */
export const CAPTURED_USAGE_TURN1: AgyStoredUsage = {
  input: 42445,
  output: 2259,
  thinking: 1531,
  cacheRead: 106044,
  total: 44704,
};

/** Turn 2 of the same conversation — proves input/cacheRead grow with the
 *  conversation while total alone would understate the context (~2.6x here). */
export const CAPTURED_USAGE_TURN2: AgyStoredUsage = {
  input: 66273,
  output: 2718,
  thinking: 1931,
  cacheRead: 114196,
  total: 68991,
};

const writeTool = (target: string): AgyStoredToolCall => ({
  toolName: 'write_to_file',
  args: { TargetFile: target, Content: 'def add(a, b):\n    return a + b\n' },
  output: '',
  isError: false,
});

const commandTool = (command: string, output: string): AgyStoredToolCall => ({
  toolName: 'run_command',
  args: { CommandLine: command },
  output,
  isError: false,
});

/** Stored turns mirroring the live A/B antigravity session: two file writes
 *  (agy reports EMPTY output for writes), two commands (unittest + slow tick),
 *  then a tool-less second turn. Usage blocks are the real captured numbers. */
export function storedTurnsFromAbRun(): AntigravityTurn[] {
  return [
    {
      turnId: 'turn-1',
      prompt: 'Tasks: create calc.py + test_calc.py, run the unittest suite, run a slow tick command.',
      response: '### Summary\n\nAll four steps completed; the suite passed and the tick command printed tick 0..3.',
      model: 'gemini-3.6-flash-medium',
      conversationId: '73f93edd-ab-run-conv',
      timestamp: 1_788_962_800_000,
      status: 'done',
      turnDurationMs: 17_000,
      usage: CAPTURED_USAGE_TURN1,
      numTurns: 1,
      agyStatus: 'SUCCESS',
      tools: [
        writeTool('/tmp/agpi-compare/calc.py'),
        writeTool('/tmp/agpi-compare/test_calc.py'),
        commandTool(
          'python3 -m unittest -v test_calc',
          'test_add_negative ... ok\ntest_add_positive ... ok\ntest_add_zero ... ok\n\nOK',
        ),
        commandTool('python3 -c "import time; …"', 'tick 0\ntick 1\ntick 2\ntick 3\n'),
      ],
    },
    {
      turnId: 'turn-2',
      prompt: 'Second question: what files did you create and what did the last command output?',
      response: 'Files created: calc.py and test_calc.py. Last command output: tick 0..3.',
      model: 'gemini-3.6-flash-medium',
      conversationId: '73f93edd-ab-run-conv',
      timestamp: 1_788_963_100_000,
      status: 'done',
      turnDurationMs: 5_200,
      usage: CAPTURED_USAGE_TURN2,
      numTurns: 2,
      agyStatus: 'SUCCESS',
      tools: [],
    },
  ];
}

/** The 57-tool inventory captured live from a real agy 1.1.27 init event
 *  (2026-09-09). Frozen so visibility/mapping tests fail loudly when agy
 *  adds or renames tools the surfacing layers do not know about. */
export const AGY_TOOL_INVENTORY: readonly string[] = [
  'ask_custom_permission', 'ask_permission', 'ask_question', 'browser_click_element',
  'browser_drag_pixel_to_pixel', 'browser_get_dom', 'browser_get_network_request',
  'browser_input', 'browser_list_network_requests', 'browser_mouse_down',
  'browser_mouse_up', 'browser_move_mouse', 'browser_press_key', 'browser_refresh_page',
  'browser_resize_window', 'browser_scroll', 'browser_scroll_dom', 'browser_select_option',
  'browser_subagent', 'call_mcp_tool', 'capture_browser_console_logs',
  'capture_browser_screenshot', 'click_browser_pixel', 'command_status', 'define_subagent',
  'delete_knowledge', 'execute_browser_javascript', 'find_by_name', 'finish',
  'generate_image', 'grep_search', 'invoke_subagent', 'list_browser_pages', 'list_dir',
  'list_permissions', 'list_resources', 'manage_inbox', 'manage_subagents', 'manage_task',
  'multi_replace_file_content', 'notebook_edit', 'notebook_execution', 'open_browser_url',
  'read_browser_page', 'read_resource', 'read_url_content', 'replace_file_content',
  'run_command', 'schedule', 'search_web', 'sed_file', 'send_command_input',
  'send_message', 'view_file', 'wait', 'wait_5_seconds', 'write_to_file',
];
