# Child H — `/autocompact75 handoff` from the Pi Web UI frontend: reproduced, root-caused, fixed, live-validated

- Child session: `01a0a42e-e5b1-7422-bc57-0560c028e9fd`
- Repos touched: `/root/pi-enhancement` only (6 files). `/root/pi-web-ui-wt-handoff` was **read-only** (clean tree, no diff) — the failing layer is not in Pi Web UI.
- Evidence: `logs/` beside this file. Every claim below cites an artefact there or a command whose output is in one.
- Status: **fix complete + isolated end-to-end live-validated. Nothing deployed, nothing committed** (parent owns both).

---

## 1. Reproduction — the operator's exact failure, from his own session

The operator's referenced session log *is* the session he tried to hand off. His attempt is in the
production journal (not in the JSONL, because the extension refused before writing anything):

`logs/04-live-reproduction.log`

```
Sep 15 08:20:14 [auto-compact-75] Session runtime fenced [2026-09-15T07-56-10-243Z_01a0a410-…jsonl]:
  session changed outside this runtime: disk entry sequence differs from the loaded session (157 on disk, 155 in memory)
Sep 15 08:20:14 [auto-compact-75] auto-compact-75: handoff refused: session changed outside this runtime:
  disk entry sequence differs from the loaded session (157 on disk, 155 in memory)
```

Consequence (operator-visible): the refused attempt **fenced the live Web UI session** — every later prompt is
rejected until a resync. There is no lease file for that session on disk, no `auto-compact-75-safety` entry in
its JSONL and no `handoff`/`claim` string anywhere in the session: the refusal happened at the freshness gate
*inside* `beginOwnershipHandoff`, before any lease/handoff state was written.

Independent disposable reproduction, driven exactly like the operator drives it — typing the command into the
chat and sending it over the **browser WebSocket path** (`scripts/ws-validate.mjs`, the protocol the browser
speaks), deployed extension v2.6.0, port 3093:

```
$ node scripts/ws-validate.mjs --base http://localhost:3093 --password dev-password --origin http://localhost:3000 \
    --session /tmp/ac75-val/pi-sessions/…01a0a440….jsonl --step command --text "/autocompact75 handoff"
 {"verdict":"OK notification received",
  "notification":{"message":"auto-compact-75: handoff refused: session changed outside this runtime:
     disk entry sequence differs from the loaded session (9 on disk, 8 in memory)","type":"warning"}}
```

and the next prompt on that session was rejected:

```
 "notification":{"message":"Session input blocked: session changed outside this runtime: disk entry sequence
   differs from the loaded session (9 on disk, 8 in memory). Run /autocompact75 resync when idle …"}
```

Boot/teardown for that server: `logs/boot-validation-server.sh` (transient `systemd-run` unit, outside the
`pi-web-ui.service` cgroup per the restart rule); teardown via `scripts/validation-server-stop.mjs`.

## 2. Root cause (failing layer: the extension's handoff gate under the Web UI host — not the client, not the send path, not command registration)

`/autocompact75` **is** registered in Web UI pi sessions and **does** execute server-side
(`[PiService] Commands: autocompact75`; `AgentSession.prompt()` resolves extension commands before any
streaming/ownership guard, so the browser path reaches the handler). The gates then rejected the handoff:

`beginOwnershipHandoff` called `verifyCompactionSafety(ctx, { requireMemoryContentMatch: true, fenceOnAppendOnly: true })`.
`fenceOnAppendOnly: true` suppresses the v2.3.0 classification that every other path uses, so an
**append-only disk tail this runtime never loaded** is treated as "session changed outside this runtime":
`fenceOwnership(...)` + refusal.

The tail is host-induced, not a competing writer. At the refusal instant the file had exactly 157 entries and
the runtime's view had 155; the two disk-only entries are the **last two** on disk and were appended after the
runtime's last in-memory entry:

```
5aaa9bee custom/bg-shell-tasks 2026-09-15T08:18:52.179Z
59e8e57e custom/background-tasks 2026-09-15T08:18:53.010Z
```

Those are sibling-extension registry snapshots (`background-shell` / `subagent` persist them via
`pi.appendEntry` on session lifecycle events). They reached the file through a SessionManager the command's
runtime does not read from — i.e. an extension instance whose `pi` binding survived a session
rebind/rehydration and persisted through the older SessionManager. That is why disk grew while memory did not,
and why it persisted (80 s later) rather than being a transient flush window.

The extension's **own classifier** agrees that this state is adoptable, not divergent — computed read-only
against the real production file with the memory view reconstructed as the first 155 entries
(`logs/classify-production-state.mjs` → `logs/02-production-classification.log`):

```
{"fresh":false,"reason":"disk entry sequence differs from the loaded session (…, 155 in memory)",
 "appendOnlyDiskAhead":true,"canFastForward":true,"suffixEntries":[{"id":"5aaa9bee","type":"custom"},
 {"id":"59e8e57e","type":"custom"}, …]}
```

So the handoff gate alone disagreed with the rest of the extension (75 % deferral, `agent_settled` adoption,
`/autocompact75 resync`) about a state all of them call adoptable — and its disagreement both refused the
handoff and fenced the session.

**A second, independent half of the same defect surfaced during validation:** the same sibling snapshots are
appended when a *target* opens the session. The offer pinned a whole-file SHA-256, so the target's own
load-time append invalidated the offer, and `claim` refused permanently — leaving the session fenced by its own
offer and unclaimable by anyone (`Ownership: conflict … run /autocompact75 claim` in the target, and
`claim` → `session changed after the handoff was offered`). Reproduced on a disposable server with the v2.7.0
handoff-side fix already in place (see §4, "before" run).

## 3. Fix (pi-enhancement, `auto-compact-75` v2.6.0 → **v2.7.0**)

Two coordinated changes; every safety gate that decides *who owns what* is untouched.

1. `index.ts` — `beginOwnershipHandoff` is now async and, **before** the unchanged strict gate, adopts an
   append-only disk tail through the existing shared `adoptAppendOnlyDiskTail()` (lease-verified, pinned
   fingerprint verified before/after). Then it applies `verifyCompactionSafety(..., { fenceOnAppendOnly: true })`
   exactly as before, so the pinned handoff fingerprint covers the whole file the target verifies.
   An adoption failure falls through to that gate, which fences exactly as before. Non-idle / queued /
   compaction-in-flight refusals are unchanged.
2. `session-ownership.mjs` + `index.ts` — the offer now also pins `sessionBytes` (`fingerprintSessionFile`
   returns it). New `inspectHandoffPin()` accepts the offer when **either** the file is byte-identical **or**
   the pinned byte prefix is still byte-identical (SHA-256 over exactly the pinned length, file
   newline-terminated) and the file only grew with whole appended lines. `claimSessionLease()` and the
   target's `fastForwardIntentionalHandoff()` both use it; the promote-time confirm compares against the
   fingerprint observed at claim time. Rewrites, reordering, truncation, partial writes, and offers written
   before the byte length existed (old leases) all still fail closed and preserve the offer.

**Deliberate behaviour change, called out explicitly:** this relaxes one documented invariant — "a changed
JSONL is refused without granting ownership" now means "a JSONL changed in any way other than append-only
growth". It was necessary, not cosmetic: on this host *both* the idle source and the freshly opened target
persist sibling snapshots into the session file, so a whole-file pin made `handoff`/`claim` unusable in
practice (proven live, §4). The replacement rule is a byte-exact prefix proof, which is *stronger* than the
entry-subsequence heuristic the same extension already accepts elsewhere (v2.3.0), and any non-append change
still refuses. The prior pinned expectation was updated in the test suite rather than left contradictory —
`tests/auto-compact-75-ownership.test.mjs` now asserts append-only growth is claimable and adds explicit
**rewrite**, **truncation**, and **promotion-race** refusals.

## 4. RED / GREEN

RED (before the fix) — `logs/01-red-unit.log`, new scenario in
`tests/extension-session-ownership-runtime.test.mjs` (idle owner holding the lease, append-only host tail):

```
AssertionError: handoff must adopt an append-only disk tail written by the hosting process instead of
refusing it as external divergence
  actual:   'auto-compact-75: handoff refused: session changed outside this runtime: disk entry sequence
             differs from the loaded session (3 on disk, 2 in memory)'
  expected: /handoff ready/iu
```

RED for the claim side (`logs/01-red-unit.log` run before `sessionBytes` existed; `logs/05-red-target-side.log`):

```
AssertionError: the offer must pin the offered byte length so append-only growth can be proven
  actual: 'undefined'  expected: 'number'

AssertionError: a target must claim a handoff whose pinned prefix only gained appended entries
  actual: 'auto-compact-75: ownership claim refused because this loaded session is stale: the session changed
           after handoff was offered. Close and reopen the session runtime from disk; …'
  expected: /fast-forwarded.*ownership claim complete/iu
```

(The target-side RED was produced by temporarily reverting only that pin check in a file copy — no git
operations — then restoring; the fix source is intact, verified by `grep -c inspectHandoffPin index.ts` = 2.)

GREEN — all 14 auto-compact-75 suites, `logs/06-suite-green.log`:

```
auto-compact-75 / -resume / -diagnostics / -ownership / -observability / -retry-resilience   PASS
compaction-recovery-coordination, compact-observability, session-ownership-transient-retry,
session-ownership-two-process                                                                PASS
extension-compaction-runtime, extension-session-ownership-runtime,
extension-session-dispose-ownership-runtime, goal-engine-session-ownership-runtime           PASS
```

New assertions that now hold: append-only source tail → `handoff ready` + offer `state=handing_off` +
`sessionFingerprint` == `sha256sum` of the whole file (including the adopted tail) + source self-fenced;
append-only growth after the offer → claim accepted; appended entries adopted by the target; successful
claim leaves the target owned and unfenced; rewritten / truncated / promoted-race JSONL still refused.

## 5. Isolated end-to-end validation (`logs/e2e-validation.sh` → `logs/03-e2e-validation.log`)

Disposable server on port 3220, `systemd-run` transient unit `ac75-val3` (outside the service cgroup), with
**`PI_AGENT_DIR=/tmp/ac75-agent`** holding an isolated extension copy (v2.7.0 source) — the deployed mirror at
`/root/.pi/agent/extensions` was never written to (fingerprints differ: repo `ab51773b2182b63c`, deployed
`ab626e259b812b5e`) — plus isolated `PI_SESSION_LEASE_DIR`. Real DeepSeek V4 Flash turns; the two LLM calls
were the only provider cost.

**Scenario A — Web UI → CLI, with the host append-only tail (the reported path):**

```
source session: /tmp/ac75-val3/pi-sessions/…01a0a448-b0d9….jsonl
--- one real turn over the browser-WebSocket path            {"verdict":"OK agent_end"}
--- host-shaped append-only tail (sibling snapshots, disk only)
--- /autocompact75 handoff via the browser-WebSocket path
    "auto-compact-75: handoff ready; this source is fenced. Open the same session on the target and run
     /autocompact75 claim (or takeover)."
--- offer lease: {'state':'handing_off','extensionVersion':'2.7.0',
                  'sessionFingerprint':'dddcb646…','sessionBytes':7891}
--- the CLI target's own load appends its sibling snapshots too (this is what broke the old whole-file pin)
--- claim from a real pi CLI process
    "auto-compact-75: ownership claim complete; this target may continue the session"
```

**Transfer proved functionally complete, not just a lease flip:**

```
$ pi -p 'Reply with exactly: HANDOFF-TARGET-OK' --session <source jsonl>   →  HANDOFF-TARGET-OK
$ (browser WS prompt on the same session)  →  "Session input blocked: this runtime intentionally handed off
                                              ownership and is now fenced. Run /autocompact75 claim in this
                                              target runtime."
```

**Scenario B — must still refuse (mismatched source):** offer, then rewrite an offered entry in place →
`auto-compact-75: ownership claim refused: session changed after the handoff was offered`, and the offer is
preserved for diagnosis (`offer preserved: handing_off`, lease present).

**Scenario C — must still refuse (non-idle source):** handoff sent over the browser path while a real turn was
running → `auto-compact-75: handoff refused: the session is still running or has queued messages`, and the run
completed normally afterwards (`agent_end`) — the busy source was neither fenced nor damaged.

## 6. Changed-path inventory

`/root/pi-enhancement` (6 files modified, no new files, nothing committed):

| Path | Change |
|---|---|
| `auto-compact-75/index.ts` | async `beginOwnershipHandoff` + append-only pre-adoption; target-side pin uses `inspectHandoffPin`; `await` at the command site |
| `auto-compact-75/session-ownership.mjs` | `fingerprintSessionFile` returns `bytes`; offer stores `sessionBytes`; new `inspectHandoffPin`; `claimSessionLease` uses it |
| `auto-compact-75/diagnostics.mjs` | version `2.6.0` → `2.7.0` |
| `auto-compact-75/README.md` | v2.7.0 bullet; fingerprint-pinning paragraph now documents the append-only exception and its retained guarantees |
| `tests/auto-compact-75-ownership.test.mjs` | append-only claim accepted (+`sessionBytes` pin); rewrite, truncation refusals |
| `tests/extension-session-ownership-runtime.test.mjs` | host-tail handoff scenario, divergent-tail refusal, target-claim-with-growth scenario |

`/root/pi-web-ui-wt-handoff`: **no changes** (`git status --short` empty).
`/root/pi-web-ui` main checkout: only this handback (`operations/…/child-handoff/`), untracked. Note
`scripts/p27-ws-transport-validate.mjs` shows as modified there — **not mine**; I never wrote to that checkout.
`/root/.pi/agent/extensions/auto-compact-75` (deployed mirror): **untouched**, still v2.6.0.

## 7. Deployment the parent must perform (nothing was deployed)

1. **Deploy the extension by copy** (the extension is deployed by copy, not by path):
   `cp -r /root/pi-enhancement/auto-compact-75/. /root/.pi/agent/extensions/auto-compact-75/`
   — copy the whole directory (it includes `diagnostics.mjs`, `session-ownership.mjs`, `resume.mjs`).
2. **Restart the host process.** Live pi sessions load the extension at session creation; the Web UI caches
   imported `.mjs` modules per process (documented caveat), so a running `pi-web-ui.service` will keep serving
   stale code to *newly created sessions* — `systemctl restart pi-web-ui.service` (owner-gated; pre-check
   `activeTurns: 0` and no non-terminal run receipts, as in previous sessions). The global `pi` CLI needs no
   restart.
3. **Verify**: load a Web UI pi session and run `/autocompact75` — expect version `2.7.0` and source fingerprint
   `ab51773b2182b63c` with no "source on disk differs" warning; then `/autocompact75 handoff` on an idle session.
4. Commit/push as the parent sees fit (`auto-compact-75 v2.7.0` + tests + README).
5. No Pi Web UI change, no `server/dist` build, no contract bump, no production restart for any other reason.

## 8. Limits, deliberate decisions, and follow-ups I did not take

- **Not reproduced by the triggering writer path itself.** The *state* was reproduced two ways (a real
  disposable session given the identical host-shaped tail, and the disposable session's own load-time sibling
  appends), but I did not reproduce the stale-`pi`-binding event that produced production's tail. The
  classification of that state is proven by the extension's own classifier on the production file (§2). The
  underlying host behaviour — sibling extensions persisting snapshots into a session file through a non-current
  SessionManager, at session load and after handoff — is a **separate, pi-web-ui-side follow-up** worth
  investigating (evidence: entry types/timestamps in §2 and §5); auto-compact-75 now tolerates it rather than
  fencing.
- **The claim-side relaxation is deliberate** (§3) and flips one previously pinned expectation; if the parent
  would rather keep whole-file strictness, the handoff-side half (§3.1) still fixes the reported refusal, but
  the transfer will then fail at `claim` on this host, as the "before" run in §5 shows.
- I did not exercise the handoff from the *browser GUI* (clicking in the page): the browser path was driven
  over the same authenticated WebSocket the client uses, which is the documented equivalent for extension slash
  commands (`docs/LIVE-VALIDATION.md`, Option 3). No client-side interception is involved — `/compact` is the
  only client-intercepted command and `/autocompact75 …` is not it.
- All disposable servers were run under transient `systemd-run` units outside the service cgroup and stopped
  with the repo stopper; ports 3093/3210/3220 are free; the isolated agent dir (which held a copy of
  `auth.json`) and all `/tmp/ac75-*` artefacts I created were deleted; no production service was touched.
