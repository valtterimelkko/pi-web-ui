import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { cleanUserPrompt, parseNativeAntigravityTranscript, loadNativeAntigravityTurnsFromRoots, antigravityTranscriptCandidateRoots } from "../../../src/antigravity/antigravity-native-reader.js";

describe("cleanUserPrompt", () => {
  it("extracts text within <USER_REQUEST> tags", () => {
    const raw = "<USER_REQUEST>\nSay HELLO_WORLD\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nfoo\n</ADDITIONAL_METADATA>";
    expect(cleanUserPrompt(raw)).toBe("Say HELLO_WORLD");
  });

  it("returns stripped raw string when no tags are present", () => {
    expect(cleanUserPrompt("  Hello there  ")).toBe("Hello there");
  });
});

describe("parseNativeAntigravityTranscript", () => {
  it("parses single user input and model response", () => {
    const jsonl = [
      JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "<USER_REQUEST>\nSay AGY_TEST\n</USER_REQUEST>", created_at: "2026-09-08T20:00:00Z" }),
      JSON.stringify({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", content: "AGY_TEST", created_at: "2026-09-08T20:00:02Z", status: "DONE" }),
    ].join("\n");

    const turns = parseNativeAntigravityTranscript(jsonl, "conv-123", "Gemini 3.5 Flash");
    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe("Say AGY_TEST");
    expect(turns[0].response).toBe("AGY_TEST");
    expect(turns[0].conversationId).toBe("conv-123");
    expect(turns[0].status).toBe("done");
  });

  it("captures tool calls and outputs", () => {
    const jsonl = [
      JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: "Run tool" }),
      JSON.stringify({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", tool_calls: [{ name: "run_command", args: { CommandLine: "echo hi" } }] }),
      JSON.stringify({ step_index: 2, source: "MODEL", type: "GENERIC", content: "hi\n" }),
      JSON.stringify({ step_index: 3, source: "MODEL", type: "PLANNER_RESPONSE", content: "Tool finished" }),
    ].join("\n");

    const turns = parseNativeAntigravityTranscript(jsonl, "conv-123");
    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe("Run tool");
    const firstTurn = turns[0];
    const firstTool = firstTurn?.tools?.[0];
    expect(firstTurn?.tools).toHaveLength(1);
    expect(firstTool?.toolName).toBe("run_command");
    expect(firstTool?.output).toBe("hi\n");
  });
});

describe("antigravityTranscriptCandidateRoots", () => {
  it("resolves each conversations dir to its parent root and dedupes, explicit dir first", () => {
    const roots = antigravityTranscriptCandidateRoots(
      "/home/x/.gemini/antigravity-cli/conversations",
      "/home/x/.gemini/antigravity-cli/conversations",
      "/home/x/.gemini/antigravity/conversations",
    );
    expect(roots).toEqual([
      "/home/x/.gemini/antigravity-cli",
      "/home/x/.gemini/antigravity",
    ]);
  });

  it("falls back to config roots when no explicit dir is given", () => {
    const roots = antigravityTranscriptCandidateRoots(
      undefined,
      "/tmp/cli/conversations",
      "/tmp/desktop/conversations",
    );
    expect(roots).toEqual(["/tmp/cli", "/tmp/desktop"]);
  });
});

describe("loadNativeAntigravityTurnsFromRoots", () => {
  const CONV = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

  async function makeBrainRoot(
    rootDir: string,
    conversationId: string,
    fileName: string,
    prompt: string,
    response: string,
  ): Promise<void> {
    const logsDir = path.join(rootDir, "brain", conversationId, ".system_generated", "logs");
    await fs.mkdir(logsDir, { recursive: true });
    const jsonl = [
      JSON.stringify({ step_index: 0, source: "USER_EXPLICIT", type: "USER_INPUT", content: `<USER_REQUEST>\n${prompt}\n</USER_REQUEST>`, created_at: "2026-09-11T10:15:36Z" }),
      JSON.stringify({ step_index: 1, source: "MODEL", type: "PLANNER_RESPONSE", content: response, status: "DONE" }),
    ].join("\n");
    await fs.writeFile(path.join(logsDir, fileName), jsonl + "\n", "utf-8");
  }

  it("falls back to a later root when an earlier root lacks the conversation (desktop app data root)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-roots-"));
    const cliRoot = path.join(dir, "cli");
    const desktopRoot = path.join(dir, "desktop");
    // CLI root exists and holds a different conversation; the requested one only exists
    // under the desktop root, stored as transcript_full.jsonl.
    await makeBrainRoot(cliRoot, "11111111-2222-4333-8444-555555555555", "transcript.jsonl", "OTHER-CONV", "other");
    await makeBrainRoot(desktopRoot, CONV, "transcript_full.jsonl", "DESKTOP-PROBE", "DESKTOP-REPLY");

    const turns = await loadNativeAntigravityTurnsFromRoots(CONV, undefined, [cliRoot, desktopRoot]);
    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe("DESKTOP-PROBE");
    expect(turns[0].response).toBe("DESKTOP-REPLY");
    expect(turns[0].conversationId).toBe(CONV);
  });

  it("prefers transcript.jsonl over transcript_full.jsonl within the same root", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-roots-"));
    const root = path.join(dir, "cli");
    await makeBrainRoot(root, CONV, "transcript.jsonl", "PRIMARY", "primary-reply");
    await makeBrainRoot(root, CONV, "transcript_full.jsonl", "SECONDARY", "secondary-reply");

    const turns = await loadNativeAntigravityTurnsFromRoots(CONV, undefined, [root]);
    expect(turns).toHaveLength(1);
    expect(turns[0].prompt).toBe("PRIMARY");
  });

  it("prefers earlier roots when the conversation exists in several roots", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-roots-"));
    const cliRoot = path.join(dir, "cli");
    const desktopRoot = path.join(dir, "desktop");
    await makeBrainRoot(cliRoot, CONV, "transcript.jsonl", "CLI-COPY", "cli-reply");
    await makeBrainRoot(desktopRoot, CONV, "transcript.jsonl", "DESKTOP-COPY", "desktop-reply");

    const turns = await loadNativeAntigravityTurnsFromRoots(CONV, undefined, [cliRoot, desktopRoot]);
    expect(turns[0].prompt).toBe("CLI-COPY");
  });

  it("returns an empty list when no candidate root holds the conversation", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agy-roots-"));
    const root = path.join(dir, "cli");
    await makeBrainRoot(root, "11111111-2222-4333-8444-555555555555", "transcript.jsonl", "OTHER", "other");

    const turns = await loadNativeAntigravityTurnsFromRoots(CONV, undefined, [root]);
    expect(turns).toEqual([]);
  });
});
