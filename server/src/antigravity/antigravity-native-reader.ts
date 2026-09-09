import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { AntigravityTurn, AgyStoredToolCall } from "./antigravity-session-store.js";
import { AGY_STORED_TOOL_LIMIT, AGY_STORED_TOOL_OUTPUT_LIMIT } from "./antigravity-session-store.js";

/** Extract bare user request text from the prompt, stripping AGY envelope wrappers. */
export function cleanUserPrompt(raw: string): string {
  if (!raw) return "";
  const m = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/);
  if (m && m[1]) return m[1].trim();
  return raw.trim();
}

/** Parse an Antigravity native transcript JSONL file into AntigravityTurn objects. */
export function parseNativeAntigravityTranscript(
  jsonlContent: string,
  conversationId: string,
  model = "Gemini 3.5 Flash (Medium)",
): AntigravityTurn[] {
  const turns: AntigravityTurn[] = [];
  const lines = jsonlContent.split("\n").filter((l) => l.trim().length > 0);

  let currentPrompt: string | null = null;
  let currentPromptTs = Date.now();
  let currentResponse = "";
  let currentTools: AgyStoredToolCall[] = [];
  let currentStatus: "done" | "error" = "done";

  const flushTurn = () => {
    if (currentPrompt !== null) {
      turns.push({
        turnId: randomUUID(),
        prompt: currentPrompt,
        response: currentResponse,
        model,
        conversationId,
        timestamp: currentPromptTs,
        status: currentStatus,
        ...(currentTools.length > 0 ? { tools: currentTools.slice(0, AGY_STORED_TOOL_LIMIT) } : {}),
      });
      currentPrompt = null;
      currentResponse = "";
      currentTools = [];
      currentStatus = "done";
    }
  };

  for (const line of lines) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    const type = typeof parsed.type === "string" ? parsed.type : "";
    const content = typeof parsed.content === "string" ? parsed.content : "";

    if (type === "USER_INPUT") {
      flushTurn();
      currentPrompt = cleanUserPrompt(content);
      const createdAt = typeof parsed.created_at === "string" ? parsed.created_at : undefined;
      currentPromptTs = createdAt ? new Date(createdAt).getTime() : Date.now();
    } else if (type === "PLANNER_RESPONSE") {
      if (content.trim()) {
        currentResponse = currentResponse ? `${currentResponse}\n${content}` : content;
      }
      if (Array.isArray(parsed.tool_calls)) {
        for (const tc of parsed.tool_calls) {
          if (tc && typeof tc === "object" && typeof (tc as { name?: unknown }).name === "string") {
            const name = (tc as { name: string }).name;
            const args = (tc as { args?: unknown }).args;
            currentTools.push({
              toolName: name,
              args,
              isError: false,
            });
          }
        }
      }
      if (parsed.status === "ERROR") {
        currentStatus = "error";
      }
    } else if (type === "GENERIC" || type === "TOOL_RESULT") {
      if (currentTools.length > 0 && content) {
        const lastTool = currentTools[currentTools.length - 1];
        if (!lastTool.output) {
          lastTool.output = content.slice(0, AGY_STORED_TOOL_OUTPUT_LIMIT);
          lastTool.isError = parsed.status === "ERROR";
        }
      }
    }
  }

  flushTurn();
  return turns;
}

/** Resolve the native brain transcript file path for a given Antigravity conversation ID. */
export function resolveNativeAntigravityTranscriptPath(conversationId: string, conversationsDir?: string): string {
  const rootDir = conversationsDir
    ? path.resolve(conversationsDir, "..")
    : path.join(os.homedir(), ".gemini", "antigravity-cli");
  return path.join(rootDir, "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
}

/** Read and parse native Antigravity transcript from disk into turns. */
export async function loadNativeAntigravityTurns(
  conversationId: string,
  model?: string,
  conversationsDir?: string,
): Promise<AntigravityTurn[]> {
  const transcriptPath = resolveNativeAntigravityTranscriptPath(conversationId, conversationsDir);
  try {
    const raw = await fs.readFile(transcriptPath, "utf-8");
    return parseNativeAntigravityTranscript(raw, conversationId, model);
  } catch {
    try {
      const fullPath = transcriptPath.replace("transcript.jsonl", "transcript_full.jsonl");
      const raw = await fs.readFile(fullPath, "utf-8");
      return parseNativeAntigravityTranscript(raw, conversationId, model);
    } catch {
      return [];
    }
  }
}
