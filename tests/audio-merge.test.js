'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { mergeAudioFiles } = require('../lib/audio-merge');

function findExecutable(name) {
  const candidates = [process.env.FFMPEG_PATH, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`, name].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['-version'], { windowsHide: true, encoding: 'utf8' });
    if (result.status === 0) return path.isAbsolute(candidate) ? candidate : candidate;
  }
  return null;
}

function runFfmpeg(ffmpeg, args) {
  const result = spawnSync(ffmpeg, args, { windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, `ffmpeg failed: ${result.stderr}`);
}

function estimateFrequency(samples, start, seconds) {
  const begin = Math.floor(start * 16000);
  const end = Math.min(samples.length, begin + Math.floor(seconds * 16000));
  let crossings = 0;
  for (let index = begin + 1; index < end; index += 1) {
    if (samples[index - 1] <= 0 && samples[index] > 0) crossings += 1;
  }
  return crossings / ((end - begin) / 16000);
}

async function makeFixture() {
  const ffmpeg = findExecutable('ffmpeg');
  const ffprobe = findExecutable('ffprobe');
  if (!ffmpeg) return null;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-merge-测试-'));
  const inputDir = path.join(root, "输入 '音频'\nsource");
  const meetingDir = path.join(root, '会议 输出');
  await fs.mkdir(inputDir);
  await fs.mkdir(meetingDir);
  const first = path.join(inputDir, "第一段 '四百四十赫兹'.wav");
  const second = path.join(inputDir, '第二段 880赫兹.mp3');
  runFfmpeg(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.65', '-ar', '44100', '-ac', '2', first]);
  runFfmpeg(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.65', '-ar', '22050', '-ac', '1', '-codec:a', 'libmp3lame', second]);
  return { ffmpeg, ffprobe, root, first, second, meetingDir };
}

test('merges formats and sample rates in input order into normalized PCM WAV', { timeout: 30000 }, async t => {
  const fixture = await makeFixture();
  if (!fixture) return t.skip('本机没有 FFmpeg，跳过音频合并集成测试');
  try {
    const progress = [];
    const result = await mergeAudioFiles({
      inputPaths: [fixture.first, fixture.second], ffmpegPath: fixture.ffmpeg,
      outputDir: fixture.meetingDir, onProgress: event => progress.push(event),
    });
    assert.equal(result.path, path.join(fixture.meetingDir, 'original.wav'));
    assert.deepEqual(result.sources, [fixture.first, fixture.second]);
    assert.ok(result.duration > 1.2 && result.duration < 1.5, `unexpected duration: ${result.duration}`);
    const wav = await fs.readFile(result.path);
    assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
    assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
    assert.equal(wav.readUInt32LE(24), 16000);
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt16LE(34), 16);
    const samples = new Int16Array(wav.buffer, wav.byteOffset + 44, (wav.length - 44) / 2);
    assert.ok(Math.abs(estimateFrequency(samples, 0.1, 0.35) - 440) < 10, 'first source should remain first');
    assert.ok(Math.abs(estimateFrequency(samples, 0.8, 0.35) - 880) < 20, 'second source should remain second');
    assert.ok(progress.some(event => event.stage === 'merge-audio' && event.totalFiles === 2));
    assert.equal(progress.at(-1).processedFiles, 2);
    assert.equal(await fs.readFile(fixture.first).then(() => true), true);
    assert.equal(await fs.readFile(fixture.second).then(() => true), true);
    assert.deepEqual((await fs.readdir(fixture.meetingDir)).sort(), ['original.wav']);
  } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
});

test('cancel and failed conversions clean only their private temp directory', { timeout: 30000 }, async t => {
  const fixture = await makeFixture();
  if (!fixture) return t.skip('本机没有 FFmpeg，跳过音频合并集成测试');
  try {
    const keep = path.join(fixture.meetingDir, 'keep.txt');
    await fs.writeFile(keep, 'leave me');

    const controller = new AbortController();
    let requestedCancel = false;
    await assert.rejects(mergeAudioFiles({
      inputPaths: [fixture.first, fixture.second], ffmpegPath: fixture.ffmpeg,
      outputDir: fixture.meetingDir,
      onProgress: event => {
        if (!requestedCancel && event.processedFiles === 0 && event.processedSeconds > 0) {
          requestedCancel = true;
          controller.abort();
        }
      },
      signal: controller.signal,
    }), error => error.name === 'AbortError');
    assert.ok(requestedCancel, 'cancellation should happen while FFmpeg reports progress');
    assert.deepEqual((await fs.readdir(fixture.meetingDir)).sort(), ['keep.txt']);

    const joiningController = new AbortController();
    let cancelledDuringJoin = false;
    await assert.rejects(mergeAudioFiles({
      inputPaths: [fixture.first, fixture.second], ffmpegPath: fixture.ffmpeg,
      outputDir: fixture.meetingDir,
      onProgress: event => {
        if (!cancelledDuringJoin && event.phase === 'joining' && event.processedBytes > 0) {
          cancelledDuringJoin = true;
          joiningController.abort();
        }
      },
      signal: joiningController.signal,
    }), error => error.name === 'AbortError');
    assert.ok(cancelledDuringJoin, 'cancellation should interrupt PCM joining');
    assert.deepEqual((await fs.readdir(fixture.meetingDir)).sort(), ['keep.txt']);

    const bad = path.join(fixture.root, '坏的输入.wav');
    await fs.writeFile(bad, 'not audio');
    await assert.rejects(mergeAudioFiles({ inputPaths: [bad], ffmpegPath: fixture.ffmpeg, outputDir: fixture.meetingDir }), /FFmpeg 执行失败/);
    assert.deepEqual((await fs.readdir(fixture.meetingDir)).sort(), ['keep.txt']);
    assert.equal(await fs.readFile(keep, 'utf8'), 'leave me');
  } finally { await fs.rm(fixture.root, { recursive: true, force: true }); }
});

test('rejects empty, directory, and over-limit input without creating artifacts', async () => {
  const ffmpeg = findExecutable('ffmpeg');
  if (!ffmpeg) return;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-merge-validate-'));
  const meetingDir = path.join(root, 'meeting');
  await fs.mkdir(meetingDir);
  try {
    await assert.rejects(mergeAudioFiles({ inputPaths: [], ffmpegPath: ffmpeg, outputDir: meetingDir }), /至少选择/);
    await assert.rejects(mergeAudioFiles({ inputPaths: Array(51).fill(path.join(root, 'missing.wav')), ffmpegPath: ffmpeg, outputDir: meetingDir }), /最多合并 50/);
    await assert.rejects(mergeAudioFiles({ inputPaths: [root], ffmpegPath: ffmpeg, outputDir: meetingDir }), /不是普通文件/);
    assert.deepEqual(await fs.readdir(meetingDir), []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
