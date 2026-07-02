# Execution Plan — Markdown Editor in the Files Tab

> **Audience:** a highly capable execution agent.
> **Prime directive:** This feature is *small in surface area but strict on quality*. You are known to be excellent — and known to occasionally declare victory early. **Do not.** A task is done only when every quality gate in [§9](#9-quality-gates-non-negotiable) has passed with captured evidence, including a **live browser validation on a disposable server**. If you are tempted to say "this should work" — stop, run it, and paste the output.

---

## 1. Goal (what you are building)

Turn the Files tab's current **read-only** file preview into a **Markdown source editor with a toggleable, GitHub-flavored live preview**, saving through the *existing* `/api/files/write` endpoint.

This is inspired by BuilderIO's `agent-native` **Content** app ("open-source Obsidian/Notion for MDX"), but **deliberately and heavily simplified** to fit a mobile-first, filesystem-backed tab. We keep the *spirit* (a pleasant place to read and edit Markdown next to your agent) and drop the product surface (no database, no MDX runtime, no pages tree, no Notion-style databases, no sharing, no version history).

You are **not** porting the Content app. You are adding a focused editor to an existing tab. Read [§2](#2-scope--decisions-already-made) before touching anything — the scope is settled, not open.

---

## 2. Scope — decisions already made

These were decided with the maintainer. **Do not expand scope. Do not re-litigate.** If you believe a decision is wrong, stop and ask; do not silently "improve."

| Area | Decision | Implication |
|---|---|---|
| **Editor type** | **Source + live preview** | A Markdown *source* editor (plain `<textarea>`) with a toggle to a rendered `react-markdown` + `remark-gfm` preview. **Not** WYSIWYG. **No Tiptap. No CodeMirror. No new editor dependency.** |
| **Agent integration** | **Manual only** | The editor is **UI-only**. There is **no** special agent wiring, no "Ask agent to edit" button, no new tools/MCP/actions. The user drives the agent from the normal Chat tab. |
| **Feature scope** | **Markdown / GFM only** | GitHub-flavored Markdown (tables, task lists, fenced code, strikethrough). **No MDX/JSX runtime. No custom interactive blocks. No databases. No pages tree.** |
| **Save & sync** | **Explicit Save + manual Refresh** | A **Save** button writes to disk. A **Refresh** re-reads from disk. **No autosave. No file-watching.** The user manually reconciles any agent-made changes by refreshing. |

### Sub-decisions (defaults — implement these unless the maintainer overrides)

1. **Truncation safety (CRITICAL — see [§6](#6-critical-safety-truncation--data-loss)).** If a file was loaded truncated, the editor must be **read-only and Save must be blocked**. Never let a user save a partial copy over a full file.
2. **Editor widget:** plain `<textarea>`. Zero new dependencies. Honors "keep diffs minimal."
3. **File-type gating:** editing is offered only for Markdown-ish extensions (`.md`, `.mdx`, `.markdown`, `.txt`). Every other file keeps today's read-only `<pre>` preview.
4. **Mobile UX:** edit mode opens as a **full-screen overlay** (the current side panel is too narrow to edit in), with an **unsaved-changes guard** before close/navigate.
5. **Toolbar:** none in v1 (no bold/heading/link buttons). Plain textarea + preview toggle only.

### Explicitly OUT of scope

- Tiptap / CodeMirror / any rich-text or code-editor library.
- MDX/JSX execution, custom React blocks, embeds.
- Notion-style databases, board/calendar/gallery/timeline views.
- Hierarchical pages / page tree / backlinks.
- Autosave, file-watching, live collaborative sync, conflict-merge UI.
- Any agent/tool/MCP/action wiring, cross-runtime integration, or Internal API work.
- New storage (no DB, no Drizzle). Filesystem only.
- Version history, comments, sharing, full-text search.

---

## 3. Signposted resources (read these first, with full paths)

**Project rules (obey exactly — they override defaults):**
- `/root/pi-web-ui/CLAUDE.md` — agent instructions, required workflow, security rules. Note the **`AGENTS.md` ↔ `CLAUDE.md` byte-identical sync rule** and `npm run docs:check-agent-guides`.
- `/root/pi-web-ui/SECURITY.md` — auth, path validation, CSRF, prompt-injection rules.
- `/root/pi-web-ui/docs/ARCHITECTURE.md`, `/root/pi-web-ui/docs/CODEBASE-MAP.md` — orientation.

**The code you will change or extend:**
- `/root/pi-web-ui/client/src/components/Files/FilesTab.tsx` — the tab. Today it renders a file list + a **read-only** `<pre>` preview panel. This is where the editor UI goes.
- `/root/pi-web-ui/client/src/store/filesStore.ts` — Zustand store. Has `selectFile`, `createFile(path, content)`, and talks to `/api/files/*`. **Note:** `selectFile` currently *discards* the server's `truncated` flag — you must preserve it (see [§6](#6-critical-safety-truncation--data-loss)).
- `/root/pi-web-ui/server/src/routes/files.ts` — Express routes. **`/api/files/write` already overwrites files**, and **`/api/files/read` already returns `{ content, truncated, totalSize }`**. You most likely need **zero server changes** (confirm; see [§5](#5-backend-do-not-change-unless-you-prove-you-must)).

**Reuse references (do not reinvent):**
- `/root/pi-web-ui/client/src/components/Chat/MessageBubble.tsx` — the canonical, already-shipping usage of `ReactMarkdown` + `remarkGfm` in this codebase. **Match its rendering approach** (component overrides, `@tailwindcss/typography` classes) so the preview looks consistent with chat. Deps already in `client/package.json`: `react-markdown`, `remark-gfm`, `@tailwindcss/typography`.
- `/root/pi-web-ui/client/src/components/Navigation/BottomNav.tsx` — tab structure / mobile constraints; understand the space you are working in.

**Testing harness (this feature adds the FIRST client component tests):**
- `/root/pi-web-ui/client/vitest.config.ts` — **tests live under `client/tests/**`** (include pattern `tests/**/*.{test,spec}.*`), **not** co-located. Environment `jsdom`, setup `client/tests/setup.ts`, `@testing-library/react` available. Coverage thresholds: **lines 70 / functions 70 / branches 60 / statements 70**.
- Server tests are co-located as `*.test.ts` (e.g. `/root/pi-web-ui/server/src/security/security.test.ts`) — reference only if you end up touching the server.
- TDD skill: use **`test-driven-development`** — write the failing test first, always.

**Live validation:**
- `/root/pi-web-ui/docs/LIVE-VALIDATION.md` — **read §"Safety contract: never validate on production by default"**. The same production-safety rule applies to browser validation (see [§8](#8-live-validation-mandatory-disposable-server-only)).
- For localhost browser validation use the **`webapp-testing`** skill (it manages the dev-server lifecycle). For interactive/manual browser poking use the **`playwright-cli`** skill. Both are named per `/root/pi-web-ui/CLAUDE.md`.
- **No Internal API / agent-orchestration harness is needed for this feature** — the agent integration is "manual only," so there is no runtime behavior to validate over the socket. Do **not** stand that machinery up; browser-level validation is the correct and sufficient tool here.

---

## 4. Design of the change

Keep the diff minimal and localized to the client. Suggested shape (adapt if the code guides you elsewhere, but justify deviations):

### 4.1 State (`filesStore.ts`)
Extend the store to support editing without breaking existing read-only behavior:
- Preserve the server's truncation signal on read: add `previewTruncated: boolean` (and optionally `previewTotalSize: number`) set from the `/api/files/read` response inside `selectFile`. **This is the fix that makes the safety guard possible.**
- Add edit state: `isEditing: boolean`, `editBuffer: string | null`, `isDirty: boolean` (derived or tracked), `isSaving: boolean`, `saveError: string | null`.
- Add actions:
  - `startEditing()` — seed `editBuffer` from `previewContent`; refuse (no-op + surfaced reason) if `previewTruncated` is true.
  - `updateEditBuffer(next: string)` — set buffer, mark dirty.
  - `saveFile()` — POST to `/api/files/write` with `{ path: selectedFile, content: editBuffer }`; on success clear dirty, refresh preview from buffer; on failure surface `saveError` and **keep the buffer** (never lose the user's text).
  - `cancelEditing()` — discard buffer (guarded by the dirty check at the UI layer).
- Reuse the existing `/api/files/write` call pattern already present in `createFile`.

### 4.2 UI (`FilesTab.tsx` + a new editor component)
- Add a small **`MarkdownEditor`** component (new file under `client/src/components/Files/`) responsible for: the `<textarea>` source pane, the **Edit ⇄ Preview** toggle, the rendered preview (via the MessageBubble rendering approach), a **Save** button, a **Refresh** button, and the dirty/unsaved indicator.
- In `FilesTab`, when a selected file's extension is Markdown-ish **and** not truncated, render `MarkdownEditor` instead of the read-only `<pre>`. Otherwise keep the existing `<pre>` (and, when truncated, show the existing "truncated" affordance and **do not** offer editing).
- **Mobile:** open the editor as a full-screen overlay; the side panel remains for desktop widths if that fits naturally, but the overlay is the priority for the constrained mobile case.
- **Unsaved-changes guard:** closing the overlay, selecting another file, or navigating away while `isDirty` must prompt the user (reuse `window.confirm` for v1, matching the existing delete-confirm pattern in `FilesTab`).
- **Save** button is **disabled** while `!isDirty`, while `isSaving`, and (belt-and-braces) whenever `previewTruncated`.

### 4.3 What "live preview" means here
Toggle between **Edit** (textarea) and **Preview** (rendered). A split view is acceptable on wide screens but is not required; the toggle is the v1 contract. Rendering must go through `react-markdown` + `remark-gfm` exactly like `MessageBubble.tsx`. **Do not** enable raw HTML / `rehype-raw` / any HTML passthrough (XSS surface) — GFM only.

---

## 5. Backend — do NOT change unless you prove you must

Expectation: **zero server changes.** `/api/files/write` already overwrites and `/api/files/read` already returns `truncated`. Both are behind `cookieAuthMiddleware` + `apiLimiter` + `validatePath()`.

If you conclude a server change *is* required, you must:
1. State precisely why the client-only path is insufficient.
2. Preserve `cookieAuthMiddleware`, `apiLimiter`, and `validatePath()` on any touched route.
3. Add a **co-located `*.test.ts`** covering the change (server tests are co-located).
4. Get the maintainer's nod before expanding surface area.

---

## 6. CRITICAL SAFETY: truncation → data loss

This is the single real correctness hazard in this feature. **Treat it as a hard requirement, not a nicety.**

- `/api/files/read` caps at 200KB and returns `truncated: true` for larger files; the old UI further truncated the display.
- If a user edits a file that was loaded **truncated** and then saves, the write would **overwrite the full on-disk file with a partial copy → silent data loss.**

**Required behavior:**
- The store must preserve `truncated` from the read response (today `selectFile` throws it away — fix that).
- When `truncated` is true: editing is **not offered**, the editor is **not entered**, and Save is **impossible** (guard at both store and UI layers). Show a clear read-only notice explaining the file is too large to edit safely here.
- There must be an **automated test** proving Save is blocked for a truncated file, and a **live-validation step** exercising it (see [§7](#7-tdd-required-order-of-work) and [§8](#8-live-validation-mandatory-disposable-server-only)).

---

## 7. TDD — required order of work

**Write the failing test first, every time.** Use the `test-driven-development` skill. Client tests go under **`client/tests/**`** (see `client/vitest.config.ts`), not co-located.

Suggested increments (each: red → green → refactor, commit-worthy states kept green):

1. **Store: preserve truncation.** Test that `selectFile` sets `previewTruncated` from the read response. → Implement.
2. **Store: edit buffer + dirty.** Test `startEditing` seeds the buffer, `updateEditBuffer` marks dirty. → Implement.
3. **Store: save.** Test `saveFile` POSTs to `/api/files/write` with correct body, clears dirty on success, and **retains the buffer + sets `saveError` on failure**. (Mock `fetch`.) → Implement.
4. **Store: truncation blocks edit/save.** Test `startEditing`/`saveFile` are refused when `previewTruncated` is true. → Implement.
5. **Component: `MarkdownEditor`.** Tests (via `@testing-library/react`): renders textarea in edit mode; toggle shows rendered preview (assert GFM output, e.g. a table or task list renders); Save disabled when clean; Save enabled when dirty and calls the store; unsaved-changes guard fires on close while dirty; truncated file shows read-only notice and **no** editor.
6. **Component: `FilesTab` wiring.** Test that a `.md` selection renders the editor and a non-markdown / truncated selection renders the read-only `<pre>`.

Keep coverage above the configured thresholds (70/70/60/70). Since these are the first client tests, verify `npm run test` (client workspace) actually discovers and runs them before going further.

---

## 8. Live validation (MANDATORY, disposable server only)

A green unit suite is **not** sufficient to claim done. You must drive the real UI in a browser and observe the file change on disk.

**Production safety — read carefully:**
- **NEVER validate against production.** Production is the systemd `pi-web-ui.service` (port `3456`, `pi.letsautomate.work`). Do not touch it. Do not restart/redeploy it.
- Validate against a **disposable local server you start yourself** (the `webapp-testing` skill manages a localhost dev server lifecycle; configure browser-ready auth/origins as needed).
- If — and only if — production validation were genuinely required, that needs the maintainer's **explicit** prior permission. It is not required here; do not seek it.

**Validation script (Playwright via `webapp-testing`), must exercise the real flow:**
1. Log in / reach the app on the disposable server; open the **Files** tab.
2. Create or navigate to a `.md` file in an allowed directory (e.g. under `/root` or the session cwd).
3. Enter edit mode, change the content, click **Save**.
4. **Assert on disk:** read the file back (via the app's Refresh **and** independently, e.g. reading the file from the filesystem/`/api/files/read`) and confirm the new content persisted.
5. Toggle **Preview** and assert GFM renders (e.g. a Markdown table or task list appears as HTML, not raw text).
6. **Truncation guard:** point at a file large enough to be returned truncated and confirm the editor is not offered and Save is impossible.
7. **Dirty guard:** make an edit and attempt to close/navigate; confirm the unsaved-changes prompt appears.

Capture evidence (script + console output and/or screenshots). Paste it into your final report. "I ran Playwright and it passed" without output is not evidence.

---

## 9. Quality gates (NON-NEGOTIABLE)

Run all of these from `/root/pi-web-ui` and **paste the actual output** for each. Do not summarize as "passing" — show it. If any gate fails, the task is **not** done.

- [ ] `npm run lint` — clean.
- [ ] `npm run typecheck` — clean.
- [ ] `npm test` — all suites green, **including the new client tests**; confirm the new tests are actually discovered (they are the first under `client/tests/**`).
- [ ] Coverage for touched client files respects thresholds (**70 / 70 / 60 / 60→70** per `client/vitest.config.ts`).
- [ ] `npm run build` — succeeds.
- [ ] `npm run docs:check-agent-guides` — passes (you are adding a doc; if you touch `CLAUDE.md`/`AGENTS.md`, run `npm run docs:sync-agent-guides` first and keep them byte-identical).
- [ ] **Live validation** ([§8](#8-live-validation-mandatory-disposable-server-only)) run on a **disposable** server, with captured evidence, covering: save-to-disk, preview render, **truncation guard**, dirty guard.
- [ ] Security review of the diff: no raw-HTML markdown passthrough; existing auth/path-validation preserved; no new unauthenticated surface; no secrets/tokens/session dumps staged.
- [ ] `git status --short`, `git diff --stat`, `git diff --cached --stat` reviewed; **only your own files** staged.

### Anti-"claim victory early" checklist
Before you report success, confirm you can answer **yes, with pasted evidence** to each:
- Did I see the edited content **on disk** after Save (not just in the UI)?
- Did I prove Save is **blocked** for a truncated file, in a real browser?
- Did I prove the **unsaved-changes** prompt fires?
- Did the **preview** render GFM (table/task list) as HTML?
- Are lint, typecheck, test, build, and docs-check outputs all pasted?
- Did I keep the scope to exactly [§2](#2-scope--decisions-already-made) — no Tiptap, no MDX runtime, no agent wiring, no autosave?

If any answer is "not yet," you are not done.

---

## 10. Definition of Done

1. Files tab lets a user open a Markdown file, edit its source, toggle a GFM live preview, and Save to disk via the existing `/api/files/write`.
2. Truncated (large) files are read-only and cannot be saved — proven by test and live validation.
3. Manual Refresh re-reads from disk; unsaved-changes are guarded.
4. No new runtime dependency, no backend change (or a justified, tested, auth-preserving one), no scope creep beyond [§2](#2-scope--decisions-already-made).
5. Every gate in [§9](#9-quality-gates-non-negotiable) is green with pasted evidence, including disposable-server live validation.
6. Diff is minimal and localized to the client (plus this plan / any doc updates).

---

## 11. Commit / delivery

- Work on the **current branch** (`master`). **Do not create a new branch.** Another agent may be working in parallel — **stage and commit only your own files.** Inspect `git status --short` and stage explicitly; never `git add -A` blindly.
- Verify no secrets, tokens, cookies, `.env`, session/transcript artifacts, or local machine files are staged.
- Commit message ends with:

  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```
- Commit and push only when the implementation and all gates are green (per maintainer instruction for this feature).
