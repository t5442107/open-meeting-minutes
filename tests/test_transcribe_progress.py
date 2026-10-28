import unittest
from types import SimpleNamespace

from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).parent.parent / 'backend'))
from transcribe_progress import AudioProgress, report_whisper_frames


class FakeTqdm:
    def __init__(self, total=100, **kwargs):
        self.total = total
        self.n = 0
        self.kwargs = kwargs

    def update(self, amount):
        self.n += amount

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class TranscribeProgressTest(unittest.TestCase):
    def test_whisper_frame_updates_are_forwarded_and_tqdm_is_restored(self):
        tqdm_module = SimpleNamespace(tqdm=FakeTqdm)
        whisper_module = SimpleNamespace(tqdm=tqdm_module)
        updates = []

        with report_whisper_frames(whisper_module, lambda current, total: updates.append((current, total))):
            with tqdm_module.tqdm(total=100, disable=True) as progress:
                progress.update(25)
                progress.update(30)
                self.assertFalse(progress.kwargs['disable'])
                self.assertIsNotNone(progress.kwargs['file'])

        self.assertEqual(updates, [(25, 100), (55, 100)])
        self.assertIs(tqdm_module.tqdm, FakeTqdm)

    def test_reports_real_audio_seconds_speed_and_eta(self):
        now = [10.0]
        events = []
        progress = AudioProgress(120, lambda event, **data: events.append((event, data)),
                                 'transcribe', '正在转写完整录音',
                                 clock=lambda: now[0], min_interval=0)
        progress.start()
        now[0] = 20.0
        progress.report(250, 1000)

        data = events[-1][1]
        self.assertEqual(data['processedSeconds'], 30)
        self.assertEqual(data['totalSeconds'], 120)
        self.assertEqual(data['elapsed'], 10)
        self.assertEqual(data['audioSpeed'], 3)
        self.assertEqual(data['eta'], 30)
        self.assertEqual(data['stage'], 'transcribe')

    def test_zero_speed_has_unknown_eta_and_finish_completes(self):
        events = []
        progress = AudioProgress(2.5, lambda event, **data: events.append(data),
                                 'refine', '正在校正完整录音', clock=lambda: 1)
        progress.start()
        self.assertIsNone(events[-1]['eta'])
        progress.finish()
        self.assertEqual(events[-1]['processedSeconds'], 2.5)
        self.assertEqual(events[-1]['totalSeconds'], 2.5)

    def test_tail_progress_excludes_cached_prefix_from_speed_and_eta(self):
        now = [10.0]
        events = []
        progress = AudioProgress(
            600, lambda event, **data: events.append(data), 'finish-transcript',
            '复用已有转写，正在补齐末尾', clock=lambda: now[0], min_interval=0,
            progress_offset=588, progress_duration=12, initial_processed=590)
        progress.start()
        now[0] = 14.0
        progress.report(95, 100)

        data = events[-1]
        self.assertAlmostEqual(data['processedSeconds'], 599.4)
        self.assertEqual(data['totalSeconds'], 600)
        self.assertAlmostEqual(data['audioSpeed'], 2.35)
        self.assertAlmostEqual(data['eta'], 0.6 / 2.35)


if __name__ == '__main__':
    unittest.main()
