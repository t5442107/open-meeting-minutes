import contextlib
import importlib.util
import io
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    'worker_protocol_test', Path(__file__).parent.parent / 'backend' / 'worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class WorkerProtocolOutputTest(unittest.TestCase):
    def test_emit_keeps_protocol_events_on_captured_stdout_during_library_redirect(self):
        protocol = io.StringIO()
        redirected_stdout = io.StringIO()
        redirected_stderr = io.StringIO()
        previous_protocol = worker._protocol_stdout
        worker._protocol_stdout = protocol
        try:
            with contextlib.redirect_stdout(redirected_stdout), \
                    contextlib.redirect_stderr(redirected_stderr):
                worker.emit('progress', stage='transcribe', processedSeconds=3)
        finally:
            worker._protocol_stdout = previous_protocol

        self.assertIn('"event": "progress"', protocol.getvalue())
        self.assertIn('"processedSeconds": 3', protocol.getvalue())
        self.assertEqual(redirected_stdout.getvalue(), '')
        self.assertEqual(redirected_stderr.getvalue(), '')


if __name__ == '__main__':
    unittest.main()
