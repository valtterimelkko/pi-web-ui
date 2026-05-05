/**
 * Goal Engine — Compaction Hooks
 *
 * Hooks into Pi's compaction lifecycle to preserve goal state across
 * context summarization and re-inject context afterward.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { buildGoalPrompt } from "./prompt.js";
import { isActive, saveGoalState, type GoalState } from "./state.js";

/**
 * Register compaction lifecycle handlers.
 */
export function registerCompactionHooks(
	pi: ExtensionAPI,
	getState: () => GoalState,
): void {
	// ── Before compaction: persist goal state ──────────────────
	pi.on("session_before_compact", async (_event, _ctx) => {
		const gs = getState();
		if (!isActive(gs)) return;
		// Persist current state so it survives the compaction boundary.
		saveGoalState(gs, pi);
	});

	// ── After compaction: inject context recovery for the agent ──
	pi.on("session_compact", async (_event, ctx) => {
		const gs = getState();
		if (!isActive(gs)) return;

		ctx.ui.notify(
			`📦 Goal "${gs.objective.slice(0, 40)}${gs.objective.length > 40 ? "…" : ""}" — context compacted, goal still active`,
			"info",
		);

		// Inject a context-recovery message that the agent sees next turn.
		// This primes it to re-read files and re-orient itself.
		pi.sendMessage(
			{
				customType: "goal_context_restored",
				content: [
					"CONTEXT COMPACTED. The conversation has been summarized.\n",
					"Your goal is still active. The goal prompt will be re-injected.\n",
					"Re-read any files you were working on before continuing.\n",
					buildGoalPrompt(gs),
				].join("\n"),
				display: "Goal context restored after compaction",
			},
			{ deliverAs: "followUp" },
		);
	});
}
