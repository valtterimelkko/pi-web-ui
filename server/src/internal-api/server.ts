/**
 * Internal API Server
 *
 * HTTP server bound to a Unix domain socket (or 127.0.0.1) that exposes
 * the Pi Web UI backend for programmatic consumption by other local
 * applications.
 *
 * Key properties:
 * - Reuses existing runtime services (no backend duplication)
 * - Sessions created via this API appear in the web UI sidebar
 * - Model lists are always live (no caching)
 * - Three verbosity levels: answers, tasks, full
 */

import { createServer, request as httpRequest, type Server, type IncomingMessage, type ServerResponse } from 'http';
import type { Socket } from 'net';
import { randomBytes } from 'crypto';
import { writeFile, readFile, mkdir } from 'fs/promises';
import path from 'path';
import os from 'os';
import { createAuthMiddleware } from './middleware/auth.js';
import { ErrorCode } from './error-codes.js';
import { RequestBodyTooLargeError } from './request-body.js';
import { closeServerWithGrace } from './server-shutdown.js';
import { createSessionRoutes } from './routes/sessions.js';
import { createModelsRoutes, type ModelsRoutesDeps } from './routes/models.js';
import { createHealthRoutes, type HealthRoutesDeps } from './routes/health.js';
import { createCapabilitiesRoutes, type CapabilitiesRoutesDeps } from './routes/capabilities.js';
import { createDiagnosticsRoutes } from './routes/diagnostics.js';
import { createEventTypesRoutes } from './routes/event-types.js';
import { createNotificationsRoutes } from './routes/notifications.js';
import { RunReceiptManager } from './run-receipts/run-receipt-manager.js';
import { RunReceiptStore } from './run-receipts/run-receipt-store.js';
import { buildStallNotification } from './run-receipts/stall-notification.js';
import { readPiRuntimeQuiescence } from './runtime-quiescence.js';
import { NotificationManager } from '../notifications/notification-manager.js';
import { NotificationStore } from '../notifications/notification-store.js';
import { NotificationIngressSpool } from '../notifications/notification-ingress-spool.js';
import { ChannelRouter } from '../notifications/channels/notification-channel.js';
import { pickNotificationChannel } from '../notifications/channel-factory.js';
import { readPreferences, deriveLegacyArrays } from '../routes/preferences.js';
import { createRequestLoggingMiddleware } from './request-logging.js';
import { pushDiagnosticsRecord } from './diagnostics-buffer.js';
import { setLogTap } from '../logging/logger.js';
import { wireGoalInterruptions, type GoalInterruptionWiring, type AnnouncedInterruption } from './goal/interruption-wiring.js';
import { setGoalContinueProbe } from './watch/watch-manager.js';
import type { ClaudeService } from '../claude/claude-service.js';
import type { OpenCodeService } from '../opencode/opencode-service.js';
import type { AntigravityService } from '../antigravity/antigravity-service.js';
import type { MultiSessionManager } from '../pi/multi-session-manager.js';
import type { SessionRegistryManager } from '../session-registry.js';
import type { PiService } from '../pi/pi-service.js';
import { config } from '../config.js';
import { createLogger } from '../logging/logger.js';
import { bindOwnerOnlyUnixSocket, UnixSocketOwner } from './unix-socket-owner.js';
import { getWorkerPool } from '../routes/sessions.js';
import {
  AdmissionController,
  admissionStartupStatus,
  connectAdmissionToLagReadings,
  createValidationPressureOverride,
  type AdmissionControllerOptions,
} from './admission-controller.js';
import { getHealthTelemetry } from '../observability/health-telemetry.js';
import { createValidationLeakOverride } from '../observability/admission-leak-override.js';
import { CommandCodeService } from '../command-code/command-code-service.js';
import { DrainController, composeInterruptedBusySessions, consumeDrainRecord, createBusySessionSource, type DrainBusySession } from './drain-controller.js';
import { createDrainRoutes, isExecutionEntryRequest } from './routes/drain.js';

const logger = createLogger('InternalAPI');


// ─── Configuration ───────────────────────────────────────────────────────────

export interface InternalApiConfig {
  /** Unix socket path (primary) */
  socketPath?: string;
  /** Fallback: bind to 127.0.0.1 on this port */
  port?: number;
  /** Pre-set API key (auto-generated if not provided) */
  apiKey?: string;
  /** Path to store the auto-generated API token */
  tokenPath?: string;
  /** Directory for durable long-horizon watch ledgers */
  watchDir?: string;
  /** Directory for the durable API-pin expiry ledger */
  pinDir?: string;
  /** Directory for persisted Internal-API run receipts. */
  runReceiptDir?: string;
  /**
   * B4: durable drain-verdict record read once at boot. Defaults to
   * `internal-api-drain.json` beside the run-receipt directory, so a disposable
   * server with its own receipt dir never reads production's record.
   */
  drainRecordPath?: string;
  /** Idempotency replay window for accepted runs. */
  runReceiptIdempotencyTtlMs?: number;
  /** Default API-pin lifetime (ms) */
  pinDefaultTtlMs?: number;
  /** Hard maximum API-pin lifetime (ms) */
  pinMaxTtlMs?: number;
  /** How often the pin-expiry sweep runs (ms) */
  pinExpiryIntervalMs?: number;
  /** Enable the API (default: true if config present) */
  enabled?: boolean;
  /** Maximum graceful shutdown wait before persistent clients are closed. */
  shutdownGraceMs?: number;
  /** Callback invoked when a session is created via the API */
  onSessionCreated?: (sessionId: string, sessionPath: string, runtime: string) => void;
  /** Optional execution-admission tuning; defaults are CPU/memory-derived. */
  admissionMaxActiveTurns?: number;
  admissionInteractiveReserve?: number;
  admissionMinimumHeadroomBytes?: number;
  admissionHostMinimumHeadroomBytes?: number;
  admissionReservedBytesPerTurn?: number;
  admissionReservedPidsPerTurn?: number;
  /** B2 heap/lag admission knobs (see AdmissionControllerOptions). */
  admissionHeapPressureFraction?: number;
  admissionHeapRecoveryFraction?: number;
  admissionReservedHeapBytesPerTurn?: number;
  admissionLagThresholdMs?: number;
  admissionLagRecoveryMs?: number;
  admissionLagSustainedReadings?: number;
  /** Command Code turn concurrency; mirrored as the commandcode admission limit. */
  commandCodeConcurrency?: number;
}

const DEFAULT_SOCKET_PATH = path.join(os.homedir(), '.pi-web-ui', 'internal-api.sock');
const DEFAULT_TOKEN_PATH = path.join(os.homedir(), '.pi-web-ui', 'internal-api-token');
const DEFAULT_WATCH_DIR = path.join(os.homedir(), '.pi-web-ui', 'watches');
const DEFAULT_PIN_DIR = path.join(os.homedir(), '.pi-web-ui', 'pins');
const DEFAULT_RUN_RECEIPT_DIR = path.join(os.homedir(), '.pi-web-ui', 'run-receipts');
const DEFAULT_NOTIFICATIONS_DIR = path.join(os.homedir(), '.pi-web-ui', 'notifications');

/**
 * Build the shared admission options from the server boundary. Command Code's
 * own process semaphore and Internal API admission must expose the same limit;
 * otherwise capacity can claim a slot that the runtime will immediately refuse.
 */
export function resolveInternalApiAdmissionOptions(input: Pick<InternalApiConfig,
  'admissionMaxActiveTurns'
  | 'admissionInteractiveReserve'
  | 'admissionMinimumHeadroomBytes'
  | 'admissionHostMinimumHeadroomBytes'
  | 'admissionReservedBytesPerTurn'
  | 'admissionReservedPidsPerTurn'
  | 'admissionHeapPressureFraction'
  | 'admissionHeapRecoveryFraction'
  | 'admissionReservedHeapBytesPerTurn'
  | 'admissionLagThresholdMs'
  | 'admissionLagRecoveryMs'
  | 'admissionLagSustainedReadings'
  | 'commandCodeConcurrency'
>): AdmissionControllerOptions {
  return {
    maxActiveTurns: input.admissionMaxActiveTurns,
    interactiveReserve: input.admissionInteractiveReserve,
    minimumHeadroomBytes: input.admissionMinimumHeadroomBytes,
    hostMinimumHeadroomBytes: input.admissionHostMinimumHeadroomBytes,
    reservedBytesPerTurn: input.admissionReservedBytesPerTurn,
    reservedPidsPerTurn: input.admissionReservedPidsPerTurn,
    heapPressureFraction: input.admissionHeapPressureFraction,
    heapRecoveryFraction: input.admissionHeapRecoveryFraction,
    reservedHeapBytesPerTurn: input.admissionReservedHeapBytesPerTurn,
    lagThresholdMs: input.admissionLagThresholdMs,
    lagRecoveryMs: input.admissionLagRecoveryMs,
    lagSustainedReadings: input.admissionLagSustainedReadings,
    runtimeMaxActiveTurns: input.commandCodeConcurrency === undefined
      ? undefined
      : { commandcode: input.commandCodeConcurrency },
  };
}

// ─── Server ──────────────────────────────────────────────────────────────────

export class InternalApiServer {
  private server: Server | null = null;
  private config: InternalApiConfig;
  private apiKey: string;
  private startTime: number = Date.now();

  // Service dependencies
  private claudeService: ClaudeService;
  private opencodeService: OpenCodeService;
  private antigravityService: AntigravityService;
  private multiSessionManager: MultiSessionManager;
  private sessionRegistry: SessionRegistryManager;
  private piService: PiService;
  private commandCodeService: CommandCodeService;
  private runReceiptManager: RunReceiptManager | null = null;
  private drainController: DrainController | null = null;
  private notificationManager: NotificationManager | null = null;
  private socketOwner: UnixSocketOwner | null = null;
  private sessionRoutesShutdown: (() => Promise<void>) | null = null;
  /** B2: unsubscribes admission from A2 lag readings on stop. */
  private admissionLagUnsubscribe: (() => void) | null = null;
  /** The per-session event broker owned by the session routes; null before start. */
  private eventBroker: import('../internal-api/event-broker.js').InternalApiEventBroker | null = null;
  private onBrowserMessage?: (message: Record<string, unknown>) => void;
  private goalControlHandler: ((sessionId: string, body: Record<string, unknown>) => Promise<{ statusCode: number; body: Record<string, unknown> }>) | null = null;
  /** Wave K (contract 1.59.0): interruption sweep wiring; null before start. */
  private goalInterruptions: GoalInterruptionWiring | null = null;
  private goalInterruptionStop: (() => void) | null = null;
  /** Unix socket path this server is listening on (loopback dispatch). */
  private listeningSocketPath: string | null = null;
  private stopPromise: Promise<void> | null = null;
  private readonly connections = new Set<Socket>();

  // Unique ID for this internal API's Pi SDK sessions
  private internalClientId: string;

  constructor(deps: {
    config: InternalApiConfig;
    claudeService: ClaudeService;
    opencodeService: OpenCodeService;
    antigravityService: AntigravityService;
    multiSessionManager: MultiSessionManager;
    sessionRegistry: SessionRegistryManager;
    piService: PiService;
    commandCodeService?: CommandCodeService;
    /** Contract 1.27.0: browser bridge for goal events (WebSocket fan-out). */
    onBrowserMessage?: (message: Record<string, unknown>) => void;
  }) {
    this.onBrowserMessage = deps.onBrowserMessage;
    this.config = deps.config;
    this.apiKey = deps.config.apiKey || '';
    this.claudeService = deps.claudeService;
    this.opencodeService = deps.opencodeService;
    this.antigravityService = deps.antigravityService;
    this.multiSessionManager = deps.multiSessionManager;
    this.sessionRegistry = deps.sessionRegistry;
    this.piService = deps.piService;
    this.commandCodeService = deps.commandCodeService ?? new CommandCodeService({
      config: {
        enabled: config.commandCodeEnabled,
        executablePath: config.commandCodeExecutablePath,
        stateDir: config.commandCodeStateDir,
        nativeHomeDir: config.commandCodeNativeHomeDir,
        allowedCwdRoots: config.commandCodeAllowedCwdRoots,
        maxTurns: config.commandCodeMaxTurns,
        maxWallTimeMs: config.commandCodeMaxWallTimeMs,
        concurrency: config.commandCodeConcurrency,
      },
    });
    this.internalClientId = `internal-api-${randomBytes(4).toString('hex')}`;
  }

  /**
   * Start the internal API server.
   * Generates an API key if one wasn't provided.
   */
  async start(): Promise<void> {
    const socketPath = this.config.socketPath || DEFAULT_SOCKET_PATH;
    const tokenPath = this.config.tokenPath || DEFAULT_TOKEN_PATH;
    const socketOwner = new UnixSocketOwner(socketPath);
    await socketOwner.prepareForBind();

    try {
    // Initialise Command Code before readiness. This performs only the public
    // executable/model discovery probe and never reads native auth state.
    await this.commandCodeService.init();

    // Generate or load API key
    if (!this.apiKey) {
      this.apiKey = await this.resolveApiKey(tokenPath);
    }

    // Load durable run receipts before binding the socket. A restart must
    // recover in-flight records before a caller can retry an idempotent key.
    const runReceiptDir = this.config.runReceiptDir || DEFAULT_RUN_RECEIPT_DIR;
    // B4: the previous process's drain verdict (if any) tells boot recovery
    // which interrupted runs a drain-then-restart announced as cut off.
    const drainRecordPath = this.config.drainRecordPath || path.join(path.dirname(runReceiptDir), 'internal-api-drain.json');
    const priorDrain = consumeDrainRecord(drainRecordPath);
    const drainCutOff = new Set(priorDrain?.state === 'timed_out' ? priorDrain.cutOffRunIds : []);
    const runReceiptManager = new RunReceiptManager({
      store: new RunReceiptStore(runReceiptDir, {
        classifyRecovery: (record) => (drainCutOff.has(record.runId) ? 'drain_timeout' : 'server_restart'),
      }),
      idempotencyTtlMs: this.config.runReceiptIdempotencyTtlMs ?? config.internalApiRunIdempotencyTtlMs,
      // C2 (contract 1.57.0): dispatched runs with no runtime activity inside
      // the start window terminalise NEVER_STARTED (distinct from the idle
      // watchdog's TURN_STALLED); 0 disables start detection.
      runStartWindowMs: config.internalApiRunStartWindowMs,
      onStalled: (receipt) => {
        // Two genuinely different events share this hook (2026-09-15):
        //
        //  - a turn that really was executing and stopped responding, or hit the
        //    ceiling -> runtime cessation is unconfirmed and the admission slot is
        //    held (drained, then quarantined as capacity debt);
        //  - a run that never produced a single unit of work -- typically a wake
        //    accepted onto a session that never ran it. Nothing is in flight, the
        //    drain releases the slot on its first poll, and the operator needs to
        //    know the wake was LOST rather than being told a run was quarantined.
        //
        // The wording for both lives in stall-notification.ts so the claims it
        // makes about capacity are reviewable. (It previously claimed the slot
        // "is already released by terminalisation" here while the message sent to
        // the operator said the opposite, and neither matched the drain/quarantine
        // behaviour in run-receipt-manager.terminalize().)
        const notice = buildStallNotification(receipt);
        void this.notificationManager?.emitExplicit({
          title: notice.title,
          body: notice.body,
        }).catch(() => { /* best-effort; a failed ping must not affect terminalisation */ });
      },
      // §11 fence: on cancel/stall the admission slot is held (not reusable) until
      // the runtime confirms it has stopped, or a 30s drain timeout (quarantine).
      isRuntimeQuiescent: async (sessionId) => {
        try {
          const commandCodeEntry = await this.commandCodeService.getSession(sessionId);
          if (commandCodeEntry) return !this.commandCodeService.isRunning(sessionId);
          const entry = await this.sessionRegistry.get(sessionId);
          if (!entry) return true; // session gone -> quiescent
          if (entry.sdkType === 'commandcode') return !this.commandCodeService.isRunning(sessionId);
          if (entry.sdkType === 'claude') return !this.claudeService.isRunning(sessionId);
          if (entry.sdkType === 'opencode') return !this.opencodeService.isRunning(sessionId);
          if (entry.sdkType === 'antigravity') return !this.antigravityService.isRunning(sessionId);
          return readPiRuntimeQuiescence(() => this.multiSessionManager.getSessionStatus(entry.path));
        } catch {
          return false; // status lookup failure is not positive cessation evidence
        }
      },
      // C2 (contract 1.57.0): the operator learns a dispatched run never
      // started without polling. The parent-watch firing sink is registered
      // separately by the route layer (it owns the watch manager).
      onRunNeverStarted: (receipt) => {
        const notice = buildStallNotification(receipt);
        void this.notificationManager?.emitExplicit({
          title: notice.title,
          body: notice.body,
        }).catch(() => { /* best-effort; a failed ping must not affect terminalisation */ });
      },
    });
    await runReceiptManager.init();
    this.runReceiptManager = runReceiptManager;
    // B4.1 + correction 01: receipt-less busy sessions the previous process's
    // drain announced as cut off, composed through the shared helper so work
    // that finished normally inside the hold window is NOT announced as an
    // interruption (its receipts are terminal at boot), and sessions whose
    // runs were receipt-backed are left to the receipt path.
    const recoveredReceiptSessionIds = new Set(runReceiptManager.getRestartRecoveredRuns().map((run) => run.sessionId));
    const interruptedBusySessions = composeInterruptedBusySessions(
      priorDrain,
      recoveredReceiptSessionIds,
      (runId) => runReceiptManager.get(runId)?.status,
    );
    {
      const recovered = runReceiptManager.getRestartRecoveredRuns();
      const byDrain = recovered.filter((run) => run.interruptionReason === 'drain_timeout').length;
      const busyNote = interruptedBusySessions.length > 0
        ? `; ${interruptedBusySessions.length} receipt-less busy session(s) reconciled from the drain record`
        : '';
      if (priorDrain || recovered.length > 0 || interruptedBusySessions.length > 0) {
        logger.info(
          `[InternalAPI] restart reconciliation: ${recovered.length} run(s) interrupted by restart ` +
          `(${byDrain} announced by drain, ${recovered.length - byDrain} unplanned)${busyNote}; ` +
          `previous drain: ${priorDrain ? `${priorDrain.state} reason=${JSON.stringify(priorDrain.reason)} cutOff=${priorDrain.cutOffRunIds.length} cutOffSessions=${priorDrain.cutOffSessions.length}` : 'none'}`,
        );
      }
    }

    // One process-local admission authority sees all Internal API conductors.
    // It preserves explicit headroom for interactive Web UI turns.
    const admissionOptions = resolveInternalApiAdmissionOptions(this.config);
    // Resolve + apply conservative production defaults for any unset safety knob
    // (a missing/mis-loaded .env.production cannot make the server run
    // non-conservative CPU-derived admission), and surface the result at startup.
    const admissionStatus = admissionStartupStatus({
      ...admissionOptions,
      isProduction: process.env.NODE_ENV === 'production',
    });
    const r = admissionStatus.resolved;
    logger.info(
      `[InternalAPI] admission: maxActiveTurns=${r.maxActiveTurns} apiTurnLimit=${r.apiTurnLimit} ` +
      `interactiveReserve=${r.interactiveReserve} controlReserve=${r.controlReserve} ` +
      `executionCapacity=${r.executionCapacity} minHeadroom=${r.minimumHeadroomBytes} ` +
      `reserved/turn=${r.reservedBytesPerTurn} reservedPids/turn=${r.reservedPidsPerTurn} ` +
      `hostHeadroom=${r.hostMinimumHeadroomBytes} ` +
      `heap=${r.heapPressureFraction}/${r.heapRecoveryFraction} reservedHeap/turn=${r.reservedHeapBytesPerTurn} ` +
      `lag=${r.lagThresholdMs}ms/${r.lagRecoveryMs}ms×${r.lagSustainedReadings}` +
      (admissionStatus.prodFallbackKnobs.length ? ` [prod-fallback: ${admissionStatus.prodFallbackKnobs.join(',')}]` : '') +
      (admissionStatus.usingDefaults ? ' [CPU-defaults]' : ''),
    );
    if (admissionStatus.warning) logger.warn(`[InternalAPI] ${admissionStatus.warning}`);
    for (const warning of r.warnings) logger.warn(`[InternalAPI] ${warning}`);
    // B2: validation-only pressure injection (inert unless PI_WEB_UI_VALIDATION_MODE=true).
    // Correction 01: guarded by the validation child's identity record, not NODE_ENV.
    const pressureOverride = createValidationPressureOverride(process.env, {
      onRefused: (reason) => logger.warn(`[InternalAPI] admission: ${reason}`),
    });
    if (pressureOverride) logger.warn('[InternalAPI] admission: VALIDATION pressure override file active (INTERNAL_API_ADMISSION_TEST_PRESSURE_FILE) — disposable validation server only');
    const admissionController = new AdmissionController({
      ...admissionStatus.options,
      pressureOverride,
      configExplicitness: {
        explicitKnobs: admissionStatus.explicitKnobs,
        prodFallbackKnobs: admissionStatus.prodFallbackKnobs,
      },
    });
    // B2: the event_loop_lag gate consumes the A2 sampler's readings.
    this.admissionLagUnsubscribe?.();
    this.admissionLagUnsubscribe = connectAdmissionToLagReadings(admissionController, getHealthTelemetry());

    // J3: admission's counts feed the A2 sampler's turn-count-mismatch detector
    // (plan §6 J3 — a detector, not a fix; admission behaviour is unchanged).
    // Correction 02: the source is the read-only activeCounts() — NOT
    // snapshot(), whose pressure evaluation latches admission's heap gate and
    // re-reads cgroup/PID/host sources synchronously. Fail-open: a throwing
    // source omits the fields instead of breaking the sample. The leak
    // decoration is validation-only (identity-gated; see
    // createValidationLeakOverride) so a disposable server can plant the
    // 2026-10-02-style stuck permit for the live proof; production never
    // constructs it.
    const validationLeak = createValidationLeakOverride(process.env, {
      onRefused: (reason) => logger.warn(`[InternalAPI] admission: ${reason}`),
    });
    if (validationLeak) logger.warn(`[InternalAPI] admission: VALIDATION leak injection active (${validationLeak.describe()})`);
    getHealthTelemetry().registerSources({
      admissionCounts: () => {
        const counts = admissionController.activeCounts();
        return validationLeak ? validationLeak.apply(counts) : counts;
      },
    });

    // B4 drain-then-restart: closes admission through the shared seam and
    // waits for active turns AND nonterminal receipts before a restart.
    // B4.1 + correction 01: the settle wait ALSO counts resident busy sessions
    // that hold no admission slot and no receipt — Pi extension-driven turns
    // (goal-engine continuations, watch-wake deadlines, subagent) and browser
    // (P0) turns via the SDK's public streaming state, and other runtimes via
    // their existing busy flags. The shared source refreshes the cross-runtime
    // snapshot on EVERY measurement (shared in-flight promise — overlapping
    // callers await one refresh) and the drain route awaits it before a start,
    // so a busy non-Pi session can never be measured against a stale or empty
    // snapshot. Pi is always read live, never from the snapshot.
    const busySource = createBusySessionSource({
      listRegistryEntries: () => this.sessionRegistry.listAll().then((all) => all.map((entry) => ({ id: entry.id, sdkType: entry.sdkType }))),
      isRuntimeRunning: (sdkType, sessionId) => {
        if (sdkType === 'claude') return this.claudeService.isRunning(sessionId);
        if (sdkType === 'opencode') return this.opencodeService.isRunning(sessionId);
        if (sdkType === 'antigravity') return this.antigravityService.isRunning(sessionId);
        if (sdkType === 'commandcode') return this.commandCodeService.isRunning(sessionId);
        return false; // 'pi' is covered by the live resident accessor
      },
      listPiBusySessions: () => this.multiSessionManager.listBusySessions().map((s) => ({ sessionId: s.sessionId, runtime: 'pi', busyReason: s.busyBecause.join('+') })),
    });
    const listBusySessions = (): DrainBusySession[] => {
      // Correction 01: every measurement kicks the shared refresh; the NEXT
      // poll reads it. The pre-start hook awaits it (bounded staleness mid-drain).
      void busySource.refresh();
      return busySource.listBusySessions();
    };
    const drainController = new DrainController({
      admission: admissionController,
      listNonterminalRuns: () => runReceiptManager.listNonterminal(),
      listBusySessions,
      // Correction 02: every outcome decision awaits this (bounded) before it
      // measures — a decision on a lagging snapshot could miss a busy session.
      refreshBusySessions: () => busySource.refresh(),
      quarantinedTurns: () => runReceiptManager.getQuarantinedCount(),
      recordPath: drainRecordPath,
      // Wave K: a timed-out drain re-runs the interruption sweep shortly after
      // the verdict (the cut-off sessions are still busy at that instant; the
      // re-runs catch them once they go idle when no restart follows).
      onTimedOut: (cutOff) => {
        const announced = new Map(cutOff.sessionIds.map((sessionId) => [sessionId, { source: 'drain' as const, interruptionReason: 'drain_timeout' as const }]));
        for (const delayMs of [120_000, 300_000]) {
          const timer = setTimeout(() => {
            void this.goalInterruptions?.runSweep(announced).catch(() => undefined);
          }, delayMs);
          timer.unref?.();
        }
      },
    });
    this.drainController = drainController;
    const drainRoutes = createDrainRoutes({ drain: drainController, onBeforeStart: () => busySource.refresh() });

    // Create routes
    const sessionRoutes = createSessionRoutes({
      claudeService: this.claudeService,
      opencodeService: this.opencodeService,
      antigravityService: this.antigravityService,
      multiSessionManager: this.multiSessionManager,
      sessionRegistry: this.sessionRegistry,
      piService: this.piService,
      internalClientId: this.internalClientId,
      watchDir: this.config.watchDir || DEFAULT_WATCH_DIR,
      runReceiptManager,
      pinDir: this.config.pinDir || DEFAULT_PIN_DIR,
      pinDefaultTtlMs: this.config.pinDefaultTtlMs,
      pinMaxTtlMs: this.config.pinMaxTtlMs,
      pinExpiryIntervalMs: this.config.pinExpiryIntervalMs,
      onSessionCreated: this.config.onSessionCreated,
      piSessionDir: config.sessionDir || path.join(config.piAgentDir, 'sessions'),
      claudeSessionDir: config.claudeSessionDir,
      antigravitySessionDir: config.antigravitySessionDir,
      admissionController,
      blockedPiProviders: config.internalApiBlockedPiProviders,
      commandCodeService: this.commandCodeService,
      onBrowserMessage: this.onBrowserMessage,
      drainRetryAfterSeconds: drainController.retryAfterSeconds,
      getRestartInterruptedRuns: () => runReceiptManager.getRestartRecoveredRuns(),
      getRestartInterruptedBusySessions: () => interruptedBusySessions,
    });
    this.sessionRoutesShutdown = sessionRoutes.shutdown;
    this.eventBroker = sessionRoutes.broker;

    // Wave K (contract 1.59.0): interruption sweep wiring — durable stores,
    // sweep, R6 live observers, R5 probe for the watch reconciliation.
    const goalContinueRoot = path.join(path.dirname(runReceiptDir), 'goal-continue');
    const goalInterruptions = wireGoalInterruptions({
      listRegistryEntries: async () => {
        const all = await this.sessionRegistry.listAll();
        return all.map((entry) => ({ id: entry.id, path: entry.path, sdkType: entry.sdkType, origin: entry.origin, parentSource: entry.parentSource }));
      },
      isSessionBusy: (sessionId) => {
        const busy = this.multiSessionManager.listBusySessions();
        return busy.some((b) => b.sessionId === sessionId || b.sessionPath === sessionId);
      },
      dispatchPrompt: (sessionId, message) => this.dispatchGoalContinuePrompt(sessionId, message),
      brokerPublish: (brokerKey, event) => {
        try {
          this.eventBroker?.publish(brokerKey, event as Parameters<NonNullable<typeof this.eventBroker>['publish']>[1]);
        } catch { /* best-effort visibility */ }
      },
      addExtensionUiObserver: (sessionPath, observer) => {
        this.multiSessionManager.addExtensionUiObserver?.(sessionPath, observer);
      },
      removeExtensionUiObserver: (sessionPath, observer) => {
        this.multiSessionManager.removeExtensionUiObserver?.(sessionPath, observer);
      },
      markerDir: path.join(goalContinueRoot, 'markers'),
      overlayDir: path.join(goalContinueRoot, 'overlay'),
      logger: { info: (message) => logger.info(message), warn: (message) => logger.warn(message) },
    });
    this.goalInterruptions = goalInterruptions;
    setGoalContinueProbe((sessionId) => goalInterruptions.hasGoalContinueMarker(sessionId));
    this.goalInterruptionStop = () => {
      goalInterruptions.shutdown();
      setGoalContinueProbe(undefined);
    };
    this.goalControlHandler = async (sessionId, body) => {
      // Re-enter the HTTP handler through a synthetic exchange so the browser
      // control path uses the exact same logic as the Internal API route.
      const { PassThrough, Writable } = await import('node:stream');
      const req = new PassThrough() as unknown as IncomingMessage;
      req.method = 'POST';
      req.url = `/api/v1/sessions/${sessionId}/goal`;
      req.headers = { 'content-type': 'application/json' };
      req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
      const chunks: Buffer[] = [];
      const res = new Writable({
        write(chunk: Buffer, _enc, cb) { chunks.push(chunk); cb(); },
      }) as unknown as ServerResponse & { statusCode: number };
      res.statusCode = 200;
      res.setHeader = () => res;
      res.writeHead = (function (code: number) { res.statusCode = code; return res; }) as never;
      let payload = '';
      res.end = (function (data?: string | Buffer) {
        if (data) chunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
        payload = Buffer.concat(chunks).toString();
        return res;
      }) as never;
      res.on = (() => res) as never;
      res.getHeader = () => undefined;
      await sessionRoutes.handleSessionGoalControl(req as IncomingMessage, res, sessionId);
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(payload) as Record<string, unknown>; } catch { /* non-JSON */ }
      return { statusCode: res.statusCode, body: parsed };
    };
    await sessionRoutes.ready;
    this.multiSessionManager.setSessionMaterializedHandler((sessionId) => sessionRoutes.reapplyRetentionForSession(sessionId));

    const modelsDeps: ModelsRoutesDeps = {
      piService: this.piService,
      claudeService: this.claudeService,
      opencodeService: this.opencodeService,
      antigravityService: this.antigravityService,
      commandCodeService: this.commandCodeService,
      blockedPiProviders: config.internalApiBlockedPiProviders,
    };
    const modelsRoutes = createModelsRoutes(modelsDeps);

    const healthDeps: HealthRoutesDeps = {
      claudeService: this.claudeService,
      opencodeService: this.opencodeService,
      antigravityService: this.antigravityService,
      commandCodeService: this.commandCodeService,
      startTime: this.startTime,
      enabled: {
        claude: true,
        opencode: config.opencodeServerEnabled,
        antigravity: config.antigravityEnabled,
        commandcode: config.commandCodeEnabled,
      },
    };
    const healthRoutes = createHealthRoutes(healthDeps);

    const capabilitiesDeps: CapabilitiesRoutesDeps = {
      claudeService: this.claudeService,
      opencodeService: this.opencodeService,
      antigravityService: this.antigravityService,
      commandCodeService: this.commandCodeService,
      blockedPiProviders: config.internalApiBlockedPiProviders,
    };
    const capabilitiesRoutes = createCapabilitiesRoutes(capabilitiesDeps);

    const diagnosticsRoutes = createDiagnosticsRoutes({
      sessionRegistry: this.sessionRegistry,
      isVisibleSession: async (sessionId) => {
        const commandCode = await this.commandCodeService.getSession(sessionId);
        if (commandCode) return true;
        const entry = await this.sessionRegistry.get(sessionId);
        return Boolean(entry && entry.sdkType !== 'commandcode');
      },
      workerSummary: () => {
        const pool = getWorkerPool();
        const crashes = pool.getCrashStats();
        return {
          pool: pool.getStats(),
          crashes: {
            totalCrashes: crashes.totalCrashes,
            crashesLast24h: crashes.crashesLast24h,
            crashesLastHour: crashes.crashesLastHour,
            byType: crashes.byType,
            oomStats: crashes.oomStats,
          },
        };
      },
    });

    const eventTypesRoutes = createEventTypesRoutes();

    // Notification layer (Telegram on agent_end; explicit POST). Inert when
    // NOTIFICATIONS_ENABLED is off: no observers are attached and the outbox is
    // not drained. Credentials come from env only (never committed).
    const notificationsDir = config.notificationsDir || DEFAULT_NOTIFICATIONS_DIR;
    const notificationStore = new NotificationStore(notificationsDir);
    const notificationRouter = new ChannelRouter();
    notificationRouter.register(
      pickNotificationChannel({
        validationMode: config.validationMode,
        telegramBotToken: config.telegramBotToken,
        telegramChatId: config.telegramChatId,
        timeoutMs: config.notificationsChannelTimeoutMs,
      }),
    );
    const notificationManager = new NotificationManager({
      enabled: config.notificationsEnabled,
      store: notificationStore,
      router: notificationRouter,
      services: {
        pi: this.multiSessionManager,
        claude: this.claudeService,
        opencode: this.opencodeService,
        antigravity: this.antigravityService,
        commandcode: this.commandCodeService,
      },
      isSessionAllowed: async (record) => record.runtime !== 'commandcode'
        || await this.commandCodeService.getSession(record.sessionId) !== undefined
          || await this.commandCodeService.getSession(record.sessionPath) !== undefined,
      tailMaxChars: config.notificationsTailMaxChars,
      publicBaseUrl: config.notificationsPublicBaseUrl ?? config.allowedOrigins[0],
      debounceMs: config.notificationsDebounceMs,
      maxAttempts: config.notificationsMaxDeliveryAttempts,
      ingressSpool: new NotificationIngressSpool(path.join(notificationsDir, 'ingress')),
      ingressPollMs: config.notificationsIngressPollMs,
      // Live-resolve the renamed display name (web-ui-prefs.json) so the
      // notification header reflects a rename even after opt-in. Best-effort:
      // a read failure falls back through the snapshot label → runtime label.
      resolveLabel: async (sessionPath: string) => {
        try {
          const prefs = await readPreferences();
          const name = deriveLegacyArrays(prefs).sessionDisplayNames[sessionPath];
          return typeof name === 'string' && name.trim() ? name.trim() : undefined;
        } catch {
          return undefined;
        }
      },
    });
    await notificationManager.init();
    this.notificationManager = notificationManager;
    const notificationRoutes = createNotificationsRoutes({
      manager: notificationManager,
      sessionRegistry: this.sessionRegistry,
    });

    // Capture recent structured logs into the diagnostics ring buffer so the
    // /diagnostics endpoints can self-serve them. The buffer scrubs secrets on
    // push, so the tap never persists tokens/credentials.
    setLogTap((record) => pushDiagnosticsRecord(record));

    const authMiddleware = createAuthMiddleware(this.apiKey);

    const requestLogging = createRequestLoggingMiddleware(logger);

    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // CORS for local development (permissive because local-only)
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, PATCH, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Verbosity, Idempotency-Key');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      // Route matching
      const url = req.url || '/';
      const parsed = parseUrl(url);

      // Request logging (debug) wraps auth + routing so the per-request
      // requestId is shared with prompt correlation lines.
      requestLogging(req, res, () => {
        // Apply auth middleware (except health)
        authMiddleware(req, res, () => {
          void this.routeRequest(req, res, parsed, {
            sessionRoutes,
            modelsRoutes,
            healthRoutes,
            capabilitiesRoutes,
            diagnosticsRoutes,
            eventTypesRoutes,
            notificationRoutes,
            drainRoutes,
          }).catch((error) => {
            const tooLarge = error instanceof RequestBodyTooLargeError;
            const malformedPath = error instanceof URIError;
            if (tooLarge || malformedPath) {
              logger.warn(`Internal API request rejected: ${error instanceof Error ? error.message : String(error)}`);
            } else {
              logger.errorObject('Internal API request failed', error);
            }
            if (res.headersSent) {
              res.destroy(error instanceof Error ? error : undefined);
              return;
            }
            sendJson(res, tooLarge ? 413 : malformedPath ? 400 : 500, {
              error: tooLarge ? error.message : malformedPath ? 'Malformed URL path encoding.' : 'Internal API request failed.',
              code: tooLarge
                ? ErrorCode.PAYLOAD_TOO_LARGE
                : malformedPath ? ErrorCode.INVALID_REQUEST : ErrorCode.INTERNAL_ERROR,
            });
          });
        });
      });
    });
    this.server.on('connection', (socket) => {
      this.connections.add(socket);
      socket.once('close', () => this.connections.delete(socket));
    });

    // Bind under the process-lifetime ownership lock. Node removes its own Unix
    // socket on close; the lock prevents a cooperative successor from binding
    // the pathname until shutdown has completed.
    await this.bindToSocket(socketPath);
    await socketOwner.captureOwnership();
    this.socketOwner = socketOwner;

    logger.info(`[InternalAPI] Listening on Unix socket: ${socketPath}`);
    logger.info(`[InternalAPI] API token ready at: ${tokenPath}`);

    // Wave K: the boot sweep runs once the API is reachable (continue dispatch
    // goes through the loopback prompt path so admission applies). R5 ordering:
    // the watch reconciliation's continue probe awaits this classification.
    this.listeningSocketPath = socketPath;
    {
      const announced = new Map<string, AnnouncedInterruption>();
      for (const run of runReceiptManager.getRestartRecoveredRuns()) {
        announced.set(run.sessionId, { source: 'receipt', interruptionReason: run.interruptionReason });
      }
      for (const busy of interruptedBusySessions) {
        if (!announced.has(busy.sessionId)) {
          announced.set(busy.sessionId, { source: 'drain', interruptionReason: busy.interruptionReason });
        }
      }
      void goalInterruptions.runSweep(announced)
        .then(() => goalInterruptions.startObserving())
        .catch((error) => logger.warn(`[InternalAPI] wave K boot sweep failed: ${error instanceof Error ? error.message : String(error)}`));
    }
    } catch (error) {
      this.drainController?.shutdown();
      this.drainController = null;
      const notificationManager = this.notificationManager;
      notificationManager?.shutdown();
      await notificationManager?.waitForIdle();
      this.notificationManager = null;
      this.multiSessionManager.setSessionMaterializedHandler(undefined);
      this.admissionLagUnsubscribe?.();
      this.admissionLagUnsubscribe = null;
      this.goalInterruptionStop?.();
      this.goalInterruptionStop = null;
      this.goalInterruptions = null;
      if (this.sessionRoutesShutdown) {
        await this.sessionRoutesShutdown().catch(() => { /* preserve startup error */ });
        this.sessionRoutesShutdown = null;
      }
      await this.commandCodeService.shutdown().catch(() => { /* preserve startup error */ });
      if (this.runReceiptManager) {
        await this.runReceiptManager.shutdown().catch(() => { /* preserve startup error */ });
        this.runReceiptManager = null;
      }
      await this.closeHttpServer().catch(() => { /* preserve startup error */ });
      await socketOwner.release().catch(() => { /* preserve startup error */ });
      throw error;
    }
  }

  /**
   * Stop the server and clean up the socket file.
   */
  /** The notification manager (built in start()), or null. Exposed so the cookie-auth browser route can reach it. */
  getNotificationManager(): NotificationManager | null {
    return this.notificationManager;
  }

  /**
   * Contract 1.27.0 goal function: browser goal-control entry point. Returns
   * null until the internal API server has started (routes not built yet).
   */
  getGoalControlHandler(): ((sessionId: string, body: Record<string, unknown>) => Promise<{ statusCode: number; body: Record<string, unknown> }>) | null {
    return this.goalControlHandler;
  }

  /**
   * B4.1 correction 01: the browser prompt fence. True while a drain is
   * active OR held (admission stays closed after the verdict until a restart
   * or hold expiry), so a browser prompt arriving after `settled` cannot start
   * a turn the restart then kills silently. Null until the server has started
   * (Internal API disabled = never fenced).
   */
  getDrainFence(): (() => { active: boolean; retryAfterSeconds: number }) | null {
    if (!this.drainController) return null;
    const drain = this.drainController;
    return () => {
      const status = drain.status();
      return { active: status.state !== 'idle', retryAfterSeconds: drain.retryAfterSeconds };
    };
  }

  /**
   * The per-session Internal API event broker (watch-defect brief fix 3):
   * lets the host process bridge externally observed session activity (e.g.
   * the SessionWatcher's native CLI file changes) into the same broker the
   * WatchManager subscribes to, without going through a prompt path. Null
   * until the server has started.
   */
  getEventBroker(): import('../internal-api/event-broker.js').InternalApiEventBroker | null {
    return this.eventBroker;
  }

  async stop(): Promise<void> {
    if (!this.stopPromise) this.stopPromise = this.stopInternal();
    return this.stopPromise;
  }

  private async stopInternal(): Promise<void> {
    const failures: unknown[] = [];
    try {
      this.drainController?.shutdown();
      this.drainController = null;
      const notificationManager = this.notificationManager;
      notificationManager?.shutdown();
      await notificationManager?.waitForIdle().catch((error) => failures.push(error));
      this.notificationManager = null;
      this.multiSessionManager.setSessionMaterializedHandler(undefined);
      this.admissionLagUnsubscribe?.();
      this.admissionLagUnsubscribe = null;
      this.goalInterruptionStop?.();
      this.goalInterruptionStop = null;
      this.goalInterruptions = null;
      if (this.sessionRoutesShutdown) {
        await this.sessionRoutesShutdown().catch((error) => failures.push(error));
        this.sessionRoutesShutdown = null;
      }
      await this.commandCodeService.shutdown().catch((error) => failures.push(error));
      if (this.runReceiptManager) {
        await this.runReceiptManager.shutdown().catch((error) => failures.push(error));
        this.runReceiptManager = null;
      }
      await this.closeHttpServer().catch((error) => failures.push(error));
    } finally {
      await this.socketOwner?.release().catch((error) => failures.push(error));
      this.socketOwner = null;
    }
    logger.info('[InternalAPI] Server stopped');
    if (failures.length > 0) throw new AggregateError(failures, 'Internal API shutdown encountered errors');
  }

  private async closeHttpServer(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server?.listening) return;
    await closeServerWithGrace(server, this.connections, this.config.shutdownGraceMs ?? 2000);
  }

  // ── Routing ──────────────────────────────────────────────────────────────

  private async routeRequest(
    req: IncomingMessage,
    res: ServerResponse,
    parsed: { path: string[]; query: URLSearchParams },
    deps: {
      sessionRoutes: ReturnType<typeof createSessionRoutes>;
      modelsRoutes: ReturnType<typeof createModelsRoutes>;
      healthRoutes: ReturnType<typeof createHealthRoutes>;
      capabilitiesRoutes: ReturnType<typeof createCapabilitiesRoutes>;
      diagnosticsRoutes: ReturnType<typeof createDiagnosticsRoutes>;
      eventTypesRoutes: ReturnType<typeof createEventTypesRoutes>;
      notificationRoutes: ReturnType<typeof createNotificationsRoutes>;
      drainRoutes: ReturnType<typeof createDrainRoutes>;
    },
  ): Promise<void> {
    // Skip 'api' prefix if present: /api/v1/health → ['api', 'v1', 'health']
    const segments = parsed.path[0] === 'api' ? parsed.path.slice(1) : parsed.path;
    const [version, resource, id, action, subId, subAction] = segments;

    if (version !== 'v1') {
      sendJson(res, 404, { error: 'API version not found', code: ErrorCode.NOT_FOUND });
      return;
    }

    // B4: while draining, new P2/P3 creates and prompts are refused here with
    // SERVER_DRAINING + Retry-After, before any receipt or runtime work.
    if (isExecutionEntryRequest(req.method, [resource, id, action].filter((s): s is string => s !== undefined))
      && deps.drainRoutes.refusesExecution()) {
      deps.drainRoutes.sendDrainingRefusal(res);
      return;
    }

    switch (resource) {
      case 'drain': {
        // B4 drain-then-restart control (contract 1.51.0).
        if (id) {
          sendJson(res, 404, { error: 'Unknown drain endpoint', code: ErrorCode.NOT_FOUND });
        } else if (req.method === 'POST') {
          await deps.drainRoutes.handleStartDrain(req, res);
        } else if (req.method === 'GET') {
          await deps.drainRoutes.handleGetDrain(req, res);
        } else if (req.method === 'DELETE') {
          await deps.drainRoutes.handleCancelDrain(req, res);
        } else {
          sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
        }
        return;
      }
      case 'capacity': {
        if (req.method === 'GET' && !id) {
          deps.sessionRoutes.handleCapacity(req, res);
        } else {
          sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
        }
        return;
      }
      case 'sessions': {
        if (!id) {
          // /api/v1/sessions
          if (req.method === 'GET') {
            await deps.sessionRoutes.handleListSessions(req, res);
          } else if (req.method === 'POST') {
            await deps.sessionRoutes.handleCreateSession(req, res);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        // /api/v1/sessions/batch and /api/v1/sessions/usage are reserved words
        if (id === 'batch' && !action) {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleBatchCreate(req, res);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }
        if (id === 'batch' && action === 'prompt') {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleBatchPrompt(req, res);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }
        if (id === 'usage') {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleAggregateUsage(req, res);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }
        // Reserved word: bounded read-only native (direct-CLI) session discovery.
        if (id === 'native' && !action) {
          if (req.method === 'GET') {
            await deps.sessionRoutes.handleListNativeSessions(req, res);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        // Reserved word: contract 1.40.0 native session adoption.
        if (id === 'adopt-native' && !action) {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleAdoptNativeSession(req, res);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        const sessionId = decodeURIComponent(id);

        if (action === 'prompt') {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleSendPrompt(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'abort') {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleAbort(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'info') {
          if (req.method === 'GET') {
            await deps.sessionRoutes.handleGetSessionInfo(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'diagnostics') {
          if (req.method === 'GET') {
            await deps.diagnosticsRoutes.handleGetSessionDiagnostics(req, res, sessionId, parsed.query);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'evidence') {
          if (req.method === 'GET') {
            await deps.sessionRoutes.handleGetSessionEvidence(req, res, sessionId, parsed.query);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'history') {
          if (req.method === 'GET') {
            await deps.sessionRoutes.handleGetSessionHistory(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'transcript') {
          if (req.method === 'GET') {
            await deps.sessionRoutes.handleSessionTranscript(req, res, sessionId, parsed.query);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'events') {
          if (req.method === 'GET') {
            await deps.sessionRoutes.handleSessionEvents(req, res, sessionId, parsed.query);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'notifications') {
          // /api/v1/sessions/:id/notifications[/opt-in]
          if (subId === 'opt-in') {
            if (req.method === 'POST') {
              await deps.notificationRoutes.handleOptIn(req, res, sessionId);
            } else if (req.method === 'DELETE') {
              await deps.notificationRoutes.handleOptOut(req, res, sessionId);
            } else {
              sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
            }
            return;
          }
          if (!subId) {
            if (req.method === 'GET') {
              await deps.notificationRoutes.handleGetSessionState(req, res, sessionId);
            } else {
              sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
            }
            return;
          }
        }

        if (action === 'wait') {
          if (req.method === 'GET') {
            await deps.sessionRoutes.handleSessionWait(req, res, sessionId, parsed.query);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'watch') {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleRegisterWatch(req, res, sessionId);
          } else if (req.method === 'GET') {
            await deps.sessionRoutes.handleGetWatch(req, res, sessionId, parsed.query);
          } else if (req.method === 'DELETE') {
            await deps.sessionRoutes.handleDeleteWatch(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'transfer') {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleSessionTransfer(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'control') {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleSessionControl(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        // Contract 1.40.0: link an existing registered session under a parent.
        if (action === 'adopt') {
          if (req.method === 'POST') {
            await deps.sessionRoutes.handleAdoptSession(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'goal') {
          if (req.method === 'GET') {
            // Read endpoints skip the bounded control lane (pure observer).
            await deps.sessionRoutes.handleGetSessionGoal(req, res, sessionId);
          } else if (req.method === 'POST') {
            await deps.sessionRoutes.handleSessionGoalControl(req, res, sessionId);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }

        if (action === 'approvals') {
          // /api/v1/sessions/:id/approvals/pending
          if (subId === 'pending' && !subAction) {
            if (req.method === 'GET') {
              await deps.sessionRoutes.handleListPendingApprovals(req, res, sessionId);
            } else {
              sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
            }
            return;
          }
          // /api/v1/sessions/:id/approvals/:requestId/respond
          if (subId && subAction === 'respond') {
            if (req.method === 'POST') {
              await deps.sessionRoutes.handleRespondApproval(req, res, sessionId, decodeURIComponent(subId));
            } else {
              sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
            }
            return;
          }
          sendJson(res, 404, { error: 'Unknown approvals endpoint', code: ErrorCode.NOT_FOUND });
          return;
        }

        // /api/v1/sessions/:id
        if (req.method === 'GET') {
          await deps.sessionRoutes.handleGetSession(req, res, sessionId);
        } else if (req.method === 'DELETE') {
          await deps.sessionRoutes.handleDeleteSession(req, res, sessionId);
        } else {
          sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
        }
        return;
      }

      case 'runs': {
        if (id && req.method === 'GET') {
          await deps.sessionRoutes.handleGetRunReceipt(req, res, decodeURIComponent(id));
        } else {
          sendJson(res, id ? 405 : 404, {
            error: id ? 'Method not allowed' : 'Run id is required',
            code: id ? ErrorCode.METHOD_NOT_ALLOWED : ErrorCode.NOT_FOUND,
          });
        }
        return;
      }

      case 'models': {
        if (id === 'refresh') {
          if (req.method === 'POST') {
            await deps.modelsRoutes.handleRefreshModels(req, res);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }
        if (req.method === 'GET') {
          await deps.modelsRoutes.handleListModels(req, res);
        } else {
          sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
        }
        return;
      }

      case 'watches': {
        // Round-2 §3 (contract 1.26.0): long-poll wait across one or many watches.
        if (id === 'wait' && !subId) {
          if (req.method === 'GET') {
            await deps.sessionRoutes.handleWatchesWait(req, res, parsed.query);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }
        sendJson(res, 404, { error: 'Unknown watches endpoint', code: ErrorCode.NOT_FOUND });
        return;
      }

      case 'health': {
        await deps.healthRoutes.handleHealth(req, res);
        return;
      }

      case 'capabilities': {
        if (req.method === 'GET') {
          await deps.capabilitiesRoutes.handleGetCapabilities(req, res);
        } else {
          sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
        }
        return;
      }

      case 'diagnostics': {
        if (req.method === 'GET') {
          await deps.diagnosticsRoutes.handleGetDiagnostics(req, res, parsed.query);
        } else {
          sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
        }
        return;
      }

      case 'events': {
        // GET /api/v1/events/types — structured event-type registry
        if (id === 'types') {
          if (req.method === 'GET') {
            await deps.eventTypesRoutes.handleGetEventTypes(req, res);
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
          return;
        }
        sendJson(res, 404, { error: 'Unknown events endpoint', code: ErrorCode.NOT_FOUND });
        return;
      }

      case 'notifications': {
        // POST /api/v1/notifications — explicit durable acceptance
        // GET  /api/v1/notifications — recent delivery log
        // GET  /api/v1/notifications/:id — one delivery status
        if (id) {
          if (req.method === 'GET') {
            await deps.notificationRoutes.handleGetDeliveryStatus(req, res, decodeURIComponent(id));
          } else {
            sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
          }
        } else if (req.method === 'POST') {
          await deps.notificationRoutes.handleExplicitNotify(req, res);
        } else if (req.method === 'GET') {
          await deps.notificationRoutes.handleGetRecentDeliveries(req, res, parsed.query);
        } else {
          sendJson(res, 405, { error: 'Method not allowed', code: ErrorCode.METHOD_NOT_ALLOWED });
        }
        return;
      }

      default: {
        sendJson(res, 404, { error: 'Unknown endpoint', code: ErrorCode.NOT_FOUND });
      }
    }
  }

  // ── Socket binding ───────────────────────────────────────────────────────

  private async bindToSocket(socketPath: string): Promise<void> {
    // Ensure parent directory exists
    const dir = path.dirname(socketPath);
    await mkdir(dir, { recursive: true, mode: 0o700 });

    // Do not advertise readiness until owner-only permissions are confirmed.
    if (!this.server) throw new Error('Internal API HTTP server was not initialized.');
    await bindOwnerOnlyUnixSocket(this.server, socketPath);
  }

  // ── API key management ───────────────────────────────────────────────────

  /**
   * Wave K (contract 1.59.0): dispatch a goal continue through the server's
   * OWN prompt endpoint over loopback — the full prompt pipeline (injection
   * checks, admission with shared parents' capacity, receipts, broker fan-out)
   * applies, exactly as for an external caller. Maps admission/draining
   * refusals to a Retry-After for the sweep's bounded retry window.
   */
  private dispatchGoalContinuePrompt(sessionId: string, message: string): Promise<{ ok: boolean; retryAfterSeconds?: number; reason?: string }> {
    const socketPath = this.listeningSocketPath;
    if (!socketPath || !this.apiKey) {
      return Promise.resolve({ ok: false, reason: 'server not listening' });
    }
    return new Promise((resolve) => {
      const body = Buffer.from(JSON.stringify({ message, mode: 'prompt' }));
      const request = httpRequest({
        host: 'localhost',
        socketPath,
        path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/prompt`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
          authorization: `Bearer ${this.apiKey}`,
        },
        timeout: 15_000,
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const status = response.statusCode ?? 0;
          if (status === 200 || status === 202) {
            resolve({ ok: true });
            return;
          }
          const retryAfterHeader = response.headers['retry-after'];
          const retryAfterSeconds = typeof retryAfterHeader === 'string' ? Number.parseInt(retryAfterHeader, 10) : undefined;
          resolve({
            ok: false,
            ...(Number.isFinite(retryAfterSeconds) && (status === 429 || status === 503) ? { retryAfterSeconds } : {}),
            reason: `prompt endpoint answered ${status}: ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`,
          });
        });
      });
      request.on('timeout', () => {
        request.destroy();
        resolve({ ok: false, reason: 'loopback prompt timed out' });
      });
      request.on('error', (error) => {
        resolve({ ok: false, reason: `loopback prompt failed: ${error.message}` });
      });
      request.end(body);
    });
  }

  private async resolveApiKey(tokenPath: string): Promise<string> {
    // Check env var first
    if (process.env.INTERNAL_API_KEY) {
      return process.env.INTERNAL_API_KEY;
    }

    // Try to read existing token file
    try {
      const existing = await readFile(tokenPath, 'utf-8');
      const trimmed = existing.trim();
      if (trimmed.length >= 16) {
        return trimmed;
      }
    } catch {
      // Token file doesn't exist, generate new
    }

    // Generate and persist a new random token
    const token = randomBytes(48).toString('hex'); // 96 chars
    await mkdir(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
    await writeFile(tokenPath, token, { mode: 0o600 });
    return token;
  }
}

// ─── URL Parsing ─────────────────────────────────────────────────────────────

function parseUrl(url: string): { path: string[]; query: URLSearchParams } {
  // Handle /api/v1/resource/id/action format
  const parts = url.split('?')[0].split('/').filter(Boolean);
  const queryString = url.includes('?') ? url.split('?')[1] : '';
  const query = new URLSearchParams(queryString);
  return { path: parts, query };
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
