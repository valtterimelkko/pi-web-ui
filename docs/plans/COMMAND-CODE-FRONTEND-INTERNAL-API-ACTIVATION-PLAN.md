# Command Code Frontend + Internal API Activation Plan

## Objective

Complete and verify the released Command Code integration across:

1. the browser-facing WebSocket/frontend path; and
2. the authenticated Internal API shadow path;

while preserving containment, shadow/browser isolation, MCP/Drive Mode exclusions, and the prohibition on production restart or production configuration changes during this execution.

## Guardrails

- Do not restart, reconfigure, or validate against `pi-web-ui.service` or its default Internal API socket.
- Use disposable validation servers and provider-free Command Code fixtures only.
- Keep browser-contained sessions WebSocket-only; Internal API remains shadow-only.
- Keep `PI_INTERNAL_API_COMMANDCODE_ENABLED=false` and `PI_COMMAND_CODE_BROWSER_ENABLED=false` as repository defaults.
- Do not add Command Code to MCP, Drive Mode, or disposable `--runtime all`.
- Read `docs/SELF-NOTIFICATIONS.md` and use `scripts/notify.sh` only at meaningful milestones, questions, and completion; never include secrets or transcripts.
- If the Internal API response contract changes, update `docs/INTERNAL-API-CONTRACT.md` and `/root/agent-os/docs/PI-WEB-UI-INTERNAL-API-CONTRACT.md` together, update Agent OS types/client/tests, and bump the minor contract version only for a genuinely additive public change.

## Phase 0 — Baseline and contract audit

- Record clean repository state and current release commit.
- Compare Pi Web UI contract `1.19.0`, runtime capability/model/effort projections, shadow attestation request/response shapes, and browser exclusion semantics with Agent OS's mirrored contract, `src/pi-web-ui/client.ts`, types, and tests.
- Identify stale assumptions without touching production.
- Run focused baseline tests in both repositories before changes.

## Phase 1 — TDD contract-parity fixes, if required

- Write failing Agent OS tests for any mismatch found, especially:
  - dynamic exact Command Code model catalogue and model-scoped native effort metadata;
  - `commandcode` capacity/runtime typing when present;
  - shadow-only role/attestation request requirements;
  - browser-contained exclusion from Internal API routes;
  - current `1.19.0` output-evidence/usage projections if consumed by Agent OS.
- Implement the smallest parity fix in Agent OS and update its mirrored contract documentation.
- Add/update Pi Web UI contract docs only if the public API actually changed.
- Run Agent OS focused tests and Pi Web UI focused contract tests.

## Phase 2 — Disposable Internal API live validation

- Boot `npm run validate:server -- --command-code-fixture` in a fresh disposable directory.
- Exercise the authenticated Unix-socket Internal API shadow path:
  - health/capabilities/models exact discovery;
  - attested `commandcode` session creation;
  - prompt dispatch and terminal receipt;
  - normalized transcript/history/evidence readback;
  - repeated stable readback and cleanup;
  - negative browser-contained-to-Internal-API isolation checks.
- Run the corresponding Agent OS disposable client/live proof against the same isolated socket where supported.
- Capture bounded evidence only.

## Phase 3 — Disposable browser/frontend live validation

- Boot a separate fresh disposable validation server with `--command-code-fixture --command-code-browser-fixture`.
- Exercise the authenticated browser WebSocket path, including the same availability message consumed by the frontend, exact model/effort metadata, session creation, prompt/stream/replay, and containment markers.
- Run localhost UI validation with `webapp-testing` where the fixture server can serve the production client bundle, or use the repository's authenticated WebSocket validator when browser UI hosting/auth is not available.
- Verify browser sessions do not appear in Internal API shadow list/detail/diagnostics/notification/receipt/transfer surfaces.
- Do not include the browser fixture in `--runtime all`.

## Phase 4 — Critical review and full gates

- Perform an independent read-only security/release review of both repositories.
- Run:
  - `npm run docs:check-agent-guides`
  - `npm run docs:check-links`
  - `npm run lint`
  - `npm run typecheck`
  - `npm run build`
  - `npm test`
  - relevant Agent OS typecheck/tests/docs checks
  - `git diff --check` and secret/artifact scans.
- Confirm no production service/process was restarted and no production env/state was modified.

## Phase 5 — Commit and push

- Review staged file list and stats in each repository.
- Commit Pi Web UI changes if any, then push `origin/master`.
- Commit Agent OS counterpart changes if any, then push `origin/main`.
- Send a final Telegram `done` notification with commit hashes and validation evidence.
- Stop before any production restart or production configuration enablement; provide the operator-only activation handoff separately.

## Completion evidence

The objective is complete only when:

- both disposable live paths pass independently;
- any contract consumer parity is updated and tested in both repositories;
- all required tests/build/docs/security checks pass;
- both repositories are clean and pushed;
- no production restart/configuration/action occurred;
- milestone and final self-notifications were accepted by the local notification API.
