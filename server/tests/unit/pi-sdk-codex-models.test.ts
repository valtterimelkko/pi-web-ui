import { describe, expect, it } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

describe('Pi SDK OpenAI Codex model runtime', () => {
  it('resolves the GPT-5.6 Codex variants', async () => {
    const modelRuntime = await ModelRuntime.create({
      authPath: '/tmp/pi-sdk-codex-models-test-auth.json',
      modelsPath: null,
      allowModelNetwork: false,
    });

    for (const id of ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol']) {
      expect(modelRuntime.getModel('openai-codex', id)).toMatchObject({
        id,
        provider: 'openai-codex',
      });
    }
  });
});
