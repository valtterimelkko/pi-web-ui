"""E2a-5 correction 04 — tests for the ACTUAL Python oracle functions
(oracle_lib.py, imported by browser-check.py). Run:
  python3 -m unittest scripts/e2a-rerun/oracle.test.py -v
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import oracle_lib  # noqa: E402


FINAL = 'A5H1-045230-API-DESKTOP'


class TestHb2StreamVerdict(unittest.TestCase):
    """Correction 07 item 1: samples are tagged {t_ms, phase, texts}; the
    verdict requires a response-specific PRE-TERMINAL observation (a live
    sample with a >=4-char proper prefix of the final text) or a live sample
    holding the full final text before the transcript recorded completion."""

    @staticmethod
    def sample(phase, *texts, t_ms=0):
        return {'t_ms': t_ms, 'phase': phase, 'texts': [t for t in texts if t is not None]}

    def test_reviewer_counterexample_settled_only_fails(self):
        # the reviewer's exact counterexample: a single sample holding FINAL
        v = oracle_lib.hb2_stream_verdict([self.sample('settled', FINAL)], FINAL)
        self.assertFalse(v['ok'], v)
        self.assertEqual(v['reason'], 'streaming-not-observed')

    def test_settled_only_samples_fail(self):
        # settled-phase samples only, carrying just the final text
        samples = [self.sample('settled', FINAL, t_ms=1000)]
        v = oracle_lib.hb2_stream_verdict(samples, FINAL)
        self.assertFalse(v['ok'], v)
        self.assertEqual(v['reason'], 'streaming-not-observed')

    def test_live_unrelated_bubbles_then_settled_final_fails(self):
        # pre-existing transcript bubbles do not count towards "reply observed"
        samples = [
            self.sample('live', 'Goal: write numbers', 'DONE — count.txt has the values'),
            self.sample('live', 'Goal: write numbers'),
            self.sample('settled', 'Goal: write numbers', FINAL),
        ]
        v = oracle_lib.hb2_stream_verdict(samples, FINAL)
        self.assertFalse(v['ok'], v)
        self.assertEqual(v['reason'], 'streaming-not-observed')

    def test_live_proper_prefix_then_final_passes(self):
        samples = [
            self.sample('live', FINAL[:6], t_ms=100),
            self.sample('live', FINAL, t_ms=200),
            self.sample('settled', FINAL, t_ms=3000),
        ]
        v = oracle_lib.hb2_stream_verdict(samples, FINAL)
        self.assertTrue(v['ok'], v)

    def test_live_full_text_only_does_not_establish_streaming(self):
        # correction 08 precondition: a live sample holding the FULL final text
        # does NOT count as streaming evidence (only a proper-prefix live
        # observation does); failure checks still apply to it
        samples = [self.sample('live', FINAL, t_ms=100)]
        v = oracle_lib.hb2_stream_verdict(samples, FINAL)
        self.assertFalse(v['ok'], v)
        self.assertEqual(v['reason'], 'streaming-not-observed')

    def test_short_prefix_below_four_chars_does_not_count(self):
        # a 3-char prefix is not response-specific enough
        samples = [self.sample('live', FINAL[:3], t_ms=100)]
        v = oracle_lib.hb2_stream_verdict(samples, FINAL)
        self.assertFalse(v['ok'], v)
        self.assertEqual(v['reason'], 'streaming-not-observed')

    def test_doubled_prefix_in_later_live_sample_fails(self):
        samples = [
            self.sample('live', FINAL[:6], t_ms=100),
            self.sample('live', FINAL[:6] + FINAL[:6], t_ms=200),
            self.sample('settled', FINAL, t_ms=3000),
        ]
        v = oracle_lib.hb2_stream_verdict(samples, FINAL)
        self.assertFalse(v['ok'], v)
        self.assertEqual(v['reason'], 'doubled-prefix-in-sample')

    def test_doubled_prefix_in_settled_sample_fails(self):
        samples = [
            self.sample('live', FINAL[:6], t_ms=100),
            self.sample('settled', FINAL[:2] + FINAL, t_ms=3000),
        ]
        v = oracle_lib.hb2_stream_verdict(samples, FINAL)
        self.assertFalse(v['ok'], v)
        self.assertEqual(v['reason'], 'doubled-prefix-in-sample')

    def test_separate_bubble_partial_duplicate_fails(self):
        samples = [
            self.sample('live', FINAL[:6], t_ms=100),
            self.sample('live', FINAL[:6], FINAL, t_ms=200),
            self.sample('settled', FINAL, t_ms=3000),
        ]
        v = oracle_lib.hb2_stream_verdict(samples, FINAL)
        self.assertFalse(v['ok'], v)


class TestAssistantReplyRecorded(unittest.TestCase):
    """Correction 08 precondition: the streaming loop must exit only when an
    ASSISTANT record containing the marker is persisted — the user record
    carries the marker too (it is in the prompt), so it must not count."""

    def test_user_record_only_is_false(self):
        entries = [{'type': 'message', 'message': {'role': 'user',
                   'content': [{'type': 'text', 'text': 'Reply with exactly: M-1 followed by the numbers 1 to 60'}]}}]
        self.assertFalse(oracle_lib.assistant_reply_recorded(entries, 'M-1'))

    def test_assistant_record_with_marker_is_true(self):
        entries = [{'type': 'message', 'message': {'role': 'user',
                   'content': [{'type': 'text', 'text': 'Reply with exactly: M-1'}]}},
                   {'type': 'message', 'message': {'role': 'assistant',
                   'content': [{'type': 'text', 'text': 'M-1 1 2 3'}]}}]
        self.assertTrue(oracle_lib.assistant_reply_recorded(entries, 'M-1'))

    def test_empty_entries_is_false(self):
        self.assertFalse(oracle_lib.assistant_reply_recorded([], 'M-1'))

    def test_assistant_record_without_marker_is_false(self):
        entries = [{'type': 'message', 'message': {'role': 'assistant',
                   'content': [{'type': 'text', 'text': 'an unrelated reply'}]}}]
        self.assertFalse(oracle_lib.assistant_reply_recorded(entries, 'M-1'))


class TestHb2CombinedVerdict(unittest.TestCase):
    def test_combined_requires_settled_and_streaming(self):
        stream_ok = {'ok': True, 'reason': 'clean'}
        v = oracle_lib.hb2_combined_verdict(True, 1, 1, False, stream_ok)
        self.assertTrue(v['ok'])
        v = oracle_lib.hb2_combined_verdict(True, 1, 1, False, {'ok': False, 'reason': 'doubled-prefix-in-sample'})
        self.assertFalse(v['ok'])
        self.assertEqual(v['reason'], 'doubled-prefix-in-sample')
        v = oracle_lib.hb2_combined_verdict(False, 2, 1, False, stream_ok)
        self.assertFalse(v['ok'])
        self.assertEqual(v['reason'], 'settled-check-failed')
        v = oracle_lib.hb2_combined_verdict(True, 1, 1, True, stream_ok)
        self.assertFalse(v['ok'])


class TestHb6UserCounts(unittest.TestCase):
    BUBBLES_TYPED = [
        {'role': 'user', 'text': 'Say exactly: M-T1'},
        {'role': 'assistant', 'text': 'M-T1'},
        {'role': 'user', 'text': 'Say exactly: M-T2'},
        {'role': 'assistant', 'text': 'M-T2'},
    ]

    def test_one_user_bubble_per_typed_prompt(self):
        counts = oracle_lib.hb6_user_counts(self.BUBBLES_TYPED, ['Say exactly: M-T1', 'Say exactly: M-T2'])
        self.assertEqual(counts, [1, 1])

    def test_missing_user_bubble_with_same_text_elsewhere_fails(self):
        # the prompt text appears in an ASSISTANT bubble only — the typed user
        # bubble never rendered; substring presence must not count it
        bubbles = [
            {'role': 'assistant', 'text': 'Reply with exactly one line: M-T1 and nothing else.'},
            {'role': 'assistant', 'text': 'M-T1'},
        ]
        counts = oracle_lib.hb6_user_counts(bubbles, ['Reply with exactly one line: M-T1 and nothing else.'])
        self.assertEqual(counts, [0])

    def test_duplicated_user_bubble_counts_two(self):
        bubbles = self.BUBBLES_TYPED + [{'role': 'user', 'text': 'Say exactly: M-T1'}]
        counts = oracle_lib.hb6_user_counts(bubbles, ['Say exactly: M-T1', 'Say exactly: M-T2'])
        self.assertEqual(counts, [2, 1])

    def test_role_scoping_ignores_assistant_repeats(self):
        # the assistant quoting the prompt is not a user bubble
        bubbles = [
            {'role': 'user', 'text': 'Say exactly: M-T1'},
            {'role': 'assistant', 'text': 'You said: Say exactly: M-T1'},
        ]
        counts = oracle_lib.hb6_user_counts(bubbles, ['Say exactly: M-T1'])
        self.assertEqual(counts, [1])


class TestUserBubbleClassification(unittest.TestCase):
    def test_classify_bubble_by_class_signature(self):
        self.assertEqual(oracle_lib.classify_bubble('bg-gray-100 dark:bg-neutral-800 rounded-2xl px-4'), 'user')
        self.assertEqual(oracle_lib.classify_bubble('pl-3 pr-8 border-l-2 break-words overflow-hidden'), 'assistant')
        self.assertEqual(oracle_lib.classify_bubble('bg-surface-subtle border border-outline-default rounded-lg p-3'), 'other')
        self.assertEqual(oracle_lib.classify_bubble(''), 'other')


if __name__ == '__main__':
    unittest.main(verbosity=2)
