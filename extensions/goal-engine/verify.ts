/**
 * Goal Engine — Completion Verification
 *
 * Detects when the agent has achieved its goal by parsing the
 * assistant's final output for explicit completion signals.
 *
 * v1: Signal-based — agent says "GOAL_ACHIEVED" when done.
 * v2: Plan-based — parse compaction summary's ### Done section.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";

// ═══════════════════════════════════════════════════════════
// Completion Signals
// ═══════════════════════════════════════════════════════════

const COMPLETION_PATTERNS = [
	/\bGOAL_ACHIEVED\b/i,
	/\bOBJECTIVE_ACHIEVED\b/i,
	/\ball tasks (?:are )?complete\b/i,
	/\bthe goal has been (?:fully )?achieved\b/i,
];

/**
 * Check whether the assistant text signals goal completion.
 * Case-insensitive, matches explicit completion signals.
 */
export function isGoalAchieved(text: string): boolean {
	if (!text || text.length < 5) return false;
	return COMPLETION_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Extract the assistant's text content from an AgentMessage.
 */
export function extractAssistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";

	const content = (message as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const block of content) {
		if (
			typeof block === "object" &&
			block !== null &&
			"type" in block &&
			block.type === "text" &&
			"text" in block &&
			typeof block.text === "string"
		) {
			parts.push(block.text);
		}
	}
	return parts.join("\n");
}
