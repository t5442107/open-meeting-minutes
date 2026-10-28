"""Low-latency local streaming ASR companion for the Whisper worker."""
import argparse
import base64
import json
import math
import os
from pathlib import Path
import queue
import shutil
import ssl
import sys
import tarfile
import threading
import time
import urllib.request
import uuid

import certifi
import numpy as np
import sherpa_onnx
from opencc import OpenCC

MODEL_URL = ('https://github.com/k2-fsa/sherpa-onnx/releases/download/'
             'asr-models/sherpa-onnx-streaming-paraformer-bilingual-zh-en.tar.bz2')
MODEL_FILES = ('encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt')
PUNCT_URL = ('https://github.com/k2-fsa/sherpa-onnx/releases/download/'
             'punctuation-models/sherpa-onnx-punct-ct-transformer-zh-en-vocab272727-2024-04-12-int8.tar.bz2')
PUNCT_MODEL = 'model.int8.onnx'
SPEAKER_URL = ('https://github.com/k2-fsa/sherpa-onnx/releases/download/'
               'speaker-recongition-models/3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx')
output_lock = threading.Lock()


def emit(event, **data):
    with output_lock:
        print(json.dumps({'event': event, **data}, ensure_ascii=False), flush=True)


def prepare_model(folder):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    targets = {name: folder / name for name in MODEL_FILES}
    if all(path.is_file() and path.stat().st_size > 1000 for path in targets.values()):
        return targets
    archive = folder / 'streaming-paraformer.tar.bz2'
    temporary = archive.with_suffix('.part')
    transfer = str(uuid.uuid4())
    try:
        with urllib.request.urlopen(
                MODEL_URL, context=ssl.create_default_context(cafile=certifi.where()),
                timeout=60) as response, temporary.open('wb') as output:
            try:
                total = int(response.headers.get('Content-Length', 0))
            except (TypeError, ValueError):
                total = 0
            started = time.monotonic()
            downloaded = 0
            emit('progress', stage='live-model-download', message='正在下载本地实时语音模型',
                 transferId=transfer, filename=archive.name, downloaded=0, total=total, speed=0)
            while True:
                block = response.read(1024 * 512)
                if not block:
                    break
                output.write(block)
                downloaded += len(block)
                elapsed = max(time.monotonic() - started, 0.001)
                speed = downloaded / elapsed
                emit('progress', stage='live-model-download', message='正在下载本地实时语音模型',
                     transferId=transfer, filename=archive.name, downloaded=downloaded,
                     total=total, speed=speed,
                     eta=(total - downloaded) / speed if total and speed else None)
        if total and downloaded != total:
            raise RuntimeError('实时语音模型下载不完整')
        temporary.replace(archive)
    except Exception as error:
        temporary.unlink(missing_ok=True)
        raise RuntimeError(f'实时语音模型下载失败：{error}') from error

    extracted = set()
    try:
        with tarfile.open(archive, 'r:bz2') as data:
            for member in data.getmembers():
                basename = Path(member.name).name
                if basename not in targets or not member.isfile():
                    continue
                source = data.extractfile(member)
                if source is None:
                    continue
                temp_target = targets[basename].with_suffix(targets[basename].suffix + '.part')
                with source, temp_target.open('wb') as output:
                    shutil.copyfileobj(source, output)
                if temp_target.stat().st_size <= 1000:
                    temp_target.unlink(missing_ok=True)
                    raise RuntimeError(f'实时语音模型文件无效：{basename}')
                temp_target.replace(targets[basename])
                extracted.add(basename)
        if extracted != set(MODEL_FILES):
            raise RuntimeError('实时语音模型压缩包缺少必要文件')
    finally:
        archive.unlink(missing_ok=True)
    return targets


def download_file(url, target, stage, message):
    target = Path(target)
    if target.is_file() and target.stat().st_size > 10000:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + '.part')
    transfer = str(uuid.uuid4())
    try:
        with urllib.request.urlopen(
                url, context=ssl.create_default_context(cafile=certifi.where()),
                timeout=60) as response, temporary.open('wb') as output:
            try:
                total = int(response.headers.get('Content-Length', 0))
            except (TypeError, ValueError):
                total = 0
            started = time.monotonic()
            downloaded = 0
            emit('progress', stage=stage, message=message, transferId=transfer,
                 filename=target.name, downloaded=0, total=total, speed=0)
            while True:
                block = response.read(512 * 1024)
                if not block:
                    break
                output.write(block)
                downloaded += len(block)
                speed = downloaded / max(time.monotonic() - started, 0.001)
                emit('progress', stage=stage, message=message, transferId=transfer,
                     filename=target.name, downloaded=downloaded, total=total,
                     speed=speed, eta=(total - downloaded) / speed if total and speed else None)
        if total and downloaded != total:
            raise RuntimeError('下载文件长度不匹配')
        temporary.replace(target)
        return target
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def prepare_punctuation(folder):
    folder = Path(folder) / 'punctuation'
    target = folder / PUNCT_MODEL
    if target.is_file() and target.stat().st_size > 1000000:
        return target
    archive = download_file(PUNCT_URL, folder / 'punctuation.tar.bz2',
                            'punctuation-download', '正在下载中文标点模型')
    try:
        with tarfile.open(archive, 'r:bz2') as data:
            member = next((item for item in data.getmembers()
                           if Path(item.name).name == PUNCT_MODEL and item.isfile()), None)
            if member is None:
                raise RuntimeError('标点模型压缩包缺少模型文件')
            source = data.extractfile(member)
            if source is None:
                raise RuntimeError('无法读取标点模型')
            temporary = target.with_suffix(target.suffix + '.part')
            with source, temporary.open('wb') as output:
                shutil.copyfileobj(source, output)
            if temporary.stat().st_size <= 1000000:
                temporary.unlink(missing_ok=True)
                raise RuntimeError('标点模型文件无效')
            temporary.replace(target)
    finally:
        archive.unlink(missing_ok=True)
    return target


def match_speaker(samples, extractor, speakers, max_speakers):
    if extractor is None or len(samples) < 16000:
        return None
    stream = extractor.create_stream()
    stream.accept_waveform(16000, samples)
    stream.input_finished()
    if not extractor.is_ready(stream):
        return None
    embedding = np.asarray(extractor.compute(stream), dtype=np.float32)
    norm = float(np.linalg.norm(embedding))
    if not math.isfinite(norm) or norm <= 1e-8:
        return None
    embedding /= norm
    best_name, best_score = None, -1.0
    for name, centroid in speakers.items():
        score = float(np.dot(embedding, centroid))
        if score > best_score:
            best_name, best_score = name, score
    if best_name is None or (best_score < 0.55 and (max_speakers <= 0 or len(speakers) < max_speakers)):
        best_name = f'speaker_{len(speakers) + 1}'
        speakers[best_name] = embedding
    else:
        updated = speakers[best_name] * 0.8 + embedding * 0.2
        updated_norm = float(np.linalg.norm(updated))
        if updated_norm > 1e-8:
            speakers[best_name] = updated / updated_norm
    return best_name


def run():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-dir', required=True)
    parser.add_argument('--speaker-model-dir', required=True)
    parser.add_argument('--speaker-device', choices=('cpu', 'cuda'), default='cpu')
    parser.add_argument('--speakers', type=int, default=-1)
    args = parser.parse_args()
    try:
        files = prepare_model(args.model_dir)
        recognizer = sherpa_onnx.OnlineRecognizer.from_paraformer(
            tokens=str(files['tokens.txt']), encoder=str(files['encoder.int8.onnx']),
            decoder=str(files['decoder.int8.onnx']), num_threads=max(1, min(4, os.cpu_count() or 2)),
            enable_endpoint_detection=True, provider='cpu')
        stream = recognizer.create_stream()
        converter = OpenCC('t2s')
        auxiliary = {'punctuator': None}
        speaker_jobs = queue.Queue()
        speaker_centroids = {}

        def load_punctuation():
            try:
                punctuation_path = prepare_punctuation(args.model_dir)
                punct_config = sherpa_onnx.OfflinePunctuationConfig(
                    model=sherpa_onnx.OfflinePunctuationModelConfig(
                        ct_transformer=str(punctuation_path), num_threads=1))
                auxiliary['punctuator'] = sherpa_onnx.OfflinePunctuation(punct_config)
            except Exception as error:
                emit('live-error', message=f'标点模型不可用，将使用基础标点：{error}')

        def process_speakers():
            extractor = None
            covered_until = 0.0
            try:
                bundled = Path(__file__).parent / 'models' / 'embedding.onnx'
                embedding_path = (bundled if bundled.is_file() and bundled.stat().st_size > 1000000
                                  else download_file(
                                      SPEAKER_URL,
                                      Path(args.speaker_model_dir) / '3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx',
                                      'speakers-download', '正在准备实时声纹模型'))
                embedding_config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                    model=str(embedding_path), num_threads=max(1, min(2, os.cpu_count() or 1)),
                    provider=args.speaker_device)
                if not embedding_config.validate():
                    raise RuntimeError(f'实时声纹模型配置无效：{embedding_config}')
                extractor = sherpa_onnx.SpeakerEmbeddingExtractor(embedding_config)
                emit('live-speaker-ready')
            except Exception as error:
                emit('live-error', message=f'实时声纹未能启动：{error}')
            emit('live-aux-ready')

            while True:
                job = speaker_jobs.get()
                if job['kind'] == 'shutdown':
                    return
                if job['kind'] == 'flush':
                    emit('live-speaker-flushed', requestId=job['requestId'], success=extractor is not None)
                    continue
                if extractor is None:
                    continue
                try:
                    speaker = match_speaker(job['samples'], extractor, speaker_centroids, args.speakers)
                    if speaker:
                        start = max(covered_until, job.get('utteranceStart', job['start']))
                        if job['end'] > start + 0.05:
                            emit('live-speaker-turn', speaker=speaker, start=start, end=job['end'])
                            covered_until = job['end']
                        if job['kind'] == 'preview':
                            emit('live-speaker-preview', speaker=speaker,
                                 start=job['start'], end=job['end'])
                except Exception as error:
                    emit('live-error', message=f'实时声纹匹配失败：{error}')

        threading.Thread(target=load_punctuation, daemon=True).start()
        threading.Thread(target=process_speakers, daemon=True).start()
        last_text = ''
        audio_seconds = 0.0
        utterance_start = 0.0
        utterance_audio = []
        last_preview_at = 0.0

        def publish_result(final=False):
            nonlocal last_text, utterance_audio
            result = recognizer.get_result(stream)
            raw_text = result if isinstance(result, str) else getattr(result, 'text', '')
            text = converter.convert(raw_text or '').strip()
            if not text or (text == last_text and not final):
                return
            punctuator = auxiliary['punctuator']
            try:
                shown = punctuator.add_punctuation(text).strip() if punctuator else text
                shown = shown or text
            except Exception as error:
                auxiliary['punctuator'] = None
                shown = text
                emit('live-error', message=f'实时标点失败，已切换基础标点：{error}')
            if not final:
                shown = shown.rstrip('，。！？；：,.!?;:') + '，'
            elif not punctuator and shown[-1] not in '，。！？；：,.!?;:':
                shown += '。'
            emit('live-hypothesis', text=shown, final=final, speaker=None,
                 start=utterance_start, end=audio_seconds)
            last_text = text
            if final:
                samples = np.concatenate(utterance_audio) if utterance_audio else np.empty(0, dtype=np.float32)
                speaker_jobs.put({'kind': 'final', 'samples': samples[-48000:] if audio_seconds - utterance_start > 3 else samples,
                                  'start': utterance_start, 'end': audio_seconds})
                utterance_audio = []

        emit('live-ready')
        for line in sys.stdin:
            try:
                request = json.loads(line)
                if request.get('command') == 'shutdown':
                    speaker_jobs.put({'kind': 'shutdown'})
                    break
                if request.get('command') == 'flush':
                    try:
                        stream.input_finished()
                        while recognizer.is_ready(stream):
                            recognizer.decode_stream(stream)
                        publish_result(final=True)
                    except Exception as error:
                        emit('live-error', message=f'末尾实时转写收尾失败：{error}')
                    speaker_jobs.put({'kind': 'flush', 'requestId': request.get('requestId')})
                    continue
                if request.get('command') != 'audio':
                    continue
                pcm = base64.b64decode(request.get('pcm', ''), validate=True)
                if len(pcm) % 2:
                    continue
                samples = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
                if not samples.size:
                    continue
                stream.accept_waveform(16000, samples)
                utterance_audio.append(samples)
                audio_seconds += len(samples) / 16000.0
                while recognizer.is_ready(stream):
                    recognizer.decode_stream(stream)
                endpoint = recognizer.is_endpoint(stream)
                publish_result(final=bool(endpoint))
                if not endpoint and audio_seconds - utterance_start >= 2.0 and audio_seconds - last_preview_at >= 1.5 and speaker_jobs.qsize() < 3:
                    recent = np.concatenate(utterance_audio)[-48000:]
                    if len(recent) >= 32000 and float(np.sqrt(np.mean(recent ** 2))) >= 0.008:
                        speaker_jobs.put({'kind': 'preview', 'samples': recent,
                                          'start': audio_seconds - len(recent) / 16000,
                                          'utteranceStart': utterance_start, 'end': audio_seconds})
                        last_preview_at = audio_seconds
                if endpoint:
                    recognizer.reset(stream)
                    last_text = ''
                    utterance_start = audio_seconds
                    utterance_audio = []
                    last_preview_at = audio_seconds
            except Exception as error:
                emit('live-error', message=f'实时识别片段失败：{error}')
    except Exception as error:
        emit('live-error', fatal=True, message=str(error))


if __name__ == '__main__':
    run()
