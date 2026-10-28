import importlib.util
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'worker_device_test', Path(__file__).parent.parent / 'backend' / 'worker.py')
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class FakeCuda:
    def __init__(self, available=True):
        self.available = available

    def is_available(self):
        return self.available

    def get_device_name(self, index):
        return 'Test NVIDIA GPU'


class FakeTorch:
    def __init__(self, available=True):
        self.cuda = FakeCuda(available)


class WorkerDeviceTest(unittest.TestCase):
    def test_cuda_wheel_vendor_dll_directories_are_discovered(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp) / 'site-packages'
            torch_dir = root / 'torch'
            expected = [torch_dir / 'lib', root / 'nvidia' / 'cudnn' / 'bin',
                        root / 'nvidia' / 'cublas' / 'bin']
            for directory in expected:
                directory.mkdir(parents=True)
            self.assertEqual(worker.torch_dll_search_directories(torch_dir),
                             [expected[0], expected[2], expected[1]])

    def test_cpu_does_not_probe_cuda(self):
        class CpuTorch:
            class cuda:
                @staticmethod
                def is_available():
                    raise AssertionError('CPU mode must not probe CUDA')

        self.assertEqual(worker.configure_device(CpuTorch(), 'cpu'), ('cpu', None))

    def test_cuda_returns_gpu_name(self):
        with patch.object(worker.sys, 'platform', 'win32'), \
                patch.object(worker.platform, 'machine', return_value='AMD64'):
            self.assertEqual(worker.configure_device(FakeTorch(), 'cuda'),
                             ('cuda', 'Test NVIDIA GPU'))

    def test_cuda_unavailable_fails_instead_of_falling_back(self):
        with patch.object(worker.sys, 'platform', 'win32'), \
                patch.object(worker.platform, 'machine', return_value='AMD64'):
            with self.assertRaisesRegex(RuntimeError, '已请求 CUDA'):
                worker.configure_device(FakeTorch(available=False), 'cuda')

    def test_cuda_rejects_non_windows(self):
        with patch.object(worker.sys, 'platform', 'darwin'):
            with self.assertRaisesRegex(RuntimeError, '仅支持 Windows x64'):
                worker.configure_device(FakeTorch(), 'cuda')

    def test_fp16_is_enabled_only_for_cuda(self):
        self.assertTrue(worker.transcribe_fp16('cuda'))
        self.assertFalse(worker.transcribe_fp16('cpu'))


if __name__ == '__main__':
    unittest.main()
