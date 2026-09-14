import { describe, it, expect } from 'vitest';
import {
  createSpokenLedger,
  normaliseSpokenText,
  CONTENT_SCOPE,
} from '../../../src/lib/spokenLedger';

/**
 * P16 — the shared spoken ledger.
 *
 * The surface has several speech producers; this is the one record they all
 * consult and update. The properties pinned here are the ones the surface
 * depends on: a claim is single-use, text comparison survives respacing,
 * scopes keep mechanical acks from being silenced by content behind them, and
 * the record cannot grow without limit.
 */
describe('spokenLedger — the shared record of what has been said', () => {
  it('claim is single-use: the first caller wins, the second is refused', () => {
    const ledger = createSpokenLedger();
    expect(ledger.claim('The build is green.')).toBe(true);
    expect(ledger.claim('The build is green.')).toBe(false);
    expect(ledger.has('The build is green.')).toBe(true);
    expect(ledger.size()).toBe(1);
  });

  it('different text is still claimable after an unrelated claim', () => {
    const ledger = createSpokenLedger();
    expect(ledger.claim('First answer.')).toBe(true);
    expect(ledger.claim('A genuinely new answer.')).toBe(true);
    expect(ledger.size()).toBe(2);
  });

  it('comparison is normalised: respacing the same words is still a duplicate', () => {
    const ledger = createSpokenLedger();
    expect(ledger.claim('  The build\n  is   green. ')).toBe(true);
    expect(ledger.claim('The build is green.')).toBe(false);
    expect(normaliseSpokenText('  a\n\tb  c ')).toBe('a b c');
  });

  it('mark records without refusing — the explicit producer always plays', () => {
    const ledger = createSpokenLedger();
    ledger.mark('What the operator asked for.');
    expect(ledger.has('What the operator asked for.')).toBe(true);
    // The explicit path marks; it never consults a claim to refuse itself.
    expect(ledger.claim('What the operator asked for.')).toBe(false);
  });

  it('mark is idempotent and empty text is never claimable', () => {
    const ledger = createSpokenLedger();
    ledger.mark('Once.');
    ledger.mark('Once.');
    ledger.mark('   ');
    expect(ledger.size()).toBe(1);
    expect(ledger.claim('')).toBe(false);
    expect(ledger.has('')).toBe(false);
  });

  it('scopes are independent: an event-scoped ack does not block content, and vice versa', () => {
    const ledger = createSpokenLedger();
    expect(ledger.claim('same words', 'turn-1')).toBe(true);
    expect(ledger.claim('same words', 'turn-1')).toBe(false);
    // A later event with the SAME constant words must still be allowed…
    expect(ledger.claim('same words', 'turn-2')).toBe(true);
    // …and the default content scope is untouched by event-scoped claims.
    expect(ledger.claim('same words')).toBe(true);
    expect(ledger.has('same words', CONTENT_SCOPE)).toBe(true);
  });

  it('forgets the oldest claim at capacity and keeps the newest', () => {
    const ledger = createSpokenLedger(2);
    expect(ledger.claim('one')).toBe(true);
    expect(ledger.claim('two')).toBe(true);
    expect(ledger.claim('three')).toBe(true);
    expect(ledger.size()).toBe(2);
    expect(ledger.has('one')).toBe(false);
    expect(ledger.has('two')).toBe(true);
    expect(ledger.has('three')).toBe(true);
  });

  it('a capacity floor of at least one entry holds', () => {
    const ledger = createSpokenLedger(0);
    expect(ledger.claim('only')).toBe(true);
    expect(ledger.has('only')).toBe(true);
    expect(ledger.claim('only')).toBe(false);
  });

  it('clear forgets everything', () => {
    const ledger = createSpokenLedger();
    ledger.claim('one');
    ledger.clear();
    expect(ledger.size()).toBe(0);
    expect(ledger.has('one')).toBe(false);
    expect(ledger.claim('one')).toBe(true);
  });
});
