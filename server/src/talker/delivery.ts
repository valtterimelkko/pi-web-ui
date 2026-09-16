/**
 * Runtime delivery adapters (plan §3, §10.9; brief: deliverability differs and
 * must degrade honestly).
 *
 *   Pi          — mid-run steer via the EXISTING path; the extension
 *                 input-event bridge is H2 (a separate child) and is NOT wired
 *                 here. The disclosure field says so; nothing is hidden.
 *   Claude      — native steer/follow-up, SDK backend ONLY. A non-SDK (or
 *                 unprovable) backend refuses honestly; it never silently
 *                 degrades.
 *   Antigravity — follow-up only, no mid-run join. Queuing behind the current
 *                 turn is a first-class outcome, not an error.
 *
 * Adapters receive their runtime functions injected, so tests exercise the
 * exact contracts against fakes; createDefaultDeliveries() lazily wires the
 * real services for the Phase 3 integration.
 */

import type { DeliveryOutcome, WorkerDelivery } from './types.js';

// ── Pi ─────────────────────────────────────────────────────────────────────

export interface PiDeliveryDeps {
  isBusy(sessionPath: string): boolean;
  steer(sessionPath: string, text: string): Promise<void>;
  prompt(sessionPath: string, text: string): Promise<void>;
  /**
   * Make the worker reachable before the relay (operator incident
   * 2026-09-16). Pi keys sessions by PATH and loads them LAZILY, so an idle
   * worker — and every worker, right after a server restart — is not in
   * memory: the relay could not resolve the wire id to a path, the prompt
   * threw `Session <ref> does not exist`, and the operator's instruction was
   * refused and lost. Resolving and loading are therefore the delivery's
   * business, not the operator's luck.
   *
   * Resolves the wire reference to the session path to deliver to and reports
   * whether THIS call loaded it (so the load can be handed back).
   */
  ensureReady?(ref: string): Promise<{ path: string; loadedHere: boolean }>;
  /** Hand back a load this delivery made. Absent = nothing to release. */
  release?(sessionPath: string): void;
}

export function createPiDelivery(deps: PiDeliveryDeps): WorkerDelivery {
  return {
    describe: () => 'pi (existing path; H2 input-event bridge not wired)',
    async deliver({ workerSessionId, text }): Promise<DeliveryOutcome> {
      try {
        // The readiness step runs FIRST, so the busy check sees the session it
        // is actually about to talk to.
        const ready = deps.ensureReady
          ? await deps.ensureReady(workerSessionId)
          : { path: workerSessionId, loadedHere: false };
        try {
          if (deps.isBusy(ready.path)) {
            await deps.steer(ready.path, text);
            return {
              outcome: 'delivered',
              mechanism: 'steer',
              disclosure: 'delivered via the existing steer path; the extension input-event bridge (H2) is not wired yet',
            };
          }
          await deps.prompt(ready.path, text);
          return { outcome: 'delivered', mechanism: 'prompt', disclosure: 'delivered as the worker was idle' };
        } finally {
          // Only a load THIS delivery made is handed back; a session that was
          // already in memory is left exactly as it was found.
          if (ready.loadedHere) deps.release?.(ready.path);
        }
      } catch (error) {
        return { outcome: 'refused', reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

// ── Claude ─────────────────────────────────────────────────────────────────

export interface ClaudeDeliveryDeps {
  getBackendMode(sessionId: string): 'sdk' | 'other' | 'unknown' | Promise<'sdk' | 'other' | 'unknown'>;
  isRunning(sessionId: string): boolean;
  steer(sessionId: string, text: string): boolean;
  followUp(sessionId: string, text: string): boolean;
  sendPrompt(sessionId: string, text: string): Promise<void>;
}

export function createClaudeDelivery(deps: ClaudeDeliveryDeps): WorkerDelivery {
  return {
    describe: () => 'claude (SDK backend only)',
    async deliver({ workerSessionId, text }): Promise<DeliveryOutcome> {
      const backend = await deps.getBackendMode(workerSessionId);
      if (backend !== 'sdk') {
        return {
          outcome: 'refused',
          reason:
            `Claude talker relay requires the SDK backend; this session's backend is '${backend}'. ` +
            'Refusing rather than degrading silently.',
        };
      }
      try {
        if (deps.isRunning(workerSessionId)) {
          if (deps.steer(workerSessionId, text)) {
            return { outcome: 'delivered', mechanism: 'steer' };
          }
          if (deps.followUp(workerSessionId, text)) {
            return { outcome: 'queued', mechanism: 'follow_up', disclosure: 'will run after the current turn' };
          }
          return { outcome: 'refused', reason: 'claude session is running but accepted neither steer nor follow-up' };
        }
        await deps.sendPrompt(workerSessionId, text);
        return { outcome: 'delivered', mechanism: 'prompt', disclosure: 'delivered as the worker was idle' };
      } catch (error) {
        return { outcome: 'refused', reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

// ── Antigravity ────────────────────────────────────────────────────────────

export interface AntigravityDeliveryDeps {
  followUp(sessionId: string, text: string): Promise<boolean>;
}

export function createAntigravityDelivery(deps: AntigravityDeliveryDeps): WorkerDelivery {
  return {
    describe: () => 'antigravity (follow-up only; no mid-run join)',
    async deliver({ workerSessionId, text }): Promise<DeliveryOutcome> {
      try {
        const queued = await deps.followUp(workerSessionId, text);
        if (queued) {
          return {
            outcome: 'queued',
            mechanism: 'follow_up',
            disclosure: 'will arrive after this turn (antigravity has no mid-run join)',
          };
        }
        return {
          outcome: 'refused',
          reason:
            'antigravity supports follow-up only and no turn is running; the talker does not start worker turns',
        };
      } catch (error) {
        return { outcome: 'refused', reason: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

// ── Null (harness runner / tests) ──────────────────────────────────────────

export interface NullDeliveryOptions {
  /** When set, every delivery reports this queued outcome (after recording the text). */
  queuedOutcome?: DeliveryOutcome;
  /** When set, every delivery reports this outcome (after recording the text). */
  forcedOutcome?: DeliveryOutcome;
}

export function createNullDelivery(options: NullDeliveryOptions = {}): WorkerDelivery & { deliveredTexts(): string[] } {
  const handed: string[] = [];
  return {
    describe: () => 'null (records verbatim text; no runtime)',
    deliveredTexts: () => [...handed],
    async deliver({ text }): Promise<DeliveryOutcome> {
      handed.push(text);
      if (options.forcedOutcome) return options.forcedOutcome;
      if (options.queuedOutcome) return options.queuedOutcome;
      return { outcome: 'delivered', mechanism: 'prompt' };
    },
  };
}

// ── Default wiring (lazy; used by the Phase 3 integration, not by tests) ───

export interface DefaultDeliveries {
  pi: WorkerDelivery;
  claude: WorkerDelivery;
  antigravity: WorkerDelivery;
}

/**
 * Wire the real services. Kept lazy (dynamic imports) so importing this module
 * never drags the runtime services into a test or the harness runner.
 *
 * The Pi MultiSessionManager is NOT a module singleton — it is owned by the
 * WebSocketConnectionManager and must be supplied by the integrator (Phase 3
 * wiring). Without it, the pi delivery refuses honestly rather than guessing.
 */
export async function createDefaultDeliveries(
  supplied?: {
    multiSessionManager?: import('../pi/multi-session-manager.js').MultiSessionManager;
    /**
     * Resolve a wire session id to its on-disk session (the server's session
     * registry — the SAME index the Internal API uses). The manager's own
     * resolver only knows sessions that are already loaded, which is exactly
     * what a relay cannot rely on (operator incident 2026-09-16).
     */
    resolveWorkerSession?: (sessionId: string) => Promise<{ path: string; cwd?: string } | undefined>;
  }
): Promise<DefaultDeliveries> {
  const [{ getClaudeService }, { getAntigravityService }] = await Promise.all([
    import('../claude/claude-service.js'),
    import('../antigravity/antigravity-service.js'),
  ]);

  const claude = getClaudeService();
  const agy = getAntigravityService();

  const manager = supplied?.multiSessionManager;
  /** One synthetic subscriber for relay-driven loads, so a load made on the
   *  operator's behalf is attributable and can be handed back. */
  const RELAY_CLIENT_ID = 'talker-relay';
  const pi: WorkerDelivery = manager
    ? createPiDelivery({
        isBusy: (path) => {
          const info = manager.getSessionStatus(path);
          return info?.status === 'busy' || info?.status === 'streaming';
        },
        steer: (path, text) => manager.steer(path, text),
        prompt: (path, text) => manager.prompt(path, text),
        ensureReady: async (ref) => {
          // Already loaded? By path, or by an id the manager can resolve itself.
          const loaded = manager.resolveSessionRef?.(ref) ?? (manager.hasSession(ref) ? ref : undefined);
          if (loaded) return { path: loaded, loadedHere: false };
          const entry = await supplied?.resolveWorkerSession?.(ref);
          const path = entry?.path ?? ref;
          // Rehydrate from disk (the same lazy-load path every client uses).
          // An unresolvable reference falls through to the path-or-id it was
          // given, so the failure stays loud instead of guessing.
          await manager.subscribeClient(RELAY_CLIENT_ID, path, entry?.cwd);
          return { path, loadedHere: true };
        },
        release: (path) => manager.unsubscribeClient(RELAY_CLIENT_ID, path),
      })
    : {
        describe: () => 'pi (unwired)',
        deliver: async () => ({
          outcome: 'refused',
          reason: 'pi delivery is not wired into this process: no MultiSessionManager instance was supplied',
        }),
      };

  const claudeDelivery = createClaudeDelivery({
    getBackendMode: async (id) => {
      const entry = await claude.getSession(id);
      const backend = entry?.claudeProfileBackend;
      if (backend === 'sdk-subscription') return 'sdk';
      if (backend) return 'other';
      return 'unknown';
    },
    isRunning: (id) => claude.isRunning(id),
    steer: (id, text) => claude.steer(id, text),
    followUp: (id, text) => claude.followUp(id, text),
    sendPrompt: async (id, text) => {
      await claude.sendPrompt(id, text, () => {}, () => {});
    },
  });

  const antigravity = createAntigravityDelivery({
    followUp: (id, text) =>
      agy.followUp(id, text, () => {}, () => {}),
  });

  return { pi, claude: claudeDelivery, antigravity };
}
