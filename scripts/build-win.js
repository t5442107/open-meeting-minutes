const fs = require("node:fs/promises");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const targetModule = require.resolve("app-builder-lib/out/targets/nsis/NsisTarget.js");
const cli = require.resolve("electron-builder/cli.js");
const anchor = "await Promise.all([packager.signIf(installerPath), defines.UNINSTALLER_OUT_FILE == null ? Promise.resolve() : (0, fs_extra_1.unlink)(defines.UNINSTALLER_OUT_FILE)]);";
const output = "await Promise.all([packager.signIf(installerPath), defines.UNINSTALLER_OUT_FILE == null ? Promise.resolve() : (0, fs_extra_1.copyFile)(defines.UNINSTALLER_OUT_FILE, path.join(this.outDir, \"__uninstaller-nsis-huiyi-jiyao.exe\")).then(() => (0, fs_extra_1.unlink)(defines.UNINSTALLER_OUT_FILE))]);";

async function main() {
  const original = await fs.readFile(targetModule, "utf8");
  if (original.split(anchor).length !== 2) {
    throw new Error("electron-builder NSIS cleanup code changed; refusing to build without retaining the verified uninstaller.");
  }
  await fs.writeFile(targetModule, original.replace(anchor, output));
  let result;
  try {
    result = spawnSync(process.execPath, [cli, "--win", "--x64", ...process.argv.slice(2)], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
  } finally {
    await fs.writeFile(targetModule, original);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status ?? 1;
  else {
    const verification = spawnSync(process.execPath, [path.join(__dirname, "verify-nsis-uninstaller.js")], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    if (verification.error) throw verification.error;
    if (verification.status !== 0) process.exitCode = verification.status ?? 1;
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
