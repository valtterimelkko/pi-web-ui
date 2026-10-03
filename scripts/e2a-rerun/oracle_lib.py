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
    """hb2: the first streamed chunk must render exactly once, observed
    PRE-TERMINALLY — settled-only evidence is rejected.

    samples: tagged observations {t_ms, phase: 'live'|'settled', texts}
    collected while the detached prompt ran ('live') and after the 3 s settle
    ('settled'). Each texts list holds the assistant-bubble inner texts.

    REQUIRED (correction 07): at least one PRE-TERMINAL observation — a live
    sample in which an assistant bubble's stripped text is non-empty, a proper
    prefix of the final text (final.startswith(t) and t != final) and at least
    4 characters (response-specific: begins with the reply's opening, so a
    pre-existing transcript bubble never counts) — OR a live sample in which a
    bubble already holds the full final text (the polling loop only exits once
    the transcript has recorded the turn, so a live sample is pre-terminal by
    construction). Otherwise: {'ok': False, 'reason': 'streaming-not-observed'}.

    Every existing failure check (doubled prefix, duplicated partial chunk
    across bubbles, repeated final text) still applies to ALL samples, live and
    settled. Pre-existing transcript bubbles never count towards "reply
    observed": only bubbles containing a prefix of the final text do.
    """
    if not final_text:
        return {'ok': False, 'reason': 'missing-final-text'}

    def is_proper_prefix(t):
        t = (t or '').strip()
        return (len(t) >= 4 and t != final_text and final_text.startswith(t))

    pre_terminal_seen = False
    seen_reply = False
    for sample in samples:
        phase = sample.get('phase', 'live')
        texts = [t for t in (sample.get('texts') or []) if t]
        # failure checks apply to ALL samples (live and settled)
        for t in texts:
            if _contains_doubled_prefix(t, final_text):
                return {'ok': False, 'reason': 'doubled-prefix-in-sample',
                        'sample': [s[:80] for s in texts]}
            if t.count(final_text) > 1:
                return {'ok': False, 'reason': 'final-text-repeated-in-bubble',
                        'sample': [s[:80] for s in texts]}
        # a duplicated partial chunk across bubbles: two or more bubbles each
        # holding a DIFFERENT proper prefix of the reply (a split render), or a
        # proper-prefix bubble coexisting with a bubble holding the full reply
        # (the partial's content is duplicated inside the full bubble)
        partial_bubbles = [t.strip() for t in texts
                           if t.strip() and t.strip() != final_text and final_text.startswith(t.strip())]
        full_bubbles = sum(1 for t in texts if final_text in t)
        if len(partial_bubbles) >= 2 or (len(partial_bubbles) >= 1 and full_bubbles >= 1 and len(texts) >= 2):
            return {'ok': False, 'reason': 'duplicate-partial-across-bubbles',
                    'sample': [s[:80] for s in texts]}
        # the pre-terminal rule (live samples only)
        if phase == 'live':
            if any(is_proper_prefix(t) for t in texts):
                pre_terminal_seen = True
            if any(final_text in t for t in texts):
                # a live sample holding the full text: the polling loop only
                # exits once the transcript recorded the turn, so this sample
                # was taken pre-terminal
                pre_terminal_seen = True
            if any(final_text in t for t in texts):
                seen_reply = True
        elif any(final_text in t for t in texts):
            seen_reply = True
    if not pre_terminal_seen:
        return {'ok': False, 'reason': 'streaming-not-observed'}
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
