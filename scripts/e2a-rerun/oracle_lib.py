"""E2a-5 correction 04 — pure oracle logic for the hb2/hb6 browser checks.

Imported by browser-check.py: these ARE the oracle functions (no separate
helper). The Playwright page collectors feed them role-tagged bubble snapshots:

  bubble  = {'role': 'user'|'assistant'|'other', 'text': <inner text>}
  samples = list collected DURING streaming (polling loop at <= 100 ms), each
            sample being the list of assistant-bubble texts at that instant.
"""
import re

# class-signature discriminators from client/src/components/Chat/MessageBubble.tsx:
# user content wrapper carries bg-gray-100 + rounded-2xl; the assistant content
# wrapper carries border-l-2 + break-words; tool cards carry neither.
_USER_SIGNATURE = ('bg-gray-100', 'rounded-2xl')
_ASSISTANT_SIGNATURE = ('border-l-2', 'break-words')


def classify_bubble(class_attr):
    """Role of a message content wrapper from its class attribute."""
    classes = set((class_attr or '').split())
    if _USER_SIGNATURE[0] in classes and _USER_SIGNATURE[1] in classes:
        return 'user'
    if _ASSISTANT_SIGNATURE[0] in classes and _ASSISTANT_SIGNATURE[1] in classes:
        return 'assistant'
    return 'other'


def _contains_doubled_prefix(text, full):
    """Any non-empty prefix of `full` repeated immediately before more of it."""
    for ln in range(1, min(64, len(full)) + 1):
        prefix = full[:ln]
        if prefix + prefix in text:
            return True
    return False


def hb2_stream_verdict(samples, final_text):
    """hb2: the first streamed chunk must render exactly once, as observed
    DURING streaming — not only in the settled DOM.

    samples: list of assistant-bubble-text lists captured while the reply
    streamed (each sample = one observation instant).

    A sample is BAD when:
      - any single bubble contains a doubled prefix of the reply (the classic
        first-chunk doubling, contiguous or partial), or
      - two or more bubbles carry overlapping parts of the reply (a duplicated
        partial chunk that later migrated or split across bubbles), or
      - a bubble contains a repeated copy of the final text.
    """
    if not final_text:
        return {'ok': False, 'reason': 'missing-final-text'}
    seen_reply = False
    for sample in samples:
        reply_bubbles = [t for t in sample if t and any(p in t for p in
                         (final_text[:4], final_text[:8], final_text))]
        if reply_bubbles:
            seen_reply = True
        # one bubble carrying a doubled prefix of the reply
        for t in sample:
            if t and _contains_doubled_prefix(t, final_text):
                return {'ok': False, 'reason': 'doubled-prefix-in-sample',
                        'sample': [s[:80] for s in sample]}
            if t and t.count(final_text) > 1:
                return {'ok': False, 'reason': 'final-text-repeated-in-bubble',
                        'sample': [s[:80] for s in sample]}
        # a duplicated partial chunk across bubbles: two bubbles each carrying
        # the same non-empty prefix of the reply (the full reply may also have
        # landed in one of them — the duplicate partial is still a defect)
        if len(reply_bubbles) >= 2:
            shared = set(reply_bubbles[0]) & set(reply_bubbles[1])
            if any(len(s.strip()) > 0 for s in shared):
                return {'ok': False, 'reason': 'duplicate-partial-across-bubbles',
                        'sample': [s[:80] for s in sample]}
        # two bubbles that together contain the reply text more than once
        joined = ''.join(sample)
        if joined and _contains_doubled_prefix(joined, final_text):
            return {'ok': False, 'reason': 'doubled-prefix-across-bubbles',
                    'sample': [s[:80] for s in sample]}
    if not seen_reply:
        return {'ok': False, 'reason': 'reply-never-observed'}
    return {'ok': True, 'reason': 'clean', 'samples': len(samples)}


def hb2_combined_verdict(settled_ok, occurrences, in_bubble, doubled_found, stream_v):
    """hb2's final verdict: the settled single-render checks AND the streaming
    observation must both pass. Returns the hb2 result dict (includes the
    streaming verdict — a run whose samples were collected but not evaluated
    cannot pass)."""
    settled = bool(settled_ok) and occurrences == 1 and in_bubble == 1 and not doubled_found
    if not settled:
        return {'ok': False, 'reason': 'settled-check-failed',
                'settled': {'occurrences': occurrences, 'inBubble': in_bubble, 'doubledFound': doubled_found},
                'streamVerdict': stream_v}
    if not stream_v.get('ok'):
        return {'ok': False, **{'reason': stream_v.get('reason', 'streaming-check-failed')},
                'settled': {'occurrences': occurrences, 'inBubble': in_bubble, 'doubledFound': doubled_found},
                'streamVerdict': stream_v}
    return {'ok': True, 'reason': 'clean-settled-and-streaming',
            'settled': {'occurrences': occurrences, 'inBubble': in_bubble, 'doubledFound': doubled_found},
            'streamVerdict': stream_v}


def hb6_user_counts(bubbles, prompts):
    """hb6: one USER-role bubble per typed prompt.

    bubbles: role-tagged bubble snapshot of the whole chat (settled).
    prompts: the exact composer texts that were typed.
    Returns the per-prompt count of USER-role bubbles whose text equals the
    prompt (trimmed). An assistant bubble quoting the prompt never counts; a
    missing user bubble counts 0 even if the same text appears in another role.
    """
    wanted = [(p, p.strip()) for p in prompts]
    counts = []
    for _, bare in wanted:
        n = sum(1 for b in bubbles
                if b.get('role') == 'user' and b.get('text', '').strip() == bare)
        counts.append(n)
    return counts


def chip_free_text_occurrences(chat_text, needle):
    """Occurrences of `needle` in chat text that has already had the queued
    chip subtree removed by the collector (kept for symmetry with the
    executor's settled check; role-scoped checks above are authoritative)."""
    if not chat_text:
        return 0
    return len(re.findall(re.escape(needle), chat_text))
