# F1 — CI portability: GitHub "Application correctness" red since wave 3

Lane `f1`, worktree `/root/.worktrees/orch-scaling/f1-pi-web-ui`, branch
`orch/f1`, base master `10149827`. No push, no merge, no rebase.

**Outcome.** The four test files that made the workflow red on every master
push since the wave-3 merge now pass under runner-like conditions (user
`nobody`, temp `HOME`, an unreadable `chmod 000` directory first on `PATH`,
unreadable `/root`, CI-style `/tmp`), and the **entire server workspace** passes
there. **No production code changed**: parent answer `01-answer.md` (option A)
confirmed the brief's item-2 premise was false — the C4 lookup already skips
unreadable PATH entries, and the CI `EACCES` came from the test's own host
assertion (`dispatch-preflight-correction01.test.ts:38`). A deterministic
regression guard pins the property, and a planted fault proves the guard
catches its loss.

## Commits

```
9ffb37d1 test(internal-api): make CI-red tests host-independent
34b61701 test(internal-api): guard unreadable/erroring PATH entries in C4 preflight
<evidence commit> docs(plans): F1 CI portability evidence bundle
```

`git diff --stat master...HEAD` (code commits): 5 files changed, 118
insertions(+), 19 deletions(-) — all `server/tests/unit/internal-api/*`.

## The CI failure and the fix

`ci-fail-10149827.log`: 4 test files / 5 tests failed; all four failed for
host-state reasons on the runner (HOME=/home/runner, no agent CLIs, `/root`
unreadable, C4's default-on cwd preflight):

| File | Runner failure | Fix |
|---|---|---|
| `dispatch-preflight-correction01` | test asserted the host fact `/root/.local/bin/agy` exists (EACCES at line 38) | simulate the host fact through the injectable `PreflightFs`; `runtimeChildPathEnv` composition stays real |
| `dispatch-preflight-routes` | expected 201 for `agy` on antigravity, but `agy` is not installed on the runner (400 `PREFLIGHT_FAILED`) | resolve a fixture executable created by the test in a temp dir on the shrunken `PATH`; assert resolution for antigravity/claude and the exact refusal shape for a missing tool |
| `parent-resolver` | real `/proc` scan returned `null`: correction 02 fails closed on EACCES from other users' `/proc/<pid>/fd`, which an unprivileged process cannot avoid | restrict the scan's dirent list to this process; keep the real `/proc/<self>/fd` readlink path; injected-io fail-closed tests unchanged |
| `pi-control-lazy-load` | two create bodies used `cwd: '/root/pi-web-ui'`, refused by the C4 cwd preflight | use the test's own temp dir (`mkdtemp`) |

## TDD receipts (RED at base → GREEN at HEAD)

The RED/GREEN environment is an unprivileged reproduction of the runner:
private mount namespace, user `nobody`, `HOME` in a temp dir, a `chmod 000`
directory first on `PATH`, a CI-like 1777 `/tmp`, a self-contained git
checkout, and read-through bind mounts of the real `node_modules`. Harness:
`/root/orch-ops/orchestration-scaling/f1/repro-ci-nobody.sh`.

```text
RED (base 10149827, before the fixes):
$ bash /root/orch-ops/orchestration-scaling/f1/repro-ci-nobody.sh \
    .../repro/red-four-files.log \
    tests/unit/internal-api/dispatch-preflight-correction01.test.ts \
    tests/unit/internal-api/dispatch-preflight-routes.test.ts \
    tests/unit/internal-api/parent-resolver.test.ts \
    tests/unit/internal-api/pi-control-lazy-load.test.ts
→ exit 1 — Test Files 4 failed (4); Tests 5 failed | 67 passed (72)
   exactly the CI failure set (EACCES host fact; agy 400-vs-201; /proc null;
   create-time thinkingLevel 400-vs-201 ×2)

GREEN (HEAD, same harness):
$ ... green-five-files-final.log (same four + dispatch-preflight.test.ts)
→ exit 0 — Test Files 5 passed (5); Tests 95 passed (95)

Full server workspace, unprivileged:
$ ... nobody-full-server-suite.log tests
→ exit 0 — Test Files 568 passed (568); Tests 6935 passed | 37 skipped
$ ... nobody-src-security.log src/security/security.test.ts
→ exit 0 — Tests 14 passed (14)     [the one server test under src/]
```

## Swallowed-error probe (item 2) and the regression guard

The brief's premise was that `runDispatchPreflight` throws on an unreadable
PATH entry. Direct probe under the same harness at base `10149827`:

```text
$ F1_PROBE=1 bash .../repro-ci-nobody.sh .../repro/probe-eacces.log
probe report: {"ok":false,"failures":[{"kind":"tool","item":"agy","problem":"not found on PATH"}]}
exit=0
```

`toolOnPath()` catches `fs.stat`/`fs.access` errors and skips the entry exactly
like a missing one; the route returned 400, not 500, in the RED run. Per
`01-answer.md`, no product change. New guard tests in
`dispatch-preflight.test.ts` (green on the current code — no honest RED exists
for a defect that is not there): an EACCES PATH entry, a file whose `X_OK`
probe errors, and an EIO stat error are each skipped like a missing entry and
never escape `runDispatchPreflight`.

**Positive control (planted fault).** Temporarily rethrowing in `toolOnPath`'s
catch at HEAD:

```text
$ (planted rethrow) cd server && … npx vitest run tests/unit/internal-api/dispatch-preflight.test.ts
→ exit 1 — Tests 6 failed | 17 passed (23), including both new guards
$ (restored via byte-identical copy) same command
→ exit 0 — Tests 23 passed (23)
```

The product file was restored byte-identically; `git status` clean afterwards.

## Sweep for other CI-hostile assumptions (item 4)

- **Decisive check:** the *whole* server workspace (568 files under `tests/` +
  the 1 under `src/`; 6,949 tests) passes under the runner-like environment —
  exit 0. No other server test trips on the runner state.
- **Grep sweep** (`grep -rn --include='*.ts' --include='*.tsx' -E
  "['\"]/(root|home/runner)" server/tests client/src client/tests`): the
  remaining `/root/...` strings are mock data, expected echoed values or
  documentation fixtures (e.g. `session-routes-*.test.ts` registry `cwd` mocks,
  `files-crud`/`git` service mocks, `preferences`/`session-meta` session-path
  strings). None probes the filesystem, and none failed on the runner at
  `10149827`.
- **Host CLI/binary dependencies left in tests** (all present in the
  ubuntu-24.04 runner image and green in CI): `ss` (iproute2) in the
  `runSs` cases, `mkfifo` (coreutils), `/bin/sh`, `git` for
  `ci-workflow-paths`, Node itself. Not changed.
- **client workspace:** no `/root`, `home/runner`, `HOME` or `homedir()` hits
  in `client/src`/`client/tests`; client tests are unmodified and pass (1,657).
- **Filesystem-listing sensitivity (flagged, not fixed):** during harness
  iteration with `TMPDIR` on tmpfs, one upstream-SDK diagnostic-parity test
  (`pi/extension-factory-cache`: "conflicts with …" owner ordering between the
  cached and plain loader) failed; it passes with the CI-like ext4 `TMPDIR`
  and passed on the runner at `10149827`. The ordering originates in the
  upstream extension loader, is outside this lane's scope, and is listed as a
  residual for the parent.

## Disposable live proof (built worktree)

A disposable validation server (`npm run validate:server`, explicit `--dir`,
`--port 0`) booted from the built worktree under
`systemd-run --scope --collect` and was probed over its Unix socket (bearer
token from `internal-api-token`); the script is
`/root/orch-ops/orchestration-scaling/f1/live-preflight-probe.sh`.

```text
probe 1: POST /api/v1/sessions {runtime:"claude", cwd:<temp>, preflight:{tools:["f1-live-no-such-tool"]}}
→ HTTP 400 {"code":"PREFLIGHT_FAILED", …, "failures":[{"kind":"tool","item":"f1-live-no-such-tool","problem":"not found on PATH"}]}
probe 2: POST /api/v1/sessions {runtime:"claude", cwd:<temp>/absent}
→ HTTP 400 {"code":"PREFLIGHT_FAILED", …, "failures":[{"kind":"cwd","item":"…/absent","problem":"does not exist"}]}
```

Both refusals happen before any runtime/model work. Server stopped:
`kill` on the dedicated process group; server log shows a clean shutdown
("Server stopped", all shutdown steps complete);
`node scripts/validation-server-stop.mjs --dir … --timeout-ms 3000` → exit 0
("process group … already gone"); no validation-server process remained.

## Gates (all from the worktree, at HEAD)

| Command | Exit | Result |
|---|---|---|
| `npm run lint` | 0 | (no output) |
| `npm run typecheck` | 0 | all workspaces |
| `npm run build` | 0 | shared/server/client/internal-api-mcp |
| `npm run docs:check-links` | 0 | 1,313 links across 333 files |
| `npm run docs:check-agent-guides` | 0 | AGENTS.md/CLAUDE.md byte-identical |
| server `vitest run tests/unit` (as root) | 0 | 494 files, 6,031 passed, 3 skipped |
| `npm test` (all workspaces) | 0 | shared 249 · server 7,025 (+3 skipped) · client 1,657 · mcp 71 |
| unprivileged full server suite (runner-like) | 0 | 568 files, 6,935 passed, 37 skipped (+ src/security 14) |
| unprivileged five CI-red files | 0 | 5 files, 95 passed |

## Definition of victory (brief items)

1. **Reproduce CI locally first (RED).** Met — `red-four-files.log`, exit 1,
   5 failed / 4 files, identical failure set to `ci-fail-10149827.log`.
2. **Fix the product bug, RED first.** Not applicable — premise false
   (`01-answer.md` option A). Behaviour verified already true; regression guard
   added; RED not honest/possible. Planted fault proves the guard works.
3. **Host-independent tests.** Met — all four files fixed as above; no host CLI,
   no unreadable `/root`, no root-only `/proc` reliance, cwds from temp dirs.
4. **Sweep.** Met — whole server workspace passes unprivileged; grep sweep
   classified; residual items listed.
5. **Gates.** Met for lint/typecheck/build/docs, root full server unit suite,
   and cross-workspace `npm test`; the four files pass under CI conditions.
   The GitHub run itself is the parent's push step (not mine).
6. **Evidence.** This bundle + `complete.md` with `FROZEN` last.

## Blind spots (what this lane does not see or cover)

- The harness **approximates** the runner: Node v24.21.0 here vs v24.20.0 in
  CI; no `npm ci`; no coverage instrumentation; the GitHub runner's filesystem
  layout and environment are reproduced in effect (unprivileged user, HOME,
  PATH, `/tmp`) but not byte-for-byte.
- The **client** and `packages/internal-api-mcp` workspaces were not re-run
  under the unprivileged harness (no host-path hits in grep; unmodified by this
  lane; they pass locally and in CI).
- `dispatch-preflight-routes` no longer proves the antigravity prepend at the
  **route** level (that needed a host-installed `agy`); the prepend composition
  is pinned by the unit tests instead.
- `parent-resolver`: the real `/proc` success path now covers this process
  only; the cross-process/fail-closed paths remain covered by injected io, not
  by a real unprivileged scan (which the platform cannot provide).
- Item 2 has **no RED on the unfixed code** (no defect); the planted-fault
  control is the substitute evidence.
- The upstream-SDK diagnostic-order sensitivity noted above is not fixed here.
- The definitive GitHub confirmation is the parent's push; this bundle does
  not claim a green workflow run.

## Residual risks

- The GitHub runner could still surface an environment difference this
  approximation missed (mitigated by running the whole server workspace, not
  just the four files).
- The `session-routes-post-terminal-fence` "receipt started within 40 ms"
  assertion is timing-sensitive under parallel load (passed standalone and in
  the final full run, failed once mid-sweep during harness iteration). It is
  not host-bound and passed on the runner; left untouched (out of lane scope).
