/**
 * voiceLive — the client-side native-voice surface.
 *
 * Modules (all framework-free except the `components/DriveMode/*` UI):
 *   - `messages`         typed wire builders + fail-closed inbound interpretation
 *   - `captureWorkletSource` / `captureDsp` / `captureSession`
 *                        16 kHz AudioWorklet capture, bounded buffers, pre-roll
 *   - `playbackSession` 24 kHz one-ahead playback with ducked, bounded audio
 *   - `speechFloor`     the read-only view of the shared speech arbiter
 *   - `controller`      one lane's state machine over the typed wire layer
 *   - `surface`         capture + playback + chime + controller orchestration
 *   - `readBack`        speaking one proposal's composed bytes aloud (H3)
 *   - `../soundEffects` the host-owned delivery chime
 *
 * `frameBus` (the app-socket routing for mounted lanes) is deliberately NOT
 * re-exported here: it depends on the app's WebSocket singleton, and this barrel
 * is the framework-free voice surface.
 */

export * from './audioConstants';
export * from './messages';
export * from './captureDsp';
export * from './captureWorkletSource';
export * from './captureSession';
export * from './playbackSession';
export * from './speechFloor';
export * from './readBack';
export * from './controller';
export * from './surface';
