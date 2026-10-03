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
import { createContinueMarkerStore, goalFingerprint as goalFingerprintFor, type ContinueMarkerStore } from './continue-marker.js';
import { configureInterruptionOverlay, createInterruptionOverlayStore, readGoalFileIdentity, type InterruptionOverlayStore } from './interruption-overlay.js';
import { createInterruptionSweep, type SweepCandidate, type SweepDispatchResult, type SweepReport } from './interruption-sweep.js';
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
  dispatchPrompt(sessionId: string, message: string, idempotencyKey?: string): Promise<SweepDispatchResult>;
  brokerPublish(brokerKey: string, event: { type: string; timestamp: number; data: unknown }): void;
  markerDir: string;
  overlayDir: string;
  logger?: { info(message: string): void; warn(message: string): void };
  observeIntervalMs?: number;
}

export interface GoalInterruptionWiring {
  /** Boot (and drain-timeout) sweep; `announced` joins the receipt/drain sets. */
  runSweep(announced: Map<string, AnnouncedInterruption>, opts?: { boot?: boolean }): Promise<SweepReport>;
  /** Resolves once the sweep has classified and reserved (R5 ordering gate). */
  classificationSettled: Promise<void>;
  /** R5 probe for the watch reconciliation (registry sessionId in, marker out). */
  hasGoalContinueMarker(sessionId: string): Promise<boolean>;
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
  let classifiedOnce = false;
  const bootTimeMs = Date.now();

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
    dispatchContinue: (sessionId, message, idempotencyKey) => deps.dispatchPrompt(sessionId, message, idempotencyKey),
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
        // F6: suppression is keyed to THIS continue only — the CURRENT goal
        // fingerprint and a continue CONFIRMED in this boot. A historical or
        // reserved marker (other goal, count 0, earlier boot) suppresses nothing.
        // C4: only a CONFIRMED marker (verification succeeded) suppresses; a
        // delivered-but-unverified continue never does.
        const path = idToPath.get(sessionId);
        if (!path) return false;
        const raw = await readRawProjection(path);
        if (raw.status === 'idle' || raw.status === 'unknown' || !raw.objective) return false;
        const fingerprint = goalFingerprintFor(raw.objective, raw.startedAt);
        const marker = await markerStore.get(sessionId, fingerprint);
        if (!marker || marker.count < 1 || marker.state !== 'confirmed') {
          if (!marker || marker.fingerprint !== fingerprint) {
            await markerStore.pruneOtherFingerprints(sessionId, fingerprint);
          }
          return false;
        }
        return typeof marker.continuedAt === 'number' && marker.continuedAt >= bootTimeMs;
      } catch {
        return false;
      }
    },

    async runSweep(announced, _opts?: { boot?: boolean }) {
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

    shutdown() {
      // Correction 03: the live observer path is removed; nothing to detach.
    },
  };

  return wiring;
}
