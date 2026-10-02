# Hb3 — Streaming-path telemetry, and the Pi `DELETE` cost (plan H3 items 2 and 5)

> **Status:** in progress — this bundle is filled as the lane's evidence lands; the coordination directory
> `/root/orch-ops/orchestration-scaling/hb3/complete.md` is the completion record.
> **Worktree:** `/root/.worktrees/orch-scaling/hb3-pi-web-ui` (branch `orch/hb3`, from master `6a70238d`).

## 1. Streaming telemetry (H3 item 2)

Design and shipped files: see `docs/OBSERVABILITY.md` § "Streaming-path telemetry (Hb3)" — the additive
`streaming` reading field (span summary receipt→dispatch, per-provider chunk rate, max provider gap),
bounded aggregation, sampler-only source, `OBSERVABILITY_STREAMING_TELEMETRY` knob.

### Unit tests (strict TDD)

To be recorded.

### Live proof (disposable server)

To be recorded.

## 2. `DELETE /api/v1/sessions/:id` cost (H3 item 5, G4 §6)

To be recorded.

## Blind spots (what this evidence does NOT see)

To be recorded.
