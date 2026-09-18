# Independent verification — Gate-5 harness change (runtime-validator, 2026-09-18)

**Verifier:** `runtime-validator` subagent, run `sa_mu6itjix_25cxjl` / task `bg_mu6itjix_25cxjl`,
32 turns, 62 tool calls, ~21 minutes. **Target:** `2900997` (checkout `794eec9`, ledger docs only
apart from the target). **Repository left clean**; scratch probes retained at `/tmp/verify-slice-*.ts`
and copied beside this file.

## Verdict: partial pass — and the partial part was real

### Verified (reproduced by the verifier, not taken from the author)

1. **The audits fail where they must** — synthetic logs at
   `/tmp/verify-slice-audits.ts` (`npx tsx`), output:
   `NO_MATCHING_CONFIRM_AUTHORISED: gateLeak=FAIL`,
   `DELIVERY_SHA_DOES_NOT_MATCH_KERNEL_DIGEST: gateLeak=FAIL byteFidelity=FAIL`,
   `WORKER_STORE_INSTRUCTION_NEVER_DELIVERED: byteFidelity=FAIL workerStoreCoverage=FAIL`,
   `WRAPPED_STORE_TEXT_CONTAINS_DELIVERY_PLUS_EXTRA_BYTES: byteFidelity=FAIL workerStoreCoverage=FAIL`;
   and pass where they must (`CORRECT_EXCERPT_SHAPED_LOG`, `CORRECT_LEGACY_FULL_TEXT_LOG`,
   `CORRECT_TRUNCATED_EXCERPT_CHAIN` — all PASS).
   The committed audit tests also passed independently: 2 files / 12 tests, exit 0.
2. **Live re-run** (exact required command): first attempt exited 1 (live ASR rendered the S3
   instruction's "changelog" as "change log", so the second parked item was not recognised);
   **second attempt exited 0** — 3/3 scenarios, gate leak clean (2 deliveries verified), byte
   fidelity 100%, worker-store coverage clean (`unauthorised=0 wrapped=0`). Evidence JSONs agree.
3. **Engine selection and hygiene**: the disposable server logged
   `Voice Mode engine selected: gemini-live`; the lane went live; the state dir was kept for
   inspection; no `validation-server-child` process remained after the run.

### The counterexample it found (and what was done about it)

An adversarial probe (`/tmp/verify-slice-adversarial.ts`) demonstrated that a **truncated delivery
excerpt extended with extra bytes** passed the gate-leak audit while the worker store carried the
extended text:

```
TRUNCATED_PREFIX_EXTENSION: gateLeak=PASS byteFidelity=PASS workerStoreCoverage=PASS
```

Cause: `excerptMatches()` accepted prefix-compatible excerpts whenever either side was truncated,
and the coverage audit consumed the delivery log's own claim about what it carried.

**Fixed on 2026-09-18** (commit follows this evidence): excerpts that come from the SAME underlying
bytes must now be **byte-identical** when both are truncated; prefix compatibility survives only for
the legitimately mixed case (one full field, one truncated excerpt). The coverage audit now consumes
the proposal's own creation-derived bytes, never the delivery frame's claim. Re-running the
verifier's own probe against the fixed code gives:

```
TRUNCATED_PREFIX_EXTENSION: gateLeak=FAIL byteFidelity=FAIL workerStoreCoverage=PASS
TRUNCATED_PREFIX_EXTENSION_DETAILS: ... reasons=bytes-mismatch,authorised-bytes-mismatch
```

Remaining, recorded honestly: the probe's `ARBITRARY_ALLOWLIST` case (`workerStoreCoverage=PASS`)
is the audit's allowlist parameter accepting any text. The runner passes exactly one frozen
constant (`SLOW_WORKER_PROMPT`); the allowlist is a reviewed-constant requirement, not a data path,
and is commented as such in the code.

### What the verifier could not establish

- Whether the live kernel can emit the malformed/hostile excerpt shape — the counterexample shows
  an audit weakness, not a live leak.
- A green live run on the first attempt: the observed S3 ASR variance is the provider's, not the
  product's, and is now recorded as a known live-ASR flakiness class (S2 is mitigated by an honest
  retry; S3's beat cannot be retried without changing the expected item count, so it is documented
  instead).
