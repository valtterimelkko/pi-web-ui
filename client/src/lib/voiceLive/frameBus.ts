/**
 * voiceLive/frameBus — the page-level seam between the app's session WebSocket
 * and the native voice lanes mounted in it (M7).
 *
 * The app has exactly one session socket. Voice frames ride that socket (the
 * server routes `voice_*` types from the same connection), so a mounted voice
 * lane needs two things the React tree cannot supply:
 *
 *   - INBOUND: the frames addressed to its lane, consumed BEFORE the session
 *     store sees them — the store has no voice vocabulary and would record
 *     protocol drift for a frame it did not expect. Exactly the pattern the
 *     talker tap (`lib/talkerBus.ts`) already uses.
 *   - OUTBOUND: the one socket's `send`, so the lane's typed frames leave the
 *     same way every other frame does.
 *
 * Frames are addressed by `laneId`. A frame that names no lane at all — the
 * transport-level refusals of M8 — belongs to the SOCKET, not to a lane, so it
 * is delivered to every mounted lane rather than dropped for failing to match.
 */

import type { VoiceClientMessage, VoiceServerMessage } from '@pi-web-ui/shared';
import { getWebSocketClient, type WebSocketSendResult } from '../websocket';
import { isVoiceServerMessage } from './messages';

export type VoiceFrameListener = (frame: VoiceServerMessage, raw: unknown) => void;

interface VoiceLaneRegistration {
  laneId: string;
  listener: VoiceFrameListener;
}

const registrations = new Set<VoiceLaneRegistration>();

/** Register a mounted lane's listener. Returns the unregister function. */
export function registerVoiceLane(laneId: string, listener: VoiceFrameListener): () => void {
  const registration: VoiceLaneRegistration = { laneId, listener };
  registrations.add(registration);
  return () => {
    registrations.delete(registration);
  };
}

/** How many lanes are currently registered (test/observability aid). */
export function voiceLaneRegistrationCount(): number {
  return registrations.size;
}

/**
 * Offer one inbound frame to the mounted voice lanes.
 *
 * Returns true when the frame was a voice frame and the app must NOT pass it to
 * the session store. A voice frame with no matching lane is consumed too: it
 * belongs to a lane that is not mounted (or is no longer), and handing it to the
 * store would only manufacture a drift report.
 */
export function emitVoiceFrame(raw: unknown): boolean {
  if (!isVoiceServerMessage(raw)) return false;
  const frame = raw as VoiceServerMessage;
  const laneId = typeof frame.laneId === 'string' ? frame.laneId : '';
  for (const registration of [...registrations]) {
    // A lane-less frame (transport refusal) is the socket's, not a lane's.
    if (laneId === '' || laneId === registration.laneId) registration.listener(frame, raw);
  }
  return true;
}

/** Send one lane frame on the app's single session socket. */
export function sendVoiceFrame(frame: VoiceClientMessage): WebSocketSendResult {
  const client = getWebSocketClient();
  if (!client) return 'failed';
  return client.send(frame);
}
