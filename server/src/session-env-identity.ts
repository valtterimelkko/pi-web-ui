/**
 * Contract 1.47.0 (C1): Pi Web UI session identity for runtime subprocesses.
 *
 * Every runtime subprocess Pi Web UI spawns for one session (Claude SDK and
 * cli-direct, Antigravity, Command Code) receives these variables so the agent
 * inside can address its own session through the Internal API (e.g. as
 * `X-Parent-Session`, or an `onFire` target). The three names are a CROSS-REPO
 * CONTRACT — Agent OS reads them. Do not rename.
 *
 * Pi runs in-process and keeps its existing `PI_SESSION_ID`. OpenCode (one
 * shared `opencode serve`) and the channel backend (one shared PTY claude) have
 * no per-session environment, so they cannot receive it.
 */

export const PI_WEB_UI_SESSION_ID_ENV = 'PI_WEB_UI_SESSION_ID';
export const PI_WEB_UI_SESSION_ORIGIN_ENV = 'PI_WEB_UI_SESSION_ORIGIN';
export const PI_WEB_UI_PARENT_SESSION_ID_ENV = 'PI_WEB_UI_PARENT_SESSION_ID';
/** Contract 1.47.0 (Amendment 1): per-session Agent OS capture opt-in, exported only when set. */
export const PI_WEB_UI_AGENT_OS_CAPTURE_ENV = 'PI_WEB_UI_AGENT_OS_CAPTURE';

export type AgentOsCaptureSetting = 'enabled' | 'disabled';

const CAPTURE_SETTINGS: ReadonlySet<string> = new Set<AgentOsCaptureSetting>(['enabled', 'disabled']);

export type SessionOrigin = 'browser' | 'internal-api' | 'native-discovered';

const ORIGINS: ReadonlySet<string> = new Set<SessionOrigin>(['browser', 'internal-api', 'native-discovered']);

export interface SessionEnvIdentity {
  /** Canonical internal (registry) session id. */
  sessionId: string;
  /** Registry `origin`, when known. */
  origin?: SessionOrigin;
  /** Parent session id, when the session is linked to a parent. */
  parentSessionId?: string;
  /** Per-session Agent OS capture opt-in, when set at creation. */
  agentOsCapture?: AgentOsCaptureSetting;
}

/** Project a registry entry (or entry-like record) onto the env identity. */
export function sessionIdentityFromEntry(
  entry: { id: string; origin?: string; parentSessionId?: string; agentOsCapture?: string } | undefined | null,
): SessionEnvIdentity | undefined {
  if (!entry || typeof entry.id !== 'string' || !entry.id) return undefined;
  return {
    sessionId: entry.id,
    ...(entry.origin && ORIGINS.has(entry.origin) ? { origin: entry.origin as SessionOrigin } : {}),
    ...(entry.parentSessionId ? { parentSessionId: entry.parentSessionId } : {}),
    ...(entry.agentOsCapture && CAPTURE_SETTINGS.has(entry.agentOsCapture)
      ? { agentOsCapture: entry.agentOsCapture as AgentOsCaptureSetting }
      : {}),
  };
}

/**
 * Return a copy of `env` carrying this session's identity. Values inherited
 * from the server's own environment are always replaced or removed, so a child
 * can never see another session's identity. Without an identity the env is
 * returned unchanged (same object).
 */
export function applySessionIdentityEnv<T extends Record<string, string | undefined>>(
  env: T,
  identity: SessionEnvIdentity | undefined,
): T {
  if (!identity || !identity.sessionId) return env;
  const next: Record<string, string | undefined> = { ...env };
  delete next[PI_WEB_UI_SESSION_ID_ENV];
  delete next[PI_WEB_UI_SESSION_ORIGIN_ENV];
  delete next[PI_WEB_UI_PARENT_SESSION_ID_ENV];
  delete next[PI_WEB_UI_AGENT_OS_CAPTURE_ENV];
  next[PI_WEB_UI_SESSION_ID_ENV] = identity.sessionId;
  if (identity.origin && ORIGINS.has(identity.origin)) next[PI_WEB_UI_SESSION_ORIGIN_ENV] = identity.origin;
  if (identity.parentSessionId) next[PI_WEB_UI_PARENT_SESSION_ID_ENV] = identity.parentSessionId;
  if (identity.agentOsCapture && CAPTURE_SETTINGS.has(identity.agentOsCapture)) {
    next[PI_WEB_UI_AGENT_OS_CAPTURE_ENV] = identity.agentOsCapture;
  }
  return next as T;
}
