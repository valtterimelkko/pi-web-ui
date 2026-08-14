import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { COMMAND_CODE_FULL_MODEL_CATALOGUE } from '../command-code/command-code-model-catalog.js';

/**
 * Creates a deterministic local Command Code-compatible CLI for disposable
 * validation. It never contacts a provider and only exists under the supplied
 * validation directory.
 */
export async function createCommandCodeValidationFixture(validationDir: string): Promise<string> {
  const binDir = path.join(validationDir, 'command-code-fixture-bin');
  const executable = path.join(binDir, 'cmd');
  await mkdir(binDir, { recursive: true, mode: 0o700 });
  const source = `#!/usr/bin/env node
const args = process.argv.slice(2);
const fs = require('node:fs');
const path = require('node:path');
const modelIndex = args.indexOf('--model');
const model = modelIndex >= 0 ? args[modelIndex + 1] : '';
const modelCatalogue = ${JSON.stringify([...COMMAND_CODE_FULL_MODEL_CATALOGUE])};
const effortIndex = args.indexOf('--effort');
const effort = effortIndex >= 0 ? args[effortIndex + 1] : '';
if (args.includes('--version')) { console.log('Command Code v1.19.0'); process.exit(0); }
if (args.includes('--list-models')) {
  for (const id of modelCatalogue) console.log(id + ' '.repeat(Math.max(2, 42 - id.length)) + 'fixture model');
  process.exit(0);
}
if (effort === '__pi_web_ui_capability_probe__') {
  if (model === 'qwen/qwen3.8-max') {
    console.error('Unknown effort "__pi_web_ui_capability_probe__". Supported: low, medium, xhigh.');
  } else {
    console.error('Model does not support adjustable reasoning effort.');
  }
  process.exit(2);
}
const supportedEfforts = model === 'qwen/qwen3.8-max' ? ['low', 'medium', 'xhigh'] : [];
if (effort && !supportedEfforts.includes(effort)) {
  console.error('unsupported reasoning effort');
  process.exit(2);
}
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  try {
    fs.mkdirSync(path.join(process.env.HOME || '', '.commandcode'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(process.env.HOME || '', '.commandcode', 'browser-write-check'), 'fixture-write-ok\\n', { mode: 0o600 });
    fs.writeFileSync(path.join(process.cwd(), 'workspace-write-check'), 'workspace-write-should-be-blocked\\n', { mode: 0o600 });
  } catch (error) {
    process.stderr.write(String(error));
  }
  const text = prompt.includes('COMMAND-CODE-BROWSER-LIVE-OK') ? 'COMMAND-CODE-BROWSER-LIVE-OK'
    : prompt.includes('MUSE-LIVE-OK') ? 'MUSE-LIVE-OK'
      : prompt.includes('RUN-RECEIPT-LIVE-OK') ? 'RUN-RECEIPT-LIVE-OK'
      : prompt.includes('EVIDENCE-LIVE-OK') ? 'EVIDENCE-LIVE-OK'
        : prompt.includes('LIVE-VALIDATION-INFO') ? 'LIVE-VALIDATION-INFO'
          : prompt.includes('LIVE-VALIDATION-OK') ? 'LIVE-VALIDATION-OK'
            : 'COMMAND-CODE-LIVE-OK';
  const sessionId = 'command-code-fixture-native-session';
  const emit = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
  emit({ type: 'event', event: { type: 'run_start', sessionId } });
  emit({ type: 'event', event: { type: 'message_start', message: { id: 'fixture-assistant', role: 'assistant' } } });
  emit({ type: 'event', event: { type: 'text_delta', messageId: 'fixture-assistant', delta: text } });
  emit({ type: 'event', event: { type: 'message_end', message: { id: 'fixture-assistant' } } });
  emit({ type: 'result', subtype: 'success', sessionId, finalText: text, ...(model === 'qwen/qwen3.8-max' ? { effort: effort || 'medium' } : {}), usage: { input: 3, output: 4, total: 7 } });
});
`;
  await writeFile(executable, source, { encoding: 'utf8', mode: 0o700 });
  await chmod(executable, 0o700);
  return executable;
}
