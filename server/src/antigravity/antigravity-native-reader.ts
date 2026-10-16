import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { config } from "../config.js";
import type { AntigravityTurn } from "./antigravity-session-store.js";
import { parseNativeAntigravityTranscript as parseNativeTranscript } from "@pi-web-ui/session-core/readers";

// The pure transcript parser moved to @pi-web-ui/session-core (command-centre
// step 1a); this wrapper keeps the configured default model.
export { cleanUserPrompt } from '@pi-web-ui/session-core/readers';

/** Parse an Antigravity native transcript JSONL file into AntigravityTurn objects. */
export function parseNativeAntigravityTranscript(
  jsonlContent: string,
  conversationId: string,
  model = config.antigravityDefaultModel,
): AntigravityTurn[] {
  return parseNativeTranscript(jsonlContent, conversationId, model);
}

/** Resolve the native brain transcript file path for a given Antigravity conversation ID. */
export function resolveNativeAntigravityTranscriptPath(conversationId: string, conversationsDir?: string): string {
  const rootDir = conversationsDir
    ? path.resolve(conversationsDir, "..")
    : path.join(os.homedir(), ".gemini", "antigravity-cli");
  return path.join(rootDir, "brain", conversationId, ".system_generated", "logs", "transcript.jsonl");
}

/** Candidate brain ROOT directories (not conversations dirs) for native
 *  Antigravity transcripts, in precedence order: an explicitly passed
 *  conversations dir (validation fixtures / custom roots) first, then the
 *  configured CLI root, then the configured desktop-app root. The desktop app
 *  keeps a parallel data root at ~/.gemini/antigravity (no "-cli" suffix) with
 *  the identical conversations/<uuid>.db + brain/<uuid>/... layout; its
 *  conversations are disjoint from the CLI's, so both must be probed.
 *  Duplicates resolve to the same root and are removed. */
export function antigravityTranscriptCandidateRoots(
  explicitConversationsDir?: string,
  cliConversationsDir: string = config.antigravityNativeConversationsDir,
  desktopConversationsDir: string = config.antigravityNativeDesktopConversationsDir,
): string[] {
  const candidates = [explicitConversationsDir, cliConversationsDir, desktopConversationsDir]
    .filter((dir): dir is string => Boolean(dir))
    .map((dir) => path.resolve(dir, ".."));
  return [...new Set(candidates)];
}

/** Read and parse a native Antigravity transcript, trying each candidate root
 *  in order and, within a root, transcript.jsonl before transcript_full.jsonl.
 *  The first readable transcript wins. Returns [] when no candidate holds the
 *  conversation. */
export async function loadNativeAntigravityTurnsFromRoots(
  conversationId: string,
  model: string | undefined,
  rootCandidates: string[],
): Promise<AntigravityTurn[]> {
  for (const rootDir of rootCandidates) {
    const baseDir = path.join(rootDir, "brain", conversationId, ".system_generated", "logs");
    for (const fileName of ["transcript.jsonl", "transcript_full.jsonl"]) {
      try {
        const raw = await fs.readFile(path.join(baseDir, fileName), "utf-8");
        return parseNativeAntigravityTranscript(raw, conversationId, model ?? config.antigravityDefaultModel);
      } catch {
        // Try the next file name, then the next root.
      }
    }
  }
  return [];
}

/** Read and parse native Antigravity transcript from disk into turns, probing
 *  the explicit conversations dir (when given), the CLI root, and the desktop
 *  app root — see antigravityTranscriptCandidateRoots. */
export async function loadNativeAntigravityTurns(
  conversationId: string,
  model?: string,
  conversationsDir?: string,
): Promise<AntigravityTurn[]> {
  return loadNativeAntigravityTurnsFromRoots(
    conversationId,
    model,
    antigravityTranscriptCandidateRoots(conversationsDir),
  );
}
