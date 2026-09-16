// Live harness for the shutdown escape worker (child S, 2026-09-15).
// Imports the REAL modules from the worktree. Deliberately wedges the main
// thread inside onShutdown, which is exactly the 2026-09-14 18:04:21 failure
// shape: the handler runs, records the signal, and then teardown never returns.
import {
  createSignalReceivedBuffer,
  installStopSignalHandlers,
  resolveEscapeAfterMs,
  spawnShutdownEscapeWorker,
} from '/root/pi-web-ui-wt-stability/server/src/shutdown-signal.js';

const signalReceived = createSignalReceivedBuffer();
spawnShutdownEscapeWorker({
  signalReceived,
  escapeAfterMs: resolveEscapeAfterMs(),
  pollIntervalMs: 500,
});

installStopSignalHandlers({
  signalReceived,
  onShutdown: () => {
    process.stderr.write('[Harness] onShutdown entered; blocking the event loop for 30s\n');
    const until = Date.now() + 30_000;
    // Busy-wait: nothing on this loop can run again until it finishes, so the
    // coordinator's own deadline is unreachable. Only the worker thread can end
    // this process, and only before systemd's TimeoutStopSec.
    while (Date.now() < until) { /* deliberate */ }
    process.stderr.write('[Harness] loop unblocked — the wedge did NOT happen\n');
  },
});

process.stderr.write(`[Harness] ready pid=${process.pid} escape_after_ms=${resolveEscapeAfterMs()}\n`);
setInterval(() => {}, 1_000);
