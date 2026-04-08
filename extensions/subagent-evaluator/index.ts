/**
 * Subagent Evaluator Extension
 * 
 * Forces structured evaluation of subagent reports with follow-up Q&A.
 * Wraps the built-in subagent tool with a mandatory evaluation pattern.
 * 
 * Flow:
 * 1. Main agent calls evaluated_subagent with task and success criteria
 * 2. Subagent executes and returns report
 * 3. Main agent MUST evaluate the report (score 1-10, identify gaps)
 * 4. If score < threshold, main agent asks follow-up questions
 * 5. Subagent answers questions (new iteration)
 * 6. Repeat until satisfied or max iterations reached
 * 7. Final synthesized result returned
 * 
 * Usage:
 *   evaluated_subagent({
 *     agent: "scout",
 *     task: "Analyze codebase structure",
 *     success_criteria: "Must identify: 1) Entry points, 2) Key modules, 3) Test structure",
 *     max_iterations: 3
 *   })
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

// Maximum iterations for Q&A loop
const MAX_ITERATIONS = 3;
const DEFAULT_ACCEPTANCE_THRESHOLD = 7; // Score 1-10

// State management for ongoing evaluations
interface EvaluationSession {
  id: string;
  agent: string;
  originalTask: string;
  successCriteria: string;
  iteration: number;
  maxIterations: number;
  threshold: number;
  reports: string[];
  evaluations: EvaluationResult[];
  agentSource: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    turns: number;
  };
}

interface EvaluationResult {
  score: number;
  isSufficient: boolean;
  gaps: string[];
  followUpQuestions: string[];
}

// In-memory store for evaluation sessions
const evaluationSessions = new Map<string, EvaluationSession>();

// Generate unique session ID
function generateSessionId(): string {
  return `eval_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Format usage stats for display
function formatUsageStats(usage: EvaluationSession["usage"]): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turns`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts.join(" ");
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  return `${Math.round(count / 1000)}k`;
}

// Write system prompt to temp file for subagent
function writePromptToTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-evaluator-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tmpDir, filePath };
}

// Discover available agents (simplified from subagent extension)
interface AgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  model?: string;
  tools?: string[];
  source: "user" | "project";
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);
  
  if (!match) {
    return { frontmatter: {}, body: content };
  }
  
  const lines = match[1].split("\n");
  const frontmatter: Record<string, string> = {};
  
  for (const line of lines) {
    const colonIndex = line.indexOf(":");
    if (colonIndex > 0) {
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      frontmatter[key] = value;
    }
  }
  
  return { frontmatter, body: match[2] };
}

function loadAgentFromFile(filePath: string): AgentConfig | null {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const { frontmatter, body } = parseFrontmatter(content);
    
    if (!frontmatter.name || !frontmatter.description) {
      return null;
    }
    
    const tools = frontmatter.tools
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    
    return {
      name: frontmatter.name,
      description: frontmatter.description,
      systemPrompt: body,
      model: frontmatter.model,
      tools: tools && tools.length > 0 ? tools : undefined,
      source: filePath.includes(".pi/agents") ? "project" : "user",
    };
  } catch {
    return null;
  }
}

function discoverAgents(cwd: string): AgentConfig[] {
  const agents: AgentConfig[] = [];
  const homeDir = os.homedir();
  
  // User agents from ~/.pi/agent/agents/
  const userDir = path.join(homeDir, ".pi", "agent", "agents");
  if (fs.existsSync(userDir)) {
    const entries = fs.readdirSync(userDir);
    for (const entry of entries) {
      if (entry.endsWith(".md")) {
        const agent = loadAgentFromFile(path.join(userDir, entry));
        if (agent) agents.push(agent);
      }
    }
  }
  
  // Project agents from .pi/agents/ (walk up from cwd)
  let currentDir = cwd;
  while (currentDir) {
    const projectDir = path.join(currentDir, ".pi", "agents");
    if (fs.existsSync(projectDir)) {
      const entries = fs.readdirSync(projectDir);
      for (const entry of entries) {
        if (entry.endsWith(".md")) {
          const agent = loadAgentFromFile(path.join(projectDir, entry));
          if (agent) agents.push({ ...agent, source: "project" });
        }
      }
      break; // Only look at nearest .pi/agents
    }
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  
  // Remove duplicates (project agents override user agents)
  const agentMap = new Map<string, AgentConfig>();
  for (const agent of agents) {
    agentMap.set(agent.name, agent);
  }
  
  return Array.from(agentMap.values());
}

// Run a single subagent task
async function runSubagent(
  agent: AgentConfig,
  task: string,
  cwd: string,
  signal: AbortSignal | undefined
): Promise<{
  output: string;
  usage: EvaluationSession["usage"];
  exitCode: number;
  errorMessage?: string;
}> {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
  
  let tmpPromptDir: string | null = null;
  let tmpPromptPath: string | null = null;
  
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  };
  
  const messages: Message[] = [];
  let stderr = "";
  let exitCode = 0;
  let errorMessage: string | undefined;
  
  try {
    if (agent.systemPrompt.trim()) {
      const tmp = writePromptToTempFile(agent.name, agent.systemPrompt);
      tmpPromptDir = tmp.dir;
      tmpPromptPath = tmp.filePath;
      args.push("--append-system-prompt", tmpPromptPath);
    }
    
    args.push(`Task: ${task}`);
    
    exitCode = await new Promise<number>((resolve) => {
      const proc = spawn("pi", args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
      let buffer = "";
      
      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        
        if (event.type === "message_end" && event.message) {
          const msg = event.message as Message;
          messages.push(msg);
          
          if (msg.role === "assistant") {
            usage.turns++;
            const msgUsage = msg.usage;
            if (msgUsage) {
              usage.input += msgUsage.input || 0;
              usage.output += msgUsage.output || 0;
              usage.cacheRead += msgUsage.cacheRead || 0;
              usage.cacheWrite += msgUsage.cacheWrite || 0;
              usage.cost += msgUsage.cost?.total || 0;
            }
            if (msg.errorMessage) errorMessage = msg.errorMessage;
          }
        }
      };
      
      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });
      
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      
      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });
      
      proc.on("error", () => resolve(1));
      
      if (signal) {
        const killProc = () => {
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });
    
    // Extract final output
    let output = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") {
        for (const part of msg.content) {
          if (part.type === "text") {
            output = part.text;
            break;
          }
        }
        if (output) break;
      }
    }
    
    if (!output && stderr) {
      output = `Error: ${stderr}`;
    }
    
    return { output, usage, exitCode, errorMessage };
  } finally {
    if (tmpPromptPath) {
      try { fs.unlinkSync(tmpPromptPath); } catch {
        // Best-effort temp file cleanup.
      }
    }
    if (tmpPromptDir) {
      try { fs.rmdirSync(tmpPromptDir); } catch {
        // Best-effort temp directory cleanup.
      }
    }
  }
}

// Format the result with evaluation prompt
function formatEvaluationPrompt(
  session: EvaluationSession,
  isFollowUp: boolean
): string {
  const iteration = session.iteration;
  const maxIter = session.maxIterations;
  const threshold = session.threshold;
  
  const header = isFollowUp
    ? `📋 FOLLOW-UP RESPONSE (Iteration ${iteration}/${maxIter})`
    : `📋 SUBAGENT REPORT (Iteration ${iteration}/${maxIter})`;
  
  const report = session.reports[session.reports.length - 1];
  
  const prompt = `
╔══════════════════════════════════════════════════════════════════╗
║  ${header.padEnd(62)} ║
╠══════════════════════════════════════════════════════════════════╣

${report}

╠══════════════════════════════════════════════════════════════════╣
║  EVALUATION REQUIRED                                             ║
╠══════════════════════════════════════════════════════════════════╣

🎯 Original Task: ${session.originalTask}

✓ Success Criteria: ${session.successCriteria}

📊 Threshold for Acceptance: ${threshold}/10 or higher

🤖 Agent: ${session.agent} (${session.agentSource})

${iteration > 1 ? `📈 Previous Iterations: ${iteration - 1}` : ""}

────────────────────────────────────────────────────────────────────

You MUST evaluate this report:

1. **Score the report** (1-10): How well does it meet the success criteria?
   - 1-3: Poor - major gaps, missing critical information
   - 4-6: Incomplete - some information present but significant gaps
   - 7-8: Good - meets most criteria, minor gaps acceptable
   - 9-10: Excellent - comprehensive, exceeds expectations

2. **Identify gaps**: What specific information is missing or unclear?

3. **Formulate follow-up questions** (if score < ${threshold}):
   - Ask specific, targeted questions
   - Focus on the most important gaps
   - Limit to 3-5 key questions

Use submit_subagent_evaluation to submit your evaluation:

\`\`\`json
{
  "session_id": "${session.id}",
  "score": <1-10>,
  "is_sufficient": <true if score >= ${threshold}, false otherwise>,
  "gaps": ["gap 1", "gap 2", ...],
  "follow_up_questions": ["question 1", "question 2", ...] // only if is_sufficient = false
}
\`\`\`

────────────────────────────────────────────────────────────────────

⚠️ IMPORTANT:
- If is_sufficient = false AND iteration < ${maxIter}, the subagent will answer your questions
- If is_sufficient = true OR iteration = ${maxIter}, the final synthesized result will be returned
- Be honest in your evaluation - quality matters more than speed
`;

  return prompt;
}

// Synthesize all reports into final result
function synthesizeFinalResult(session: EvaluationSession): string {
  const usage = formatUsageStats(session.usage);
  const finalEval = session.evaluations[session.evaluations.length - 1];
  
  let result = `
╔══════════════════════════════════════════════════════════════════╗
║  FINAL SYNTHESIZED RESULT                                        ║
╠══════════════════════════════════════════════════════════════════╣

🎯 Task: ${session.originalTask}

📊 Final Score: ${finalEval.score}/10
✓ Sufficient: ${finalEval.isSufficient ? "Yes" : "No (max iterations reached)"}

🔄 Iterations: ${session.iteration}/${session.maxIterations}
📊 Total Usage: ${usage}

────────────────────────────────────────────────────────────────────

📋 COMBINED FINDINGS:

`;

  for (let i = 0; i < session.reports.length; i++) {
    const iter = i + 1;
    const eval_ = session.evaluations[i];
    result += `━━━ Iteration ${iter} ━━━\n\n`;
    result += session.reports[i];
    result += `\n\n[Score: ${eval_?.score ?? "N/A"}/10]\n\n`;
    if (i < session.reports.length - 1) {
      result += `───\n\n`;
    }
  }

  result += `
────────────────────────────────────────────────────────────────────

📝 SYNTHESIS:

Based on ${session.iteration} iteration(s), here is the comprehensive answer:

[The main agent should synthesize this from all iterations above]

`;

  return result;
}

// Schema definitions
const EvaluatedSubagentParams = Type.Object({
  agent: Type.String({ description: "Name of the agent to invoke" }),
  task: Type.String({ description: "Task to delegate to the agent" }),
  success_criteria: Type.String({ 
    description: "Clear criteria for what constitutes a complete/successful report" 
  }),
  max_iterations: Type.Optional(Type.Number({ 
    description: "Maximum Q&A iterations (1-3)", 
    default: 3,
    maximum: 3,
    minimum: 1
  })),
  acceptance_threshold: Type.Optional(Type.Number({
    description: "Minimum score (1-10) to accept report without follow-up",
    default: 7,
    maximum: 10,
    minimum: 1
  })),
  cwd: Type.Optional(Type.String({ description: "Working directory for the agent" })),
});

const SubmitEvaluationParams = Type.Object({
  session_id: Type.String({ description: "Evaluation session ID from evaluated_subagent" }),
  score: Type.Number({ description: "Quality score 1-10", minimum: 1, maximum: 10 }),
  is_sufficient: Type.Boolean({ description: "Whether the report meets success criteria" }),
  gaps: Type.Array(Type.String(), { description: "List of identified gaps in the report" }),
  follow_up_questions: Type.Optional(Type.Array(Type.String(), { 
    description: "Questions to ask if is_sufficient is false" 
  })),
});

export default function subagentEvaluatorExtension(pi: ExtensionAPI) {
  // Tool 1: Start evaluated subagent workflow
  pi.registerTool({
    name: "evaluated_subagent",
    label: "Evaluated Subagent",
    description: [
      "Delegate tasks to subagents with mandatory quality evaluation.",
      "After subagent returns, you MUST evaluate the report against success_criteria.",
      "If insufficient, ask follow-up questions (max 3 iterations).",
      "Returns final synthesized result after evaluation loop completes.",
    ].join(" "),
    parameters: EvaluatedSubagentParams,
    promptSnippet: 'evaluated_subagent({ agent: "name", task: "...", success_criteria: "..." })',
    promptGuidelines: [
      "ALWAYS evaluate subagent reports honestly - quality over speed",
      "Use specific, targeted follow-up questions to fill gaps",
      "Accept threshold is 7/10 by default - adjust with acceptance_threshold",
      "Final result synthesizes all iterations for comprehensive answer",
    ],

    async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult> {
      const agents = discoverAgents(ctx.cwd);
      const agent = agents.find((a) => a.name === params.agent);
      
      if (!agent) {
        const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
        return {
          content: [{ type: "text", text: `Unknown agent: "${params.agent}". Available: ${available}` }],
          error: true,
        };
      }
      
      const session: EvaluationSession = {
        id: generateSessionId(),
        agent: params.agent,
        originalTask: params.task,
        successCriteria: params.success_criteria,
        iteration: 1,
        maxIterations: Math.min(params.max_iterations ?? 3, MAX_ITERATIONS),
        threshold: params.acceptance_threshold ?? DEFAULT_ACCEPTANCE_THRESHOLD,
        reports: [],
        evaluations: [],
        agentSource: agent.source,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
      };
      
      evaluationSessions.set(session.id, session);
      
      // Run initial subagent call
      const result = await runSubagent(agent, params.task, params.cwd ?? ctx.cwd, signal);
      
      // Update usage
      session.usage.input += result.usage.input;
      session.usage.output += result.usage.output;
      session.usage.cacheRead += result.usage.cacheRead;
      session.usage.cacheWrite += result.usage.cacheWrite;
      session.usage.cost += result.usage.cost;
      session.usage.turns += result.usage.turns;
      
      session.reports.push(result.output);
      
      const prompt = formatEvaluationPrompt(session, false);
      
      return {
        content: [{ type: "text", text: prompt }],
        details: {
          session_id: session.id,
          iteration: session.iteration,
          max_iterations: session.maxIterations,
          report: result.output,
          usage: session.usage,
        },
      };
    },

    renderResult(result, options, theme) {
      const details = result.details as any;
      if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "(no output)", 0, 0);
      
      const container = new Container();
      const header = theme.fg("accent", `📋 Evaluated Subagent (Iteration ${details.iteration}/${details.max_iterations})`);
      container.addChild(new Text(header, 0, 0));
      
      if (options.expanded) {
        container.addChild(new Text("", 0, 0));
        const text = result.content[0]?.type === "text" ? result.content[0].text : "";
        // Truncate for preview
        const lines = text.split("\n").slice(0, 20);
        container.addChild(new Text(lines.join("\n"), 0, 0));
        if (text.split("\n").length > 20) {
          container.addChild(new Text(theme.fg("muted", "... (truncated)"), 0, 0));
        }
      } else {
        container.addChild(new Text(theme.fg("muted", "Report received. Evaluation required."), 0, 0));
      }
      
      if (details.usage) {
        const usageStr = formatUsageStats(details.usage);
        container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
      }
      
      return container;
    },
  });

  // Tool 2: Submit evaluation and optionally continue
  pi.registerTool({
    name: "submit_subagent_evaluation",
    label: "Submit Evaluation",
    description: [
      "Submit evaluation of subagent report.",
      "If is_sufficient=false and iterations remain, triggers follow-up Q&A.",
      "Otherwise returns final synthesized result.",
    ].join(" "),
    parameters: SubmitEvaluationParams,

    async execute(toolCallId, params, signal, onUpdate, ctx): Promise<AgentToolResult> {
      const session = evaluationSessions.get(params.session_id);
      
      if (!session) {
        return {
          content: [{ type: "text", text: `Error: Evaluation session not found: ${params.session_id}` }],
          error: true,
        };
      }
      
      const evaluation: EvaluationResult = {
        score: params.score,
        isSufficient: params.is_sufficient,
        gaps: params.gaps,
        followUpQuestions: params.follow_up_questions ?? [],
      };
      
      session.evaluations.push(evaluation);
      
      // Check if we're done
      if (params.is_sufficient || session.iteration >= session.maxIterations) {
        // Return final result
        const finalResult = synthesizeFinalResult(session);
        evaluationSessions.delete(params.session_id);
        
        return {
          content: [{ type: "text", text: finalResult }],
          details: {
            final: true,
            iterations: session.iteration,
            final_score: params.score,
            usage: session.usage,
          },
        };
      }
      
      // Continue with follow-up
      session.iteration++;
      
      const agents = discoverAgents(ctx.cwd);
      const agent = agents.find((a) => a.name === session.agent);
      
      if (!agent) {
        return {
          content: [{ type: "text", text: `Error: Agent not found: ${session.agent}` }],
          error: true,
        };
      }
      
      // Build follow-up task
      const followUpTask = `
Previous task: ${session.originalTask}

Your previous report was evaluated as follows:
- Score: ${params.score}/10
- Gaps identified: ${params.gaps.join("; ")}

Please address these follow-up questions:
${params.follow_up_questions?.map((q, i) => `${i + 1}. ${q}`).join("\n") ?? "None"}

Provide a focused response that addresses these gaps.
`;
      
      const result = await runSubagent(agent, followUpTask, ctx.cwd, signal);
      
      // Update usage
      session.usage.input += result.usage.input;
      session.usage.output += result.usage.output;
      session.usage.cacheRead += result.usage.cacheRead;
      session.usage.cacheWrite += result.usage.cacheWrite;
      session.usage.cost += result.usage.cost;
      session.usage.turns += result.usage.turns;
      
      session.reports.push(result.output);
      
      const prompt = formatEvaluationPrompt(session, true);
      
      return {
        content: [{ type: "text", text: prompt }],
        details: {
          session_id: session.id,
          iteration: session.iteration,
          max_iterations: session.maxIterations,
          report: result.output,
          usage: session.usage,
        },
      };
    },

    renderResult(result, options, theme) {
      const details = result.details as any;
      if (!details) return new Text(result.content[0]?.type === "text" ? result.content[0].text : "(no output)", 0, 0);
      
      if (details.final) {
        const container = new Container();
        container.addChild(new Text(theme.fg("success", "✓ Evaluated Subagent Complete"), 0, 0));
        container.addChild(new Text(theme.fg("dim", `Iterations: ${details.iterations} | Final Score: ${details.final_score}/10`), 0, 0));
        if (details.usage) {
          container.addChild(new Text(theme.fg("dim", formatUsageStats(details.usage)), 0, 0));
        }
        return container;
      }
      
      const container = new Container();
      container.addChild(new Text(theme.fg("warning", `🔄 Follow-up Response (Iteration ${details.iteration}/${details.max_iterations})`), 0, 0));
      container.addChild(new Text(theme.fg("muted", "Evaluation required."), 0, 0));
      return container;
    },
  });
}
