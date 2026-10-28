// Optional integration test. Uses an existing WAV as a synthetic microphone, never hardware input.
const { app, BrowserWindow, systemPreferences } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const input = process.env.HUIYI_TEST_AUDIO;
if (!input) { console.error('Set HUIYI_TEST_AUDIO to a 12-second speech WAV for this integration test.'); app.exit(1); }
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyi-recording-'));
app.setPath('userData', root);
systemPreferences.askForMediaAccess = async () => true;
app.on('browser-window-created', (_event, window) => {
  window.hide(); window.webContents.on('console-message', (_event, level, message) => { if (level >= 3) console.error('RENDERER:', message); });
});
require('../main');
async function run() {
  await app.whenReady();
  let window;
  for (let i = 0; i < 100; i++) { window = BrowserWindow.getAllWindows()[0]; if (window) break; await new Promise(r => setTimeout(r, 50)); }
  if (window.webContents.isLoading()) await new Promise(r => window.webContents.once('did-finish-load', r));
  const base64 = fs.readFileSync(input).toString('base64');
  const result = await window.webContents.executeJavaScript(`(async () => { try {
    const audioContext = new AudioContext({sampleRate:16000});
    const destination = audioContext.createMediaStreamDestination();
    const source = audioContext.createBufferSource();
    const bytes = Uint8Array.from(atob('${base64}'), c=>c.charCodeAt(0));
    source.buffer = await audioContext.decodeAudioData(bytes.buffer);
    source.connect(destination);
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => destination.stream });
    document.getElementById('meetingTitle').value = '合成输入录音验证';
    document.getElementById('speakers').value = '2';
    await startRecording();
    if (!ui.recording) throw new Error(document.getElementById('toast').innerText);
    await audioContext.resume(); source.start();
    await new Promise(r => setTimeout(r, 13500));
    const hadLiveText = document.getElementById('liveTranscript').innerText;
    await stopRecording(); await audioContext.close();
    return { id: ui.meeting.id, status: ui.meeting.status, duration: ui.meeting.duration, segments: ui.meeting.segments.length, diarized: ui.meeting.diarized, warning: ui.meeting.warning, liveText: hadLiveText, audioPath: ui.meeting.audioPath };
  } catch(error) { return {failure:error.message,stack:error.stack}; } })()`);
  if (result.failure) throw new Error(result.failure);
  assert.equal(result.status, 'completed'); assert.ok(result.duration >= 12 && result.duration < 16); assert.ok(result.segments > 0);
  const wav = fs.readFileSync(result.audioPath); assert.equal(wav.readUInt32LE(40), wav.length - 44);
  assert.equal(result.diarized, true); assert.equal(result.warning, '');
  console.log('PASS: synthetic microphone → AudioWorklet PCM → IPC → saved WAV → Whisper → speaker diarization → persisted meeting', JSON.stringify({duration:result.duration,segments:result.segments,diarized:result.diarized}));
}
run().then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
app.on('will-quit', () => { fs.rmSync(root, { recursive: true, force: true }); });
