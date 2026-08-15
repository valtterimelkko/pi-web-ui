/**
 * Pure catalogue-maintenance helpers for the weekly Command Code model refresh.
 *
 * The runtime catalogue itself fails open: everything the CLI advertises minus
 * the committed exclusion list is eligible, so a newly advertised model appears
 * in the browser selector and the Internal API at the next server start without
 * any code change. The weekly job only maintains the two committed artefacts:
 *
 * - `command-code-model-efforts.ts` — per-model effort selector metadata;
 * - `command-code-model-catalog.ts` — the GOAT-plan exclusion list, which must
 *   grow when the CLI starts advertising a model the plan cannot use.
 *
 * Eligibility classification is deliberately conservative: only an explicit
 * plan/subscription rejection or a provider permission denial (exit 4) may add
 * an exclusion. Timeouts, network failures, rate limits and unknown errors are
 * inconclusive and leave the fail-open catalogue untouched.
 */

export type CommandCodeEligibility = 'eligible' | 'ineligible' | 'inconclusive';

export interface CommandCodeEligibilityProbeResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Advertised ids that are neither in the committed effort table nor in the
 * exclusion list — i.e. models this installation has never classified before.
 * Order follows the advertisement; duplicates collapse to the first occurrence.
 */
export function computeUnseenAdvertisedModels(
  advertised: readonly string[],
  known: readonly string[],
  excluded: readonly string[],
): string[] {
  const knownSet = new Set(known);
  const excludedSet = new Set(excluded);
  const unseen: string[] = [];
  for (const id of advertised) {
    if (knownSet.has(id) || excludedSet.has(id) || unseen.includes(id)) continue;
    unseen.push(id);
  }
  return unseen;
}

const PLAN_REJECTION_PATTERN = /not (?:included|available) (?:in|on) (?:your|the) (?:current )?plan|subscription (?:required|does not include)|upgrade (?:to|your)|requires (?:a )?(?:pro|max|higher) plan|payment required|\b402\b|\b403\b/i;

/**
 * Classify a real-auth one-turn probe. A clean exit means the provider served
 * the model. Explicit plan rejections and provider permission denials (exit 4,
 * matching the runtime's permission_denied exit-class) mean the GOAT plan
 * cannot use the model. Everything else is inconclusive so a transient failure
 * can never hide a usable model behind the exclusion list.
 */
export function classifyEligibilityProbe(probe: CommandCodeEligibilityProbeResult): CommandCodeEligibility {
  if (probe.timedOut) return 'inconclusive';
  if (probe.exitCode === 0) return 'eligible';
  const diagnostics = `${probe.stdout}\n${probe.stderr}`;
  if (PLAN_REJECTION_PATTERN.test(diagnostics)) return 'ineligible';
  if (probe.exitCode === 4) return 'ineligible';
  return 'inconclusive';
}

const EXCLUSION_ENTRY_PATTERN = /^ {2}'[a-z0-9][a-z0-9._/-]{0,255}',$/;

/**
 * Insert new exclusions into the catalogue source, one indented line per id,
 * after the last existing entry. Ids already present are skipped; a source
 * file whose array literal cannot be located, or a malformed id, throws so a
 * corrupt write can never land.
 */
export function renderCatalogueExclusions(source: string, additions: readonly string[]): string {
  const lines = source.split('\n');
  const closeIndex = lines.findIndex((line) => line.trim() === '] as const;');
  if (closeIndex === -1) throw new Error('Command Code catalogue exclusion array terminator not found');

  const existing = new Set<string>();
  let lastEntryIndex = -1;
  for (let i = 0; i < closeIndex; i += 1) {
    const match = lines[i].match(/^ {2}'([a-z0-9][a-z0-9._/-]{0,255})',$/);
    if (match) {
      existing.add(match[1]);
      lastEntryIndex = i;
    }
  }
  if (lastEntryIndex === -1) throw new Error('Command Code catalogue exclusion array has no parseable entries');

  const novel = additions.filter((id) => !existing.has(id));
  for (const id of novel) {
    if (!EXCLUSION_ENTRY_PATTERN.test(`  '${id}',`)) throw new Error(`Refusing to insert malformed Command Code exclusion id '${id}'`);
  }
  if (novel.length === 0) return source;

  lines.splice(lastEntryIndex + 1, 0, ...novel.map((id) => `  '${id}',`));
  return lines.join('\n');
}
