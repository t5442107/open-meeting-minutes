import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('worker', Path(__file__).parent.parent / 'backend' / 'worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

class AlignmentTest(unittest.TestCase):
    def test_traditional_transcript_conversion_preserves_english_and_numbers(self):
        self.assertEqual(worker.simplify_chinese('會議確認 API v2 於 2025 年上線'),
                         '会议确认 API v2 于 2025 年上线')

    def test_speaker_change_splits_text_using_voice_time_overlap(self):
        segments = [{'start': 0, 'end': 5, 'text': '你好再见', 'words': [
            {'start': 0.1, 'end': 1, 'word': '你好'}, {'start': 3, 'end': 4, 'word': '再见'}]}]
        turns = [{'start': 0, 'end': 2, 'speaker': 'speaker_1'}, {'start': 2.5, 'end': 5, 'speaker': 'speaker_2'}]
        result = worker.assign_speakers(segments, turns)
        self.assertEqual([s['speaker'] for s in result], ['speaker_1', 'speaker_2'])
        self.assertEqual(''.join(s['text'] for s in result), '你好再见')

    def test_no_voice_evidence_stays_unknown(self):
        result = worker.assign_speakers([{'start': 0, 'end': 1, 'text': '需要确认'}], [])
        self.assertIsNone(result[0]['speaker'])
        self.assertEqual(result[0]['text'], '需要确认')

if __name__ == '__main__':
    unittest.main()
