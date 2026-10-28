import hashlib
from io import BytesIO
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent.parent / 'backend'))
from download_progress import prepare_model_download


class Response:
    def __init__(self, body, include_length=True):
        self.body = BytesIO(body)
        self.headers = {'Content-Length': str(len(body))} if include_length else {}

    def __enter__(self): return self
    def __exit__(self, *_): self.body.close()
    def read(self, size): return self.body.read(size)


class DownloadProgressTest(unittest.TestCase):
    def setUp(self):
        self.content = b'a small mock whisper checkpoint'
        digest = hashlib.sha256(self.content).hexdigest()
        self.url = f'https://example.invalid/{digest}/tiny.pt'
        self.events = []

    def opener(self, body=None, include_length=True):
        body = self.content if body is None else body
        return lambda *args, **kwargs: Response(body, include_length)

    def test_download_verifies_then_atomically_commits_and_reports_real_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'tiny.pt'
            result = prepare_model_download('tiny', self.url, target,
                                            lambda event, **data: self.events.append((event, data)),
                                            opener=self.opener())
            self.assertEqual(result.read_bytes(), self.content)
            self.assertEqual(list(Path(folder).glob('tiny.pt.*.part')), [])
            download = [data for event, data in self.events if event == 'progress' and data['stage'] == 'model-download']
            self.assertEqual(download[-1]['downloaded'], len(self.content))
            self.assertEqual(download[-1]['total'], len(self.content))
            self.assertTrue(download[-1]['transferId'])
            self.assertEqual(download[-1]['filename'], 'tiny.pt')

    def test_bad_download_never_replaces_existing_model(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'tiny.pt'
            target.write_bytes(b'old cache')
            events = []
            with patch('download_progress.time.sleep'):
                with self.assertRaisesRegex(RuntimeError, 'SHA256'):
                    prepare_model_download('tiny', self.url, target,
                                           lambda event, **data: events.append((event, data)),
                                           opener=self.opener(b'corrupt'))
            self.assertEqual(target.read_bytes(), b'old cache')
            self.assertEqual(list(Path(folder).glob('tiny.pt.*.part')), [])
            ids = [data['transferId'] for event, data in events
                   if event == 'progress' and data['stage'] == 'model-download']
            self.assertGreaterEqual(len(ids), 3)
            self.assertEqual(len(set(ids)), 3)

    def test_unknown_content_length_reports_indeterminate_without_fake_total(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'tiny.pt'
            prepare_model_download('tiny', self.url, target,
                                   lambda event, **data: self.events.append((event, data)),
                                   opener=self.opener(include_length=False))
            download = [data for event, data in self.events
                        if event == 'progress' and data['stage'] == 'model-download']
            self.assertTrue(all(item['indeterminate'] for item in download))
            self.assertTrue(all(item['total'] == 0 and item['eta'] is None for item in download))
            self.assertEqual(download[-1]['downloaded'], len(self.content))

    def test_failed_attempt_retries_with_a_fresh_transfer_id(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'tiny.pt'
            attempts = 0

            def retrying_opener(*_args, **_kwargs):
                nonlocal attempts
                attempts += 1
                if attempts == 1:
                    class FailingResponse(Response):
                        def read(self, _size):
                            raise OSError('temporary network failure')
                    return FailingResponse(self.content)
                return Response(self.content)

            with patch('download_progress.time.sleep'):
                prepare_model_download('tiny', self.url, target,
                                       lambda event, **data: self.events.append((event, data)),
                                       opener=retrying_opener)
            ids = [data['transferId'] for event, data in self.events
                   if event == 'progress' and data['stage'] == 'model-download']
            self.assertEqual(attempts, 2)
            self.assertGreaterEqual(len(ids), 3)
            self.assertEqual(len(set(ids)), 2)
            self.assertEqual(target.read_bytes(), self.content)

    def test_valid_cache_is_reused_without_network(self):
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / 'tiny.pt'
            target.write_bytes(self.content)
            result = prepare_model_download('tiny', self.url, target, lambda *_a, **_k: None,
                                            opener=lambda *_a, **_k: self.fail('unexpected network request'))
            self.assertEqual(result, target)


if __name__ == '__main__':
    unittest.main()
