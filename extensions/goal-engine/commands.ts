/**
 * Goal Engine — Commands
 *
 * Registers the /goal command and its subcommands with Pi.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { isActive, type GoalState } from "./state.js";
import { buildGoalPrompt } from "./prompt.js";

/**
 * Register all goal-engine commands.
 */
export function registerCommands(
	pi: ExtensionAPI,
	getState: () => GoalState,
	setState: (gs: GoalState) => void,
	saveState: (gs: GoalState) => void,
	clearState: () => GoalState,
	resetErrors: () => void,
): void {
	// ═══════════════════════════════════════════════════════
	// /goal [objective]
	// ═══════════════════════════════════════════════════════
	pi.registerCommand("goal", {
		description:
			"Define and start an autonomous goal. The agent will keep working until the objective is met. Subcommands: pause, resume, clear, status.",
		args: [{ name: "objective", description: "The verifiable objective to achieve (or subcommand: pause, resume, clear, status)" }],
		handler: async (args, ctx) => {
			const input = args.objective?.trim() || "";

			// If no argument, show status
			if (!input) {
				await showGoalStatus(getState(), ctx);
				return;
			}

			// Subcommands
			const sub = input.toLowerCase();
			if (sub === "pause") {
				await pauseGoal(getState, setState, saveState, ctx);
				return;
			}
			if (sub === "resume") {
				await resumeGoal(getState, setState, saveState, resetErrors, pi, ctx);
				return;
			}
			if (sub === "clear") {
				await clearGoal(getState, clearState, ctx);
				return;
			}
			if (sub === "status") {
				await showGoalStatus(getState(), ctx);
				return;
			}

			// Otherwise: start a new goal
			await startGoal(input, getState, setState, saveState, resetErrors, pi, ctx);
		},
	});

	// ═══════════════════════════════════════════════════════
	// Convenience subcommands as separate commands
	// ═══════════════════════════════════════════════════════

	pi.registerCommand("goal-pause", {
		description: "Pause the active goal (wraps up current turn)",
		handler: async (_args, ctx) => {
			await pauseGoal(getState, setState, saveState, ctx);
		},
	});

	pi.registerCommand("goal-resume", {
		description: "Resume a paused goal",
		handler: async (_args, ctx) => {
			await resumeGoal(getState, setState, saveState, resetErrors, pi, ctx);
		},
	});

	pi.registerCommand("goal-clear", {
		description: "Clear the current goal",
		handler: async (_args, ctx) => {
			await clearGoal(getState, clearState, ctx);
		},
	});

	pi.registerCommand("goal-status", {
		description: "Show current goal status",
		handler: async (_args, ctx) => {
			await showGoalStatus(getState(), ctx);
		},
	});
}

// ═══════════════════════════════════════════════════════════
// Command handlers
// ═══════════════════════════════════════════════════════════

async function startGoal(
	objective: string,
	getState: () => GoalState,
	setState: (gs: GoalState) => void,
	saveState: (gs: GoalState) => void,
	resetErrors: () => void,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const existing = getState();
	if (isActive(existing)) {
		const override = await ctx.ui.confirm(
			"Goal already active",
			`A goal is currently ${existing.status}: "${existing.objective.slice(0, 60)}${existing.objective.length > 60 ? "…" : ""}"\n\nOverride with new goal?`,
		);
		if (!override) {
			ctx.ui.notify("Goal unchanged. Use /goal pause or /goal clear first.", "info");
			return;
		}
	}

	const gs: GoalState = {
		objective,
		planItems: [],
		planDone: [],
		status: "running",
		turnCount: 0,
		startedAt: Date.now(),
		completedAt: null,
	};

	setState(gs);
	saveState(gs);
	resetErrors();

	ctx.ui.notify(
		`🎯 Goal started: "${objective.slice(0, 60)}${objective.length > 60 ? "…" : ""}"\nUse /goal pause, /goal status, or /goal clear to manage.`,
		"success",
	);

	// Send the initial prompt
	const goalPrompt = buildGoalPrompt(gs);
	await ctx.waitForIdle();
	pi.sendUserMessage(
		`Goal: ${objective}\n\nBegin working toward this objective. Start by exploring the codebase, understanding what needs to change, and creating a plan. Then execute the plan, verifying your progress at each step.`,
	);
}

async function pauseGoal(
	getState: () => GoalState,
	setState: (gs: GoalState) => void,
	saveState: (gs: GoalState) => void,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const gs = getState();
	if (gs.status !== "running") {
		ctx.ui.notify(`No active goal to pause (status: ${gs.status})`, "warning");
		return;
	}

	gs.status = "wrapping-up";
	setState(gs);
	saveState(gs);
	ctx.ui.notify(
		"⏸ Pausing — the agent will finish its current turn then stop. Use /goal resume to continue.",
		"info",
	);
}

async function resumeGoal(
	getState: () => GoalState,
	setState: (gs: GoalState) => void,
	saveState: (gs: GoalState) => void,
	resetErrors: () => void,
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const gs = getState();
	if (gs.status !== "paused") {
		ctx.ui.notify(`No paused goal to resume (status: ${gs.status}). Use /goal "objective" to start one.`, "warning");
		return;
	}

	gs.status = "running";
	setState(gs);
	saveState(gs);
	resetErrors();

	ctx.ui.notify(`▶ Resuming goal: "${gs.objective.slice(0, 50)}${gs.objective.length > 50 ? "…" : ""}" (Turn ${gs.turnCount + 1})`, "info");

	await ctx.waitForIdle();
	pi.sendUserMessage(
		"Resume working toward the goal. Continue from where you left off. Report progress and whether the objective has been fully achieved.",
	);
}

async function clearGoal(
	getState: () => GoalState,
	clearState: () => GoalState,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const gs = getState();
	if (!isActive(gs) && gs.status !== "paused") {
		ctx.ui.notify("No active goal to clear.", "warning");
		return;
	}

	const confirmed = await ctx.ui.confirm(
		"Clear goal?",
		`This will permanently stop the goal:\n"${gs.objective.slice(0, 80)}${gs.objective.length > 80 ? "…" : ""}"\n\n${gs.turnCount} turns completed. Progress will not be saved.`,
	);

	if (!confirmed) {
		ctx.ui.notify("Goal unchanged.", "info");
		return;
	}

	clearState();
	ctx.ui.notify("🗑 Goal cleared.", "info");
}

async function showGoalStatus(gs: GoalState, ctx: ExtensionCommandContext): Promise<void> {
	if (gs.status === "idle") {
		ctx.ui.notify("No active goal. Use /goal \"objective\" to start one.", "info");
		return;
	}

	const statusLabel: Record<string, string> = {
		idle: "Idle",
		running: "▶ Running",
		"wrapping-up": "⏸ Wrapping up…",
		paused: "⏸ Paused",
	};

	const lines: string[] = [];
	lines.push(`Status: ${statusLabel[gs.status] || gs.status}`);
	lines.push(`Objective: ${gs.objective}`);
	lines.push(`Started: ${new Date(gs.startedAt).toLocaleString()}`);
	lines.push(`Turns: ${gs.turnCount}`);

	if (gs.planItems.length > 0) {
		lines.push("");
		lines.push("Plan:");
		for (let i = 0; i < gs.planItems.length; i++) {
			lines.push(`  ${gs.planDone[i] ? "✓" : "☐"} ${gs.planItems[i]}`);
		}
	}

	if (gs.completedAt) {
		lines.push("");
		lines.push(`Completed: ${new Date(gs.completedAt).toLocaleString()}`);
	}

	if (!ctx.hasUI) {
		ctx.ui.notify(lines.join("\n"), "info");
		return;
	}

	// Show detailed overview in UI
	await ctx.ui.custom<void>((tui, theme, _, done) => {
		const content = lines.join("\n").split("\n");
		return {
			handleInput(data: string): void {
				if (data === "\x1b" || data === "\x03") done();
			},
			render(_width: number): string[] {
				const result: string[] = [];
				result.push("");
				result.push(`  ${theme.fg("accent", "═══ Goal Status ═══")}`);
				result.push("");
				for (const line of content) {
					if (line.startsWith("Status:")) {
						result.push(`  ${theme.fg("bold", line)}`);
					} else if (line.startsWith("  ") && (line.includes("✓") || line.includes("☐"))) {
						result.push(`  ${theme.fg(line.includes("✓") ? "success" : "muted", line)}`);
					} else {
						result.push(`  ${theme.fg("muted", line)}`);
					}
				}
				result.push("");
				result.push(`  ${theme.fg("dim", "Press Escape to close")}`);
				result.push("");
				return result;
			},
		};
	});
}
