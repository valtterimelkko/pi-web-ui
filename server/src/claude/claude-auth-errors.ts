/**
 * Shared Claude auth-expiry detection and reauth messaging.
 *
 * The "re-authenticate" affordance was originally implemented only for the
 * channel-backed Claude path (it scraped the PTY for login prompts). The SDK
 * and direct-CLI backends are now the primary paths, so auth-expiry detection
 * and the user-facing remediation message are centralised here and shared by
 * all three backends. The remediation text is profile-aware: native
 * subscription sessions are told to run `claude auth login`, while provider
 * profiles (e.g. GLM/Z.ai) are told to refresh their bearer token.
 */

/** Error code surfaced to the client when Claude auth has expired / is invalid. */
export const CLAUDE_AUTH_EXPIRED_CODE = 'CLAUDE_AUTH_EXPIRED';

/**
 * Patterns indicating Claude (or a provider behind a profile) rejected the
 * request because authentication has expired or is invalid — as opposed to a
 * transient capacity failure (see `claude-transient-errors.ts`).
 */
export const CLAUDE_AUTH_ERROR_PATTERN =
  /(?:please run \/login|claude auth login|invalid authentication credentials|invalid[_ ]api[_ ]key|authentication[_ ]error|oauth token (?:has )?expired|api error:\s*401|\b401\b\s*unauthorized|\bunauthorized\b)/i;

/** True when `text` looks like a Claude authentication failure. */
export function isClaudeAuthError(text: string | null | undefined): boolean {
  if (!text) return false;
  return CLAUDE_AUTH_ERROR_PATTERN.test(text);
}

export interface ReauthContext {
  /**
   * True when the session authenticates with a provider bearer token
   * (e.g. GLM/Z.ai) rather than the native Claude subscription.
   */
  tokenBacked?: boolean;
  /** Human-friendly profile label (falls back to id) for the message. */
  profileLabel?: string;
  /** The env var that carries the profile's auth token, if any. */
  authTokenEnv?: string;
  /** Provider display name (e.g. "Z.ai"), if known. */
  providerLabel?: string;
}

/** Generic fallback for when a reauth error reaches the client with no message. */
export const DEFAULT_REAUTH_MESSAGE =
  'Claude authentication has expired or is invalid. Re-authenticate on the server, then retry.';

/**
 * Build a profile-aware remediation message for an auth-expiry error.
 * Native subscription → `claude auth login`. Token-backed profile → refresh token.
 */
export function buildReauthMessage(ctx?: ReauthContext): string {
  if (ctx?.tokenBacked) {
    const provider = ctx.providerLabel ? `${ctx.providerLabel} ` : '';
    const profile = ctx.profileLabel ? ` for profile "${ctx.profileLabel}"` : '';
    const tokenHint = ctx.authTokenEnv ? ` (\`${ctx.authTokenEnv}\`)` : '';
    return (
      `The ${provider}auth token${profile}${tokenHint} appears to have expired or is invalid. ` +
      'Refresh it on the server, then retry.'
    );
  }
  return 'Claude Code authentication has expired. Run `claude auth login` (or `/login`) on the server, then retry.';
}

/** Minimal structural profile shape needed to derive a reauth context. */
export interface ReauthProfileLike {
  id?: string;
  label?: string;
  baseUrl?: string;
  authTokenEnv?: string;
  authTokenPath?: string;
}

/**
 * Derive a {@link ReauthContext} from a Claude profile. A profile that carries
 * a provider base URL or an explicit auth token source is treated as
 * token-backed; everything else (including no profile) is native subscription.
 */
export function reauthContextFromProfile(profile?: ReauthProfileLike | null): ReauthContext {
  if (!profile) return { tokenBacked: false };
  const tokenBacked = Boolean(profile.baseUrl || profile.authTokenEnv || profile.authTokenPath);
  if (!tokenBacked) return { tokenBacked: false };
  return {
    tokenBacked: true,
    profileLabel: profile.label ?? profile.id,
    authTokenEnv: profile.authTokenEnv,
    providerLabel: providerLabelFromBaseUrl(profile.baseUrl),
  };
}

function providerLabelFromBaseUrl(baseUrl?: string): string | undefined {
  if (!baseUrl) return undefined;
  if (baseUrl.includes('z.ai') || baseUrl.includes('bigmodel')) return 'Z.ai';
  return undefined;
}
