/**
 * Goal Engine — State Management
 *
 * Goal state persisted via pi.appendEntry("goal_engine", ...) so it survives
 * compaction. On session reload, state is reconstructed from session entries.
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

// ═══════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════

export type GoalStatus = "idle" | "running" | "wrapping-up" | "paused";

export interface GoalState {
	objective: string;
	/** Plan items — extracted from agent's first pass at the goal */
	planItems: string[];
	/** Which items have been marked done by the agent */
	planDone: boolean[];
	status: GoalStatus;
	turnCount: number;
	startedAt: number;
	completedAt: number | null;
}

export const EMPTY_GOAL_STATE: GoalState = {
	objective: "",
	planItems: [],
	planDone: [],
	status: "idle",
	turnCount: 0,
	startedAt: 0,
	completedAt: null,
};

// ═══════════════════════════════════════════════════════════
// Persistence via session entries
// ═══════════════════════════════════════════════════════════

const ENTRY_TYPE = "goal_engine";

/**
 * Call on session_start / session_reload to reconstruct state from the
 * most recent goal_engine entry in the session branch.
 */
export function loadGoalState(ctx: ExtensionContext): GoalState {
	const entries = ctx.sessionManager.getBranch();
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.type === "custom" && "customType" in entry && entry.customType === ENTRY_TYPE) {
			const data = (entry as { data?: GoalState }).data;
			if (data) return { ...EMPTY_GOAL_STATE, ...data };
		}
	}
	return { ...EMPTY_GOAL_STATE };
}

/** Persist a copy of state so it is available after compaction / reload. */
export function saveGoalState(goalState: GoalState, pi: { appendEntry<T>(type: string, data?: T): void }): void {
	pi.appendEntry(ENTRY_TYPE, { ...goalState });
}

/** Reset to empty and persist. */
export function clearGoalState(pi: { appendEntry<T>(type: string, data?: T): void }): GoalState {
	const cleared = { ...EMPTY_GOAL_STATE };
	pi.appendEntry(ENTRY_TYPE, { ...cleared });
	return cleared;
}

// ═══════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════

export function isActive(gs: GoalState): boolean {
	return gs.status === "running" || gs.status === "wrapping-up";
}

export function progressText(gs: GoalState): string {
	if (gs.planItems.length === 0) return `Turn ${gs.turnCount}`;
	const done = gs.planDone.filter(Boolean).length;
	const total = gs.planItems.length;
	return `${done}/${total} items done — Turn ${gs.turnCount}`;
}
