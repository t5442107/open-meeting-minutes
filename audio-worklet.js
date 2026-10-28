class MeetingRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = []; this.accumulator = 0; this.sum = 0; this.count = 0;
    this.port.onmessage = (event) => {
      if (event.data === 'flush') { this.flush(); this.port.postMessage({ type: 'flushed' }); }
    };
  }
  flush() {
    if (!this.samples.length) return;
    const pcm = new Int16Array(this.samples);
    let squareSum = 0;
    const barCount = 35;
    const barLevels = new Array(barCount);
    for (let bar = 0; bar < barCount; bar++) {
      const start = Math.floor(bar * pcm.length / barCount);
      const end = Math.max(start + 1, Math.floor((bar + 1) * pcm.length / barCount));
      let barSquareSum = 0;
      for (let i = start; i < Math.min(end, pcm.length); i++) {
        const sample = pcm[i] / 32768;
        const square = sample * sample;
        squareSum += square;
        barSquareSum += square;
      }
      barLevels[bar] = Math.sqrt(barSquareSum / Math.max(1, Math.min(end, pcm.length) - start));
    }
    const level = pcm.length ? Math.sqrt(squareSum / pcm.length) : 0;
    this.samples = [];
    this.port.postMessage({ type: 'audio', pcm: pcm.buffer, level, barLevels }, [pcm.buffer]);
  }
  process(inputs) {
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i] / channels.length;
      this.sum += value; this.count++; this.accumulator += 16000;
      if (this.accumulator >= sampleRate) {
        const sample = Math.max(-1, Math.min(1, this.sum / this.count));
        this.samples.push(Math.round(sample * (sample < 0 ? 32768 : 32767)));
        this.sum = 0; this.count = 0; this.accumulator -= sampleRate;
      }
      // Keep each live-ASR audio frame close to the 40 ms cadence used by
      // streaming recognizers instead of buffering a quarter second first.
      if (this.samples.length >= 640) this.flush();
    }
    return true;
  }
}
registerProcessor('meeting-recorder', MeetingRecorder);
