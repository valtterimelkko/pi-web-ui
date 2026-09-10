# Investigation Report: Native CLI ↔ Pi Web UI Session Round-Trip

**Date**: 2026-09-10  
**Investigated By**: Child Worker `01a08a99` / Parent Orchestrator `antigravity-3099ab72`  
**Status**: Complete (Feasibility & Architecture Verified)

---

## Executive Summary
**Yes** — for every runtime supported by Pi Web UI (`pi`, `claude`, `antigravity`, `opencode`, `commandcode`), a session adopted or transferred into the frontend remains natively resumable in its original CLI, because Pi Web UI's adoption architecture links rather than converts native session artefacts.

The native files are the authoritative source of truth. However, there is currently no explicit "hand back / detach" UI affordance or concurrency guard in the frontend. Dual-sided concurrent execution is the primary operational hazard.

---

## 1. Two Distinct Concepts (Often Conflated)

| Mechanism | What It Does | Direction | File / Store Impact |
| :--- | :--- | :--- | :--- |
| **Adoption / Import** | Links an existing native CLI session into the Pi Web UI session registry (`origin: 'native-discovered'`). Continues it in-place via its native ID. | One-way link into Web UI; native artefact stays authoritative. | **Zero conversion or movement.** Native files stay in canonical CLI paths. |
| **Cross-Runtime Transfer** | Builds a bounded ($\le 1$ MB) visible-transcript handoff payload from a source session into a *new target session* of a different runtime. | One-way context transfer between disparate runtimes. | Creates new session in target runtime; source session remains intact. |

---

## 2. Per-Runtime Storage, Conditions, and Resume Commands

### 1. Pi (`pi`)
* **Storage**: Canonical `~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<uuid>.jsonl`.
* **Mechanism**: Pi Web UI uses the Pi SDK directly (`createAgentSession` in `server/src/pi/pi-service.ts:354,414`). Format is identical JSONL entries (`message`, `toolResult`, `custom`, `compaction`).
* **CLI Resume**: `pi -c` (in same working directory) or `pi --session <sessionId>`.
* **Round-Trip Status**: **Native YES**. Zero translation or export required.

### 2. Claude (`claude`)
* **Storage**: Native JSONL in `~/.claude/projects/<encoded-cwd>/<uuid>.jsonl`. Pi Web UI mirror in `~/.pi-web-ui/claude-sessions/<id>.jsonl` is for replay only.
* **Mechanism**: SDK backend generates a native `claudeSessionId` (`claude-sdk-service.ts:193`) and follow-ups invoke `{ resume: claudeSessionId }` (`claude-sdk-service.ts:804,837`).
* **CLI Resume**: `claude --resume <uuid>`.
* **Hazard / Guard**: Claude enforces single-writer semantics ("Session ID already in use"). Resume in CLI only when the Web UI session is idle.
* **Round-Trip Status**: **Native YES**.

### 3. Antigravity (`agy`)
* **Storage**: Native SQLite DB `~/.gemini/antigravity-cli/conversations/<id>.db` + `brain/<id>/`. Pi Web UI mirror `~/.pi-web-ui/antigravity-sessions/` is a replay mirror.
* **Mechanism**: The frontend never simulates turns; every turn spawns `agy --conversation <uuid>` (`agy-stream-process.ts:103-107`). All turns appends directly to the native SQLite database.
* **CLI Resume**: `agy --conversation <id>` or select from the `agy` TUI list. Sees all turns executed in Web UI.
* **Hazard / Guard**: Database and brain directory lock contention if both CLI and Web UI run concurrently; model slug must be valid.
* **Round-Trip Status**: **Native YES**.

### 4. OpenCode (`opencode`)
* **Storage**: OpenCode native storage at `~/.local/share/opencode/storage`.
* **Mechanism**: Delegated to local OpenCode server via session ID (`opencode-service.ts:530-571`).
* **CLI Resume**: `opencode` with session ID against the same storage.
* **Round-Trip Status**: **Native YES**.

### 5. CommandCode (`cmdc`)
* **Storage**: `<cliHome>/projects/<encoded-cwd>/<uuid>.jsonl`.
* **Mechanism**: Same native JSONL structure and locking as Claude.
* **CLI Resume**: `cmdc --resume <uuid>`.
* **Round-Trip Status**: **Native YES**.

---

## 3. Web UI Locks & Concurrency Rules

1. **Web UI Internal Locks** (Do not prevent CLI access):
   * Session pin (`maxPinnedSessions=5` in `MultiSessionManager`).
   * Watch retention claims (`watch-target:`).
   * Admission control (`activeTurns`).
2. **Native Operational Rule**:
   * **Never run CLI and Web UI turns concurrently on the same session ID.**
   * Wait until the Web UI session status is `idle` (`activeTurns: 0`, `busy: false`) before executing CLI commands.

---

## 4. Implementation Scope for Clean "Hand-Back to CLI" Feature

If an explicit UI hand-back workflow is desired in the future:
1. **UX Affordance (~0.5 day)**:
   * "Resume in CLI" modal/button in session menu showing the exact CLI command (`pi -c`, `claude --resume <uuid>`, `agy --conversation <id>`) with copy button.
2. **Lifecycle Hygiene (~1 day)**:
   * "Detach from Web UI" action that releases Web UI pins, stops streaming child processes (e.g. `agy`), and marks the registry entry as `handed-off`.
3. **Drift Guard (~0.5 day)**:
   * Warn or guard if a Web UI user prompts a session whose native file mtime has advanced beyond the frontend's known watermark.

---

## Conclusion
Because Pi Web UI's adoption model was designed to keep native files as the authoritative store, **no data migration, format conversion, or export pipeline is needed**. Round-trip resumption in the native CLI is completely feasible today under the condition of sequential (non-concurrent) turn execution.
