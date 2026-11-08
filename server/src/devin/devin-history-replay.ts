// Replay over stored Devin turns: the turn shape is structurally compatible
// with the shared Antigravity turn reader (prompt/response/status/usage/tools),
// so the same pure renderer serves both runtimes.
export { turnsToReplayEvents } from '@pi-web-ui/session-core/readers';
