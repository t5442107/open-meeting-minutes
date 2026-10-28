import sys
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).parent.parent / 'backend'))
from live_transcript import LiveTranscriptCache


def segment(*words, text=None):
    return {'start': words[0]['start'] if words else 0,
            'end': words[-1]['end'] if words else 0,
            'text': text if text is not None else ''.join(word['word'] for word in words),
            'words': list(words)}


class LiveTranscriptCacheTest(unittest.TestCase):
    def test_long_repeated_word_sequence_uses_local_time_window_for_dedup(self):
        class CountingCache(LiveTranscriptCache):
            comparisons = 0

            @classmethod
            def _is_duplicate(cls, candidate, existing):
                cls.comparisons += 1
                return super()._is_duplicate(candidate, existing)

        cache = CountingCache()
        words = [{'start': index * 0.2, 'end': index * 0.2 + 0.05, 'word': '嗯'}
                 for index in range(3000)]
        accepted, _ = cache.add_chunk(0, 600, [segment(*words)])
        self.assertTrue(accepted)
        self.assertEqual(len(cache.words), 3000)

        accepted, _ = cache.add_chunk(599.8, 0.2, [segment(
            {'start': 0.02, 'end': 0.10, 'word': '嗯'})])
        self.assertTrue(accepted)
        self.assertEqual(len(cache.words), 3000)
        self.assertLess(CountingCache.comparisons, 7000)

    def test_overlapping_chunks_reuse_committed_words_and_only_append_new_tail(self):
        cache = LiveTranscriptCache()
        accepted, first = cache.add_chunk(0, 12, [
            segment({'start': 0.2, 'end': 0.6, 'word': '开场。'},
                    {'start': 10.0, 'end': 10.4, 'word': '重复词'})])
        self.assertTrue(accepted)
        self.assertEqual(cache.frontier, 12)
        self.assertEqual(len(first), 1)

        accepted, second = cache.add_chunk(10, 12, [
            segment({'start': 0.05, 'end': 0.45, 'word': '重复词'},
                    {'start': 1.2, 'end': 1.5, 'word': '新词'})])
        self.assertTrue(accepted)
        self.assertEqual([item['text'] for item in second], ['新词'])
        self.assertEqual(cache.committed_until, 11.5)

        combined = cache.combine_tail([
            segment({'start': 1.25, 'end': 1.55, 'word': '新词'},
                    {'start': 2.4, 'end': 2.8, 'word': '收尾。'})], 10)
        self.assertEqual([item['word'] for item in combined[0]['words']],
                         ['开场。', '重复词', '新词', '收尾。'])

    def test_gap_invalidates_cache_for_safe_full_transcription_fallback(self):
        cache = LiveTranscriptCache()
        self.assertTrue(cache.add_chunk(0, 5, [])[0])
        self.assertFalse(cache.add_chunk(5.2, 2, [])[0])
        self.assertFalse(cache.valid)
        self.assertIn('gap', cache.invalid_reason)
        self.assertIsNone(cache.combine_tail([], 5.2))

    def test_failed_chunk_invalidates_reuse_but_keeps_later_live_partials(self):
        cache = LiveTranscriptCache()
        self.assertTrue(cache.add_chunk(0, 5, [])[0])
        cache.invalidate('chunk inference failed')
        accepted, partial = cache.add_chunk(5, 2, [
            segment({'start': 0.1, 'end': 0.3, 'word': '仍显示实时文字'})])
        self.assertFalse(accepted)
        self.assertFalse(cache.valid)
        self.assertEqual(partial[0]['text'], '仍显示实时文字')

    def test_first_chunk_must_cover_audio_from_zero(self):
        cache = LiveTranscriptCache()
        self.assertFalse(cache.add_chunk(1, 2, [])[0])
        self.assertFalse(cache.valid)

    def test_silent_chunk_advances_contiguous_coverage(self):
        cache = LiveTranscriptCache()
        self.assertTrue(cache.add_chunk(0, 4, [])[0])
        self.assertTrue(cache.add_chunk(3, 4, [])[0])
        self.assertEqual(cache.frontier, 7)
        self.assertEqual(cache.words, [])
        self.assertEqual(cache.combine_tail([], 5), [])

    def test_already_complete_coverage_does_not_need_a_tail_pass(self):
        cache = LiveTranscriptCache()
        self.assertTrue(cache.add_chunk(0, 5, [segment(
            {'start': 1, 'end': 2, 'word': '全部完成'})])[0])
        self.assertTrue(cache.covers_duration(5))
        self.assertTrue(cache.covers_duration(5 + 0.9 / 16000))
        self.assertFalse(cache.covers_duration(5 + 2 / 16000))
        self.assertEqual(cache.as_segments()[0]['text'], '全部完成')

    def test_missing_word_timestamps_invalidates_cache_and_tail(self):
        cache = LiveTranscriptCache()
        self.assertFalse(cache.add_chunk(0, 5, [segment(text='无法安全复用')])[0])
        self.assertFalse(cache.valid)

        valid = LiveTranscriptCache()
        self.assertTrue(valid.add_chunk(0, 5, [segment({'start': 1, 'end': 2, 'word': '已有'})])[0])
        self.assertIsNone(valid.combine_tail([segment(text='尾部无时间戳')], 3))

    def test_short_recording_without_chunks_falls_back_and_reset_clears_cache(self):
        cache = LiveTranscriptCache()
        self.assertIsNone(cache.combine_tail([], 0))
        self.assertTrue(cache.add_chunk(0, 3, [segment({'start': 1, 'end': 2, 'word': '试验'})])[0])
        cache.reset()
        self.assertTrue(cache.valid)
        self.assertFalse(cache.has_chunks)
        self.assertEqual(cache.frontier, 0)
        self.assertEqual(cache.committed_until, 0)
        self.assertEqual(cache.words, [])


if __name__ == '__main__':
    unittest.main()
