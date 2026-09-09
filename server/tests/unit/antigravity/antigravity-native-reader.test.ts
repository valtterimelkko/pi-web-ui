import { describe, it, expect } from "vitest";
import { cleanUserPrompt, parseNativeAntigravityTranscript } from "../../../src/antigravity/antigravity-native-reader.js";

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
