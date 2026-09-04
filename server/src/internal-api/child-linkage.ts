/**
 * Child-orchestration surfacing (contract 1.34.0) — parent linkage for
 * Internal-API-dispatched children.
 *
 * A Pi parent orchestrates children over the Internal API via bash `curl` (or
 * the watch-wake extension's in-process calls). Nothing historically linked
 * those children back to the calling session. This module provides:
 *
 *  - {@link pickExplicitParentId} — header-first explicit identity
 *    (`X-Parent-Session`, body `parentSessionId` as fallback);
 *  - {@link InFlightBashCorrelator} — automatic fallback fed by the pi tool
 *    event stream the server already receives: matches the session with an
 *    in-flight bash call referencing the Internal API socket (Node v24 exposes
 *    no SO_PEERCRED, so peer-credential correlation is unavailable);
 *  - {@link ChildLinkRegistry} — resolves parents against the registry,
 *    links children, subscribes to each child's broker key, and emits a single
 *    `child_turn_ended` to the parent's surfaces when the child's turn ends.
 *
 * Linkage is display-only metadata on a local, same-user socket: an
 * unresolvable parent is silently ignored rather than failing the request.
 */

import type { ChildCardProjection, SubagentToolSummary } from '@pi-web-ui/shared';

export interface ParentLink {
  parentSessionId: string;
  /** Broker publish key for the parent (pi sessions publish under their path). */
  parentBrokerKey: string;
  parentSdkType: string;
}

/** Minimal registry surface used for parent resolution (testable). */
export interface LinkageRegistry {
  get(id: string): Promise<{ id: string; sdkType: string; path: string } | undefined>;
  getByPath(path: string): Promise<{ id: string; sdkType: string; path: string } | undefined>;
}

/** Pick the explicit parent id: header wins over body; whitespace is empty. */
export function pickExplicitParentId(
  headerValue: string | undefined,
  bodyValue: string | undefined,
): string | undefined {
  const header = headerValue?.trim();
  if (header) return header;
  const body = bodyValue?.trim();
  if (body) return body;
  return undefined;
}

/** Substrings that mark a bash command as an Internal API call. */
const SOCKET_MARKERS = ['internal-api.sock'] as const;

/** Correlator entries expire after this long without an end event. */
const IN_FLIGHT_TTL_MS = 10 * 60 * 1000;

/** Hard cap on tracked in-flight calls (bounded memory). */
const IN_FLIGHT_CAP = 64;

interface InFlightCall {
  toolCallId: string;
  startedAt: number;
}

/**
 * Tracks in-flight bash tool calls per session key (pi = session path) and
 * answers "which session is calling the Internal API right now?". Fed from
 * the raw pi event stream the server already receives.
 */
export class InFlightBashCorrelator {
  private readonly inFlight = new Map<string, InFlightCall>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  observe(sessionKey: string, event: { type: string; toolName?: unknown; toolCallId?: unknown; args?: unknown }): void {
    if (event.type === 'tool_execution_start' && event.toolName === 'bash' && typeof event.toolCallId === 'string') {
      const command = (event.args as { command?: unknown } | undefined)?.command;
      if (typeof command === 'string' && SOCKET_MARKERS.some((m) => command.includes(m))) {
        if (this.inFlight.size >= IN_FLIGHT_CAP) {
          // Evict the oldest entry to stay bounded.
          const oldest = [...this.inFlight.entries()].sort((a, b) => a[1].startedAt - b[1].startedAt)[0];
          if (oldest) this.inFlight.delete(oldest[0]);
        }
        this.inFlight.set(sessionKey, { toolCallId: event.toolCallId, startedAt: this.now() });
      }
      return;
    }
    if (event.type === 'tool_execution_end' && typeof event.toolCallId === 'string') {
      for (const [key, call] of this.inFlight) {
        if (call.toolCallId === event.toolCallId) this.inFlight.delete(key);
      }
    }
  }

  /** The session key with the newest matching in-flight bash call, or null. */
  correlate(): string | null {
    const now = this.now();
    let best: { key: string; startedAt: number } | null = null;
    for (const [key, call] of this.inFlight) {
      if (now - call.startedAt > IN_FLIGHT_TTL_MS) {
        this.inFlight.delete(key);
        continue;
      }
      if (!best || call.startedAt > best.startedAt) best = { key, startedAt: call.startedAt };
    }
    return best?.key ?? null;
  }
}

function brokerKeyFor(sdkType: string, path: string, id: string): string {
  // Pi publishes events under the session *path*; other runtimes under the id.
  return sdkType === 'pi' ? path : id;
}

/** Project the create response into a `child_dispatched` card (pure). */
export function buildChildDispatchedCard(input: {
  childSessionId: string;
  runtime: string;
  model?: string;
  modelSelector?: string;
  resolvedModel?: string;
  cwd?: string;
  parentSessionId: string;
  label?: string;
}): ChildCardProjection {
  const model = input.resolvedModel ?? input.model;
  const selector = input.modelSelector !== undefined && input.modelSelector !== model
    ? input.modelSelector
    : undefined;
  return {
    id: input.childSessionId,
    childSessionId: input.childSessionId,
    kind: 'internal_api_child',
    status: 'dispatched',
    label: input.label ?? `${input.runtime} child ${input.childSessionId.slice(0, 8)}`,
    runtime: input.runtime,
    ...(model !== undefined ? { model } : {}),
    ...(selector !== undefined ? { modelSelector: input.modelSelector } : {}),
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    parentSessionId: input.parentSessionId,
    startedAt: Date.now(),
  };
}

export interface ChildLinkRegistryDeps {
  broker: { subscribe(key: string, handler: (event: { type: string; data?: unknown }) => void, replay?: boolean, cls?: string): () => void };
  broadcast: (message: Record<string, unknown>) => void;
  publish: (key: string, event: { type: string; timestamp: number; data: unknown }) => void;
  registry: LinkageRegistry;
}

/** Internal-API children linked to parents, with terminal-turn fan-out. */
export class ChildLinkRegistry {
  private readonly links = new Map<string, { parent: ParentLink; unsubs: Array<() => void>; notified: boolean }>();

  constructor(private readonly deps: ChildLinkRegistryDeps) {}

  /** Resolve the parent from explicit values; null = unresolvable → no linkage. */
  async resolveParent(headerValue: string | undefined, bodyValue: string | undefined): Promise<ParentLink | null> {
    const explicit = pickExplicitParentId(headerValue, bodyValue);
    if (!explicit) return null;
    try {
      const byId = await this.deps.registry.get(explicit);
      const entry = byId ?? await this.deps.registry.getByPath(explicit);
      if (!entry) return null;
      return {
        parentSessionId: entry.id,
        parentBrokerKey: brokerKeyFor(entry.sdkType, entry.path, entry.id),
        parentSdkType: entry.sdkType,
      };
    } catch {
      return null;
    }
  }

  /** Link a created child to its parent and watch for its terminal turn. */
  async linkChild(child: { sessionId: string; sessionPath: string; runtime: string; model?: string }, parent: ParentLink): Promise<void> {
    if (this.links.has(child.sessionId)) return;
    const childKey = brokerKeyFor(child.runtime, child.sessionPath, child.sessionId);
    let notified = false;
    const unsub = this.deps.broker.subscribe(childKey, (event) => {
      if (notified) return;
      if (event.type !== 'agent_end' && event.type !== 'complete') return;
      notified = true;
      const timestamp = Date.now();
      const data = {
        sessionId: parent.parentSessionId,
        child: {
          id: child.sessionId,
          childSessionId: child.sessionId,
          kind: 'internal_api_child',
          status: 'completed',
          label: `${child.runtime} child ${child.sessionId.slice(0, 8)}`,
          ...(child.runtime !== undefined ? { runtime: child.runtime } : {}),
          ...(child.model !== undefined ? { model: child.model } : {}),
          parentSessionId: parent.parentSessionId,
          endedAt: timestamp,
        } satisfies ChildCardProjection,
      };
      try {
        this.deps.publish(parent.parentBrokerKey, { type: 'child_turn_ended', timestamp, data });
      } catch { /* non-fatal */ }
      try {
        this.deps.broadcast({ ...data, type: 'child_turn_ended', sessionId: parent.parentSessionId } as Record<string, unknown>);
      } catch { /* non-fatal */ }
    }, false, 'child-link');
    this.links.set(child.sessionId, { parent, unsubs: [unsub], notified: false });
  }

  /** Drop a link (session deleted). */
  unlink(childSessionId: string): void {
    const link = this.links.get(childSessionId);
    if (!link) return;
    for (const u of link.unsubs) {
      try { u(); } catch { /* non-fatal */ }
    }
    this.links.delete(childSessionId);
  }
}

/** Re-export so call sites can type the summary payload without new imports. */
export type { SubagentToolSummary };
