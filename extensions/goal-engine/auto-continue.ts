/**
 * Goal Engine — Auto-Continuation Loop
 *
 * After each turn, if the goal is still active and not paused, queues a
 * follow-up message so the agent continues working without user input.
 *
 * Also handles the "wrapping-up" state (triggered by /goal pause) and
 * detects goal completion via verify.ts.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { isGoalAchieved, extractAssistantText } from "./verify.js";
import { isActive, progressText, saveGoalState, type GoalState } from "./state.js";

const MAX_CONSECUTIVE_ERRORS = 3;

export function registerAutoContinueHooks(
	pi: ExtensionAPI,
	getState: () => GoalState,
	setState: (gs: GoalState) => void,
): {
	consecutiveErrors: () => number;
	resetErrors: () => void;
} {
	let consecutiveErrors = 0;

	pi.on("turn_end", async (event, ctx) => {
		const gs = getState();
		if (!isActive(gs)) return;

		// Parse the assistant's final message
		const assistantText = extractAssistantText(event.message);

		// Check for goal completion
		if (isGoalAchieved(assistantText)) {
			gs.status = "idle";
			gs.completedAt = Date.now();
			setState(gs);
			saveGoalState(gs, pi);
			ctx.ui.notify(
				`🎯 Goal achieved in ${gs.turnCount} turns: "${gs.objective.slice(0, 50)}${gs.objective.length > 50 ? "…" : ""}"`,
				"success",
			);
			consecutiveErrors = 0;
			return;
		}

		// Handle wrapping-up → pause
		if (gs.status === "wrapping-up") {
			gs.status = "paused";
			setState(gs);
			saveGoalState(gs, pi);
			ctx.ui.notify(
				`⏸ Goal paused after ${gs.turnCount} turns — use /goal resume to continue`,
				"info",
			);
			consecutiveErrors = 0;
			return;
		}

		// Check for error / aborted turn
		const isError =
			event.message.role === "assistant" &&
			"stopReason" in event.message &&
			(event.message as { stopReason?: string }).stopReason === "error";

		if (isError) {
			consecutiveErrors++;
			if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
				gs.status = "paused";
				setState(gs);
				saveGoalState(gs, pi);
				ctx.ui.notify(
					`⚠ Goal paused after ${consecutiveErrors} consecutive errors. Use /goal resume to retry.`,
					"warning",
				);
				return;
			}
			ctx.ui.notify(
				`⚠ Goal turn ${gs.turnCount} ended with error (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}). Retrying…`,
				"warning",
			);
		} else {
			consecutiveErrors = 0; // Reset on successful turn
		}

		// Increment turn count and queue continuation
		gs.turnCount++;
		setState(gs);
		saveGoalState(gs, pi);

		// Queue auto-continuation. Small delay to let post-turn processing
		// (auto-compaction, queued messages) settle.
		setTimeout(() => {
			// Only queue if goal is still active (could have been paused/cleared
			// during the timeout)
			const fresh = getState();
			if (fresh.status !== "running") return;

			pi.sendUserMessage(
				"Continue working toward the goal. Report your progress and state whether the objective has been fully achieved.",
				{ deliverAs: "followUp" },
			);
		}, 200);
	});

	return {
		consecutiveErrors: () => consecutiveErrors,
		resetErrors: () => { consecutiveErrors = 0; },
	};
}
