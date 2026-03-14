# Live Kimi Web UI Specification (Independent Audit)

This document is an independently produced UI specification based on a live manual audit of `https://kimi.letsautomate.work` on 2026-03-14. It is intentionally based on fresh interaction evidence from the deployed product, not on the older specification files already present in this directory.

The goal is to describe the interaction model, visible states, dialogs, menus, and slash-command behavior clearly enough that another agent web UI can reuse the same UX patterns.

## Scope and evidence

- Audit target: live Kimi Code Web UI deployment
- Branding/version observed: `Kimi Code`, `v1.19.0`
- Audit method: live browser interaction via `playwright-cli`
- Primary evidence folder: [`live-kimi-ui-audit-2026-03-14/`](./live-kimi-ui-audit-2026-03-14/)
- Screenshots: [`live-kimi-ui-audit-2026-03-14/screenshots/`](./live-kimi-ui-audit-2026-03-14/screenshots/)
- Accessibility/tree snapshots: [`live-kimi-ui-audit-2026-03-14/snapshots/`](./live-kimi-ui-audit-2026-03-14/snapshots/)
- Browser trace: [`live-kimi-ui-audit-2026-03-14/traces/trace-1773523634593.trace`](./live-kimi-ui-audit-2026-03-14/traces/trace-1773523634593.trace)
- Console warning capture: [`live-kimi-ui-audit-2026-03-14/traces/console-warning.log`](./live-kimi-ui-audit-2026-03-14/traces/console-warning.log)

## Product-level interaction model

The UI is a two-pane desktop application:

1. A persistent left sidebar for session discovery and navigation.
2. A main conversation pane for the currently selected session.

The experience is optimized around a single active session, but it preserves visible access to the broader session list at all times unless the sidebar is collapsed.

The visual model is "agent chat first" rather than "document first". Most secondary functions are expressed as compact icon buttons, popovers, or slash-command driven actions rather than top-level navigation tabs.

## Information architecture

### 1. Sidebar / session rail

Evidence:

- [`01-landing.png`](./live-kimi-ui-audit-2026-03-14/screenshots/01-landing.png)
- [`01-landing.md`](./live-kimi-ui-audit-2026-03-14/snapshots/01-landing.md)
- [`15-grouped-view.png`](./live-kimi-ui-audit-2026-03-14/screenshots/15-grouped-view.png)
- [`16-list-view-restored.png`](./live-kimi-ui-audit-2026-03-14/screenshots/16-list-view-restored.png)

The sidebar contains, top to bottom:

- Kimi brand link/logo
- app version label
- `Sessions` section heading
- `Refresh sessions` icon button
- `New Session` icon button
- session search field
- layout toggle for `List view` vs `Grouped view`
- scrollable session list
- `Archived` disclosure row with count badge
- bottom utility controls:
  - theme toggle
  - sidebar collapse toggle

### 2. Main conversation area

Evidence:

- [`04-chat-initial.png`](./live-kimi-ui-audit-2026-03-14/screenshots/04-chat-initial.png)
- [`07-response-complete.png`](./live-kimi-ui-audit-2026-03-14/screenshots/07-response-complete.png)
- [`28-code-block-response.png`](./live-kimi-ui-audit-2026-03-14/screenshots/28-code-block-response.png)

The main area contains:

- a compact header row with session title and utility icons
- a scrolling log of messages and stateful blocks
- a bottom composer/status area that persists even while the message list changes

The layout reads like a professional coding assistant rather than a generic messaging app: there is strong emphasis on context usage, file footprint, model selection, and thought/tool states.

## Session list behavior

### Default state

The left rail shows recent sessions as vertically stacked row buttons. Each row contains:

- a truncated title or first-message label
- a relative timestamp such as `Just now`, `3m ago`, `10h ago`

Rows are pressable button-like cards, not plain links.

### Empty-state behavior

Evidence:

- [`01-landing.png`](./live-kimi-ui-audit-2026-03-14/screenshots/01-landing.png)

When no session is active, the main pane shows an empty-state message:

- `Create a session to begin`
- a short supporting sentence directing the user to the plus button
- a prominent `Create new session` CTA

This is a good reusable pattern: the app points users to the same creation affordance exposed in the sidebar, rather than introducing a second competing flow.

### List vs grouped mode

Evidence:

- [`12-grouped-view.md`](./live-kimi-ui-audit-2026-03-14/snapshots/12-grouped-view.md)
- [`15-grouped-view.png`](./live-kimi-ui-audit-2026-03-14/screenshots/15-grouped-view.png)
- [`16-list-view-restored.png`](./live-kimi-ui-audit-2026-03-14/screenshots/16-list-view-restored.png)

The session presentation mode is switched using a radio group with icon-only controls:

- `List view`
- `Grouped view`

This is not a hidden settings preference; it is a highly visible top-of-sidebar control. That indicates the product considers session browsing structure a frequently changed working mode.

### Search

The session filter is a simple inline search box labeled `Search sessions...`. It sits above the list and below the action buttons, making it one of the core primitives of session discovery.

### Archived access

The `Archived` row includes a visible count badge. It is treated as a collapsible/expandable subsection rather than a separate screen.

## New session flow

Evidence:

- [`02-new-session-modal.png`](./live-kimi-ui-audit-2026-03-14/screenshots/02-new-session-modal.png)
- [`03-new-session-path-filled.png`](./live-kimi-ui-audit-2026-03-14/screenshots/03-new-session-path-filled.png)
- [`02-new-session-modal.md`](./live-kimi-ui-audit-2026-03-14/snapshots/02-new-session-modal.md)

### Entry point

The primary new-session trigger is the sidebar plus button labeled `New Session`.

### Dialog anatomy

Pressing the button opens a centered modal dialog with:

- heading: `Create New Session`
- supporting text: `Search directories or type a new path`
- path search/input field
- a visible `Current Directory` shortcut
- a scrollable list of `Recent Directories`

This is a path-first session creation flow. The first decision is where the session should live in the filesystem, not the name of the chat.

### Confirmed creation behavior

During the audit, the path `/root/pi-web-ui` was entered and accepted. A new disposable session was created successfully and appeared in the session list as an untitled session with its UUID in the label.

Reusable design takeaway: for agent UIs that are tied to workspace state, a path picker is a strong alternative to asking the user for a chat title first.

## Chat screen anatomy

Evidence:

- [`04-chat-initial.md`](./live-kimi-ui-audit-2026-03-14/snapshots/04-chat-initial.md)
- [`05-message-composed.png`](./live-kimi-ui-audit-2026-03-14/screenshots/05-message-composed.png)
- [`06-response-loading.png`](./live-kimi-ui-audit-2026-03-14/screenshots/06-response-loading.png)
- [`07-response-complete.png`](./live-kimi-ui-audit-2026-03-14/screenshots/07-response-complete.png)

### Header controls

The active session header contains:

- a session title button
- `Session info`
- `Search messages`
- `Unfold all blocks`

This is a clean pattern: three high-value actions sit in the header and all are icon based, leaving the chat itself visually dominant.

### Composer and footer controls

The bottom composer area includes:

- `Expand input`
- main text field with placeholder `Ask anything, / for commands, @ to mention files`
- `Attach files`
- `Change global model`
- `Thinking` label with a global thinking switch
- `Submit`

Directly above or beside the composer is a compact operational status strip with:

- agent status text such as `Awaiting input` or `Connecting...`
- a file/diff context pill such as `+0 -0 7 files`
- a context usage pill such as `0.0% context`, `9.3% context`, or `0.9% context`

This footer is important. It makes the app feel like a coding workstation rather than a plain conversation window.

## Message rendering model

### User messages

User messages render as plain prompt content rows in the log, visually lighter than assistant output blocks.

### Assistant messages

Assistant responses render as richer grouped cards with:

- the response body
- optional thought block above the final answer
- action row containing:
  - `Copy`
  - `Fork session`

The presence of `Fork session` at the message level is a notable product idea: branching is attached to an exact conversational point rather than only to a session-level menu.

### Streaming / active generation state

Evidence:

- [`06-response-loading.png`](./live-kimi-ui-audit-2026-03-14/screenshots/06-response-loading.png)

During generation:

- the footer status changes to `Connecting...`
- a `Thought for Xs` row appears
- the UI preserves the overall layout instead of replacing the entire message card with a spinner

This is a good pattern for agent UIs because it keeps the user oriented while signaling progress.

## Thought blocks

Evidence:

- [`08-thought-expanded.png`](./live-kimi-ui-audit-2026-03-14/screenshots/08-thought-expanded.png)

Thoughts are first-class collapsible sections. The trigger text follows the pattern `Thought for 4s`, combining label and elapsed duration.

When expanded, the thought content appears inline above the final answer. This makes the chain-of-thought-adjacent experience feel inspectable without overwhelming the default view.

Reusable pattern:

- collapsed by default or easily collapsible
- explicit elapsed-time labeling
- separate from final answer block
- `Unfold all blocks` header action to expand multiple hidden sections at once

## Markdown and code rendering

Evidence:

- [`28-code-block-response.png`](./live-kimi-ui-audit-2026-03-14/screenshots/28-code-block-response.png)
- [`24-code-block-response.md`](./live-kimi-ui-audit-2026-03-14/snapshots/24-code-block-response.md)

The audit confirmed rendering of:

- headings
- bullet lists
- fenced code blocks

Code blocks include a tiny toolbar/header area with two icon actions above the code. The exact icons were not text-labeled in the snapshot, but they are visually distinct from the broader message-level `Copy` and `Fork session` actions.

Implementation takeaway: use both message-level actions and code-block-local actions. They serve different user intents.

## Header popups and dialogs

### Session info popover

Evidence:

- [`09-session-info.png`](./live-kimi-ui-audit-2026-03-14/screenshots/09-session-info.png)
- [`06-session-info.md`](./live-kimi-ui-audit-2026-03-14/snapshots/06-session-info.md)

`Session info` opens a compact overlay showing copyable session metadata, including:

- Session ID
- Working Directory
- Session Directory

Each field appears designed to be copied independently. This is a pragmatic operator-friendly panel rather than a decorative info modal.

### Search messages dialog

Evidence:

- [`11-search-messages.png`](./live-kimi-ui-audit-2026-03-14/screenshots/11-search-messages.png)
- [`09-search-messages.md`](./live-kimi-ui-audit-2026-03-14/snapshots/09-search-messages.md)
- [`traces/console-warning.log`](./live-kimi-ui-audit-2026-03-14/traces/console-warning.log)

`Search messages` opens a centered dialog with:

- a search field
- instruction/footer text
- keyboard hints for `↑↓`, `Enter`, and `Esc`

This dialog is clearly optimized for keyboard-driven recall inside long sessions.

Accessibility note from live console:

- `Warning: Missing Description or aria-describedby={undefined} for {DialogContent}.`

That warning appeared while this dialog family was open, so another implementation should preserve the structure but fix the missing descriptive association.

### Model selector dialog

Evidence:

- [`17-model-menu.png`](./live-kimi-ui-audit-2026-03-14/screenshots/17-model-menu.png)
- [`13-model-menu.md`](./live-kimi-ui-audit-2026-03-14/snapshots/13-model-menu.md)

The model picker opens as a proper selection dialog with:

- heading `Select global model`
- combobox
- listbox of models
- close control

This is not an inline dropdown tucked into the composer. It behaves more like a command/search dialog, which scales better for large model catalogs.

## Slash command palette

Evidence:

- [`18-slash-palette-root.png`](./live-kimi-ui-audit-2026-03-14/screenshots/18-slash-palette-root.png)
- [`19-slash-palette-model-filter.png`](./live-kimi-ui-audit-2026-03-14/screenshots/19-slash-palette-model-filter.png)
- [`14-slash-palette-root.md`](./live-kimi-ui-audit-2026-03-14/snapshots/14-slash-palette-root.md)
- [`15-slash-palette-model-filter.md`](./live-kimi-ui-audit-2026-03-14/snapshots/15-slash-palette-model-filter.md)

### Placement and structure

Typing `/` in the composer opens a palette anchored above the input area. It visually behaves like a command menu attached to the composer, not like a full-screen command bar.

The palette contains a vertically scrollable command list with rich descriptions. Built-in commands observed at the top included:

- `/init`
- `/compact`
- `/clear`
- `/yolo`
- `/plan`
- `/add-dir`
- `/export`
- `/import`

### Skill command integration

Below the core built-ins, the palette expands into a long `/skill:*` catalog. This is important: the product treats built-in slash commands and installed skills as one unified discovery surface.

### Filtering behavior

Filtering rapidly biases toward skill entries. For example, filtering with `/mo` surfaced skill-style entries rather than a simple short model-only menu.

### `/help` quirk

Evidence:

- [`16-slash-help.md`](./live-kimi-ui-audit-2026-03-14/snapshots/16-slash-help.md)
- [`20-slash-help.png`](./live-kimi-ui-audit-2026-03-14/screenshots/20-slash-help.png)

Typing `/help` did not reveal a native built-in help sheet in the tested deployment. Instead, the composed value was driven toward `/skill:kimi-cli-help`.

This is a critical product detail: the deployed UI's help-discovery behavior differs from what a user might expect from a classic slash-command system.

## Slash command execution findings

### Execution mechanic

In this deployment, slash commands in the multiline composer were not reliably executed by pressing `Enter` alone. The reliable path was:

1. type or select the slash command
2. click the `Submit` button

If another agent UI copies this behavior, it should do so deliberately. Otherwise, a stronger keyboard-commit behavior would likely be more intuitive.

### Observed results

| Command | Result observed in live UI | Evidence |
| --- | --- | --- |
| `/plan` | Inline assistant-style system response: `Plan mode ON...` with generated plan file path | [`24-slash-plan-submitted.png`](./live-kimi-ui-audit-2026-03-14/screenshots/24-slash-plan-submitted.png), [`20-slash-plan-submitted.md`](./live-kimi-ui-audit-2026-03-14/snapshots/20-slash-plan-submitted.md) |
| `/yolo` | Inline confirmation: `You only live once! All actions will be auto-approved.` | [`25-slash-yolo-submitted.png`](./live-kimi-ui-audit-2026-03-14/screenshots/25-slash-yolo-submitted.png), [`21-slash-yolo-submitted.md`](./live-kimi-ui-audit-2026-03-14/snapshots/21-slash-yolo-submitted.md) |
| `/new` | Inline error: `Unknown slash command "/new".` | [`26-slash-new-submitted.png`](./live-kimi-ui-audit-2026-03-14/screenshots/26-slash-new-submitted.png), [`22-slash-new-submitted.md`](./live-kimi-ui-audit-2026-03-14/snapshots/22-slash-new-submitted.md) |
| `/export` | Export succeeded and wrote a markdown file under `~/pi-web-ui/`; warning about sensitive info included | [`27-slash-export-submitted.png`](./live-kimi-ui-audit-2026-03-14/screenshots/27-slash-export-submitted.png), [`23-slash-export-submitted.md`](./live-kimi-ui-audit-2026-03-14/snapshots/23-slash-export-submitted.md) |
| `/compact keep only a brief summary of slash command testing and UI findings` | Inline processing followed by `The context has been compacted.` | [`29-slash-compact.png`](./live-kimi-ui-audit-2026-03-14/screenshots/29-slash-compact.png), [`30-slash-compact-complete.png`](./live-kimi-ui-audit-2026-03-14/screenshots/30-slash-compact-complete.png), [`26-slash-compact-complete.md`](./live-kimi-ui-audit-2026-03-14/snapshots/26-slash-compact-complete.md) |
| `/clear` | Inline success: `The context has been cleared.` with context usage dropping to `0.0%` | [`31-slash-clear-submitted.png`](./live-kimi-ui-audit-2026-03-14/screenshots/31-slash-clear-submitted.png), [`27-slash-clear-submitted.md`](./live-kimi-ui-audit-2026-03-14/snapshots/27-slash-clear-submitted.md) |

### Important product conclusion

Slash commands in the deployed product mostly resolve as inline transcript events, not separate toast banners, wizards, or full modal workflows.

That is a major reusable pattern:

- keep the user inside the conversation
- render mode toggles and command results as chat-native system responses
- use the transcript itself as the audit trail for mode changes

## Dynamic state indicators

### Context usage pill

Evidence:

- pre-compaction: around `9.3%`
- post-compaction: `0.9%`
- post-clear: `0.0%`

This makes context pressure visible in a lightweight, always-available way. It is one of the most reusable ideas from this UI.

### File/diff pill

Examples observed:

- `+0 -0 7 files`
- `+0 -0 584 files`
- `+0 -0 995 files`

This pill compresses working-set scope into a single compact control. It likely opens a secondary surface for file details, though the audit prioritized higher-value surfaces first.

### Status text

Observed status values included:

- `Awaiting input`
- `Connecting...`

During longer slash operations such as compaction, the composer also shifted into a more active follow-up state and briefly exposed stop/queue-style affordances.

## Notable quirks and inconsistencies

These are especially useful if another agent UI is borrowing the same ideas but wants to tighten the UX.

### 1. Hidden dialog remnants in snapshots

After session creation and some later interactions, the accessibility snapshots still contained `Create New Session` dialog content even though the user-visible flow had moved on. That suggests dialog nodes may remain mounted or remain exposed longer than ideal.

### 2. Dismissal behavior was not always clean

Some overlays/popovers did not appear to disappear cleanly from the snapshot tree after `Esc`, even when the visible UI had advanced.

### 3. `/help` behavior was surprising

The deployment did not expose a straightforward built-in help surface through `/help`; it drifted into a skill suggestion path instead.

### 4. Slash command submission favored clicking over keyboard

This is workable but slightly at odds with the otherwise operator-friendly, keyboard-aware design language of the rest of the product.

### 5. Search dialog accessibility warning

The live deployment emitted a dialog accessibility warning about missing description linkage.

## Reusable patterns worth carrying into another agent UI

### Must-copy patterns

1. **Persistent session rail plus active chat pane**
   - Keeps multi-session work discoverable without breaking chat focus.

2. **Workspace-path-first session creation**
   - Strong fit for coding agents that operate on filesystem context.

3. **Operational footer around the composer**
   - Status, file footprint, context usage, model, and thinking controls all belong close to the input.

4. **Inline slash-command audit trail**
   - Mode changes like `/plan`, `/yolo`, `/compact`, and `/clear` feel trustworthy when they appear as transcript events.

5. **Collapsible thought blocks with elapsed time**
   - Great compromise between transparency and clutter control.

6. **Message-level branching via `Fork session`**
   - This is a differentiated feature that maps naturally to agent workflows.

### Patterns to improve when reusing

1. Make `Enter` slash submission explicit and reliable.
2. Ensure dialogs unmount cleanly and are removed from the accessibility tree when closed.
3. Keep `/help` as a predictable first-party affordance even if skills exist.
4. Preserve keyboard hints, but fully wire up accessible descriptions for dialogs.

## Minimal UI contract for another implementation

If another product wants to reproduce the core feel of this UI, it should at minimum implement:

- left session rail with search, refresh, create, archive access, and alternate list/group views
- path-based new-session dialog
- active chat header with session info, search, and block expansion
- composer with attachment, model switching, thinking toggle, submit, and context indicators
- assistant messages with copy and branch actions
- expandable thought blocks
- slash palette anchored above the composer
- inline transcript responses for command-driven mode changes

Without these pieces, the result may still be a chat app, but it will not feel like this Kimi-style coding agent workstation.

## Evidence index

### Core screenshots

- Landing: [`01-landing.png`](./live-kimi-ui-audit-2026-03-14/screenshots/01-landing.png)
- New session modal: [`02-new-session-modal.png`](./live-kimi-ui-audit-2026-03-14/screenshots/02-new-session-modal.png)
- New session path entered: [`03-new-session-path-filled.png`](./live-kimi-ui-audit-2026-03-14/screenshots/03-new-session-path-filled.png)
- Initial chat: [`04-chat-initial.png`](./live-kimi-ui-audit-2026-03-14/screenshots/04-chat-initial.png)
- Message composed: [`05-message-composed.png`](./live-kimi-ui-audit-2026-03-14/screenshots/05-message-composed.png)
- Loading state: [`06-response-loading.png`](./live-kimi-ui-audit-2026-03-14/screenshots/06-response-loading.png)
- Completed response: [`07-response-complete.png`](./live-kimi-ui-audit-2026-03-14/screenshots/07-response-complete.png)
- Thought expanded: [`08-thought-expanded.png`](./live-kimi-ui-audit-2026-03-14/screenshots/08-thought-expanded.png)
- Session info: [`09-session-info.png`](./live-kimi-ui-audit-2026-03-14/screenshots/09-session-info.png)
- Search messages: [`11-search-messages.png`](./live-kimi-ui-audit-2026-03-14/screenshots/11-search-messages.png)
- Grouped view: [`15-grouped-view.png`](./live-kimi-ui-audit-2026-03-14/screenshots/15-grouped-view.png)
- Model menu: [`17-model-menu.png`](./live-kimi-ui-audit-2026-03-14/screenshots/17-model-menu.png)
- Slash palette root: [`18-slash-palette-root.png`](./live-kimi-ui-audit-2026-03-14/screenshots/18-slash-palette-root.png)
- Slash palette filtered: [`19-slash-palette-model-filter.png`](./live-kimi-ui-audit-2026-03-14/screenshots/19-slash-palette-model-filter.png)
- `/plan`: [`24-slash-plan-submitted.png`](./live-kimi-ui-audit-2026-03-14/screenshots/24-slash-plan-submitted.png)
- `/yolo`: [`25-slash-yolo-submitted.png`](./live-kimi-ui-audit-2026-03-14/screenshots/25-slash-yolo-submitted.png)
- `/export`: [`27-slash-export-submitted.png`](./live-kimi-ui-audit-2026-03-14/screenshots/27-slash-export-submitted.png)
- Markdown/code rendering: [`28-code-block-response.png`](./live-kimi-ui-audit-2026-03-14/screenshots/28-code-block-response.png)
- `/compact`: [`30-slash-compact-complete.png`](./live-kimi-ui-audit-2026-03-14/screenshots/30-slash-compact-complete.png)
- `/clear`: [`31-slash-clear-submitted.png`](./live-kimi-ui-audit-2026-03-14/screenshots/31-slash-clear-submitted.png)

## Final conclusion

The live Kimi Web UI is best understood as a coding-agent control room built around four ideas:

- sessions are first-class and always nearby
- the composer doubles as a command launcher
- agent state is exposed through compact operational indicators
- command and mode transitions are recorded inside the conversation itself

That combination gives the product a distinctly "serious agent operator" feel. If another agent web UI adopts the same structure, especially the session rail, operational composer footer, inline mode transcript, and branching/thought affordances, it can recreate most of the practical strengths of this interface without copying its branding.
