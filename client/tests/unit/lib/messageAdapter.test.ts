import { describe, expect, it } from 'vitest';
import { normalizeToolName } from '../../../src/lib/messageAdapter';

describe('normalizeToolName', () => {
  it('routes Pi evaluated_subagent results through the compact subagent card', () => {
    expect(normalizeToolName('evaluated_subagent')).toBe('subagent');
  });

  it('maps antigravity tool names onto the pi card families (F8)', () => {
    expect(normalizeToolName('run_command')).toBe('bash');
    expect(normalizeToolName('write_to_file')).toBe('write');
    expect(normalizeToolName('view_file')).toBe('read');
    expect(normalizeToolName('replace_file_content')).toBe('edit');
    expect(normalizeToolName('multi_replace_file_content')).toBe('edit');
    expect(normalizeToolName('sed_file')).toBe('edit');
    expect(normalizeToolName('list_dir')).toBe('find');
    expect(normalizeToolName('find_by_name')).toBe('glob');
    expect(normalizeToolName('grep_search')).toBe('grep');
    expect(normalizeToolName('search_web')).toBe('web_search');
    expect(normalizeToolName('read_url_content')).toBe('web_fetch');
    expect(normalizeToolName('read_resource')).toBe('web_fetch');
    expect(normalizeToolName('invoke_subagent')).toBe('subagent');
  });

  it('keeps the background-command lifecycle names distinct (F9)', () => {
    expect(normalizeToolName('command_status')).toBe('command_status');
    expect(normalizeToolName('send_command_input')).toBe('send_command_input');
    expect(normalizeToolName('wait')).toBe('wait');
  });
});
