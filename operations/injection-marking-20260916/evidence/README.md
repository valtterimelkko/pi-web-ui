# Evidence — injection marking live validation (2026-09-16)

Disposable servers only (never production). Two same-build legs differing ONLY
in the kill-switch env: LEGACY = `AGENT_OS_INJECT_CAPTURE_MARKING=0` (today's
behaviour, byte-for-byte), MARKED = unset (the new structural lane). The
extension symlink flip to the worktree build was scoped to session creation on
the MARKED legs and restored immediately (original target recorded and
restored: `/root/pi-enhancement/agent-os-inject`; verified after restore).

## What each file proves

| Path | Proof |
|---|---|
| `legacy/legacy-message-starts.json` | Wire: the capture injection arrives as `role:"user"` (index 5) — today's bug shape. Packet lane rides as `custom agent-os` INSIDE the turn (index 1), confirming it must not bound a turn. |
| `marked/marked-message-starts.json` | Wire: the capture injection arrives as `role:"custom", customType:"agent-os-capture"` — the structural mark. Everything else (operator prompt, packet lane, work answer) identical in kind and order to LEGACY. |
| `legacy/legacy-screen.json` vs `marked/marked-screen.json` | Screen-view projection: the capture wording renders as a USER item only in LEGACY (`capture_wording_items=1` vs `0`); every other projected kind comes from genuinely different model runs. Projection code itself is unchanged (unit-pinned equivalence in `server/tests/unit/talker/injection-marking-projections.test.ts`). |
| `legacy/legacy-full.json`, `marked/marked-full.json` | Full transcript projection: capture wording present as a user entry only in LEGACY (1 vs 0). |
| `legacy/legacy-history.json`, `marked/marked-history.json` | Normalised replay (pi path): LEGACY 14 message_end events (2 user incl. the capture prompt + 12 assistant); MARKED 8 (1 user + 7 assistant) — the injection drops out of replay; custom entries excluded in BOTH legs (packet lane absent from both). |
| `browser-legacy/legacy-ws-sent.json` | **The bug, live in a real browser**: Drive Mode (reading level headlines) sent TWO `talker_digest` requests — request 1 = the work answer, request 2 = the capture housekeeping ("Agent OS capture completed via the requested automated lane…") — i.e. the operator's spoken summary narrated the capture housekeeping. |
| `browser-marked/marked-ws-sent.json` | **The fix, live**: exactly ONE `talker_digest` request — the work answer only. The housekeeping answer (present in the transcript as the worker's second assistant message) is never submitted to the talker. |
| `browser-legacy/`, `browser-marked/` DOM txt | The Voice Mode surface rendered the worker's answers in both legs (side pane = the same VirtualizedMessageList; virtualized list → only visible items in DOM, so DOM absence is not evidence of absence — the authoritative session-view proof is the screen projection above). |
| `journal-legacy.jsonl`, `journal-marked.jsonl` | The extension's own journal: `agent_end capture-prompt outcome=delivered` fired in BOTH legs (the routine capture keeps happening exactly as today), then `skip:already-fired` (once-per-session guard intact). |
| `*.jsonl.gz` | Raw WS frame dumps for both legs (gzip; full event streams including every message_start/update/end and tool event). |
| `boot-ab.sh`, `boot-client.sh`, `flip-symlink.sh`, `drive-session.mjs`, `browser-drive.mjs` | The exact harness: disposable servers (systemd-run scopes, isolated dirs/ports/journals/vault), vite dev clients, reversible symlink flip, session driver (wire + projections), browser driver (Drive Mode flow + talker_digest capture). |
| `logs/server-*.log`, `logs/client-*.log` | Server/client boot logs (ports, sockets, allowed origins, extension load lists). |

## Environment facts (for re-running)

- Disposable servers: `npm run validate:server -- --dir <dir> --port <port>` under
  `systemd-run --scope --collect` (the wrapper refuses the production slice).
- `AGENT_OS_VAULT_ROOT` pointed at `/root/inject-lab-20260916/vault` — the REAL
  `agent-os` verb ran with real decision logic against a disposable vault; the
  capture candidates produced by the housekeeping turns landed there, never in
  the operator's vault.
- Session cwd `/root/inject-lab-20260916/workspace*` — deliberately NOT a
  `/tmp` validation-shaped path, because the verb's capture decision skips
  smoke-pattern cwds (`skip:smoke-cwd`).
- Browser sessions used Drive Mode's own new-session flow (model
  `openai-codex/gpt-5.6-luna`; the picker's `kimi-for-coding` quota was
  exhausted — verified separately).
- The wire driver used `zai/glm-5.3-flash` (canonical default child route),
  resolved live from `/models` (selector match enforced, refusal otherwise).
