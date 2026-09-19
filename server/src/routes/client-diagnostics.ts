import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { cookieAuthMiddleware } from '../middleware/auth.js';
import { validateBody } from '../security/input-validation.js';
import { createLogger } from '../logging/logger.js';

/**
 * P13 — client-side error ingest for the Voice Mode surface.
 *
 * Why this endpoint exists (justification required by the observability
 * doctrine): a client crash on the speech surface is today unknowable from
 * the server. The browser diagnostic ring is manual-only (Copy/Download on
 * the error boundary) and dies with the page, so the class of failure the
 * operator hits — "it errored and I can't tell you more" — leaves no record
 * any agent can query. The manual bundle is the documented fallback for
 * survivable states; a crash is not survivable.
 *
 * Design — extend, do not fork (docs/OBSERVABILITY.md): this route adds NO
 * store, NO buffer and NO query surface. It validates a strictly bounded,
 * scrubbed report and re-emits it as an ORDINARY central-logger record from
 * the `ClientVoice` component, which therefore lands in the existing
 * diagnostics ring through the existing logger tap (secret-scrubbed on entry,
 * bounded 1,000 records / 2 MiB, process-local). Retrieval rides the same
 * documented path as every other record:
 *
 *   GET /api/v1/diagnostics?component=ClientVoice
 *
 * Boundedness: every string field is length-capped by the schema, the
 * recent-event context is capped at 12 allowlisted entries, the request
 * shares the global /api rate limit, and the CLIENT additionally caps itself
 * at a small number of reports per page load. An error-level record is
 * attention-worthy; the ring bound contains any residual flood.
 *
 * P13 gap fill — PLAYBACK HEALTH. A crash is only half of "why didn't I hear
 * it?". The other half is a lane that accepted audio and never played it: the
 * surface's playback faults and its playback stats lived only in the page's
 * memory, so "did the lane play everything?" had no server-side answer at all.
 * The same route now also accepts a bounded `kind: 'playback_health'` report
 * (a fault, or the lane-end summary) and re-emits it as an ordinary
 * `ClientVoice` WARN record with the bounded stats attached — warn, not info,
 * because info records are namespace-filtered and this evidence must always
 * reach the ring. No new store, no new query: the same documented read returns
 * it, and at `lane_end` a non-zero `pendingMs` is audio the operator never
 * heard.
 *
 * Privacy: message/stack are operator-authored crash text — scrubbed here via
 * the logger's ring scrubber on entry, and scrubbed again client-side before
 * upload. No utterance text, no transcript bodies, no cookies, no auth data.
 * The schema is STRICT: an unknown field is rejected rather than stored, so a
 * caller cannot smuggle transcript content in beside a health record.
 */

const router = Router();

const logger = createLogger('ClientVoice');

/** Allowlisted browser-ring event projection (no text, no ids — same rules
 *  as the manual diagnostic bundle). */
const recentEventSchema = z.object({
  at: z.string().max(40).optional(),
  kind: z.enum(['connection', 'message', 'protocol_drift', 'storage_error', 'ui_error', 'speech']),
  operation: z.string().max(40).optional(),
  speechTier: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
  state: z.string().max(80).optional(),
  errorName: z.string().max(80).optional(),
});

const reportSchema = z
  .object({
    /** Report family. Absent means a client error report (back-compatible). */
    kind: z.enum(['client_error', 'playback_health']).default('client_error'),
    /** What on the surface reported: uncaught_error, unhandled_rejection,
     *  react_render, playback_failed, dictation_error, talker_listener. */
    operation: z.string().min(1).max(40).optional(),
    /** Bounded crash text (client-side scrubbed; ring-scrubbed on entry). */
    message: z.string().min(1).max(300).optional(),
    errorName: z.string().max(80).optional(),
    stack: z.string().max(1500).optional(),
    /** Voice-surface correlation, when the surface knows it: the worker
     *  session the talker lane is bound to (the same key VoiceMode records
     *  carry), so a client error joins the server-side story instead of
     *  floating free. Global-handler reports legitimately omit it. */
    runtime: z.string().max(20).optional(),
    workerSessionId: z.string().max(80).optional(),
    /** Bounded tail of the browser diagnostic ring for context (the barge-in
     *  path especially: floor_held/duck/playback events precede a crash). */
    recentEvents: z.array(recentEventSchema).max(12).optional(),
    /** playback_health only: what was observed. `lane_end` is the summary. */
    reason: z
      .enum(['playback_chunk_corrupt', 'playback_seq_gap', 'playback_overflow', 'lane_end'])
      .optional(),
    /** playback_health only: bounded, scrubbed fault detail (never speech). */
    detail: z.string().max(300).optional(),
    /** playback_health only: the numbers at the moment of the report. At
     *  `lane_end`, non-zero pendingMs is audio accepted and never played. */
    stats: z
      .object({
        chunksScheduled: z.number().int().min(0).max(1_000_000),
        chunksDropped: z.number().int().min(0).max(1_000_000),
        pendingChunks: z.number().int().min(0).max(1_000_000),
        pendingMs: z.number().int().min(0).max(1_000_000),
        queuedMs: z.number().int().min(0).max(1_000_000),
        ducked: z.boolean(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === 'client_error') {
      if (!value.operation) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['operation'], message: 'operation is required' });
      }
      if (!value.message) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['message'], message: 'message is required' });
      }
      return;
    }
    if (!value.reason) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'reason is required for a playback_health report' });
    }
    if (!value.stats) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stats'], message: 'stats are required for a playback_health report' });
    }
  });

router.use(cookieAuthMiddleware);

router.post('/', validateBody(reportSchema), (req: Request, res: Response) => {
  const report = req.body as z.infer<typeof reportSchema>;

  const correlation: Record<string, unknown> = {
    ...(report.runtime ? { runtime: report.runtime } : {}),
    ...(report.workerSessionId ? { workerSessionId: report.workerSessionId } : {}),
    ...(report.recentEvents ? { recentEvents: report.recentEvents } : {}),
  };

  if (report.kind === 'playback_health') {
    // The stats ARE the record: a reader must not have to do arithmetic on the
    // client, and at `lane_end` a non-zero pendingMs is the stranded audio.
    logger
      .child({
        operation: 'playback_health',
        reason: report.reason,
        stats: report.stats,
        ...(report.detail ? { detail: report.detail } : {}),
        ...correlation,
      })
      .warn('client playback health');
    res.status(204).end();
    return;
  }

  const fields: Record<string, unknown> = {
    operation: report.operation ?? 'unknown',
    ...correlation,
  };
  const errShape = {
    name: report.errorName ?? 'Error',
    message: report.message ?? 'unspecified client error',
    ...(report.stack ? { stack: report.stack } : {}),
  };

  logger.child(fields).error('client error report:', errShape);

  // 204: accepted, nothing to say back. The client is fire-and-forget.
  res.status(204).end();
});

export default router;
