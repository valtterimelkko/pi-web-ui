# Subagent Evaluator Extension

A Pi Coding Agent extension that enforces structured evaluation of subagent reports with follow-up Q&A.

## Overview

This extension wraps the built-in `subagent` tool with a mandatory evaluation pattern. When you delegate a task to a subagent, the main agent **must** evaluate whether the report is comprehensive enough before proceeding.

### Key Features

- ✅ **Mandatory Evaluation**: Forces quality assessment of every subagent report
- 🔄 **Q&A Loop**: Up to 3 iterations of follow-up questions for incomplete reports
- 📊 **Scoring System**: 1-10 score with configurable acceptance threshold
- 📝 **Gap Identification**: Structured gap analysis drives follow-up questions
- 🎯 **Final Synthesis**: Combines all iterations into comprehensive result

## Installation

```bash
# Copy to Pi extensions directory
mkdir -p ~/.pi/agent/extensions/subagent-evaluator
cp index.ts ~/.pi/agent/extensions/subagent-evaluator/

# Reload Pi
pi /reload
```

## Usage

### Basic Usage

```typescript
evaluated_subagent({
  agent: "scout",
  task: "Analyze the codebase structure and identify main components",
  success_criteria: "Must identify: 1) Entry points, 2) Key modules, 3) Test structure, 4) Dependencies"
})
```

### With Options

```typescript
evaluated_subagent({
  agent: "planner",
  task: "Create implementation plan for feature X",
  success_criteria: "Must include: 1) File changes, 2) Dependencies, 3) Test plan, 4) Risk assessment",
  max_iterations: 3,        // Maximum Q&A rounds (default: 3, max: 3)
  acceptance_threshold: 8,  // Minimum score to accept (default: 7)
  cwd: "/path/to/project"   // Working directory for subagent
})
```

### Evaluation Flow

1. **Initial Call**: Subagent executes task and returns report
2. **Evaluation Required**: Main agent receives report with evaluation prompt
3. **Submit Evaluation**: Use `submit_subagent_evaluation` with:
   - `score`: 1-10 rating
   - `is_sufficient`: true if score >= threshold
   - `gaps`: List of missing information
   - `follow_up_questions`: Questions for next iteration (if insufficient)
4. **Final Result**: After sufficient quality or max iterations, synthesized result returned

### Example Session

```
User: Analyze this codebase for security issues

Agent: evaluated_subagent({
  agent: "scout",
  task: "Analyze codebase for security vulnerabilities",
  success_criteria: "Must identify: 1) Auth weaknesses, 2) Input validation issues, 3) Secret handling"
})

[Subagent returns initial report]

Agent: submit_subagent_evaluation({
  session_id: "eval_1234567890_abc123",
  score: 5,
  is_sufficient: false,
  gaps: ["No analysis of database query injection risks", "Missing secret scanning in config files"],
  follow_up_questions: [
    "Check all SQL queries for parameterization",
    "Scan config files and env vars for hardcoded secrets"
  ]
})

[Subagent answers follow-up questions]

Agent: submit_subagent_evaluation({
  session_id: "eval_1234567890_abc123",
  score: 9,
  is_sufficient: true,
  gaps: [],
  follow_up_questions: []
})

[Final synthesized result returned]
```

## Scoring Guide

| Score | Meaning | Action |
|-------|---------|--------|
| 1-3 | Poor | Major gaps, ask comprehensive follow-ups |
| 4-6 | Incomplete | Significant gaps, ask targeted questions |
| 7-8 | Good | Minor gaps acceptable, can proceed |
| 9-10 | Excellent | Comprehensive, exceeds expectations |

## Why This Pattern?

Subagents lack the main agent's full context. They often return surface-level analysis because:

1. **Limited Context Window**: Isolated from main conversation
2. **No Big Picture**: Don't understand overall goals
3. **Single-Pass**: No opportunity to dig deeper

The evaluator pattern bridges this gap by:

1. **Quality Gate**: Forces critical assessment before accepting
2. **Targeted Follow-ups**: Main agent directs deeper investigation
3. **Iterative Improvement**: Multiple passes refine the answer
4. **Bounded Cost**: Max 3 iterations prevents runaway usage

## Integration with Enhanced Plan Mode

Use `evaluated_subagent` in plan mode for higher-quality analysis:

```typescript
// In wave-based planning
{
  tool: "evaluated_subagent",
  params: {
    agent: "scout",
    task: "Analyze authentication system",
    success_criteria: "Must cover: OAuth flow, session management, token validation"
  }
}
```

## Technical Details

- **State Management**: In-memory sessions keyed by unique ID
- **Agent Discovery**: Uses same logic as built-in subagent tool
- **Usage Tracking**: Aggregates tokens/cost across all iterations
- **Cleanup**: Sessions auto-deleted after completion or error

## License

MIT - Part of Pi Enhancement Project
