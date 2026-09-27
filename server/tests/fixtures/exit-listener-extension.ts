/**
 * B1 host-side exit-listener guard fixture: a deliberately badly-behaved
 * extension that registers a process-level exit listener at module scope, the
 * pattern the subagent extension used before the B1 fix (A1 soak §3,
 * retainer 2). Loaded through the real SDK extension loader by
 * `tests/integration/pi-extension-exit-listener.test.ts`.
 */
export default function exitListenerExtension(_pi: unknown): void {
  process.once('exit', () => undefined);
}
