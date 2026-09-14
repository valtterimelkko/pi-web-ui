# Pi Codex compaction session-ID patch — RETIRED

> **Retired 2026-07-17.** The defect this doc describes was fixed **server-side by OpenAI** on 2026-07-14 — no pi code change was needed or merged. The postinstall patch, the patch scripts, the extension auto-heal, and the regression tests have all been removed. This doc remains as a historical record and diagnostic reference.

## Resolution

- Defect: compaction summary requests went out without the session ID; the Codex backend mapped sessionless/UUIDv4-identified requests for `gpt-5.6-luna` to an invalid alias and failed with `Model not found gpt-5.6-luna-free-1p-codexswic-ev3` (upstream: [earendil-works/pi#6477](https://github.com/earendil-works/pi/issues/6477), superseded by [#6555](https://github.com/earendil-works/pi/issues/6555)).
- 2026-07-14 — OpenAI fixed the backend mapping; maintainer-confirmed ("UUIDv4 works now, OpenAI fixed it on their end, no changes needed" — [#6584](https://github.com/earendil-works/pi/pull/6584), closed unmerged along with [#6533](https://github.com/earendil-works/pi/pull/6533); #6555 closed).
- 2026-07-17 — retirement executed:
  - This repo: embedded SDK restored to pristine 0.80.6; postinstall hook, `scripts/patch-pi-codex-compaction-session-id.mjs`, and both regression tests (`pi-codex-compaction-session-id.test.ts`, `pi-codex-compaction-patch-script.test.ts`) removed.
  - `/root/pi-enhancement`: patcher script, `pi-update` patch-reapply step, and the auto-compact-75 arity probe/auto-heal removed (extension v2.1.0). Global CLI install (0.80.9) restored to pristine from patch backups verified byte-identical to the published npm tarball.
  - Live verification: pristine SDK 0.80.9 compacted successfully on `openai-codex/gpt-5.6-luna` (sessionless summarization request accepted by the Codex backend).

## If Codex compaction ever fails again

Do **not** resurrect the patch blindly — first reproduce on a pristine install, then check upstream ([earendil-works/pi](https://github.com/earendil-works/pi/issues)) for a recurrence. The retired implementation (replacement snippets, classifier, tests) is preserved in git history: this repo pre-retirement and `pi-enhancement` commit `db991c7`.

## History

- 2026-07-09 — Luna compaction failure diagnosed; embedded SDK patched (`026c651`), full server suite + real cloned-session compaction verified.
- 2026-07-09 — Patch script made upstream-aware; fixture tests added (`c4a7128`). Global CLI patched; `pi-update` wrapper + extension integrity probe added (pi-enhancement).
- 2026-07-10 — Extension auto-heal after `pi update`; `/autocompact75 compact`; live-validated across all three Codex 5.6 models over the browser WebSocket path.
- 2026-07-14 — OpenAI fixed the backend server-side; upstream issues #6477/#6555 closed without a code change.
- 2026-07-17 — Patch ecosystem retired after live-verifying pristine SDK compaction on Luna; both installs restored to pristine.
