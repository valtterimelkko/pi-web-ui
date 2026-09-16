/**
 * PARENT VERIFICATION PROBE — card contract (voice-card programme, 2026-09-15).
 *
 * Written by the parent, not by the implementing child: it re-derives the
 * frozen invariants from the operator's reported symptoms, and it is the
 * acceptance test for the seam — the payload the card is shown must be the same
 * bytes the release sends, for BOTH variants.
 *
 * Run: npx tsx operations/voice-card-20260915/parent-verification/seam-probe.ts
 */
import { normaliseRelayText, visibleRemovalFragments } from '../../../server/src/talker/relay-normalise.js';
import {
  PendingProposalStore,
  describeProposal,
  joinOriginalDraftText,
  type DraftUtteranceEntry,
} from '../../../server/src/talker/pending-proposal.js';

let failed = 0;
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`);
  if (!ok) failed++;
}

// ── 1. The operator-reported case: dictation's trailing newline ──────────────
{
  const relay = normaliseRelayText('I want to run autonomously all the system updates.\n');
  check(
    'P1 whitespace-only change is byte-level changed with no recorded removal',
    relay.changed && relay.removals.length === 0,
    JSON.stringify(relay)
  );
  const part: DraftUtteranceEntry = { id: 1, text: relay.text, turn: 1, originalText: 'I want to run autonomously all the system updates.\n' };
  const descriptor = describeProposal([part]);
  check(
    'P2 the card does NOT claim a tidy when only whitespace changed (the operator-reported "verbatim the same")',
    descriptor.cleaned === false && descriptor.removed === undefined && descriptor.original === undefined,
    JSON.stringify(descriptor)
  );
  check(
    'P3 the relay text is still normalised (newline trimmed)',
    descriptor.text === 'I want to run autonomously all the system updates.',
    descriptor.text
  );
}

// ── 2. A visible tidy: fragments only, original offered ──────────────────────
{
  const raw = 'Um, tell the worker to rerun the suite';
  const relay = normaliseRelayText(raw);
  const part: DraftUtteranceEntry = { id: 1, text: relay.text, turn: 1, originalText: raw, removals: relay.removals };
  const descriptor = describeProposal([part]);
  check('P4 a visible tidy reports cleaned=true', descriptor.cleaned === true, JSON.stringify(descriptor));
  check(
    'P5 removed carries FRAGMENTS, never the whole utterance (the "I replaced your prompt" defect)',
    descriptor.removed !== undefined && descriptor.removed !== raw && !descriptor.removed.includes(raw),
    JSON.stringify(descriptor.removed)
  );
  check('P6 original carries the operator\'s raw bytes', descriptor.original === raw, String(descriptor.original));
  check(
    'P7 every visible fragment removed is accounted for in the note',
    visibleRemovalFragments(relay.removals).every(f => (descriptor.removed ?? '').includes(f.trim())),
    JSON.stringify({ removals: relay.removals, note: descriptor.removed })
  );
}

// ── 3. The seam: payload bytes ≡ release bytes, both variants ────────────────
{
  const raw = 'Um, tell the worker to rerun the suite';
  for (const variant of ['tidied', 'original'] as const) {
    const store = new PendingProposalStore();
    store.appendToDraft(1, raw, 1);
    const snapshot = (store.snapshotDraft()?.utterances ?? []) as DraftUtteranceEntry[];
    const descriptor = describeProposal(snapshot);
    const taken = store.takeForRelease(1, undefined, variant);
    const expected = variant === 'tidied' ? descriptor.text : descriptor.original;
    check(
      `P8 ${variant} release bytes === the bytes the card was shown`,
      taken !== null && taken.text === expected,
      JSON.stringify({ taken: taken?.text, expected })
    );
  }
  // multi-part: the original join must equal the release join
  const store = new PendingProposalStore();
  store.appendToDraft(1, 'Um, rebase main', 1);
  store.appendToDraft(2, 'okay so run the suite', 1);
  const snapshot = (store.snapshotDraft()?.utterances ?? []) as DraftUtteranceEntry[];
  const descriptor = describeProposal(snapshot);
  const original = store.takeForRelease(1, undefined, 'original');
  check(
    'P9 multi-part original release === describeProposal().original (same join)',
    original !== null && descriptor.original !== undefined && original.text === descriptor.original &&
      descriptor.original === joinOriginalDraftText(snapshot),
    JSON.stringify({ taken: original?.text, original: descriptor.original })
  );
}

// ── 4. The gate is not widened by the variant ───────────────────────────────
{
  const store = new PendingProposalStore();
  store.appendToDraft(1, 'Um, rerun the suite', 1);
  // age the draft past the confirmation window (6 turns default)
  const lapsed = store.takeForRelease(99, undefined, 'original');
  check('P10 a lapsed draft refuses even the original variant', lapsed === null, JSON.stringify(lapsed));
  const empty = new PendingProposalStore();
  check('P11 nothing pending refuses the original variant', empty.takeForRelease(1, undefined, 'original') === null, 'null expected');
}

// ── 5. Relay output bytes are unchanged for representative inputs ────────────
{
  const cases: Array<[string, string]> = [
    ['Okay, so do the thing.', 'so do the thing.'],
    ['Um, do the thing.', 'do the thing.'],
    ['run the deploy checks', 'run the deploy checks'],
  ];
  const ok = cases.every(([input, expected]) => normaliseRelayText(input).text === expected);
  check('P12 relay text unchanged for representative inputs (no behaviour drift in the normaliser)', ok, JSON.stringify(cases.map(([i]) => [i, normaliseRelayText(i).text])));
}

console.log(failed === 0 ? '\nPARENT PROBE: ALL PASS' : `\nPARENT PROBE: ${failed} FAILURE(S)`);
process.exit(failed === 0 ? 0 : 1);
