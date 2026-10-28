const fs = require('node:fs/promises');
const { createReadStream, createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');
const path = require('node:path');

// Eight-second windows make the first live result arrive sooner while keeping
// a one-second acoustic overlap for words that cross a chunk boundary.
const LIVE_CHUNK_BYTES = 8 * 32000;
const LIVE_OVERLAP_BYTES = 1 * 32000;

function wavHeader(size) {
  if (size > 0xffffffff - 36) throw new Error('录音达到 WAV 格式容量上限，请结束当前会议再新建录音。');
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(size + 36, 4); header.write('WAVE', 8); header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(size, 40); return header;
}

class Recording {
  constructor({ meeting, store, engine, language, onEvent, useLiveTranscript = false }) {
    Object.assign(this, { meeting, store, engine, language, onEvent, useLiveTranscript });
    this.bytes = 0; this.pending = Buffer.alloc(0); this.overlap = Buffer.alloc(0); this.processed = 0;
    this.tail = Promise.resolve(); this.accepting = true; this.index = 0; this.failure = null;
  }
  async open() {
    this.folder = this.store.meetingDir(this.meeting.id);
    this.raw = path.join(this.folder, 'recording.pcm'); this.wav = path.join(this.folder, 'recording.wav');
    await fs.mkdir(path.join(this.folder, 'chunks'), { recursive: true });
    this.handle = await fs.open(this.raw, 'w');
  }
  append(pcm) {
    if (!this.accepting) return;
    const buffer = Buffer.from(pcm);
    if (buffer.length % 2 || buffer.length > 128000) return;
    this.tail = this.tail.then(async () => {
      await this.handle.writeFile(buffer); this.bytes += buffer.length;
      if (!this.liveFailed) {
        try { this.engine.sendLive(buffer); }
        catch (error) { this.liveFailed = true; this.onEvent({ event: 'live-error', message: `实时识别暂不可用，录音仍会保存：${error.message}` }); }
      }
      if (!this.useLiveTranscript) {
        this.pending = Buffer.concat([this.pending, buffer]);
        while (this.pending.length >= LIVE_CHUNK_BYTES) {
          const chunk = this.pending.subarray(0, LIVE_CHUNK_BYTES);
          this.pending = this.pending.subarray(LIVE_CHUNK_BYTES);
          await this.flushChunk(chunk);
        }
      }
    }).catch(error => { this.failure = error; this.onEvent({ event: 'error', message: `录音写入失败：${error.message}` }); });
  }
  async flushChunk(chunk) {
    const audio = Buffer.concat([this.overlap, chunk]);
    const filename = path.join(this.folder, 'chunks', `${this.index++}.wav`);
    await fs.writeFile(filename, Buffer.concat([wavHeader(audio.length), audio]));
    try { this.engine.send({ command: 'chunk', path: filename, offset: (this.processed - this.overlap.length) / 32000, language: this.language }); }
    catch (error) { this.onEvent({ event: 'error', message: `实时转写已暂停，录音仍会保存：${error.message}` }); }
    this.overlap = Buffer.from(chunk.subarray(Math.max(0, chunk.length - LIVE_OVERLAP_BYTES)));
    this.processed += chunk.length;
  }
  async finish() {
    this.accepting = false; await this.tail;
    const speakerFlush = (typeof this.engine.finishLive === 'function'
      ? this.engine.finishLive()
      : Promise.resolve({ success: false })).catch(error => {
      this.onEvent({ event: 'live-error', message: `实时声纹收尾未完成：${error.message}` });
      return { success: false };
    });
    await this.handle.sync(); await this.handle.close();
    await fs.writeFile(this.wav, wavHeader(this.bytes));
    await pipeline(createReadStream(this.raw), createWriteStream(this.wav, { flags: 'a' }));
    const liveResult = await speakerFlush;
    // If live ASR failed, submit the final partial Whisper window so its cache
    // can still cover the recording. When live ASR worked, its flushed text is
    // authoritative for fast completion and this extra transcription is waste.
    if ((!this.useLiveTranscript || this.liveFailed) && this.pending.length) {
      const tail = this.pending;
      this.pending = Buffer.alloc(0);
      await this.flushChunk(tail);
    }
    if (this.failure) throw new Error(`已保存收到的录音，但写入过程中发生错误：${this.failure.message}`);
    return { path: this.wav, duration: this.bytes / 32000, liveSpeakerReady: !!liveResult.success,
      liveAudioSent: this.bytes > 0 && !this.liveFailed };
  }
}
module.exports = { Recording, wavHeader };
