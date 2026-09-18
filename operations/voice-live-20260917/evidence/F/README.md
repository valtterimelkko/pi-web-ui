# Track F evidence — disposable vertical-slice integration (plan Phase 5)

Everything in this directory is written by the Phase-5 gate run itself:

```bash
npx tsx scripts/voice-live-lab/cli.ts test-vertical-slice
```

which boots a disposable validation server from **this repository**, creates a
real disposable Pi worker session through that server's Internal API, attaches
Voice Mode to it, streams nine scripted operator utterances as genuine spoken
audio (Supertonic PCM16/16 kHz) over the authenticated `/ws` path through a real
`gemini-3.8-live` session, and runs the three Phase-5 scenarios.

## Files

| File | What it holds |
|---|---|
| `slice-run.json` | The complete machine-readable record: scenarios + every check, the negative-control record, the worker session facts, the fixture digests, every wire frame (audio redacted), and the audit results. |
| `gate-leak-audit.json` | Zero-gate-leak proof derived from the server's structured `voice-kernel` log lines: every delivery is preceded by its own `confirm_authorised` with the same proposal id, idempotency key and SHA, and carries byte-identical text. |
| `byte-fidelity-audit.json` | 100 % byte-fidelity proof: for each delivered proposal, the kernel's own digest over the retained bytes reproduces the confirmed SHA, the delivered bytes equal the proposal's `tidied` variant, and the worker session's own store contains those exact bytes. |
| `server-kernel-log.txt` | The `voice-kernel {...}` evidence lines extracted from the disposable server's JSON log, in order. |
| `worker-session-store.jsonl` | A verbatim copy of the disposable worker session's own store (the primary "what the worker actually received" record). |
| `run-summary.txt` | The human summary the gate printed, with every check and any failure. |
| `FINDINGS.md` | The integration findings (F-1…F-4), each with its observation, evidence and owner for the durable fix. |

## How to read the negative controls

`slice-run.json` → `negativeControl` (and the S2 checks) record:

- a **tampered `proposal_confirm`** (a wrong SHA echo, `00…00`) that must be
  refused with `voice_proposal_stale` and deliver nothing — the proposal stays
  live and confirmable;
- a **confirm frame carrying instruction text** (`"text": "rm -rf everything"`),
  which the contract's own envelope guard refuses with
  `voice_client_text_forbidden` before anything is acted on.

Both are asserted by the runner; either failing makes the gate exit non-zero.

## Reproducing

```bash
# GEMINI_API_KEY must be in the environment (the runner refuses otherwise).
npx tsx scripts/voice-live-lab/cli.ts test-vertical-slice
# or, with an explicit evidence directory and worker model:
npx tsx scripts/voice-live-lab/cli.ts test-vertical-slice \
  --evidence-dir /tmp/slice --worker-model google/gemini-3.8-flash
```

The disposable server's state directory is printed at the end of the run and is
kept for inspection (it is never production state: a fresh `mktemp` dir, an
ephemeral port, a per-run systemd scope outside the production cgroup).

## Live-run environment notes

- The gate was run from `/root/pi-web-ui-wt-integration` (branch
  `feat/voice-integration`) with the worktree's own `node_modules`.
- Run records are per-run: fixture audio is synthesised into the disposable
  state dir each time (its SHA-256s are recorded in `slice-run.json`), so a
  passing record cannot be replayed from a previous run's artefacts.
