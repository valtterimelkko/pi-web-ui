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
    def test_clean_streaming_passes(self):
        samples = [
            [],
            [FINAL[:3]],
            [FINAL[:8]],
            [FINAL],
            [FINAL],
        ]
        v = oracle_lib.hb2_stream_verdict(samples, FINAL)
        self.assertTrue(v['ok'], v)

    def test_doubled_prefix_in_any_sample_fails(self):
        # the classic doubled first chunk: 'AA5H1...' rendered in one bubble
        samples = [
            [],
            [FINAL[:2]],
            [FINAL[:2] + FINAL],  # doubled prefix contiguous
            [FINAL],
        ]
        v = oracle_lib.hb2_stream_verdict(samples, FINAL)
        self.assertFalse(v['ok'], v)
        self.assertEqual(v['reason'], 'doubled-prefix-in-sample')

    def test_doubled_prefix_transient_only_fails(self):
        # even if the settled DOM is clean, a transient doubling is a failure
        samples = [
            [],
            [FINAL[:4], FINAL[:4] + FINAL[:4]],  # transient duplicate partial
            [FINAL],
        ]
        v = oracle_lib.hb2_stream_verdict(samples, FINAL)
        self.assertFalse(v['ok'], v)

    def test_separate_bubble_carrying_reply_part_fails(self):
        # a second assistant bubble carrying part of the reply while another
        # carries it too — the duplicate evades settled-text checks
        samples = [
            [],
            [FINAL[:6]],
            [FINAL[:6], FINAL],  # partial chunk duplicated into a new bubble
            [FINAL],
        ]
        v = oracle_lib.hb2_stream_verdict(samples, FINAL)
        self.assertFalse(v['ok'], v)
        self.assertEqual(v['reason'], 'duplicate-partial-across-bubbles')

    def test_missing_reply_fails(self):
        v = oracle_lib.hb2_stream_verdict([[], []], FINAL)
        self.assertFalse(v['ok'], v)


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
