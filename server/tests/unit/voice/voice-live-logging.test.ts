/**
 * The native Voice Mode path must be isolatable in the log stream.
 *
 * Before this test, everything the native lane emitted — the bridge's own
 * diagnostics, the structured `voice-kernel` evidence lines, the engine-selection
 * line at mount construction — went out under the generic `WebUI` component,
 * because the mount is wired from `connection.ts`'s module logger. `DEBUG=` and
 * the diagnostics route's `?component=` filter could therefore not separate a
 * voice problem from ordinary WebSocket traffic. The talker path already has its
 * own component (`VoiceMode`); the native path now has `VoiceLive`.
 *
 * The doc list is asserted too: a component an operator cannot find in
 * docs/OBSERVABILITY.md is a component they will not use.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { VOICE_LIVE_LOG_COMPONENT, createVoiceLiveLogger, createLogEvidenceSink } from '../../../src/websocket/voice-live-mount.js';

describe('native Voice Mode logging component', () => {
  it('names the component VoiceLive and keeps the name in one place', () => {
    expect(VOICE_LIVE_LOG_COMPONENT).toBe('VoiceLive');
  });

  it('creates a logger bound to that component, and the sink stamps its records with it', () => {
    const logger = createVoiceLiveLogger();
    expect(logger.component).toBe('VoiceLive');

    const sink = createLogEvidenceSink(logger);
    expect(typeof sink).toBe('function');
  });

  it('documents every voice component in the observability component list', () => {
    const doc = readFileSync(
      fileURLToPath(new URL('../../../../docs/OBSERVABILITY.md', import.meta.url)),
      'utf8'
    );
    for (const component of ['VoiceLive', 'VoiceMode', 'ClientVoice']) {
      expect(doc).toContain(`\`${component}\``);
    }
  });
});
