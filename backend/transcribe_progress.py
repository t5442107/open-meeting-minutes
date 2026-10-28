"""Progress adapters for Whisper's existing frame-based transcription loop.

This module deliberately has no Torch or Whisper imports so its behavior can
be tested without loading the speech model.
"""
from contextlib import contextmanager
import io
import time


class _ProgressBarProxy:
    """Delegate tqdm behavior while reporting its real frame counter."""

    def __init__(self, progress_bar, on_update):
        self._progress_bar = progress_bar
        self._on_update = on_update

    def update(self, amount=1):
        result = self._progress_bar.update(amount)
        total = getattr(self._progress_bar, 'total', None)
        current = getattr(self._progress_bar, 'n', 0)
        if total:
            self._on_update(current, total)
        return result

    def __enter__(self):
        self._progress_bar.__enter__()
        return self

    def __exit__(self, *args):
        return self._progress_bar.__exit__(*args)

    def __getattr__(self, name):
        return getattr(self._progress_bar, name)


@contextmanager
def report_whisper_frames(transcribe_module, on_update):
    """Temporarily wrap tqdm.tqdm referenced by whisper.transcribe.

    Whisper remains responsible for decoding and timing calculations. Its
    pbar.update(frame_delta) calls are the only source of transcription
    progress, so no estimated chunks or second inference pass are introduced.
    """
    tqdm_module = transcribe_module.tqdm
    original = tqdm_module.tqdm

    def wrapped_tqdm(*args, **kwargs):
        # Whisper passes disable=True for verbose=None, which leaves tqdm's
        # frame counter at zero. Keep the bar silent but make update() count.
        if kwargs.get('disable'):
            kwargs['disable'] = False
            kwargs.setdefault('file', io.StringIO())
        return _ProgressBarProxy(original(*args, **kwargs), on_update)

    tqdm_module.tqdm = wrapped_tqdm
    try:
        yield
    finally:
        tqdm_module.tqdm = original


class AudioProgress:
    """Convert Whisper mel-frame updates to elapsed audio seconds and ETA."""

    def __init__(self, total_seconds, emit, stage, message, clock=time.monotonic,
                 min_interval=0.5, progress_offset=0.0,
                 progress_duration=None, initial_processed=0.0):
        self.total_seconds = max(0.0, float(total_seconds))
        self.progress_offset = max(0.0, float(progress_offset))
        self.progress_duration = (self.total_seconds if progress_duration is None
                                  else max(0.0, float(progress_duration)))
        self.initial_processed = min(self.total_seconds, max(0.0, float(initial_processed)))
        self.emit = emit
        self.stage = stage
        self.message = message
        self.clock = clock
        self.min_interval = min_interval
        self.started = clock()
        self.last_emit = None
        self.processed_seconds = self.initial_processed

    def report(self, processed_frames, total_frames, force=False):
        now = self.clock()
        if total_frames:
            fraction = min(1.0, max(0.0, float(processed_frames) / total_frames))
            mapped = self.progress_offset + self.progress_duration * fraction
            self.processed_seconds = max(self.processed_seconds, mapped)
        elapsed = max(0.0, now - self.started)
        if (not force and self.last_emit is not None
                and now - self.last_emit < self.min_interval):
            return
        newly_processed = max(0.0, self.processed_seconds - self.initial_processed)
        audio_speed = newly_processed / elapsed if elapsed > 0 else 0.0
        remaining = max(0.0, self.total_seconds - self.processed_seconds)
        self.emit('progress', stage=self.stage, message=self.message,
                  processedSeconds=self.processed_seconds,
                  totalSeconds=self.total_seconds, elapsed=elapsed,
                  eta=remaining / audio_speed if audio_speed > 0 and remaining else None,
                  audioSpeed=audio_speed)
        self.last_emit = now

    def start(self):
        self.report(0, 1, force=True)

    def finish(self):
        self.processed_seconds = self.total_seconds
        self.report(1, 1, force=True)
