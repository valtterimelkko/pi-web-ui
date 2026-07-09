import { describe, expect, it } from 'vitest';
import { AuthStorage, ModelRegistry } from '@earendil-works/pi-coding-agent';

describe('Pi SDK OpenAI Codex model registry', () => {
  it('registers the GPT-5.6 Codex variants', () => {
    const registry = ModelRegistry.create(AuthStorage.create('/tmp/pi-sdk-codex-models-test-auth.json'));

    for (const id of ['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol']) {
      expect(registry.find('openai-codex', id)).toMatchObject({
        id,
        provider: 'openai-codex',
      });
    }
  });
});
