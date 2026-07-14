# Antigravity Models Through CLIProxyAPI and Pi

> **Status:** exploratory design note. This is not an implemented or live-validated integration.

## External project

The proposed gateway is [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI), with its [official documentation](https://help.router-for.me/). CLIProxyAPI supports Antigravity OAuth login and exposes provider-compatible API interfaces that could potentially be consumed by the Pi model layer.

## Why this is being considered

Pi Web UI's current Antigravity path runs `agy -p` as a subprocess for each turn. The harness has not been especially enjoyable to use, and the current integration has important limitations:

- no native response streaming
- no tool-call visibility
- no approval UI
- a higher-trust permission posture
- Antigravity conversation-database correlation and replay workarounds
- model/output behaviour that is still tied to the Antigravity harness

This is a judgement about the **harness**, not a conclusion that the underlying models are poor. The useful model available through the Antigravity subscription has not yet been fairly tested outside Antigravity.

## Potential architecture

```text
Browser
  -> Pi Web UI
    -> Pi Coding Agent / Pi SDK
      -> CLIProxyAPI on localhost
        -> Antigravity OAuth-backed model
```

In this arrangement, Pi would remain the agent runtime and CLIProxyAPI would be a model/credential gateway. The model would receive Pi's system prompt, tools, context management and compaction behaviour rather than Antigravity's native agent scaffolding.

That could give the model a better overall working environment: real Pi streaming, tool events, extensions, skills, session persistence and a simpler replay path. However, it could also perform worse if the model depends on Antigravity-specific prompting, tools or backend behaviour. The only reliable answer is a controlled benchmark.

## Main trade-offs

### Possible benefits

- A more coherent Pi-native user experience
- Real tool visibility and normal Pi session handling
- Pi extensions, skills and compaction remain available
- Less Antigravity-specific lifecycle, replay and subprocess code
- Potentially easier model switching and future provider management

### Possible costs and risks

- CLIProxyAPI adds another local service, credential store and compatibility layer
- Protocol translation may affect tools, thinking, streaming, multimodal input or context limits
- Native Antigravity behaviour and conversation state would not be preserved
- Model aliases and context-window metadata would need explicit validation
- Account quotas and OAuth refresh would be managed behind the gateway rather than directly by Pi
- Google may regard third-party routing of Antigravity OAuth credentials as a policy violation; this should not be treated as a compliant production architecture

OpenCode is a related but separate consideration. It was originally added because Z.AI/GLM coding-plan access recognised OpenCode while rejecting Pi. Since GLM has performed better through the Claude Code path in practice, OpenCode is now a less important runtime for this operator, but this note does not propose removing it yet.

## What to test

The model must be compared both with the current Antigravity path and, where useful, with Pi's ordinary providers:

1. Ordinary coding task
2. Bash, Read and Edit tool use
3. A multi-step implementation task
4. Follow-up turns and session resume
5. Long-context work and compaction
6. Reasoning-level changes, streaming, failure handling and returned model identity

The result should measure both task success and user experience. It should not assume that a better harness automatically makes the model better, or that the same model label produces equivalent behaviour across runtimes.

## Proposed six-step approach

1. **Keep the current Antigravity code** while the alternative is evaluated.
2. **Add CLIProxyAPI as a clearly named Pi provider**, for example `cliproxy-antigravity`.
3. **Start with static model entries** and a local gateway; add dynamic model-management integration only if needed.
4. **Run the benchmark above** against real, representative tasks.
5. **If the results are good, disable the Antigravity UI path** with `ANTIGRAVITY_ENABLED=false`.
6. **Do not delete the existing runtime immediately**; retain it as a rollback path until the gateway-backed route has survived real long-running sessions.

The intended outcome is a decision based on evidence: retain native Antigravity if it provides unique value, or treat CLIProxyAPI-backed models as Pi providers if the Pi experience is equal or better. This remains an experimental option because of the OAuth policy risk and the lack of a live Pi-to-CLIProxyAPI Antigravity validation so far.

## Related Pi Web UI documentation

- [`ANTIGRAVITY-INTEGRATION.md`](./ANTIGRAVITY-INTEGRATION.md) — current `agy -p` runtime
- [`RUNTIME-OVERVIEW.md`](./RUNTIME-OVERVIEW.md) — runtime comparison
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — runtime boundaries and session model
- [`CLAUDE-PROVIDER-PROFILES.md`](./CLAUDE-PROVIDER-PROFILES.md) — analogous provider-profile routing through an Anthropic-compatible endpoint
