const { spawnSync } = require('node:child_process');
const path = require('node:path');
const pkg = require('../package.json');

const identity = String(process.env.HUIYI_MAC_SIGNING_IDENTITY || process.env.CSC_NAME || '').trim();
const arch = process.arch;
const appPath = path.resolve(`dist/mac-${arch}/${pkg.build.productName}.app`);
const zipPath = path.resolve(`dist/${pkg.build.productName}-${pkg.version}-${arch}-mac.zip`);
const args = [
  require.resolve('electron-builder/cli.js'),
  '--mac',
  identity ? 'dir' : 'zip',
  ...process.argv.slice(2).filter(arg => !['dir', 'zip', 'dmg'].includes(arg)),
  '--config.electronDist=node_modules/electron/dist',
  '--config.appId=com.codex.huijiyijao.mac'
];

const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
if (result.error) {
  console.error(`macOS 打包失败：${result.error.message}`);
  process.exitCode = 1;
} else if (result.status !== 0) {
  process.exitCode = result.status ?? 1;
} else if (identity) {
  const sign = spawnSync('codesign', [
    '--force', '--deep', '--sign', identity, '--options', 'runtime',
    '--entitlements', 'build/entitlements.mac.plist', appPath
  ], { stdio: 'inherit' });
  if (sign.error || sign.status !== 0) {
    console.error(`macOS 应用签名失败：${sign.error?.message || `codesign exited with ${sign.status}`}`);
    process.exitCode = sign.status ?? 1;
  } else {
    const verify = spawnSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath], { stdio: 'inherit' });
    if (verify.error || verify.status !== 0) {
      console.error(`macOS 签名验证失败：${verify.error?.message || `codesign exited with ${verify.status}`}`);
      process.exitCode = verify.status ?? 1;
    } else {
      const archive = spawnSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', appPath, zipPath], { stdio: 'inherit' });
      if (archive.error || archive.status !== 0) {
        console.error(`macOS ZIP 打包失败：${archive.error?.message || `ditto exited with ${archive.status}`}`);
        process.exitCode = archive.status ?? 1;
      }
    }
  }
}
