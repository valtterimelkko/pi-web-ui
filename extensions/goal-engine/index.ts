/**
 * Goal Engine — Autonomous Multi-Turn Goal Execution for Pi
 *
 * Defines a verifiable objective that Pi will keep working toward across
 * multiple turns until the goal is achieved, paused, or cleared.
 *
 * Commands:
 *   /goal "objective"       — Start a new autonomous goal
 *   /goal pause             — Pause (wraps up current turn)
 *   /goal resume            — Continue from paused
 *   /goal clear             — Abandon the current goal
 *   /goal status            — Show detailed goal progress
 *   /goal                   — Alias for status
 *
 * Hooks:
 *   before_agent_start — Injects goal system prompt every turn
 *   turn_end           — Auto-continuation loop + completion detection
 *   session_before_compact — Persists goal state before compaction
 *   session_compact    — Re-injects context after compaction
 *   session_start      — Reconstructs state from session entries
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { registerCommands } from "./commands.js";
import { registerCompactionHooks } from "./compaction.js";
import { registerAutoContinueHooks } from "./auto-continue.js";
import { buildGoalPrompt } from "./prompt.js";
import { isActive, loadGoalState, saveGoalState, clearGoalState, type GoalState, EMPTY_GOAL_STATE } from "./state.js";

export default function (pi: ExtensionAPI): void {
	// ── In-memory goal state ──────────────────────────────────
	let goalState: GoalState = { ...EMPTY_GOAL_STATE };

	const getState = () => goalState;
	const setState = (gs: GoalState) => { goalState = gs; };
	const saveState = (gs: GoalState) => saveGoalState(gs, pi);
	const clearState = () => {
		const cleared = clearGoalState(pi);
		goalState = cleared;
		return cleared;
	};

	// ═══════════════════════════════════════════════════════
	// Session lifecycle — reconstruct state on load
	// ═══════════════════════════════════════════════════════

	pi.on("session_start", async (_event, ctx) => {
		goalState = loadGoalState(ctx);
		if (isActive(goalState)) {
			ctx.ui.notify(
				`🎯 Goal restored: "${goalState.objective.slice(0, 50)}${goalState.objective.length > 50 ? "…" : ""}" — use /goal resume to continue`,
				"info",
			);
		}
	});

	// ═══════════════════════════════════════════════════════
	// System prompt injection — every turn while active
	// ═══════════════════════════════════════════════════════

	pi.on("before_agent_start", async (event, _ctx) => {
		const gs = getState();
		if (!isActive(gs)) return;
		const goalBlock = buildGoalPrompt(gs);
		return { systemPrompt: event.systemPrompt + "\n\n" + goalBlock };
	});

	// ═══════════════════════════════════════════════════════
	// Auto-continue loop
	// ═══════════════════════════════════════════════════════

	const { resetErrors } = registerAutoContinueHooks(pi, getState, setState);

	// ═══════════════════════════════════════════════════════
	// Compaction hooks
	// ═══════════════════════════════════════════════════════

	registerCompactionHooks(pi, getState);

	// ═══════════════════════════════════════════════════════
	// Commands
	// ═══════════════════════════════════════════════════════

	registerCommands(pi, getState, setState, saveState, clearState, resetErrors);
}
