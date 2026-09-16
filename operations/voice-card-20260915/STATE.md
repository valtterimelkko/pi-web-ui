# STATE — voice-card programme (current state, not a completion claim)

**Read this before acting. Rewritten at every fan-in / dispatch.**

- Socket: `/root/.pi-web-ui/internal-api.sock` · token: `/root/.pi-web-ui/.token-path` → `~/.pi-web-ui/internal-api-token`
- Repo: `/root/pi-web-ui` (branch `master`, HEAD `9690dba` at programme start) · production: `pi-web-ui.service`, contract **1.42.0**, run from `server/dist`
- Parent session: `01a0a410-f683-7422-bc57-055af50db3f2` (managed, cwd `/root/pi-web-ui`)

## Stage

W0 complete → W1 **ACCEPTED, committed and pushed** (`0798661`) → **W2b live validation running**.

## W1 verification (parent, independent of the child's own tests)

- Child run `770f8fa7` completed 08:21:03Z on `deepseek/deepseek-flash` (102 tool calls,
  750 insertions across 17 files). Handback: `child-card-contract/complete.md` (+ `logs/`).
- Parent re-ran the affected suites: server talker+transport **31 files / 416 passed**;
  client DriveMode + talkerBus **22 files / 209 passed**. (The baseline's "2 skipped" are
  `describe.skipIf(!API_KEY)` real-model tests in `talker-long-session.integration.test.ts`,
  which run only when `OPENROUTER_API_KEY` is in the shell — present in the parent's
  environment, absent in the child's, and stripped by `npm test`. No test was un-skipped
  or deleted.)
- Parent probe `parent-verification/seam-probe.ts` (13 checks, written from the operator's
  symptoms, not from the child's tests): **ALL PASS** — the whitespace-only case makes no
  tidy claim; `removed` carries fragments not the whole utterance; `original` is the raw
  bytes; both release variants are byte-identical to the payload the card was shown;
  a lapsed draft and an empty draft still refuse.
- Deviations adjudicated: **D-1 accepted** (session-registry pass-through — the variant
  cannot reach the one release path otherwise; no logic added), **D-2 accepted**
  (outgoing field lives in `useTalkerTurn.ts`), **D-3 accepted** — the pre-existing
  transport assertion that pinned the D1 defect (`removed` contains the whole utterance)
  was replaced by the frozen R2 contract, with a negative assertion beside it; the
  programme's R2 and that assertion could not both hold. **D-4 noted** (one shape-pin test
  added without a RED run; disclosed by the child).
- Doc: `docs/DRIVE-MODE.md` card paragraph updated by the parent to match the contract.


## Route deviation (recorded, 2026-09-15 08:13Z)

First dispatch used `opencode-go/deepseek-v4.1-flash` (the routing table's named pool
for this model). The turn ended in 0.7 s with **0 tool calls, 0 tokens, no text**;
the child's session JSONL carries the runtime's own error:

> `403 RegionError: The latest version of this model is only available hosted in China and requires explicit opt in`

So the opencode-go pool cannot serve this model for this workspace, and the
live commandcode catalogue carries no 4.1 entry. The operator named DeepSeek V4.1
Flash; the route actually available and already authenticated on this host is the
native pi provider entry **`deepseek/deepseek-flash`** (displayName "DeepSeek V4.1
Flash", the same selector this parent session runs on). Verified live before
re-dispatch: a one-line probe returned `PROBE-OK`. Route deviation is recorded here
and reported to the operator; the child's model binding was re-set and read back
(`/info` → `deepseek/deepseek-flash`).

## Baseline (parent preflight, 2026-09-15 ~08:10 UTC)

- `npm test --workspace=server -- tests/unit/talker tests/unit/websocket/talker-transport.test.ts` → 31 files / 396 passed / 2 skipped
- `npm test --workspace=client -- tests/unit/components/DriveMode` → 21 files / 193 passed
- Provider quota at dispatch: GLM peak window ACTIVE (avoid zai); command-code pool normal;
  opencode-go `deepseek-v4.1-flash` selected per operator instruction and the owner-approved route table.

## Children

| Child | Session id | Route | Owned paths | Status |
|---|---|---|---|---|
| `card-contract` | `01a0a41e-2e40-7422-bc57-055db541b7e3` | pi / `deepseek/deepseek-flash` ("DeepSeek V4.1 Flash") / high | server talker + ws seam, client DriveMode card | dispatched, running |

## Next sequence

1. On wake: reconcile the child (receipt, transcript, handback file, watch ledger) — all children, not just the one named.
2. Parent: re-run both suites + typecheck; write the parent seam probe; verify the brief's §4 invariants independently.
3. Commit + push path-limited (parent only), then dispatch W2b live validation on a disposable server.
4. W3 reviewer, then W4 operator-gated deployment.

## W2b (live validation, dispatched 08:26:30Z)

- Child `01a0a42c-b47d-7422-bc57-055e4ca4dd61` on pi / `deepseek/deepseek-flash` / high
  (created with the opencode-go selector then re-pointed with `set_model`, read back —
  the opencode-go pool is region-blocked, see the route-deviation note).
- Run `34c84bb3-bbf0-47ab-851f-a808140beedf` (detached) · retention lease `bae3603e-2d53-408c-a76f-e677e843f90c`
- Watch `watch-01a0a42c-…` generation `b7ec2084-1277-460e-a98a-1b40e0c8818f` (onFire follow_up → parent)
- Board: `live-validation` (dispatcher-registered) · `card-contract` marked left after its COMPLETE declaration
- Backstop `deadline-b08ff433-59a1-4dcc-b988-fde92db734fa` → 2026-09-15T09:11:42Z
- Validation must run on a **disposable** server with a local deterministic talker stub
  (`WAVE2B-APPROACH.md`); production untouched.

## W2b ACCEPTED (parent verification, 08:55Z)

`child-live-validation/complete.md` (+ 11 evidence files) reviewed. Live rows **L1–L7 all PASS**
with the bytes recorded, e.g.:
- L1 `"Proceed.\n"` → `proposal={"text":"Proceed.","cleaned":false}` (the operator's own case, now honest);
- L2 `"Um, tell the worker to rerun the suite"` → `cleaned:true`, `removed` = fragments, `original` = the raw words;
- L3/L4 seam byte-equality for the default and the original variant;
- L5a/L5b a non-confirm turn carrying the variant releases nothing;
- L6 invalid variant → `INVALID_MESSAGE` (L6-control still proposes);
- L7 lapsed draft → re-confirmation, gate unchanged.
Ran against frozen `0798661` on a disposable server with a **local deterministic talker stub** and all
provider keys stripped (`no-hosted-model-reconciliation.txt`: 11 sessions, every assistant text block
byte-equal to the stub). Production never contacted.

The single L8b FAIL was **a stale assertion in `scripts/p27-ws-transport-validate.mjs`** (row 17 asserted the
pre-fix shape: "a proposed result carries NO proposal object"). Parent fixed that row in place to pin the
fixed contract (proposal present; `cleaned=false` ⇒ no `removed`/`original`; `cleaned=true` ⇒ both strings).
Not a behavioural regression.

## Wake log

- 08:51:10Z **lost wake (TURN_STALLED)**: run `5a62bf6c-dbfd-45d5-9fa4-9d66bcd7600f` targeted THIS parent
  session, was accepted 08:36:09, produced zero events, and was terminalised by the run watchdog at
  08:51:10 (`watchdog.reason='idle'`, `idleTimeoutMs=900000`, cessation basis `watchdog`, `workState=failed`).
  A queued cross-session wake behind a busy parent was killed before it could run — the wake was lost and the
  operator got the quarantine notice. Reported to the stability child for its liveness write-up (queued).
  Consequence for this programme: the model-free `wake_deadline` backstop is load-bearing, not optional.
- 08:11:59Z stale-probe wake (run `34ea57a6`) reconciled 08:13Z — it was the *failed*
  first attempt's `agent_end`, not the real turn. Real run `770f8fa7` verified
  `running`; current watch generation `5c30b091…` active with 0 firings / 0 wake
  attempts (fresh budget); no handback yet; tree carries only untracked `operations/`.
  No repair needed, child left undisturbed.

## Wake-delivery record

- W1 primary: watch `watch-01a0a41e-2e40-7422-bc57-055db541b7e3`, generation **`5c30b091-f724-4085-98f5-5afb62d08d63`** (CAS-replaced after the failed first attempt; onFire follow_up → parent, maxWakeups 1)
- W1 dispatch runs: `534a0d95-0ef2-4b42-a698-0213e7fd8147` (opencode-go — failed: region-blocked, 0 tokens) · `3193e456-…` (attached probe, same failure) · `b09649dd-99c9-424e-8b78-cc9e84652224` (probe on deepseek/deepseek-flash → `PROBE-OK`) · **`770f8fa7-bff2-489d-b380-a4c6357ce119` (the brief, running)**
- Retention lease `25da24b0-d611-4e90-9609-1cc060653e93` (until 10:10Z)
- Wake path proven on this parent: the failed first attempt's `agent_end` fired the
  watch and dispatched a wake to the parent with `deliveryKind: "deferred-follow-up"`
  (run `34ea57a6-490f-47bb-931c-bb8bc3c5f4ae`) — delivery to this session works.
- W1 board: child entry name `card-contract` (dispatcher-registered); parent entry `pi-01a0a410`
- W1 backstop: `wake_deadline` `deadline-4aae97d4-4945-4c85-a708-c92ca318c522`, deadline 2026-09-15T08:55:53Z (model-free)
