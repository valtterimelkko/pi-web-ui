import type { ThinkingLevel } from '../components/Settings/ThinkingLevelSelector';

/**
 * Claude thinking-level advertisement, shared by the Settings modal surfaces.
 *
 * Mirrors the server-owned helper (`server/src/claude/claude-profiles.ts`
 * `claudeThinkingLevels`): `max` is a real Claude Code effort level for
 * Sonnet/Opus (live-verified served verbatim via the SDK `options.effort`),
 * while Haiku has no effort support and stays on the legacy ceiling.
 *
 * Matching is substring-based on purpose: the session's `currentModel` often
 * carries a resolved Claude model id (e.g. `claude-sonnet-5`) rather than the
 * `profile:<id>` selector or bare alias the session was created with, because
 * the SDK `session_init` event overwrites the client model string with the
 * resolved id.
 */
export const LEGACY_THINKING_LEVELS: readonly ThinkingLevel[] = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh',
];
export const ALL_THINKING_LEVELS: readonly ThinkingLevel[] = [
  ...LEGACY_THINKING_LEVELS,
  'max',
];

/** A Claude profile/model entry from GET /api/models?sdkType=claude. */
export interface ClaudeModelEntryLike {
  id: string;
  provider?: string;
  claudeModel?: string;
  /** Server-advertised levels (contract truth when present). */
  thinkingLevels?: readonly string[];
}

const KNOWN_LEVELS: readonly ThinkingLevel[] = ALL_THINKING_LEVELS;

function isKnownLevel(value: string): value is ThinkingLevel {
  return (KNOWN_LEVELS as readonly string[]).includes(value);
}

function normalizeLevels(values: readonly string[]): readonly ThinkingLevel[] {
  const filtered = values.filter(isKnownLevel);
  return filtered.length > 0 ? filtered : LEGACY_THINKING_LEVELS;
}

function supportsMaxByAlias(model?: string | null): boolean {
  const normalized = (model ?? '').toLowerCase();
  return normalized.includes('sonnet') || normalized.includes('opus');
}

/**
 * Derive the thinking levels a Claude session may select.
 *
 * Resolution order:
 *  1. Server-advertised `thinkingLevels` on the matching profile entry.
 *  2. Z.ai profiles (GLM via Claude-native effort) → all levels.
 *  3. Substring match for sonnet/opus on the profile's claudeModel, then on
 *     the raw session model string (covers resolved ids like claude-sonnet-5).
 *  4. Legacy ceiling otherwise (haiku, unknown models).
 */
export function claudeAvailableThinkingLevels(
  sessionModel: string | null | undefined,
  profiles: readonly ClaudeModelEntryLike[],
): readonly ThinkingLevel[] {
  const entry = profiles.find((p) => p.id === sessionModel);
  if (entry) {
    if (entry.thinkingLevels && entry.thinkingLevels.length > 0) {
      return normalizeLevels(entry.thinkingLevels);
    }
    if (entry.provider === 'zai' || supportsMaxByAlias(entry.claudeModel)) {
      return ALL_THINKING_LEVELS;
    }
    return LEGACY_THINKING_LEVELS;
  }
  if (supportsMaxByAlias(sessionModel)) {
    return ALL_THINKING_LEVELS;
  }
  return LEGACY_THINKING_LEVELS;
}
