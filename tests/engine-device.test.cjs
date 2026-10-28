const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const childProcess = require('node:child_process');

test('Engine.start keeps CPU dependencies by default and forwards the device', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-device-'));
  const resources = path.join(root, 'resources');
  const runtime = path.join(resources, 'runtime');
  const backend = path.join(resources, 'backend');
  await fs.mkdir(runtime, { recursive: true });
  await fs.mkdir(backend);
  await Promise.all([
    fs.writeFile(path.join(runtime, 'uv'), ''),
    fs.writeFile(path.join(runtime, 'ffmpeg'), ''),
  ]);
  const originalSpawn = childProcess.spawn;
  let captured;
  childProcess.spawn = (command, parameters) => {
    captured = { command, parameters };
    const child = new EventEmitter();
    child.pid = 12345;
    child.killed = false;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => child.stdout.write('{"event":"ready","device":"cpu"}\n'));
    return child;
  };
  try {
    delete require.cache[require.resolve('../lib/engine')];
    const { Engine } = require('../lib/engine');
    const engine = new Engine({ appRoot: root, resources, userData: root, packaged: true });
    await engine.start();
    assert.ok(captured.parameters.includes(path.join(backend, 'requirements.txt')));
    assert.ok(captured.parameters.includes('--verbose'));
    assert.equal(captured.parameters[captured.parameters.indexOf('--model') + 1], 'large-v3-turbo');
    assert.ok(captured.parameters.includes('--device'));
    assert.equal(captured.parameters[captured.parameters.indexOf('--device') + 1], 'cpu');
    assert.equal(captured.parameters[captured.parameters.indexOf('--speaker-device') + 1], 'cpu');
    engine.child = null;
  } finally {
    delete require.cache[require.resolve('../lib/engine')];
    childProcess.spawn = originalSpawn;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Engine.start rejects CUDA off Windows', async () => {
  const { Engine } = require('../lib/engine');
  const engine = new Engine({ appRoot: '.', resources: '.', userData: '.', packaged: true });
  if (process.platform !== 'win32') {
    await assert.rejects(engine.start('large-v3-turbo', 'cuda'), /仅支持 Windows x64/);
  }
});

test('Engine.start selects the pinned requirements file for each CUDA variant', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-cuda-variant-'));
  const resources = path.join(root, 'resources');
  const runtime = path.join(resources, 'runtime');
  const backend = path.join(resources, 'backend');
  await fs.mkdir(runtime, { recursive: true });
  await fs.mkdir(backend);
  await Promise.all([
    fs.writeFile(path.join(runtime, 'uv.exe'), ''),
    fs.writeFile(path.join(runtime, 'ffmpeg.exe'), ''),
  ]);
  const originalSpawn = childProcess.spawn;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch');
  let captured;
  Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
  Object.defineProperty(process, 'arch', { ...archDescriptor, value: 'x64' });
  childProcess.spawn = (_command, parameters) => {
    captured = parameters;
    const child = new EventEmitter();
    child.pid = 12346;
    child.killed = false;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => child.stdout.write('{"event":"ready","device":"cuda"}\n'));
    return child;
  };
  try {
    delete require.cache[require.resolve('../lib/engine')];
    const { Engine } = require('../lib/engine');
    for (const variant of ['cu126', 'cu128']) {
      const engine = new Engine({ appRoot: root, resources, userData: root, packaged: true });
      await engine.start('large-v3-turbo', 'cuda', variant);
      assert.ok(captured.includes(path.join(backend, `requirements-cuda${variant.slice(2)}.txt`)));
      assert.equal(captured[captured.indexOf('--index-url') + 1], `https://download.pytorch.org/whl/${variant}`);
      assert.equal(captured[captured.indexOf('--extra-index-url') + 1], 'https://pypi.org/simple');
      assert.ok(captured.includes('--index-strategy'));
      assert.ok(captured.includes('--verbose'));
      assert.ok(captured.includes(path.join(backend, `requirements-cuda${variant.slice(2)}.txt`)));
      engine.child = null;
    }
    for (const variant of ['cu126', 'cu128']) {
      const engine = new Engine({ appRoot: root, resources, userData: root, packaged: true });
      await engine.start('large-v3-turbo', 'cpu', variant, 'cuda');
      assert.ok(captured.includes(path.join(backend, `requirements-cuda${variant.slice(2)}-speakers-gpu.txt`)));
      assert.equal(captured[captured.indexOf('--speaker-device') + 1], 'cuda');
      assert.ok(captured.includes('--find-links'));
      assert.ok(captured.includes('https://k2-fsa.github.io/sherpa/onnx/cuda.html'));
      engine.child = null;
    }
  } finally {
    delete require.cache[require.resolve('../lib/engine')];
    childProcess.spawn = originalSpawn;
    Object.defineProperty(process, 'platform', platformDescriptor);
    Object.defineProperty(process, 'arch', archDescriptor);
    await fs.rm(root, { recursive: true, force: true });
  }
});
