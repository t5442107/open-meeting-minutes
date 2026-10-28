"""Local speech worker: JSON-line commands, Whisper ASR and sherpa-onnx diarization."""
import argparse
from bisect import bisect_left
import contextlib
import ctypes
import hashlib
import importlib.util
from functools import partial as bind_urlopen
import json
import math
import os
import platform
from pathlib import Path
import ssl
import subprocess
import sys
import re
import tarfile
import time
import urllib.request
import uuid

SEGMENT_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2'
EMBED_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx'

from opencc import OpenCC
try:
    from download_progress import prepare_model_download
    from live_transcript import LiveTranscriptCache
    from transcribe_progress import AudioProgress, report_whisper_frames
except ModuleNotFoundError:  # Supports loading worker.py directly from tests.
    sys.path.insert(0, str(Path(__file__).parent))
    from download_progress import prepare_model_download
    from live_transcript import LiveTranscriptCache
    from transcribe_progress import AudioProgress, report_whisper_frames
_to_simplified = OpenCC('t2s')
_protocol_stdout = None


def torch_dll_search_directories(torch_dir):
    torch_dir = Path(torch_dir)
    return [directory for directory in
            (torch_dir / 'lib', torch_dir.parent / 'numpy.libs',
             *sorted((torch_dir.parent / 'nvidia').glob('*/bin')))
            if directory.is_dir()]


def prepare_torch_dlls():
    """Make Torch's Windows native dependencies win DLL resolution before imports."""
    if sys.platform != 'win32':
        return
    spec = importlib.util.find_spec('torch')
    if not spec or not spec.origin:
        return
    torch_dir = Path(spec.origin).parent
    # Python 3.8+ no longer uses PATH for extension dependency lookup. Keep
    # these handles alive for the worker lifetime so dependent DLLs resolve.
    for directory in torch_dll_search_directories(torch_dir):
        _dll_directory_handles.append(os.add_dll_directory(str(directory)))
    c10 = torch_dir / 'lib' / 'c10.dll'
    if c10.is_file():
        # Loading c10 first works around a Windows initialization-order issue
        # seen with newer Torch wheels and conflicting DLLs in host processes.
        ctypes.CDLL(str(c10))


_dll_directory_handles = []


def torch_dll_error(error):
    if sys.platform == 'win32' and getattr(error, 'winerror', None) == 1114:
        return RuntimeError(
            'Windows could not initialize PyTorch (c10.dll). This can happen '
            'with an older/conflicting Microsoft Visual C++ runtime. Install '
            'the latest x64 Visual C++ Redistributable, restart Windows, and '
            'try again: https://aka.ms/vs/17/release/vc_redist.x64.exe'
        )
    return error


def configure_device(torch, device):
    """Validate an explicitly requested accelerator; never silently fall back."""
    if device == 'cpu':
        return 'cpu', None
    if device != 'cuda':
        raise RuntimeError(f'不支持的语音引擎设备：{device}')
    if sys.platform != 'win32' or platform.machine().lower() not in ('amd64', 'x86_64'):
        raise RuntimeError('CUDA 语音引擎仅支持 Windows x64。')
    try:
        available = torch.cuda.is_available()
    except Exception as error:
        raise RuntimeError(f'无法初始化 CUDA：{error}') from error
    if not available:
        raise RuntimeError('已请求 CUDA，但 PyTorch 无法使用 CUDA。请确认 NVIDIA 驱动及 CUDA 12.6 PyTorch 依赖已正确安装。')
    try:
        name = torch.cuda.get_device_name(0)
    except Exception as error:
        raise RuntimeError(f'CUDA 已检测到，但无法读取 GPU 设备名称：{error}') from error
    return 'cuda', name


def transcribe_fp16(device):
    return device == 'cuda'


def simplify_chinese(text):
    """Convert Chinese script locally while OpenCC leaves Latin text and digits intact."""
    return _to_simplified.convert(text) if isinstance(text, str) else text


def emit(event, **data):
    print(json.dumps({'event': event, **data}, ensure_ascii=False),
          file=_protocol_stdout if _protocol_stdout is not None else sys.stdout,
          flush=True)


def emit_transfer(stage, message, transfer_id, filename, downloaded, total, started):
    """Emit byte progress with rates measured only from network reads."""
    now = time.monotonic()
    elapsed = max(now - started, 0.001)
    speed = downloaded / elapsed if downloaded else 0
    data = dict(stage=stage, message=message, transferId=transfer_id,
                filename=filename, downloaded=downloaded, total=total,
                speed=speed, eta=max(0, total - downloaded) / speed if total and speed else None)
    if not total:
        data['indeterminate'] = True
    emit('progress', **data)


def ensure_file(url, target, stage='speakers-download', message='正在下载说话人区分模型', filename=None):
    if target.is_file() and target.stat().st_size > 10000:
        return
    import certifi
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + '.part')
    transfer_id = str(uuid.uuid4())
    filename = filename or target.name
    context = ssl.create_default_context(cafile=certifi.where())
    for attempt in range(3):
        try:
            with urllib.request.urlopen(url, context=context, timeout=60) as response, temporary.open('wb') as output:
                try: size = int(response.headers.get('Content-Length', 0))
                except (TypeError, ValueError): size = 0
                done = 0
                started = time.monotonic()
                last_emit = 0
                emit('progress', stage=stage, message=message, transferId=transfer_id,
                     filename=filename, downloaded=0, total=size, speed=0, eta=None,
                     **({'indeterminate': True} if not size else {}))
                while True:
                    chunk = response.read(1024 * 512)
                    if not chunk:
                        break
                    output.write(chunk)
                    done += len(chunk)
                    if time.monotonic() - last_emit >= 0.5:
                        emit_transfer(stage, message, transfer_id, filename, done, size, started)
                        last_emit = time.monotonic()
            if size and done != size:
                raise RuntimeError('模型下载未完成')
            emit_transfer(stage, message, transfer_id, filename, done, size, started)
            temporary.replace(target)
            return
        except Exception:
            temporary.unlink(missing_ok=True)
            if attempt == 2:
                raise
            time.sleep(1)


def prepare_diarization(folder):
    bundled = Path(__file__).parent / 'models'
    if (bundled / 'segmentation.onnx').is_file() and (bundled / 'embedding.onnx').is_file():
        checksums = {'segmentation.onnx': '220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079', 'embedding.onnx': '1a331345f04805badbb495c775a6ddffcdd1a732567d5ec8b3d5749e3c7a5e4b'}
        for name, expected in checksums.items():
            if hashlib.sha256((bundled / name).read_bytes()).hexdigest() != expected:
                raise RuntimeError('说话人模型文件校验失败，请重新安装完整版本。')
        return bundled / 'segmentation.onnx', bundled / 'embedding.onnx'
    folder = Path(folder)
    segment = folder / 'segmentation.onnx'
    embedding = folder / 'embedding.onnx'
    if not segment.is_file():
        archive = folder / 'segmentation.tar.bz2'
        ensure_file(SEGMENT_URL, archive)
        # Extract only the model bytes, never arbitrary paths from the archive.
        with tarfile.open(archive, 'r:bz2') as data:
            member = next(item for item in data.getmembers() if item.name.endswith('/model.onnx') and item.isfile())
            content = data.extractfile(member)
            temp = segment.with_suffix('.part')
            with temp.open('wb') as output:
                import shutil
                shutil.copyfileobj(content, output)
            temp.replace(segment)
        archive.unlink(missing_ok=True)
    ensure_file(EMBED_URL, embedding)
    return segment, embedding


def assign_speakers(segments, turns):
    """Assign actual timed words by overlap; never infer a voice from the text."""
    output = []
    timed_turns = sorted(turns, key=lambda item: item['start'])
    turn_starts = [item['start'] for item in timed_turns]
    max_turn_duration = max((item['end'] - item['start'] for item in timed_turns), default=0.0)
    for segment in segments:
        words = segment.get('words') or [{'start': segment['start'], 'end': segment['end'], 'word': segment['text']}]
        for word in words:
            start, end = float(word['start']), float(word['end'])
            scores = {}
            left = bisect_left(turn_starts, start - max_turn_duration)
            right = bisect_left(turn_starts, end)
            for turn in timed_turns[left:right]:
                overlap = max(0.0, min(end, turn['end']) - max(start, turn['start']))
                scores[turn['speaker']] = scores.get(turn['speaker'], 0.0) + overlap
            speaker = max(scores, key=scores.get) if scores and max(scores.values()) > 0 else None
            text = word.get('word', '')
            if not text.strip():
                continue
            if output and output[-1]['speaker'] == speaker and start - output[-1]['end'] < 1.2 and end - output[-1]['start'] < 15:
                output[-1]['text'] += text
                output[-1]['end'] = end
            else:
                output.append({'start': start, 'end': end, 'speaker': speaker, 'text': text})
    for index, item in enumerate(output):
        item['id'] = f's{index + 1}'
        item['text'] = item['text'].strip()
    return output


def main():
    global _protocol_stdout
    # Keep JSON-lines on the worker protocol stream while noisy libraries are
    # redirected to stderr during model execution.
    _protocol_stdout = sys.stdout
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', default='large-v3-turbo')
    parser.add_argument('--device', choices=('cpu', 'cuda'), default='cpu')
    parser.add_argument('--speaker-device', choices=('cpu', 'cuda'), default='cpu')
    parser.add_argument('--model-dir', required=True)
    parser.add_argument('--diarization-dir', required=True)
    parser.add_argument('--ffmpeg', required=True)
    args = parser.parse_args()
    os.environ['PATH'] = str(Path(args.ffmpeg).parent) + os.pathsep + os.environ.get('PATH', '')
    emit('progress', stage='engine', message='正在准备本地语音引擎，首次使用会下载所需模型')
    try:
        prepare_torch_dlls()
        # Load Torch before NumPy and other native extensions on Windows.
        try:
            import torch
        except Exception as error:
            if args.device == 'cuda' or args.speaker_device == 'cuda':
                raise RuntimeError(f'已请求 CUDA，但 PyTorch 无法导入：{error}') from error
            raise torch_dll_error(error) from error
        if args.device == 'cuda' or args.speaker_device == 'cuda':
            _, gpu_name = configure_device(torch, 'cuda')
        else:
            gpu_name = None
        device = args.device
        import numpy as np
        import whisper
    except OSError as error:
        raise torch_dll_error(error) from error
    import certifi
    os.environ['SSL_CERT_FILE'] = certifi.where()
    torch.set_num_threads(max(1, min(4, os.cpu_count() or 1)))
    model_url = whisper._MODELS.get(args.model)
    if model_url:
        model_path = prepare_model_download(
            args.model, model_url, Path(args.model_dir) / model_url.rsplit('/', 1)[-1], emit,
            opener=bind_urlopen(urllib.request.urlopen, context=ssl.create_default_context(cafile=certifi.where())))
        # The official loader otherwise reads and hashes this entire (up to
        # 1.6 GB) checkpoint a second time. We just verified it, including the
        # official URL digest, so bypass only its redundant _download check.
        original_download = whisper._download
        whisper._download = lambda url, root, in_memory: str(model_path) if url == model_url else original_download(url, root, in_memory)
    emit('progress', stage='model-load', message='正在加载 Whisper 语音模型', filename=Path(model_url).name if model_url else args.model, indeterminate=True)
    with contextlib.redirect_stdout(sys.stderr):
        model = whisper.load_model(args.model, device=device, download_root=args.model_dir)
    emit('ready', model=args.model, device=device, speakerDevice=args.speaker_device,
         **({'gpuName': gpu_name} if gpu_name else {}))
    live_transcript = LiveTranscriptCache()

    def audio_samples(filename):
        result = subprocess.run([args.ffmpeg, '-nostdin', '-v', 'error', '-i', filename,
                                 '-f', 's16le', '-ac', '1', '-ar', '16000', '-'],
                                check=True, capture_output=True)
        return np.frombuffer(result.stdout, dtype=np.int16).astype(np.float32) / 32768.0

    def transcribe(audio, language, final=False, progress_stage=None,
                   progress_message=None, progress_offset=0.0,
                   progress_total_seconds=None, initial_processed=0.0):
        if not len(audio) or float(np.sqrt(np.mean(audio ** 2))) < 0.002:
            return {'segments': [], 'text': ''}
        transcribe_module = __import__('whisper.transcribe', fromlist=['transcribe'])
        progress = None
        progress_context = contextlib.nullcontext()
        if progress_stage:
            duration = (len(audio) / 16000 if progress_total_seconds is None
                        else float(progress_total_seconds))
            message = progress_message or ('正在校正完整录音' if progress_stage == 'refine'
                                           else '正在转写完整录音')
            progress = AudioProgress(duration, emit, progress_stage, message,
                                     progress_offset=progress_offset,
                                     progress_duration=len(audio) / 16000,
                                     initial_processed=initial_processed)
            progress.start()
            progress_context = report_whisper_frames(transcribe_module, progress.report)
        with contextlib.redirect_stdout(sys.stderr):
            with progress_context:
                result = model.transcribe(audio, language=None if language == 'auto' else language,
                                          task='transcribe', fp16=transcribe_fp16(device), verbose=None,
                                          word_timestamps=True, condition_on_previous_text=final,
                                          temperature=0, no_speech_threshold=0.6)
        if progress:
            progress.finish()
        return result

    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            command = request['command']
            if command == 'shutdown':
                break
            if command == 'prepare':
                prepare_diarization(args.diarization_dir)
                emit('result', requestId=request['requestId'], prepared=True)
                continue
            if command == 'reset':
                live_transcript.reset()
                emit('result', requestId=request['requestId'], reset=True)
                continue
            if command == 'chunk':
                audio = audio_samples(request['path'])
                result = transcribe(audio, request.get('language', 'zh'),
                                    progress_stage='live-transcribe',
                                    progress_message='正在识别最近一段语音')
                offset = float(request.get('offset', 0))
                accepted, partial = live_transcript.add_chunk(offset, len(audio) / 16000,
                                                              result['segments'])
                for segment in partial:
                    segment['text'] = simplify_chinese(segment['text'])
                emit('partial', segments=partial, processed=offset + len(audio) / 16000,
                     processedSeconds=live_transcript.frontier)
                continue
            if command == 'finalize':
                mode = request.get('mode', 'recording')
                strategy = request.get('finalizeStrategy', 'fast') if mode == 'recording' else 'full'
                use_fast = mode == 'recording' and strategy == 'fast'
                use_live_transcript = use_fast and bool(request.get('useLiveTranscript'))
                audio = None if use_live_transcript else audio_samples(request['path'])
                duration = float(request.get('duration') or 0) if use_live_transcript else len(audio) / 16000
                if not math.isfinite(duration) or duration <= 0:
                    audio = audio_samples(request['path'])
                    duration = len(audio) / 16000
                    use_live_transcript = False
                result = None
                fallback_reason = ''
                if use_live_transcript:
                    cached = []
                    for item in request.get('liveTranscriptSegments') or []:
                        try:
                            start, end = float(item['start']), float(item['end'])
                            text = simplify_chinese(str(item.get('text') or '').strip())
                            if math.isfinite(start) and math.isfinite(end) and 0 <= start <= end <= duration + 1 and text:
                                cached.append({'start': start, 'end': end, 'text': text, 'words': []})
                        except (KeyError, TypeError, ValueError):
                            continue
                    cached.sort(key=lambda item: (item['start'], item['end']))
                    result = {'segments': cached, 'text': ''.join(item['text'] for item in cached)}
                    emit('progress', stage='finish-transcript', message='已复用实时转写，无需补转末尾',
                         processedSeconds=duration, totalSeconds=duration, elapsed=0,
                         eta=0, audioSpeed=0, complete=True)
                elif (use_fast and live_transcript.valid and live_transcript.has_chunks
                        and live_transcript.frontier <= duration + live_transcript.gap_tolerance):
                    if live_transcript.covers_duration(duration):
                        combined = live_transcript.as_segments()
                        result = {'segments': combined,
                                  'text': ''.join(word['word'] for segment in combined
                                                  for word in segment.get('words', [])).strip()}
                        emit('progress', stage='finish-transcript', message='已复用全部实时转写',
                             processedSeconds=duration, totalSeconds=duration, elapsed=0,
                             eta=0, audioSpeed=0, complete=True)
                    else:
                        tail_start = max(0.0, live_transcript.frontier - 2.0)
                        tail_audio = audio[int(round(tail_start * 16000)):]
                        try:
                            tail_result = transcribe(
                                tail_audio, request.get('language', 'zh'), final=True,
                                progress_stage='finish-transcript',
                                progress_message='复用已有转写，正在补齐末尾',
                                progress_offset=tail_start, progress_total_seconds=duration,
                                initial_processed=live_transcript.frontier)
                            combined = live_transcript.combine_tail(tail_result['segments'], tail_start)
                            if combined is not None:
                                result = {'segments': combined,
                                          'text': ''.join(word['word'] for segment in combined
                                                          for word in segment.get('words', [])).strip()}
                            else:
                                fallback_reason = '末尾转写缺少可靠词级时间戳'
                        except Exception as error:
                            fallback_reason = f'末尾补转写失败：{error}'
                elif use_fast:
                    fallback_reason = live_transcript.invalid_reason or '没有可复用的连续实时转写'
                    if live_transcript.frontier > duration + live_transcript.gap_tolerance:
                        fallback_reason = '实时转写覆盖时长超出录音长度'

                if result is None:
                    progress_stage = 'transcribe' if mode == 'import' else 'refine'
                    if fallback_reason:
                        message = '实时转写不完整，正在全文转写' if use_fast else fallback_reason
                    elif use_fast:
                        message = '正在全文重新转写'
                    else:
                        message = '正在校正完整录音' if mode != 'import' else '正在转写完整录音'
                    result = transcribe(audio, request.get('language', 'zh'), final=True,
                                        progress_stage=progress_stage,
                                        progress_message=message)
                transcript_segments = [
                    {'start': float(item['start']), 'end': float(item['end']),
                     'text': simplify_chinese(item.get('text', '')),
                     'words': [{'start': float(word['start']), 'end': float(word['end']),
                                'word': word.get('word', '')}
                               for word in item.get('words', [])]}
                    for item in result['segments']
                ]
                transcript_text = simplify_chinese(result.get('text', '').strip())
                live_turns = []
                for item in request.get('liveSpeakerTurns') or []:
                    try:
                        start, end = float(item['start']), float(item['end'])
                        speaker = str(item['speaker'])
                        if math.isfinite(start) and math.isfinite(end) and 0 <= start < end <= duration + 1 and re.fullmatch(r'speaker_\d+', speaker):
                            live_turns.append({'start': start, 'end': end, 'speaker': speaker})
                    except (KeyError, TypeError, ValueError):
                        continue
                preliminary_segments = (assign_speakers(transcript_segments, live_turns)
                                        if request.get('skipOfflineDiarization') and live_turns
                                        else transcript_segments)
                emit('transcribed', requestId=request['requestId'], text=transcript_text,
                     segments=preliminary_segments, duration=duration)
                turns, warning = [], ''
                if result['segments']:
                    speaker_started = time.monotonic()
                    skip_offline = bool(request.get('skipOfflineDiarization'))
                    if not skip_offline:
                        emit('progress', stage='speakers', message='正在区分发言人，人数可在录音前指定',
                             indeterminate=True, elapsed=0, totalSeconds=duration)
                    live_segments = assign_speakers(result['segments'], live_turns)
                    total_chars = sum(len(str(item.get('text', '')).strip()) for item in result['segments'])
                    matched_chars = sum(len(item['text']) for item in live_segments if item['speaker'])
                    if skip_offline:
                        turns = live_turns
                        if not live_turns:
                            warning = '实时声纹未能匹配发言人；录音和转写已保存，可从历史会议重新处理。'
                        elif total_chars and matched_chars / total_chars < 0.45:
                            warning = '部分发言未能在录音时匹配声纹；已保留实时声纹结果。'
                        emit('progress', stage='speakers', message='已使用录音时完成的声纹匹配',
                             processedSeconds=duration, totalSeconds=duration, elapsed=0,
                             complete=True, diarizationSucceeded=bool(live_turns))
                    elif live_turns and total_chars and matched_chars / total_chars >= 0.45:
                        turns = live_turns
                        emit('progress', stage='speakers', message='已复用录音时的实时声纹匹配',
                             processedSeconds=duration, totalSeconds=duration, elapsed=0,
                             complete=True, diarizationSucceeded=True)
                    else:
                        try:
                            segment_path, embedding_path = prepare_diarization(args.diarization_dir)
                            import sherpa_onnx
                            with contextlib.redirect_stdout(sys.stderr):
                                config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
                                    segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                                        pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=str(segment_path)),
                                        provider=args.speaker_device),
                                    embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=str(embedding_path), provider=args.speaker_device),
                                    clustering=sherpa_onnx.FastClusteringConfig(num_clusters=int(request.get('speakers', -1)), threshold=0.7),
                                    min_duration_on=0.3, min_duration_off=0.5)
                                if not config.validate():
                                    raise RuntimeError('模型配置无效')
                                diarizer = sherpa_onnx.OfflineSpeakerDiarization(config)
                                for turn in diarizer.process(audio).sort_by_start_time():
                                    turns.append({'start': float(turn.start), 'end': float(turn.end), 'speaker': f'speaker_{turn.speaker + 1}'})
                        except Exception as error:
                            if args.speaker_device == 'cuda':
                                raise RuntimeError(f'NVIDIA 声纹区分启动失败：{error}。请检查 NVIDIA 驱动和 CUDA 声纹组件，或改用 CPU 声纹区分。') from error
                            warning = f'转写已保存，但说话人区分未完成：{error}'
                        finally:
                            emit('progress', stage='speakers', message='说话人区分已完成' if not warning else '说话人区分未完成，已保留转写',
                                 indeterminate=True, elapsed=max(0.0, time.monotonic() - speaker_started),
                                 totalSeconds=duration, complete=not bool(warning),
                                 diarizationSucceeded=not bool(warning))
                segments = assign_speakers(result['segments'], turns)
                for segment in segments:
                    segment['text'] = simplify_chinese(segment['text'])
                emit('result', requestId=request['requestId'], segments=segments, speakerTurns=turns,
                     text=transcript_text, duration=duration,
                     diarized=bool(turns), warning=warning)
        except Exception as error:
            if request.get('command') == 'chunk':
                live_transcript.invalidate(f'实时转写失败：{error}')
            emit('error', requestId=request.get('requestId'), message=str(error))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        emit('fatal', message=str(error))
        sys.exit(1)
