'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_INPUT_FILES = 50;
const SAMPLE_RATE = 16000;
const CHANNELS = 1;
const BITS_PER_SAMPLE = 16;
const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * BITS_PER_SAMPLE / 8;

function abortError() {
  const error = new Error('音频合并已取消');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError();
}

function parseClock(value) {
  const match = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(value || '');
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(`0.${match[4] || '0'}`);
}

function ffprobePath(ffmpegPath) {
  const executable = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  return path.join(path.dirname(ffmpegPath), executable);
}

function runChild(command, args, { signal, onProgress, collectStdout = false } = {}) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) { reject(error); return; }

    let stderr = '';
    let stdout = '';
    let lineBuffer = '';
    let settled = false;
    const onAbort = () => { try { child.kill(); } catch {} };
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (collectStdout) stdout += chunk;
      if (!onProgress) return;
      lineBuffer += chunk;
      const lines = lineBuffer.split(/\r?\n/);
      lineBuffer = lines.pop() || '';
      for (const line of lines) {
        const separator = line.indexOf('=');
        if (separator < 1) continue;
        const key = line.slice(0, separator);
        const value = line.slice(separator + 1);
        if (key === 'out_time_us') {
          const microseconds = Number(value);
          if (Number.isFinite(microseconds) && microseconds >= 0) onProgress(microseconds / 1e6);
        } else if (key === 'out_time') {
          const seconds = parseClock(value);
          if (seconds != null) onProgress(seconds);
        }
      }
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16000); });
    child.once('error', error => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      reject(error);
    });
    child.once('close', (code, signalName) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(abortError());
      if (code !== 0) return reject(new Error(`FFmpeg 执行失败${stderr.trim() ? `：${stderr.trim()}` : `（退出码 ${code ?? signalName}）`}`));
      resolve({ stdout, stderr });
    });
    if (signal?.aborted) onAbort();
  });
}

async function probeDuration(probePath, inputPath, signal) {
  try {
    const { stdout } = await runChild(probePath, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', inputPath,
    ], { signal, collectStdout: true });
    const duration = Number(stdout.trim());
    return Number.isFinite(duration) && duration >= 0 ? duration : null;
  } catch (error) {
    if (error.name === 'AbortError') throw error;
    return null;
  }
}

async function readPcmDataOffset(filePath) {
  const handle = await fs.open(filePath, 'r');
  try {
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, 12, 0);
    if (bytesRead !== 12 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('FFmpeg 输出了无效的 WAV 文件');
    }
    let offset = 12;
    const chunkHeader = Buffer.alloc(8);
    const stat = await handle.stat();
    while (offset + 8 <= stat.size) {
      const read = await handle.read(chunkHeader, 0, 8, offset);
      if (read.bytesRead !== 8) break;
      const id = chunkHeader.toString('ascii', 0, 4);
      const size = chunkHeader.readUInt32LE(4);
      if (id === 'data') return { offset: offset + 8, size };
      offset += 8 + size + (size & 1);
    }
    throw new Error('WAV 文件中缺少 PCM 音频数据');
  } finally {
    await handle.close();
  }
}

function pcmWavHeader(dataBytes) {
  if (dataBytes > 0xffffffff - 36) throw new Error('合并后的音频超过 WAV 格式大小上限');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(BYTES_PER_SECOND, 28);
  header.writeUInt16LE(CHANNELS * BITS_PER_SAMPLE / 8, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

async function writeAll(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, position + offset);
    if (!bytesWritten) throw new Error('写入合并音频时未能继续写入');
    offset += bytesWritten;
  }
}

async function joinWavs(wavPaths, outputPath, { signal, onProgress, sourcePaths = [] } = {}) {
  const chunks = [];
  let totalBytes = 0;
  for (const wavPath of wavPaths) {
    const info = await readPcmDataOffset(wavPath);
    chunks.push({ wavPath, ...info });
    totalBytes += info.size;
    if (totalBytes > 0xffffffff - 36) throw new Error('合并后的音频超过 WAV 格式大小上限');
  }

  const out = await fs.open(outputPath, 'wx');
  try {
    await writeAll(out, pcmWavHeader(totalBytes), 0);
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let writtenBytes = 0;
    let joinedFiles = 0;
    let currentFile = null;
    const reportJoin = () => {
      try {
        onProgress?.({ stage: 'merge-audio', phase: 'joining', message: '正在拼接音频',
          processedFiles: joinedFiles, totalFiles: wavPaths.length, currentFile,
          processedBytes: writtenBytes, totalBytes,
          processedSeconds: writtenBytes / BYTES_PER_SECOND, totalSeconds: totalBytes / BYTES_PER_SECOND });
      } catch {}
    };
    reportJoin();
    throwIfAborted(signal);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      throwIfAborted(signal);
      currentFile = sourcePaths[index] || null;
      const input = await fs.open(chunk.wavPath, 'r');
      try {
        let position = chunk.offset;
        let remaining = chunk.size;
        while (remaining > 0) {
          throwIfAborted(signal);
          const length = Math.min(buffer.length, remaining);
          const { bytesRead } = await input.read(buffer, 0, length, position);
          if (!bytesRead) throw new Error('WAV 音频数据意外结束');
          await writeAll(out, buffer.subarray(0, bytesRead), 44 + writtenBytes);
          position += bytesRead;
          remaining -= bytesRead;
          writtenBytes += bytesRead;
          reportJoin();
          throwIfAborted(signal);
        }
      } finally { await input.close(); }
      joinedFiles = index + 1;
      reportJoin();
    }
    await out.sync();
  } finally { await out.close(); }
  return totalBytes;
}

/**
 * Convert ordered audio sources to a common PCM format and join them safely.
 * @param {{inputPaths: string[], ffmpegPath: string, outputDir: string, outputFilename?: string, onProgress?: (progress: object) => void, signal?: AbortSignal, maxFiles?: number}} options
 * @returns {Promise<{path: string, duration: number, sources: string[]}>}
 */
async function mergeAudioFiles({ inputPaths, ffmpegPath: ffmpeg, outputDir, outputFilename = 'original.wav', onProgress, signal, maxFiles = MAX_INPUT_FILES } = {}) {
  if (!Array.isArray(inputPaths) || inputPaths.length === 0) throw new Error('请至少选择一个音频文件');
  if (inputPaths.length > maxFiles) throw new Error(`一次最多合并 ${maxFiles} 个音频文件`);
  if (!path.isAbsolute(ffmpeg || '')) throw new Error('FFmpeg 路径必须是绝对路径');
  if (!path.isAbsolute(outputDir || '')) throw new Error('会议目录必须是绝对路径');
  if (typeof outputFilename !== 'string' || !outputFilename || path.basename(outputFilename) !== outputFilename || /[\\/]/.test(outputFilename)) {
    throw new Error('输出文件名无效');
  }

  const sources = inputPaths.slice();
  for (const source of sources) {
    if (typeof source !== 'string' || !path.isAbsolute(source)) throw new Error('音频文件路径必须是绝对路径');
    const stat = await fs.stat(source).catch(() => null);
    if (!stat) throw new Error(`找不到音频文件：${source}`);
    if (!stat.isFile()) throw new Error(`路径不是普通文件：${source}`);
  }
  throwIfAborted(signal);
  const outputDirectoryStat = await fs.stat(outputDir).catch(() => null);
  if (!outputDirectoryStat?.isDirectory()) throw new Error('会议目录不存在或不是目录');
  const finalPath = path.join(outputDir, outputFilename);
  if (sources.some(source => path.resolve(source) === path.resolve(finalPath))) throw new Error('输出文件不能覆盖输入音频');

  const tempDir = await fs.mkdtemp(path.join(outputDir, '.audio-merge-'));
  const wavPaths = [];
  const finalTemp = path.join(tempDir, 'final.wav');
  const probe = ffprobePath(ffmpeg);
  const hasProbe = await fs.access(probe).then(() => true, () => false);
  let durations = [];
  let totalSeconds;
  let completedSeconds = 0;
  const report = progress => { try { onProgress?.(progress); } catch {} };
  try {
    durations = hasProbe ? await Promise.all(sources.map(source => probeDuration(probe, source, signal))) : sources.map(() => null);
    if (durations.every(duration => duration != null)) totalSeconds = durations.reduce((sum, duration) => sum + duration, 0);
    report({ stage: 'merge-audio', phase: 'converting', message: '正在转换音频格式', processedFiles: 0, totalFiles: sources.length,
      ...(totalSeconds == null ? {} : { processedSeconds: 0, totalSeconds }) });

    for (let index = 0; index < sources.length; index += 1) {
      throwIfAborted(signal);
      const wavPath = path.join(tempDir, `part-${String(index).padStart(3, '0')}.wav`);
      wavPaths.push(wavPath);
      let currentSeconds = 0;
      const args = [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', sources[index],
        '-map', '0:a:0', '-vn', '-ac', String(CHANNELS), '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le',
        '-progress', 'pipe:1', '-nostats', '-f', 'wav', wavPath,
      ];
      await runChild(ffmpeg, args, {
        signal,
        onProgress: seconds => {
          currentSeconds = seconds;
          if (totalSeconds != null) {
            const currentLimit = durations[index];
            report({ stage: 'merge-audio', phase: 'converting', message: `正在转换第 ${index + 1}/${sources.length} 个音频`, processedFiles: index, totalFiles: sources.length,
              processedSeconds: Math.min(totalSeconds, completedSeconds + (currentLimit == null ? seconds : Math.min(seconds, currentLimit))), totalSeconds });
          }
        },
      });
      const wavStat = await fs.stat(wavPath);
      if (!wavStat.isFile() || wavStat.size <= 44) throw new Error(`无法从音频文件读取声音：${sources[index]}`);
      if (totalSeconds != null) completedSeconds += durations[index];
      report({ stage: 'merge-audio', phase: 'converting', message: `已转换 ${index + 1}/${sources.length} 个音频`, processedFiles: index + 1, totalFiles: sources.length,
        ...(totalSeconds == null ? {} : { processedSeconds: Math.min(totalSeconds, completedSeconds), totalSeconds }) });
    }

    throwIfAborted(signal);
    const dataBytes = await joinWavs(wavPaths, finalTemp, { signal, onProgress: report, sourcePaths: sources });
    throwIfAborted(signal);
    const duration = dataBytes / BYTES_PER_SECOND;
    // A same-directory hard link publishes the completed file atomically and refuses to
    // replace any existing meeting file on both Windows and macOS.
    try {
      await fs.link(finalTemp, finalPath);
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`目标文件已存在：${finalPath}`);
      throw error;
    }
    await fs.unlink(finalTemp);
    report({ stage: 'merge-audio', phase: 'complete', message: '音频合并完成', processedFiles: sources.length, totalFiles: sources.length,
      processedBytes: dataBytes, totalBytes: dataBytes, processedSeconds: duration, totalSeconds: duration });
    return { path: finalPath, duration, sources };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

module.exports = { mergeAudioFiles, MAX_INPUT_FILES };
