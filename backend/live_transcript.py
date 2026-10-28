"""Safe cache for timestamped partials produced during live recording."""
import math
from bisect import bisect_left, bisect_right


class LiveTranscriptCache:
    """Hold only contiguous, timestamped words already committed to partials."""

    def __init__(self, gap_tolerance=0.02):
        self.gap_tolerance = gap_tolerance
        self.reset()

    def reset(self):
        self.valid = True
        self.has_chunks = False
        self.frontier = 0.0
        self.committed_until = 0.0
        self.words = []
        self._word_starts = []
        self._max_word_duration = 0.0
        self.invalid_reason = None

    def invalidate(self, reason):
        self.valid = False
        self.invalid_reason = reason

    @staticmethod
    def _normalize_word(text):
        return ''.join(char for char in text.casefold() if char.isalnum() or '\u3400' <= char <= '\u9fff')

    @classmethod
    def _is_duplicate(cls, candidate, existing):
        normalized = cls._normalize_word(candidate['word'])
        if not normalized or normalized != cls._normalize_word(existing['word']):
            return False
        duration = min(candidate['end'] - candidate['start'], existing['end'] - existing['start'])
        if duration <= 0:
            return abs(candidate['start'] - existing['start']) < 0.05
        overlap = max(0.0, min(candidate['end'], existing['end']) - max(candidate['start'], existing['start']))
        return overlap / duration >= 0.5

    @classmethod
    def _nearby_duplicate(cls, candidate, words, starts, max_duration):
        # A duplicate can only overlap a word whose start lies in this local
        # time window. Repeated words minutes apart are intentionally retained.
        left = bisect_left(starts, candidate['start'] - max_duration)
        right = bisect_right(starts, candidate['end'])
        return any(cls._is_duplicate(candidate, existing) for existing in words[left:right])

    def add_chunk(self, offset, duration, segments):
        """Commit chunk words and advance continuous coverage, or invalidate cache.

        Returns (accepted, partial_segments). A silent result with no segments
        is still accepted and advances the coverage frontier.
        """
        try:
            offset, duration = float(offset), float(duration)
        except (TypeError, ValueError):
            self.invalidate('invalid chunk interval')
            return False, []
        end = offset + duration
        if not math.isfinite(offset) or not math.isfinite(duration) or offset < 0 or duration <= 0:
            self.invalidate('invalid chunk interval')
            return False, []

        accepted_words = []
        partial_segments = []
        try:
            for segment in segments:
                raw_words = segment.get('words') or []
                if not raw_words and str(segment.get('text', '')).strip():
                    raise ValueError('missing word timestamps')
                selected = []
                for word in raw_words:
                    start, finish = float(word['start']), float(word['end'])
                    token = word.get('word', '')
                    if not math.isfinite(start) or not math.isfinite(finish) or finish < start:
                        raise ValueError('invalid word timestamps')
                    if not isinstance(token, str):
                        raise ValueError('invalid word text')
                    absolute = {'start': offset + start, 'end': offset + finish, 'word': token}
                    if (absolute['start'] + absolute['end']) / 2 < self.committed_until:
                        continue
                    if token.strip():
                        selected.append(absolute)
                if selected:
                    partial_segments.append({
                        'start': selected[0]['start'], 'end': selected[-1]['end'],
                        'text': ''.join(item['word'] for item in selected).strip(),
                        'speaker': None,
                    })
                    accepted_words.extend(selected)
        except (KeyError, TypeError, ValueError, OverflowError) as error:
            self.invalidate(str(error))
            return False, []

        if not self.valid:
            if partial_segments:
                self.committed_until = max(self.committed_until, partial_segments[-1]['end'])
            return False, partial_segments
        if not self.has_chunks and offset > self.gap_tolerance:
            self.invalidate('live transcription does not start at zero')
            if partial_segments:
                self.committed_until = max(self.committed_until, partial_segments[-1]['end'])
            return False, partial_segments
        if offset > self.frontier + self.gap_tolerance:
            self.invalidate('gap in live transcription coverage')
            if partial_segments:
                self.committed_until = max(self.committed_until, partial_segments[-1]['end'])
            return False, partial_segments

        accepted_words.sort(key=lambda item: (item['start'], item['end']))
        additions = []
        addition_starts = []
        max_duration = self._max_word_duration
        for candidate in accepted_words:
            duplicate = (self._nearby_duplicate(candidate, self.words, self._word_starts,
                                                self._max_word_duration)
                         or self._nearby_duplicate(candidate, additions, addition_starts,
                                                   max_duration))
            if not duplicate:
                additions.append(candidate)
                addition_starts.append(candidate['start'])
                max_duration = max(max_duration, candidate['end'] - candidate['start'])
        self.words.extend(additions)
        self.words.sort(key=lambda item: (item['start'], item['end']))
        self._word_starts = [item['start'] for item in self.words]
        self._max_word_duration = max_duration
        if partial_segments:
            self.committed_until = max(self.committed_until, partial_segments[-1]['end'])
        self.frontier = max(self.frontier, end)
        self.has_chunks = True
        return True, partial_segments

    def as_segments(self):
        """Return cached words in the segment shape consumed by speaker assignment."""
        if not self.words:
            return []
        return [{
            'start': self.words[0]['start'],
            'end': self.words[-1]['end'],
            'text': ''.join(item['word'] for item in self.words).strip(),
            'words': list(self.words),
        }]

    def covers_duration(self, duration, sample_rate=16000):
        return (self.valid and self.has_chunks
                and float(duration) - self.frontier <= 1 / sample_rate)

    def combine_tail(self, segments, offset):
        """Append timestamped words newer than the committed boundary.

        Returns Whisper-compatible segments, or None if tail timestamps are
        insufficient to safely use the cache and a complete transcription is
        required instead.
        """
        if not self.valid or not self.has_chunks:
            return None
        try:
            offset = float(offset)
            tail_words = []
            for segment in segments:
                raw_words = segment.get('words') or []
                if not raw_words and str(segment.get('text', '')).strip():
                    return None
                for word in raw_words:
                    start, end = float(word['start']), float(word['end'])
                    token = word.get('word', '')
                    if (not math.isfinite(start) or not math.isfinite(end) or end < start
                            or not isinstance(token, str)):
                        return None
                    absolute = {'start': offset + start, 'end': offset + end, 'word': token}
                    if token.strip() and (absolute['start'] + absolute['end']) / 2 >= self.committed_until:
                        tail_words.append(absolute)
        except (KeyError, TypeError, ValueError, OverflowError):
            return None

        tail_words.sort(key=lambda item: (item['start'], item['end']))
        additions = []
        addition_starts = []
        max_duration = self._max_word_duration
        for candidate in tail_words:
            if not (self._nearby_duplicate(candidate, self.words, self._word_starts,
                                           self._max_word_duration)
                    or self._nearby_duplicate(candidate, additions, addition_starts,
                                              max_duration)):
                additions.append(candidate)
                addition_starts.append(candidate['start'])
                max_duration = max(max_duration, candidate['end'] - candidate['start'])
        combined = list(self.words) + additions
        combined.sort(key=lambda item: (item['start'], item['end']))
        if not combined:
            return []
        return [{
            'start': combined[0]['start'],
            'end': combined[-1]['end'],
            'text': ''.join(item['word'] for item in combined).strip(),
            'words': combined,
        }]
