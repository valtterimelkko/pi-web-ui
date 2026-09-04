# DRAFT — upstream issue: `query()` should fail fast on pre-0.3 positional arguments

> **Status: DRAFT ONLY — NOT FILED.** Prepared 2026-09-04 for the pi-web-ui operator, who must review and submit (or approve submission) personally. Target: https://github.com/anthropics/claude-agent-sdk-typescript (verify issues/triage conventions before submitting; check for duplicates first). Candidate title below.

---

**Title:** `query()` silently accepts the removed pre-0.3 positional signature and self-aborts ~1–2s later with a misleading "aborted by user"

**Summary**

SDK 0.3.x changed `query()` to a single object parameter:

```ts
export declare function query(_params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query;
```

The old positional form `query(promptString, optionsObject)` still type-checks as *a* call (JavaScript-wise) but is silently mishandled:

1. `_params` is the prompt string; destructuring yields `prompt: undefined`, `options: undefined` — **the options object passed as the second argument is silently discarded**.
2. With `options === undefined`, all defaults apply — including resolving the bundled CLI binary, so a caller-supplied `pathToClaudeCodeExecutable` is ignored without warning.
3. Prompt wiring takes the non-string branch (`nw` → `streamInput(undefined)`), throwing `TypeError: Cannot read properties of undefined (reading 'Symbol(Symbol.asyncIterator)')`, which the SDK converts into an abort of its internal controller at construction (~20ms).
4. The already-spawned child boots normally; ~1–2s later cleanup SIGTERMs it and the caller's message loop rejects with `AbortError("Claude Code process aborted by user")` or `Error("Operation aborted")` — pointing at the child process, not at the call-shape mistake.

**Why this hurt in practice**

An execution agent burned a full debugging session (nine "isolation sweep" variants, binary/version bisects, config-dir experiments) on this: every variant shared the same positional call, so every variant aborted identically, and the surfaced error implicated the child/transport. The `for await` consumer never sees the original `TypeError`; it survives only as the internal abort `reason`.

**Suggested improvement**

Fail fast at entry when the arguments don't match the object signature, e.g.:

```ts
if (typeof paramsOrPrompt === 'string' || (paramsOrPrompt as any)?.[Symbol.asyncIterator]) {
  throw new TypeError(
    "query() takes a single { prompt, options } parameter object since 0.3.x. " +
    "Use query({ prompt, options }). The positional query(prompt, options) form was removed.",
  );
}
```

Optionally also warn (or throw) when `options` are passed as a second argument.

**Environment**

- `@anthropic-ai/claude-agent-sdk` 0.3.185 (behaviour confirmed identical on a fresh install)
- Node v24.20.0, Linux x64
- Repro: two-line diff from object → positional call; deterministic abort every run; abort reason observable by patching `AbortController.prototype.abort` (the original `TypeError` appears as the abort `reason`).

---

*Draft prepared by the pi-web-ui fixing agent; not submitted anywhere. Owner decision required before filing.*
