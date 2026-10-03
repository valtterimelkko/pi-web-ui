/**
 * Wave K (contract 1.59.0) — server wiring for the interruption sweep.
 *
 * Thin composition the Internal API server constructs once at boot:
 *  - the durable stores (markers + overlay) under the server-owned
 *    `<receipts-root>/goal-continue/` directory (R3);
 *  - the boot / drain-timeout sweep over registry candidates (R1 scope),
 *    announced sets joined from the recovered receipts and the prior drain;
 *  - the R6 live path: per-Pi-session extension-UI observers that classify
 *    paused/failed goal states and continue once on provider-abort evidence;
 *  - the R5 probe the watch reconciliation consults before firing a synthetic
 *    `goal_end` (a session with a continue marker is being auto-continued).
 */
import fs from 'node:fs/promises';
import { createContinueMarkerStore, type ContinueMarkerStore } from './continue-marker.js';
import { configureInterruptionOverlay, createInterruptionOverlayStore, readGoalFileIdentity, type InterruptionOverlayStore } from './interruption-overlay.js';
import { createInterruptionSweep, type SweepCandidate, type SweepDispatchResult, type SweepReport } from './interruption-sweep.js';
import { createPiGoalEventBridge } from './goal-events.js';
import { piGoalStatePath, projectPiGoalState, readPiGoalStateFile } from './pi-goal.js';
import type { SessionGoalProjection } from './types.js';

export interface WiringRegistryEntry {
  id: string;
  path: string;
  sdkType: string;
  origin?: 'browser' | 'internal-api' | 'native-discovered';
  parentSource?: string;
}

export interface AnnouncedInterruption {
  source: 'receipt' | 'drain';
  interruptionReason: string;
}

export interface GoalInterruptionWiringDeps {
  listRegistryEntries(): Promise<WiringRegistryEntry[]>;
  isSessionBusy(sessionId: string): boolean;
  dispatchPrompt(sessionId: string, message: string): Promise<SweepDispatchResult>;
  brokerPublish(brokerKey: string, event: { type: string; timestamp: number; data: unknown }): void;
  addExtensionUiObserver(sessionPath: string, observer: (message: unknown) => Promise<void>): void;
  removeExtensionUiObserver(sessionPath: string, observer: (message: unknown) => Promise<void>): void;
  markerDir: string;
  overlayDir: string;
  logger?: { info(message: string): void; warn(message: string): void };
  observeIntervalMs?: number;
}

export interface GoalInterruptionWiring {
  /** Boot (and drain-timeout) sweep; `announced` joins the receipt/drain sets. */
  runSweep(announced: Map<string, AnnouncedInterruption>): Promise<SweepReport>;
  /** Resolves once the sweep has classified and reserved (R5 ordering gate). */
  classificationSettled: Promise<void>;
  /** R5 probe for the watch reconciliation (registry sessionId in, marker out). */
  hasGoalContinueMarker(sessionId: string): Promise<boolean>;
  /** R6 live path: attach extension-UI observers to Pi sessions (idempotent). */
  attachLiveObservers(): Promise<void>;
  /** Periodic observer attachment for sessions that appear after boot. */
  startObserving(): void;
  shutdown(): void;
  sweep: ReturnType<typeof createInterruptionSweep>;
  markerStore: ContinueMarkerStore;
}

async function statMtime(filePath: string): Promise<number | undefined> {
  try {
    const st = await fs.stat(filePath);
    return st.mtimeMs;
  } catch {
    return undefined;
  }
}

export function wireGoalInterruptions(deps: GoalInterruptionWiringDeps): GoalInterruptionWiring {
  const markerStore = createContinueMarkerStore(deps.markerDir);
  const overlayStore: InterruptionOverlayStore = createInterruptionOverlayStore(deps.overlayDir);
  configureInterruptionOverlay(overlayStore);
  const logger = deps.logger;
  const idToPath = new Map<string, string>();
  const observers = new Map<string, (message: unknown) => Promise<void>>();
  let observeTimer: ReturnType<typeof setInterval> | undefined;
  let classifiedOnce = false;

  let classificationSettledResolve: () => void = () => undefined;
  const classificationSettled = new Promise<void>((resolve) => { classificationSettledResolve = resolve; });

  const readRawProjection = async (sessionPath: string): Promise<SessionGoalProjection> =>
    projectPiGoalState(await readPiGoalStateFile(sessionPath));

  const sweep = createInterruptionSweep({
    isSessionBusy: (sessionId) => deps.isSessionBusy(sessionId),
    readRawProjection,
    readTranscriptLines: async (sessionPath) => {
      try {
        return (await fs.readFile(sessionPath, 'utf8')).split('\n');
      } catch {
        return [];
      }
    },
    dispatchContinue: (sessionId, message) => deps.dispatchPrompt(sessionId, message),
    publishGoalState: (sessionId, projection) => {
      // Pi broker key = sessionPath; the registry id is the fallback.
      deps.brokerPublish(idToPath.get(sessionId) ?? sessionId, { type: 'goal_state', timestamp: Date.now(), data: projection });
    },
    markerStore,
    overlayStore,
    readGoalFileIdentity: (sessionPath) => readGoalFileIdentity(piGoalStatePath(sessionPath)),
  });

  const wiring: GoalInterruptionWiring = {
    classificationSettled,
    sweep,
    markerStore,

    hasGoalContinueMarker: async (sessionId) => {
      await classificationSettled;
      try {
        return await markerStore.hasMarker(sessionId);
      } catch {
        return false;
      }
    },

    async runSweep(announced) {
      const entries = await deps.listRegistryEntries();
      const candidates: SweepCandidate[] = [];
      for (const entry of entries) {
        const announcedFor = announced.get(entry.id) ?? announced.get(entry.path);
        candidates.push({
          sessionId: entry.id,
          sessionPath: entry.path,
          runtime: entry.sdkType,
          origin: entry.origin,
          parentSource: entry.parentSource,
          lastActivityMs: await statMtime(entry.path),
          ...(announcedFor ? { announced: announcedFor } : {}),
        });
        idToPath.set(entry.id, entry.path);
      }
      const report = await sweep.run(candidates, Date.now());
      if (!classifiedOnce) {
        classifiedOnce = true;
        classificationSettledResolve();
      }
      logger?.info(
        `[InternalAPI] wave K sweep: ${candidates.length} registry candidate(s), ` +
        `${report.continued.length} continued, ${report.interruptedVisible.length} interrupted-visible, ${report.skipped.length} skipped`,
      );
      for (const [sessionId, reason] of Object.entries(report.skipReasons)) {
        logger?.info(`[InternalAPI] wave K sweep: skipped ${sessionId}: ${reason}`);
      }
      return report;
    },

    async attachLiveObservers() {
      const entries = await deps.listRegistryEntries();
      for (const entry of entries) {
        if (entry.sdkType !== 'pi') continue;
        if (observers.has(entry.path)) continue;
        const bridge = createPiGoalEventBridge({
          // Disk truth for classification (the overlay must not re-trigger).
          readProjection: () => readRawProjection(entry.path),
          publish: () => undefined, // sessions.ts's own bridge publishes; this one only classifies
          onPausedOrFailed: (projection) => {
            idToPath.set(entry.id, entry.path);
            return sweep.handleLiveStop(entry.id, entry.path, projection);
          },
        });
        observers.set(entry.path, bridge);
        try {
          deps.addExtensionUiObserver(entry.path, bridge);
        } catch {
          observers.delete(entry.path);
        }
      }
    },

    startObserving() {
      if (observeTimer) return;
      void wiring.attachLiveObservers().catch(() => undefined);
      observeTimer = setInterval(() => { void wiring.attachLiveObservers().catch(() => undefined); }, deps.observeIntervalMs ?? 30_000);
      observeTimer.unref?.();
    },

    shutdown() {
      if (observeTimer) clearInterval(observeTimer);
      observeTimer = undefined;
      for (const [path, observer] of observers) {
        try {
          deps.removeExtensionUiObserver(path, observer);
        } catch { /* best effort */ }
      }
      observers.clear();
    },
  };

  return wiring;
}
