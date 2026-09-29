/**
 * B4 drain-then-restart HTTP surface (contract 1.51.0).
 *
 *   POST   /api/v1/drain  { reason, timeoutSeconds?, holdSeconds? }
 *          Close admission for new P2/P3 work, wait until in-flight turns AND
 *          nonterminal run receipts settle (or the timeout elapses), and answer
 *          with the verdict. A second POST while a drain runs joins it.
 *   GET    /api/v1/drain  Current drain status (never blocks).
 *   DELETE /api/v1/drain  Cancel: admission reopens, no restart expected.
 *
 * The routes sit behind the Internal API's bearer-token middleware like every
 * other route; the drain never restarts anything itself — the deploy script
 * (scripts/restart-production.sh) does that after reading the verdict.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';
import type { DrainController } from '../drain-controller.js';
import { ErrorCode, enrichedErrorBody } from '../error-codes.js';
import { readBoundedJsonBody } from '../request-body.js';

const MAX_REASON_CHARS = 500;
const MAX_SECONDS = 3600;
/** Correction 01 (self-drain): bounded, safe session ids for the busy-wait exclusion. */
const MAX_EXCLUDE_SESSIONS = 8;
const SAFE_SESSION_ID = /^[a-zA-Z0-9_-]{1,128}$/;

const startDrainSchema = z.object({
  reason: z.string().trim().min(1, 'reason is required').max(MAX_REASON_CHARS, `reason must be at most ${MAX_REASON_CHARS} characters`),
  timeoutSeconds: z.number().int().min(0).max(MAX_SECONDS).optional(),
  holdSeconds: z.number().int().min(1).max(MAX_SECONDS).optional(),
  excludeSessionIds: z.array(
    z.string().regex(SAFE_SESSION_ID, 'excludeSessionIds entries must be 1-128 characters of [a-zA-Z0-9_-]'),
  ).max(MAX_EXCLUDE_SESSIONS, `excludeSessionIds must hold at most ${MAX_EXCLUDE_SESSIONS} ids`).optional(),
}).strict();

/** Strip control characters so a reason cannot forge log or audit lines. */
function sanitizeReason(reason: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately matching control characters
  return reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

/**
 * Whether a request would start NEW P2/P3 execution — the requests a drain
 * refuses at the router. Everything else (reads, control, abort, watches,
 * approvals, adoption, DELETE, the drain endpoint itself) stays available.
 * Execution reached through other paths (goal control, watch wakes) is
 * refused by the admission seam and mapped to the same code.
 */
export function isExecutionEntryRequest(method: string | undefined, segments: readonly string[]): boolean {
  if (method !== 'POST') return false;
  const [resource, id, action] = segments;
  if (resource !== 'sessions') return false;
  if (id === undefined) return true; // create
  if (id === 'batch') return action === undefined || action === 'prompt';
  if (id === 'usage' || id === 'native' || id === 'adopt-native') return false;
  return action === 'prompt' || action === 'transfer';
}

function sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export interface DrainRoutesDeps {
  drain: DrainController;
  /**
   * B4.1: awaited once before a drain starts, so the busy-session source reads
   * a fresh snapshot (the cross-runtime registry is async; the drain's own
   * accessors are sync). A rejection must not block the drain.
   */
  onBeforeStart?: () => Promise<void>;
}

export function createDrainRoutes({ drain, onBeforeStart }: DrainRoutesDeps) {
  async function handleStartDrain(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBoundedJsonBody<unknown>(req, { maxBytes: 16 * 1024 });
    const parsed = startDrainSchema.safeParse(raw ?? undefined);
    if (!parsed.success) {
      sendJson(res, 400, {
        ...enrichedErrorBody(ErrorCode.INVALID_REQUEST, parsed.error.issues[0]?.message ?? 'Invalid drain request'),
        details: parsed.error.issues,
      });
      return;
    }
    if (onBeforeStart) {
      try {
        await onBeforeStart();
      } catch {
        /* a stale busy snapshot must never block the drain */
      }
    }
    const { reason, timeoutSeconds, holdSeconds, excludeSessionIds } = parsed.data;
    const { joined } = drain.start({
      reason: sanitizeReason(reason),
      timeoutMs: timeoutSeconds === undefined ? undefined : timeoutSeconds * 1000,
      holdMs: holdSeconds === undefined ? undefined : holdSeconds * 1000,
      excludeSessionIds,
    });
    const outcome = await drain.waitForOutcome();
    sendJson(res, 200, { ...outcome, joined });
  }

  async function handleGetDrain(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    sendJson(res, 200, drain.status());
  }

  async function handleCancelDrain(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    sendJson(res, 200, await drain.cancel('operator'));
  }

  /** 503 SERVER_DRAINING with Retry-After for a request refused by the router gate. */
  function sendDrainingRefusal(res: ServerResponse): void {
    const status = drain.status();
    res.setHeader('Retry-After', String(drain.retryAfterSeconds));
    sendJson(res, 503, {
      ...enrichedErrorBody(ErrorCode.SERVER_DRAINING, 'Server is draining before a planned restart; new sessions and prompts are refused.'),
      reason: 'draining',
      retryAfterSeconds: drain.retryAfterSeconds,
      drain: { state: status.state, reason: status.reason, startedAt: status.startedAt },
    });
  }

  /** Whether the router should refuse this request because a drain is in effect. */
  function refusesExecution(): boolean {
    return drain.status().draining;
  }

  return { handleStartDrain, handleGetDrain, handleCancelDrain, sendDrainingRefusal, refusesExecution };
}
