# Archived Command Code GOAT catalogue implementation report

> **Historical evidence only — do not execute.** The Bubblewrap/slirp4netns design, B-NET gates, namespace attestation, privileged-container workflow and disposable-VM requirement recorded by the former report were abandoned by explicit operator direction.
>
> **Current canonical plan:** [`COMMAND-CODE-SIMPLIFICATION-AND-COMPLETION-PLAN.md`](./COMMAND-CODE-SIMPLIFICATION-AND-COMPLETION-PLAN.md)

## What remains useful

The earlier work established several reusable facts that the replacement plan retains:

- the reviewed USD 10/month GOAT policy contains 35 eligible models and excludes 19 other CLI-discovered models;
- browser and Internal API surfaces need one shared model/capability authority;
- model-specific native effort values must be discovered and validated rather than translated from generic thinking levels;
- frontend creation needs request correlation, pending state and actionable CWD/model/effort errors;
- Internal API execution retains authentication, server-owned roles, receipts, evidence and transcript projection;
- previous real-provider attempts on the VPS are not accepted as completion evidence.

## What is abandoned

Do not carry forward any earlier requirement for:

- Bubblewrap browser launching;
- `slirp4netns` or another networking helper;
- `--unshare-net`;
- TAP devices, route management or network namespace descriptors;
- helper readiness/exit pipes;
- special DNS/CA sandbox mounts;
- B-NET-0 through B-NET-4;
- outer namespace attestation variables;
- a disposable VM or separately isolated validation host;
- privileged-container network evidence.

These were design choices, not inherent Command Code requirements. The replacement uses one direct server-owned `cmd` subprocess with ordinary host networking, matching the other Pi Web UI runtime paths.

## Historical production status

The abandoned execution did not restart, deploy, reconfigure or validate production. Its uncommitted implementation must be pruned against the replacement plan before any completion claim or commit.
