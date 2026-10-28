"""Atomic, checksum-verified Whisper checkpoint downloads with JSON progress."""
import hashlib
import os
from pathlib import Path
import time
import urllib.request
import uuid


def _emit(emit, stage, message, transfer_id, filename, downloaded, total,
          started=None, verify=False):
    data = dict(stage=stage, message=message, transferId=transfer_id,
                filename=filename, downloaded=downloaded, total=total)
    if verify:
        data.update(speed=None, eta=None)
    else:
        elapsed = max(time.monotonic() - started, 0.001) if started else 0.001
        speed = downloaded / elapsed if downloaded else 0
        data.update(speed=speed, eta=(total - downloaded) / speed if total and speed else None)
        if not total:
            data['indeterminate'] = True
    emit('progress', **data)


def _hash_file(path, emit, transfer_id, filename):
    size = path.stat().st_size
    digest = hashlib.sha256()
    done = 0
    started = time.monotonic()
    last_emit = 0
    _emit(emit, 'model-verify', '正在校验本地语音模型', transfer_id, filename, 0, size, verify=True)
    with path.open('rb') as source:
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            done += len(chunk)
            if time.monotonic() - last_emit >= 0.5:
                _emit(emit, 'model-verify', '正在校验本地语音模型', transfer_id, filename, done, size, verify=True)
                last_emit = time.monotonic()
    _emit(emit, 'model-verify', '本地语音模型校验完成', transfer_id, filename, done, size, verify=True)
    return digest.hexdigest()


def prepare_model_download(model, url, target, emit, opener=urllib.request.urlopen):
    """Ensure one official model is present, returning its path.

    The SHA256 is the digest in OpenAI Whisper's official model URL. New bytes
    are hashed as they arrive and committed with os.replace only after both the
    HTTP length (when provided) and checksum pass. A killed process can leave a
    .part file, which is ignored and truncated on retry; an existing checkpoint
    is never modified until the replacement is fully verified.
    """
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    expected = url.rstrip('/').split('/')[-2]
    if len(expected) != 64:
        raise RuntimeError('Whisper 模型地址缺少官方 SHA256 校验值')
    filename = target.name
    verify_id = str(uuid.uuid4())
    if target.is_file() and _hash_file(target, emit, verify_id, filename) == expected:
        return target

    last_error = None
    for attempt in range(3):
        # A retry is a new transfer so the UI never combines its rate/ETA
        # with the previous attempt. Unique siblings also isolate concurrent
        # app instances; interrupted parts are harmless on retry.
        transfer_id = str(uuid.uuid4())
        temporary = target.with_name(target.name + f'.{transfer_id}.part')
        digest = hashlib.sha256()
        done = 0
        try:
            with opener(url, timeout=60) as response:
                try:
                    total = int(response.headers.get('Content-Length', 0))
                except (TypeError, ValueError):
                    total = 0
                started = time.monotonic()
                _emit(emit, 'model-download', '正在下载 Whisper 语音模型', transfer_id,
                      filename, 0, total, started)
                last_emit = 0
                with temporary.open('wb') as output:
                    while True:
                        chunk = response.read(1024 * 1024)
                        if not chunk:
                            break
                        output.write(chunk)
                        digest.update(chunk)
                        done += len(chunk)
                        if time.monotonic() - last_emit >= 0.5:
                            _emit(emit, 'model-download', '正在下载 Whisper 语音模型',
                                  transfer_id, filename, done, total, started)
                            last_emit = time.monotonic()
                    output.flush()
                    os.fsync(output.fileno())
            _emit(emit, 'model-download', 'Whisper 语音模型下载完成', transfer_id,
                  filename, done, total, started)
            if total and done != total:
                raise RuntimeError('Whisper 模型下载未完成，请检查网络后重试。')
            if digest.hexdigest() != expected:
                raise RuntimeError('Whisper 模型 SHA256 校验失败，请检查网络后重试。')
            _emit(emit, 'model-verify', 'Whisper 语音模型校验完成', str(uuid.uuid4()),
                  filename, done, done, verify=True)
            os.replace(temporary, target)
            return target
        except Exception as error:
            last_error = error
            temporary.unlink(missing_ok=True)
            if attempt < 2:
                time.sleep(1)
    raise last_error
