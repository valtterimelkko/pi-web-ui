/**
 * The single nominal seam between `server/src/voice/` and the frozen wire
 * contract (Track E, `docs/plans/VOICE-LIVE-WIRE-CONTRACT.md`).
 *
 * Everything the voice service needs from the contract — the message types,
 * the service boundary (`VoiceBridgeService`), the emitted-event union
 * (`VoiceBridgeEmittedEvent`), the lifecycle callbacks (`VoiceBridgeCallbacks`)
 * and the runtime guards (`checkVoiceEnvelope`, `isVoiceAudioPayloadWithinLimit`,
 * `hasNoToolArguments`) — is re-exported here and imported from here, so the
 * service has exactly one place that knows the contract's module path.
 *
 * WHY A SEAM AND NOT A COPY: the brief forbids a second validator. The guards
 * used at run time are the contract's own; this module re-exports them rather
 * than restating them. If the contract ever gains a package re-export, only this
 * file changes.
 */

export * from '@pi-web-ui/shared/dist/types/voice-messages.js';
