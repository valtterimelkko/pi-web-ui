import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VOICE_WIRE_VERSION, type VoiceClientMessage } from '@pi-web-ui/shared';

const mocks = vi.hoisted(() => ({
  send: vi.fn(() => 'sent' as const),
  client: null as null | { send: (frame: unknown) => string },
}));

vi.mock('../websocket', () => ({
  getWebSocketClient: () => mocks.client,
}));

import {
  emitVoiceFrame,
  registerVoiceLane,
  sendVoiceFrame,
  voiceLaneRegistrationCount,
} from './frameBus';

function voiceServerFrame(type: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type,
    version: VOICE_WIRE_VERSION,
    laneId: 'worker-1:page',
    attachmentGeneration: 0,
    ...extra,
  };
}

beforeEach(() => {
  mocks.send.mockClear();
  mocks.client = { send: mocks.send };
});

describe('voiceLive/frameBus — inbound routing', () => {
  it('delivers a lane frame to its lane only, and consumes it', () => {
    const first: unknown[] = [];
    const second: unknown[] = [];
    const off1 = registerVoiceLane('worker-1:page', (frame) => first.push(frame));
    const off2 = registerVoiceLane('worker-2:page', (frame) => second.push(frame));

    expect(emitVoiceFrame(voiceServerFrame('voice_state', { state: 'live' }))).toBe(true);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);

    off1();
    off2();
    expect(voiceLaneRegistrationCount()).toBe(0);
  });

  it('delivers a lane-less refusal to every mounted lane (it belongs to the socket)', () => {
    const seen: string[] = [];
    const off1 = registerVoiceLane('worker-1:page', () => seen.push('one'));
    const off2 = registerVoiceLane('worker-2:page', () => seen.push('two'));

    expect(
      emitVoiceFrame({
        type: 'voice_error',
        version: VOICE_WIRE_VERSION,
        laneId: '',
        attachmentGeneration: 0,
        code: 'voice_internal_error',
        message: 'Voice frame rate exceeded; the frame was dropped.',
        fatal: false,
      }),
    ).toBe(true);
    expect(seen).toEqual(['one', 'two']);

    off1();
    off2();
  });

  it('does not consume a frame that is not a voice frame', () => {
    const listener = vi.fn();
    const off = registerVoiceLane('worker-1:page', listener);
    expect(emitVoiceFrame({ type: 'prompt_result', text: 'hello' })).toBe(false);
    expect(emitVoiceFrame('not a frame')).toBe(false);
    expect(listener).not.toHaveBeenCalled();
    off();
  });

  it('consumes an unmatched voice frame rather than letting the session store record drift', () => {
    const listener = vi.fn();
    const off = registerVoiceLane('worker-1:page', listener);
    expect(emitVoiceFrame(voiceServerFrame('voice_state', { state: 'live' }))).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    // A frame for a lane that is no longer mounted is still a voice frame.
    expect(emitVoiceFrame({ ...voiceServerFrame('voice_state', { state: 'live' }), laneId: 'gone:page' })).toBe(
      true,
    );
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('voiceLive/frameBus — outbound', () => {
  it('sends a lane frame on the app socket', () => {
    const frame = { type: 'voice_session_start' } as unknown as VoiceClientMessage;
    expect(sendVoiceFrame(frame)).toBe('sent');
    expect(mocks.send).toHaveBeenCalledWith(frame);
  });

  it('reports failure (never a silent drop) when there is no socket', () => {
    mocks.client = null;
    expect(sendVoiceFrame({ type: 'voice_session_start' } as unknown as VoiceClientMessage)).toBe('failed');
  });
});
