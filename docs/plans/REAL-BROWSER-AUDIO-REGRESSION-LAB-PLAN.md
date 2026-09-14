# Real-browser audio regression lab — execution plan

Status: **EXECUTING** — owner authorised planning followed by autonomous implementation and DeepSeek V4.1 Flash delegation on 2026-09-14. This header records authority, NOT completion. Parent acceptance lives in the checkpoint and final report.

## 1. Purpose and authority

Build a reusable, unattended lab that measures the audio actually rendered by a real browser running Pi Web UI. Make missing speech, boundary gaps, incorrect ducking, cancellation, duplication and capture/playback interactions diagnosable with retained evidence. The initiating symptom is the owner's report that sentence openings are eaten on their laptop, while other audio in that same browser works normally. Do not assume network trouble or device fault.

Victory is a working **measurement and regression capability**, not a promise that this specific laptop defect is fixed. A lab pass cannot certify untested operating systems, sound hardware, Bluetooth routes or browser versions. Preserve that distinction in every report.

Owner authority: develop and validate the lab autonomously; use capable DeepSeek V4.1 Flash children, goals, independent parent review and low-noise Telegram updates. Owner clarified that “SSE” meant **Authelia**: any Authelia change requires a separate explicit owner decision. No Authelia changes are needed for the local lab. Do not weaken authentication to simplify browser tests. No production Pi Web UI restart is required by this plan; keep the production service serving the owner while developing in isolation. Public HTTPS expansion is a separate named lane, not a hidden prerequisite for local acceptance.

Latest authority amendment (2026-09-14): owner explicitly requires parent and children to stay in fully isolated worktrees while a separate agent continues Voice Mode development; automatic merge back to the principal branch is authorised. Maximise child implementation/review; parent remains planner, supervisor and independent acceptor. Integration is sequence-gated on fresh coordination, not a new owner-approval screen.

### Scope boundaries

- Core delivery: local real-browser output capture, comparison oracle, scenario suite, real authenticated application integration, repeatable lifecycle, evidence browser/export, repeat/soak CLI and documented operator-recording import.
- Implement reusable lab tooling inside this repo, NOT an independent replacement voice player or a new platform/control-plane service.
- Reuse the actual read-aloud player and speech arbiter. Add minimal opt-in/test-scoped instrumentation only when external observation cannot provide required evidence. No speculative voice behaviour fixes bundled with the lab.
- Preserve verbatim operator input, confirmation gate and unconditional capture. Lab failures must not be “fixed” by relaxing those product invariants or modifying expected results to match a defect.
- Do not touch other agents' talker/history/attachment changes, production state, shared desktop/browser, global sound configuration, host routes, Authelia, credentials, or shared skills.
- No residential proxy, stealth browser, external browser service, or remote publication in core delivery. These are not necessary to measure local rendering and introduce uncontrolled variables.
- No automatic uploads of real user recordings to model providers. Optional listening/transcription has separate provenance and consent; machine verdicts must not pretend an audio-capable model listened when it did not.

## 2. Verified starting point (2026-09-14; recheck on resume)

Repository home `/root/pi-web-ui`, branch `master`, clean at baseline `baeea3d`. Recent landed work: `e84599a` talker self-service requests; `901bcb8` history-window fix; `baeea3d` attached-worker observability. Another lineage (`pi-01a0920a`) still claims Voice Mode work, so use isolated checkout `/root/pi-web-ui-wt-audio-lab` (detached HEAD; no new named branch) for implementation and builds. Parent integrates onto the current branch only after fresh coordination and path-limited review.

Production is a headless Linux VPS; `/root/SYSTEM_MAP.md` is the authoritative host inventory. Owner browser access is via Caddy then Authelia at `pi.letsautomate.work`. At preflight production `pi-web-ui.service` was active, PID 1178464, started 15:03:25 UTC; Internal API contract 1.42.0, Pi goal support enabled, 0 active turns. These are observations, not future guarantees. Production Internal API is used ONLY to orchestrate real child work, not to validate this lab.

Installed observation tools: Google Chrome 152.0.7977.75, PulseAudio 16.1, FFmpeg 6.1.1, `pactl`, `parec`, Xvfb; Chromium also exists via snap. Approximately 21 GiB memory available and 81 GiB disk free at preflight. Verify executable functionality and paths in `doctor`; installation is not proof a private audio daemon works.

### Canonical source map (open before implementation)

| Path | Why it matters |
|---|---|
| `docs/VOICE-MODE.md`, `docs/DRIVE-MODE.md` | Current feature and speech invariants; not historical package briefs |
| `client/src/hooks/useReadAloud.ts` | Actual TTS player: whole-response MP3 decode, shared AudioContext, source → GainNode → destination; one-ahead prefetch and retry |
| `client/src/lib/speechArbiter.ts`, `speechTelemetry.ts`, `spokenLedger.ts` | Scheduling, ducking, stop and dedup logic; reuse rather than fork |
| `client/src/components/DriveMode/useAnswerReader.ts`, `useVoiceTurn.ts`, `DriveModeDictate.tsx` | Real UI producers and capture interaction |
| `server/src/routes/tts.ts` | Cookie-protected TTS endpoint; OpenAI MP3, default model `tts-1` from config; 4000-char bound |
| `server/src/config.ts` | TTS credential precedence and model config; never print secrets |
| `client/src/dev/voiceHarness.tsx` | Existing dev harness mocks WebSocket and substitutes marker WAV; useful calibration, NOT full-stack speech proof |
| `scripts/voice-mode-browser-e2e.mjs`, `voice-mode-barge-in-e2e.mjs` | Existing browser drivers; some use fake mic and autoplay relaxation: label those limitations rather than inherit silently |
| `scripts/validation-server.ts`, `validation-server-stop.mjs` | Canonical disposable launcher, compiled mode, separate state and owned process-group teardown |
| `server/src/live-validation/validation-safety.ts`, `validation-server-env.ts` | Existing fail-closed target/isolation guardrails |
| `docs/LIVE-VALIDATION.md`, `SECURITY.md`, `tests/README.md` | Authentication, test lifecycle, strict proof semantics and quality gates |
| `docs/plans/VOICE-MODE-CONTINUATION.md`, `docs/archive/briefs/P21-first-chunk-word-loss.md` | Prior experiment caveats; historical, not current product truth |
| `/root/audiorecorder/README.md`, `client/src/capture/capture-controller.ts` there | Optional laptop recording: separate system/mic tracks; requires both inputs; actual laptop compatibility unvalidated |

P21's two analysis scripts were removed and are not tracked. Prior tone experiments and “likely device routing” prose do not resolve the reported defect. Rebuild retained, tested instruments. The recorder is useful supplemental evidence, not the automated lab's runtime dependency.

## 3. Architecture and truthful evidence boundaries

### 3.1 Owned execution capsule

One CLI invocation owns a unique private run directory, fresh browser profile, isolated display, private PulseAudio daemon/socket, null sink and monitor recording, disposable validation server and any fixture server. No system-wide PulseAudio defaults, shared VNC browser or host routing changes. Prefer an independently owned transient systemd unit with CPU/memory/PID/time bounds, not descendants silently consuming the production service cgroup. If unsupported, refuse pressure/soak modes; never claim containment from a directory alone.

Use Chrome under private Xvfb (headed virtual display) for the primary lane, ordinary user-gesture activation and actual audio output; do not ship a muted/autoplay-bypassed lane as the only test. Headless may be a secondary, explicitly labelled lane after real output is proven. Capture the exact browser flags, version, OS, sample rates and device configuration. Fake microphone input is allowed for deterministic scenario stimulus, but it must enter the browser's actual capture machinery and be labelled synthetic input, never microphone-hardware proof.

`doctor` diagnoses binaries, private daemon launch, permissions, output energy, sandbox posture, compiled build, ports and disk headroom. Missing capture produces **indeterminate**, never fallback-to-mock green. Avoid npm dependency symlinks that allow a child build/install to mutate the canonical checkout. Install lockfile dependencies in the isolated checkout.

### 3.2 Signal chain

Capture three independent layers on a shared monotonic timeline:

1. **Source:** expected text, ordered chunk IDs and voice, original MP3 bytes and hashes, decoded PCM/sample count/rate. Fixtures contain only non-sensitive author-owned diagnostic speech. Unmarked real speech is mandatory; markers supplement calibration, never stand in for words.
2. **Application:** optional post-gain PCM tap plus bounded scheduler/player events (submit, chosen tier, chunk start/end, intended stop, duck/restore, mic start/stop, source start offset/rate, context state, visibility, fetch/decode timing and error). Correlate source/intent/chunk ID and sequence even for repeated identical text. Instrumentation must not reconnect or reroute the production audio graph or change normal behaviour when disabled.
3. **Browser output:** continuous PCM/WAV recording of the dedicated sink monitor, including lead-in and tail. Start capture BEFORE playback, verify readiness with a non-confounding calibration step, and retain silence. This is OS-rendered output in the lab, not proof of a physical speaker. A graph-only recording cannot satisfy this layer.

Play identical MP3 bytes through (a) a simple reference player and (b) the real product player/arbiter. Compare results after calibrated alignment. A reference failing too means investigate fixture/capture/environment, not blame Drive Mode. Separately test the real HTTP TTS path so interception does not conceal transport behaviour.

### 3.3 Verdict/oracle

Implement deterministic signal measurements first: bounded cross-correlation or equivalent robust alignment, detected first/last content, source coverage, missing/duplicated/reordered chunks, unintended silence and gap distribution, gain envelope and duck/restore timing. Account for resampling, channel layout, MP3 encoder delay, playback rate, output latency and calibrated silence. Preserve raw samples and uncertainty. ASR alone is not a completeness oracle: it can hallucinate omitted words.

Separate `passed`, `failed`, `indeterminate`, and deliberately `not_run` per scenario. Overall required-suite exit codes: 0 all required proof passes; 1 demonstrated functional regression or unexpected browser error; 2 missing/invalid proof, target refusal, calibration/cleanup uncertainty or unsupported mandatory capability. Mixed fail/indeterminate cannot become green. Missing cases, zero captured frames, NaNs, truncated artifacts, unknown identity, stale manifest and absent cleanup all invalidate acceptance.

Initial acceptance tolerances must be frozen with RED calibration before measuring candidate changes. Suggested starting targets: detect 100 ms head/tail loss, an omitted/duplicated/reordered chunk, 250 ms inserted gap, sustained unintended gain loss; clean controls must pass with measured resampling/codec tolerance. Record exact numeric tolerance and confidence; do not claim reliable phoneme detection finer than demonstrated sensitivity. For normal chunk joins, distinguish source silence from added scheduling gap and report p50/p95/max. Lock a justified bound (initial target p95 <=100 ms when next chunk already decoded) before production-path runs; a breach is a useful detected defect, not reason to weaken oracle.

### 3.4 Durable evidence contract

Versioned manifest per run: run ID, candidate commit + dirty hash if applicable, frontend bundle hash, backend build/boot identity, entrypoint mode, OS/browser/tool versions, flag inventory, fixture/synthesis provenance, scenario seed, required/executed matrix, timestamps, attempts, named assertions and thresholds, recorder sample metadata, source/output artifact hashes, bounded logs/screenshots, and cleanup disposition. Export bounded source/output A/B clips around each anomaly with expected text, timing and relevant events; generate local HTML + JSON reports. Reports must be readable without external assets or uploading data.

Manifests are immutable once finalised; retries use separate attempt directories and never erase failed attempts. `verify-record` rechecks required evidence, hashes and verdict consistency offline. Audio, screenshots, browser state and credentials stay outside Git. Bounded default disk quota (e.g. 1 GiB/run), wall-clock timeout and explicit retention; no broad deletion. User imports are private, read-only originals, identified by hash; decoding works on copies. No raw cookies, auth headers, env dumps or real session transcripts in reports.

## 4. Execution waves (strict TDD; one implementation worker initially)

This is one closely coupled implementation chain: lifecycle → signal capture → oracle → actual UI integration. Parallelising those prematurely would produce incompatible evidence assumptions. Use **one DeepSeek implementation child** end to end; a **fresh read-only reviewer** after the frozen handback. Parent retains architecture, integration and final acceptance. Independent future analyser/platform work may parallelise only after the manifest contract is stable and with disjoint ownership.

### Wave 0 — plan, isolation, discovery (parent)

- Ground this plan in source/host state; check board and preserve baseline.
- Create isolated checkout and operations checkpoint outside the tree. Current operations root: `/root/.pi-web-ui/operations/audio-lab-20260914/`.
- Live-discover capabilities/capacity/models and provider quota before dispatch. Owner's explicit V4.1 choice supersedes older generic retirement wording for this task; use exact advertised selector, not a “latest” V4 alias. Current candidate: Pi `opencode-go/deepseek-v4.1-flash`, `high` (pool ample at preflight). Recheck immediately before dispatch; no silent fallback.
- Child goal specifies deliverable/evidence/boundaries, not micromanaged methods. Watch exact-objective `goal_end`, paused `goal_state`, question sentinel; local wake tool + one model-free backstop. No in-turn polling.

Gate: plan exists, isolated baseline recorded, owned scope/goal/watch/lease and model binding verified before real work.

### Wave 1 — lifecycle and evidence contract

Write failing tests for CLI parsing, production/foreign-target refusal, unique ownership, timeout and signal cleanup, missing evidence and verdict aggregation. Implement `doctor`, `run`, `verify-record`, report output and explicit run-directory lifecycle. Reuse canonical validation launcher/stopper. Real private PulseAudio + Xvfb/Chrome smoke; ensure disabling actual output makes the smoke fail. Unit tests alone do not open this gate.

Gate: actual Chrome-rendered tone reaches dedicated monitor, recorder can distinguish silence/missing output, forced exception and SIGTERM leave no owned browser/display/audio/server processes or listeners. Shared service identity/audio configuration unaffected.

### Wave 2 — oracle and fixture corpus

Retain generated marker fixtures and author-owned speech fixture generator/manifest; produce real MP3 through existing TTS endpoint using only narrowly allowlisted existing credentials, never copied wholesale. A small bounded live TTS calibration is in scope; routine loops use cached diagnostic speech. Record exact source voice/model and bytes. If credentials are unavailable, use local generated speech for development but report the production-TTS gate unmet.

RED first: inject known head loss, tail loss, omitted chunk, duplicate, reorder, unintended silence, gain reduction, wrong sample rate, truncated recording and timestamp skew. GREEN: identical reference output at normal and accelerated rate, repeated text, natural silence, variable-length speech. Negative controls remain required in every acceptance suite so a broken detector cannot certify silence.

Gate: adversarial cases fail for the intended measured reason; clean real-speech controls pass; calibration sensitivity and codec tolerance are documented/frozen.

### Wave 3 — actual product and authenticated full-app path

Build the isolated candidate; launch compiled disposable server with fresh test-only bcrypt password/JWT material and matching allowed origin. Login normally through cookie auth; do not copy production login cookies/JWT. Verify served frontend/backend identity. Drive the actual UI into read-aloud and Voice Mode controls using real production modules, not just a standalone audio demo or mocked player. Use deterministic fixture sessions/transport only when explicitly labelled; include one actual `/api/tts` integration playback and test unauthorised TTS denial.

Minimum required scenario matrix:

| ID | Stimulus and required evidence |
|---|---|
| start-cold | New profile/context, real gesture, complete first sentence |
| idle-resume | Playback after >=30 s silence; source and output first words compared |
| chunk-joins | >=20 varied/repeated speech chunks; ordered coverage, head/tail, gap measurements |
| speed | 1.0 and existing 1.25 speed path; duration-normalised coverage |
| mic-on/off | Real getUserMedia open/close with synthetic stimulus; output comparison and capture continuity |
| barge-duck | Start mic mid-chunk; gain ducks rather than source hard-stop; restore and unconditional capture |
| stop-cancel | Explicit stop, no stale late playback after pending synthesis resolves, honest cancellation accounting |
| pause-boundary | Pause/resume at allowed boundary without duplicate/lost content |
| priority/dedup | Receipt ack/answer/chatter ordering and repeated-text intents; intentional drop distinguished from loss |
| slow/error-TTS | Bounded delays, one failure/retry and terminal failure; errors surfaced, no hangs or falsely claimed speech |
| visibility | Background/foreground transition, context state/continuity recorded |
| level-change | Reading-level change mid-answer at boundary; expected policy cancellation separated from eaten speech |

A test may reveal an actual product regression. Keep RED evidence; parent scopes a minimal fix separately under existing authority, with no invariant relaxation. The lab itself can be operational while product regressions remain detected, but this must be reported clearly; never mark the whole required suite passed while ignoring them.

Gate: real app run + output evidence, all required scenarios executed or explicitly diagnosed; no fake Web Audio API, silent tone-only substitution, manual console intervention, or screenshots-as-audio-proof.

### Wave 4 — unattended reliability and reusable troubleshooting

- One documented command boots dependencies, runs suite, produces report and tears down, requiring no GUI clicks. Add repeat count/seed/scenario selection, finite retry and timeout, stop-on-regression option; exit nonzero on uncovered/uncertain requirements.
- Run three complete clean starts and a bounded >=20-minute soak with at least 100 chunk starts, including idle gaps and mic/duck interactions. One heavy runner at a time; no host stress or shared audio changes.
- Inject runner termination and recorder/server failure, then rerun: no stale state reused, orphan process, extra listener or unbounded disk growth. Record resource samples and cleanup checks.
- Import an external WAV/WebM/MP3 recording + expected text and optional timing metadata; validate containers/size/duration safely via argv-based FFmpeg, preserve originals. Without source/timing, classify attribution as unknown; do not fake alignment certainty. An automated synthetic import smoke is sufficient until owner supplies a real recording.
- Local report includes paired clips, waveform/timeline and troubleshooting ladder: source absent → synthesis; source present/app missing → schedule/gain; app present/sink missing → browser/output; all lab layers present/laptop missing → environment discrepancy still unproved. An optional audio-capable-agent handoff exports clips and explicit questions with actual listening provenance. No paid model dependency in core verdict loop.
- Add canonical `docs/AUDIO-REGRESSION-LAB.md` with quickstart, commands, contract, scenario-authoring recipe, limitations and how an agent diagnoses/fixes/retests without owner involvement. Link from `docs/VOICE-MODE.md`, `docs/LIVE-VALIDATION.md`, maintainer index; keep AGENTS/CLAUDE identical if touched. Future scenarios extend one registry/schema rather than fork scripts.

Gate: repeat/soak and failure-recovery evidence exist; another agent can use documented commands from a clean checkout without the implementation child's implicit state.

### Wave 5 — independent review, parent acceptance, integration

- Child stops editing and writes FROZEN handback, commit list, owned paths, exact command exits, required matrix and evidence locations. Goal-achieved is a handback signal, not acceptance.
- Fresh read-only reviewer challenges signal provenance, false-green paths, security, cleanup and product-module reuse. Parent independently reruns clean and adversarial cases, a full authenticated app case, verifies record hashes, and checks resource cleanup. Parent chooses at least one unannounced mutation distinct from the child's standard controls.
- Run repository gates: docs guide sync/check, docs link check as applicable, lint, typecheck, build, relevant client/server/shared and lab suites. Existing unrelated failures require baseline reproduction, never omission disguised as green.
- Recheck board and current principal branch; integrate only owned frozen commits, preserving intervening Voice Mode fixes. No force-push, no wholesale dirty staging, no raw evidence/media/secrets in Git. Parent pushes completed changes on current principal branch and retains proof of integrated rerun.
- Parent final report explicitly separates lab operational status, scenario/product regression status, original laptop bug status, external HTTPS lane status and production deployment status.

## 5. Victory checklist (all core items mandatory)

1. Fresh-checkout documented command works unattended with installed/preflighted dependencies.
2. Real browser, actual product player/arbiter and authenticated compiled full application exercised.
3. Original real MP3 + decoded source + OS-rendered output evidence retained and correlated; calibration markers alone insufficient.
4. Known damaged audio and disabled capture fail for measured reasons; absent evidence never green.
5. Required scenario registry/matrix complete; intentional duck/cancel is not misclassified as accidental word loss.
6. Immutable schema-versioned report verifies offline; contains identity/provenance/thresholds and source/output A/B anomaly clips.
7. Three clean starts, >=20-minute/100-start soak, crash/timeout recovery and subsequent clean rerun evidenced.
8. Owned process/listener/storage cleanup verified; no host route, shared audio, production registry or Authelia changes.
9. External recording import works with explicit limitations and private handling.
10. Maintainer/agent runbook and canonical links make this a reusable development tool, not a one-off probe.
11. Independent reviewer plus parent's own negative control and full-app rerun accepted; required repo gates recorded.
12. Code committed/pushed after coordinated integration. Do NOT equate this with production restart or a confirmed laptop fix.

A missing mandatory item means **partial/indeterminate**, with a named remaining requirement. A reproducible product defect is a valid lab finding, not proof that speech quality is fixed. Do not repeatedly relax tolerances to get green. Three failed attempts at the same approach trigger root-cause reassessment.

## 6. Optional external HTTPS lane — explicit extension, not core victory

Once the local lab is accepted, the same runner should accept an explicitly allowed disposable remote target with build/boot identity and strict production denial. It must not accept arbitrary URLs as trusted disposable servers. A separate external browser runner provides stronger external-route evidence than the same VPS calling itself. Local HTTPS with temporary certificate/trust scoped only to the lab browser can first exercise secure-context/cookie semantics without any public exposure.

Public deployment requires a concrete topology, isolated data/credentials, allowlisted origin, rate/resource bounds, TTL and teardown, and proof that production routes are unchanged. Any proposed Authelia diff goes to the owner before implementation; do not bypass SSO as a workaround. The owner's mandate permits autonomous non-Authelia lab development, but neither demands public exposure now nor makes a proxy necessary. If a shared Caddy change is desired, bring the exact minimal diff and its interaction with Authelia to the parent; do not improvise infrastructure changes inside the implementation lane. No host-level routing helper: a previous browser-egress incident mutated the host network namespace and broke inbound connectivity.

## 7. Ownership, handback and supervision

Implementation child owns new `scripts/audio-lab/`, associated focused tests/fixtures and `docs/AUDIO-REGRESSION-LAB.md`, minimal package scripts and lab-only browser adapter entrypoints. It may make narrowly tested opt-in instrumentation changes to `useReadAloud.ts`/speech telemetry if required; no behavioural changes without a reproduced defect and parent allocation. Parent owns this plan, operations checkpoint, cross-document integration and final sign-off. No child changes canonical `/root/pi-web-ui` or shared services. Commit in the isolated detached worktree; parent handles upstream integration and push.

Operations: parent `STATE.md`; child `implementation/brief.md`, `status.md`, ordered question/blocked/complete handbacks, `verify.sh` and red/green evidence. Do not store credentials there. Child asks only about scope/authority contradictions, real-data/irreversible actions or false premises; ordinary design choices are its responsibility. On blocker write the question, pause goal, emit `AUDIO_LAB_NEEDS_PARENT`, end turn. No child polling or waiting for owner. Parent watches terminal goal and pause plus backstop, reconciles all work on every wake and sends Telegram only at substantive gates. One implementation child now, one fresh review child later; no nested delegation without parent coordination.
