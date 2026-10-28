const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');

class Engine extends EventEmitter {
  constructor({ appRoot, resources, userData, packaged }) {
    super(); Object.assign(this, { appRoot, resources, userData, packaged }); this.pending = new Map();
  }
  async start(model = 'large-v3-turbo', device = 'cpu', cudaVariant = 'cu126', speakerDevice = 'cpu', speakers = -1) {
    if (this.stopped) throw new Error('引擎准备已取消');
    if (this.child) throw new Error('本地语音引擎正在使用中');
    if (!['cpu', 'cuda'].includes(device)) throw new Error(`不支持的语音引擎设备：${device}`);
    if (!['cpu', 'cuda'].includes(speakerDevice)) throw new Error(`不支持的声纹区分设备：${speakerDevice}`);
    if (device === 'cuda' && !['cu126', 'cu128'].includes(cudaVariant)) throw new Error(`不支持的 CUDA 运行时：${cudaVariant}`);
    if ((device === 'cuda' || speakerDevice === 'cuda') && process.platform !== 'win32') throw new Error('NVIDIA GPU 语音引擎仅支持 Windows x64。');
    if ((device === 'cuda' || speakerDevice === 'cuda') && process.arch !== 'x64') throw new Error('NVIDIA GPU 语音引擎仅支持 Windows x64。');
    // The sherpa-onnx CUDA speaker wheel is hosted on Hugging Face and is not
    // available reliably in all regions. Do not make recording startup depend
    // on downloading it. Whisper can still use CUDA; use the standard CPU
    // sherpa package for speaker embeddings and diarization.
    const speakerGpuFallback = speakerDevice === 'cuda';
    if (speakerGpuFallback) {
      speakerDevice = 'cpu';
      this.emit('event', { event: 'progress', stage: 'speaker-runtime', message: 'NVIDIA 声纹组件需要额外联网下载，本次改用 CPU 区分发言人；Whisper 仍使用 NVIDIA GPU。' });
    }
    const platform = process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'win' : 'linux';
    const runtimeDir = this.packaged ? path.join(this.resources, 'runtime') : path.join(this.appRoot, 'runtime', `${platform}-${process.arch}`);
    const backend = this.packaged ? path.join(this.resources, 'backend') : path.join(this.appRoot, 'backend');
    let ffmpeg = path.join(runtimeDir, process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    try { await fs.access(ffmpeg); }
    catch {
      if (this.packaged) throw new Error('安装包缺少音频解码组件，请重新安装完整版本。');
      ffmpeg = ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg'].find(candidate => require('node:fs').existsSync(candidate));
      if (!ffmpeg) throw new Error('本地解码组件尚未准备，请先运行运行环境准备脚本。');
    }
    const modelDir = await fs.access(path.join(os.homedir(), '.cache', 'whisper', `${model}.pt`)).then(() => path.join(os.homedir(), '.cache', 'whisper')).catch(() => path.join(this.userData, 'models', 'whisper'));
    const args = ['--model', model, '--device', device, '--speaker-device', speakerDevice, '--model-dir', modelDir, '--diarization-dir', path.join(this.userData, 'models', 'speakers'), '--ffmpeg', ffmpeg];
    let command, parameters;
    const localPython = process.env.HUIYI_PYTHON || (!this.packaged ? path.join(this.appRoot, 'work', 'python', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') : null);
    if (localPython && await fs.access(localPython).then(() => true).catch(() => false)) {
      command = localPython; parameters = ['-u', path.join(backend, 'worker.py'), ...args];
    } else {
      command = path.join(runtimeDir, process.platform === 'win32' ? 'uv.exe' : 'uv');
      try { await fs.access(command); } catch { throw new Error('本地引擎组件尚未准备，请先运行运行环境准备脚本或安装完整安装包。'); }
      const gpuRuntime = device === 'cuda';
      const requirements = path.join(backend, gpuRuntime
        ? speakerDevice === 'cuda' ? `requirements-cuda${cudaVariant.slice(2)}-speakers-gpu.txt` : `requirements-cuda${cudaVariant.slice(2)}.txt`
        : 'requirements.txt');
      parameters = ['run', '--no-project', '--python', '3.11', '--verbose', '--color', 'never',
        ...(gpuRuntime ? [
          '--index-url', `https://download.pytorch.org/whl/${cudaVariant}`,
          '--extra-index-url', 'https://pypi.org/simple',
          '--index-strategy', 'unsafe-best-match',
        ] : []),
        '--with-requirements', requirements, path.join(backend, 'worker.py'), ...args];
    }
    const env = { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8', UV_SYSTEM_CERTS: 'true', UV_PYTHON_INSTALL_DIR: path.join(this.userData, 'runtime', 'python'), UV_CACHE_DIR: path.join(this.userData, 'runtime', 'cache'), PATH: [path.dirname(ffmpeg), '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH || ''].join(path.delimiter) };
    this.workerCommand = command; this.workerParameters = parameters; this.workerEnv = env;
    this.speakerDevice = speakerDevice; this.speakerCount = speakers;
    this.backend = backend;
    this.emit('event', { event: 'progress', stage: 'engine', message: '正在启动本地语音引擎；首次使用需要下载运行环境与模型' });
    const usingUv = path.basename(command).toLowerCase().startsWith('uv');
    if (usingUv) this.emit('event', { event: 'progress', stage: 'runtime', message: '正在准备 Python 运行时', indeterminate: true });
    if (this.stopped) throw new Error('引擎准备已取消');
    return new Promise((resolve, reject) => {
      let ready = false, logs = '', lastLog = 0, workerStarted = false;
      const child = spawn(command, parameters, { env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
      this.child = child;
      const timeout = setTimeout(() => { reject(new Error('引擎准备超时，请检查网络后重试。')); this.stop(); }, 30 * 60 * 1000);
      child.stdin.on('error', () => {});
      readline.createInterface({ input: child.stdout }).on('line', line => {
        let event;
        try { event = JSON.parse(line); } catch { return; }
        // Once the worker has emitted any valid protocol event, its own stage
        // and progress are authoritative. Stderr can still contain package
        // warnings that mention torch/whisper long after model loading began.
        workerStarted = true;
        if (event.event === 'ready') { ready = true; clearTimeout(timeout); resolve(event); }
        else if (event.event === 'fatal') { clearTimeout(timeout); reject(new Error(event.message)); }
        const pending = this.pending.get(event.requestId);
        if (pending && ['result', 'error'].includes(event.event)) {
          this.pending.delete(event.requestId);
          if (event.event === 'error') pending.reject(new Error(event.message)); else pending.resolve(event);
        }
        this.emit('event', event);
      });
      child.stderr.on('data', data => {
        const text = data.toString();
        logs = (logs + text).slice(-5000);
        const lines = text.split(/[\r\n]+/).filter(Boolean);
        const line = lines.slice(-1)[0] || '';
        const runtime = /python|cpython|installing python/i.test(line);
        const dependency = /resolv|download|installing|prepared|audios|torch|numpy|whisper|sherpa|opencc/i.test(line);
        if (!ready && !workerStarted && Date.now() - lastLog > 700 && (runtime || dependency)) {
          const stage = runtime ? 'runtime' : 'dependencies';
          const latestWork = [...lines].reverse().find(item => /(?:Downloading|Downloaded|Installing|Installed|Prepared|Resolved)\s+/i.test(item)) || line;
          const component = (latestWork.match(/(?:Downloading|Downloaded|Installing|Installed|Prepared|Resolved)\s+([^\s,;]+)/i) || [])[1];
          const size = latestWork.match(/\b\d+(?:\.\d+)?\s*(?:B|KB|MB|GB|KiB|MiB|GiB)\b/i)?.[0];
          this.emit('event', { event: 'progress', stage,
            message: runtime ? '正在准备 Python 运行时' : '正在准备语音识别依赖',
            detail: component ? `正在处理 ${component}${size ? `（${size}）` : ''}` : undefined, indeterminate: true });
          lastLog = Date.now();
        }
      });
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('close', code => {
        clearTimeout(timeout); if (this.child === child) this.child = null;
        const error = new Error(`本地语音引擎已退出（${code ?? '已停止'}）。${logs.slice(-1200)}`);
        if (!ready) reject(error);
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        this.emit('exit', { code, message: error.message });
      });
    });
  }
  send(command) {
    if (!this.child || this.child.killed) throw new Error('本地语音引擎尚未启动');
    this.child.stdin.write(`${JSON.stringify(command)}\n`);
  }
  async startLive() {
    if (this.liveChild) return;
    const workerIndex = this.workerParameters.indexOf(path.join(this.backend, 'worker.py'));
    if (workerIndex < 0) throw new Error('无法启动实时语音识别组件');
    const script = path.join(this.backend, 'live_worker.py');
    const bundledLiveModel = path.join(this.backend, 'models', 'live-asr');
    const hasBundledLiveModel = await Promise.all(['encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt']
      .map(name => fs.access(path.join(bundledLiveModel, name)).then(() => true).catch(() => false)))
      .then(files => files.every(Boolean));
    const parameters = [...this.workerParameters.slice(0, workerIndex), script,
      '--model-dir', hasBundledLiveModel ? bundledLiveModel : path.join(this.userData, 'models', 'live-asr'),
      '--speaker-model-dir', path.join(this.userData, 'models', 'live-speakers'),
      '--speaker-device', this.speakerDevice || 'cpu',
      '--speakers', String(Number.isInteger(this.speakerCount) ? this.speakerCount : -1)];
    const child = spawn(this.workerCommand, parameters, {
      env: this.workerEnv, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.liveChild = child;
    child.stdin.on('error', () => {});
    let logs = '';
    child.stderr.on('data', data => { logs = (logs + data.toString()).slice(-1200); });
    child.stdout.setEncoding('utf8');
    let pending = '';
    child.stdout.on('data', data => {
      pending += data;
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        try { this.emit('event', JSON.parse(line)); } catch {}
      }
    });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('实时语音引擎启动超时')), 30 * 60 * 1000);
      const onEvent = event => {
        if (event.event === 'live-ready') { clearTimeout(timeout); this.liveStarting = false; this.off('event', onEvent); resolve(event); }
        else if (event.event === 'live-error' && event.fatal) { clearTimeout(timeout); this.liveStarting = false; this.off('event', onEvent); reject(new Error(event.message)); }
      };
      this.on('event', onEvent);
      child.once('error', error => { clearTimeout(timeout); this.off('event', onEvent); reject(error); });
      child.once('close', code => {
        if (this.liveChild === child) this.liveChild = null;
        clearTimeout(timeout); this.off('event', onEvent);
        if (this.liveStarting) reject(new Error(`实时语音引擎已退出（${code ?? '已停止'}）。${logs}`));
        else if (code && code !== 0) this.emit('event', { event: 'live-error', message: `实时语音引擎已停止（${code}）` });
      });
      this.liveStarting = true;
    });
  }
  sendLive(pcm) {
    if (!this.liveChild || this.liveChild.killed || this.liveChild.stdin.destroyed) throw new Error('实时语音引擎尚未准备好');
    this.liveChild.stdin.write(`${JSON.stringify({command:'audio',pcm:Buffer.from(pcm).toString('base64')})}\n`);
  }
  finishLive() {
    if (!this.liveChild || this.liveChild.killed || this.liveChild.stdin.destroyed) return Promise.resolve({ success: false });
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const child = this.liveChild;
      const cleanup = () => { clearTimeout(timeout); this.off('event', onEvent); child.off('close', onClose); };
      const onEvent = event => {
        if (event.event !== 'live-speaker-flushed' || event.requestId !== requestId) return;
        cleanup(); resolve(event);
      };
      const onClose = () => { cleanup(); reject(new Error('实时声纹引擎提前退出')); };
      const timeout = setTimeout(() => { cleanup(); reject(new Error('等待实时声纹收尾超时')); }, 20000);
      this.on('event', onEvent);
      child.once('close', onClose);
      try { child.stdin.write(`${JSON.stringify({ command: 'flush', requestId })}\n`); }
      catch (error) { cleanup(); reject(error); }
    });
  }
  request(command) {
    return new Promise((resolve, reject) => {
      const requestId = randomUUID(); this.pending.set(requestId, { resolve, reject });
      try { this.send({ ...command, requestId }); } catch (error) { this.pending.delete(requestId); reject(error); }
    });
  }
  stop() {
    this.stopped = true;
    const child = this.child;
    const liveChild = this.liveChild;
    this.child = null; this.liveChild = null; this.liveStarting = false;
    for (const processChild of [child, liveChild]) {
      if (!processChild) continue;
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(processChild.pid), '/T', '/F'], { windowsHide: true });
      else { try { process.kill(-processChild.pid, 'SIGTERM'); } catch {} }
    }
  }
}
module.exports = { Engine };
