# Goal Engine — v2 Feature Roadmap

Ideas for upgrading the goal-engine extension from MVP signal-based v1
to a more robust, production-grade autonomous agent experience.

---

## 1. Structured Plan Tracking

**Problem:** v1 relies on the agent self-reporting `GOAL_ACHIEVED`. This is fragile —
the agent can forget to signal, claim completion prematurely, or never claim it.

**Solution:** Parse the Pi compaction summary's `### Done` and `### In Progress`
sections after each turn. Track plan items with explicit `[x]` / `[ ]` markers.
When all items are `[x]`, goal is complete regardless of signal.

```
### Progress
#### Done
- [x] Audit hardcoded colors in SettingsPanel.tsx
- [x] Create ThemeContext with CSS variable definitions
#### In Progress
- [ ] Apply theme variables to settings components
```

**Effort:** Medium (~150 lines). Requires parsing markdown checkboxes
from the structured compaction summary format.

---

## 2. Metric-Based Verification

**Problem:** Plan-based goals are great for development tasks, but many goals
are measurable outcomes: "cut P95 latency by 20%", "reduce bundle size by 30%".

**Solution:** Allow goals with a metric expression:

```
/goal "Reduce bundle size to under 200KB" --metric "ls -l dist/bundle.js | awk '{print \$5}' < 204800"
```

The extension runs the metric command after each turn, parses the output,
and compares against the target. The goal is achieved when the metric is met.

**Effort:** Medium (~120 lines). Needs `ctx.bash()` for metric verification,
output parsing, and comparison logic. Stores metric command + target in goal state.

---

## 3. Maximum Turn Limit & Token Budget

**Problem:** A poorly-defined goal can run forever, burning tokens.

**Solution:** Configurable safety limits:
- `--max-turns 50` : stop after N turns regardless of completion
- `--max-tokens 500000` : stop after consuming this many tokens
- Default: 100 turns, no token limit

When limit is reached, pause and ask user whether to extend or clear.

**Effort:** Easy (~80 lines). Track `turnCount` and `totalTokens` in state,
check against limits in `turn_end` handler.

---

## 4. Resumable Goals (Cross-Session)

**Problem:** v1 goals only survive within a single Pi session. If the user
exits Pi or the process restarts, the goal state is lost.

**Solution:** Persist goal state to the auto-memory system (`.pi/memory/`).
On session start, check if an active goal exists and offer to resume.

**Effort:** Medium (~100 lines). Needs integration with the `memory` extension's
storage pattern. Goal state JSON written to disk, loaded on `session_start`.

---

## 5. Goal Discovery → Plan Handoff

**Problem:** The goal discovers a solution through exploration, but the resulting
changes may contain dead-ends, debug prints, or "scar tissue."

**Solution:** After goal completion:
1. Extract the "lessons learned" from the goal's compaction summaries
2. Generate a draft spec (`PRD.md` or plan file)
3. Offer to open in plan-mode for structured execution

This mirrors Ray Amjad's pattern: scrappy exploratory branch → distill → reimplement clean.

**Effort:** Medium (~150 lines). Needs to parse compaction summaries and
generate a structured plan output compatible with `enhanced-plan-mode`.

---

## 6. Parallel Sub-Goals

**Problem:** Some goals are naturally parallelizable — e.g., "add dark mode to
all feature modules" could be split into per-module sub-goals.

**Solution:** Combine with the `subagent` extension:
- Goal engine detects parallelizable plan items
- Spawns subagents for each independently verifiable sub-goal
- Collects results and synthesizes

**Effort:** High (~250 lines). Needs plan parsing, subagent integration,
result merging, and conflict resolution.

---

## 7. Side Conversations (if Pi Core Adds Shared-Context Branching)

**Problem:** Currently, you can't check progress or ask questions without
pausing the goal. Codex's `/side` solves this with shared prompt caching.

**Solution:** If Pi adds shared-context branching to core, implement `/goal side`
that opens a read-only side thread for inspection without disrupting the goal.

**Effort:** Depends on Pi core features. Trivial if shared-context branching exists.

---

## 8. Compaction Quality Metrics

**Problem:** Over long goals, you don't know if compaction is losing critical context.

**Solution:** After each compaction, compare the "before" and "after" summaries.
- Track information density (items per section)
- Warn if key decisions are dropped between compactions
- Offer to halt and run gap analysis

**Effort:** Medium (~120 lines). Parses compaction summaries and diffs them.

---

## 9. Goal Templates

**Problem:** Common goal patterns repeat: "optimize performance of X", "migrate Y to Z",
"add feature flag for A".

**Solution:** Template library with pre-built goal prompts, plan structures,
and verification strategies.

```
/goal template performance --target "API response time" --threshold "200ms"
/goal template migration --from "class components" --to "hooks"
```

**Effort:** Medium (~200 lines). Template system with parameter substitution.

---

## 10. Execution Log & Reporting

**Problem:** After a 14-hour goal (like Ray's), you want to understand what happened.

**Solution:** Generate a structured execution report:
- Timeline of decisions and changes
- Token consumption graph
- Files modified per turn
- Compaction events and information loss

Export as markdown or HTML.

**Effort:** Medium-High (~200 lines). Needs turn-by-turn tracking,
aggregation, and export formatting.
