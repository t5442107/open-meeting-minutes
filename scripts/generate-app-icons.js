const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
const root = path.resolve(__dirname, "..");
const source = path.join(root, "build", "app-icon.png");
const iconset = path.join(os.tmpdir(), `huiyi-iconset-${process.pid}.iconset`);

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("Icon generation requires macOS sips and iconutil.");
  }
  await fs.access(source);
  await fs.rm(iconset, { recursive: true, force: true });
  await fs.mkdir(iconset, { recursive: true });

  const icnsImages = [
    [16, "icon_16x16.png"], [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"], [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"], [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"], [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"], [1024, "icon_512x512@2x.png"],
  ];
  const icoSizes = [16, 32, 48, 256];
  const sizes = [...new Set([...icnsImages.map(([size]) => size), ...icoSizes])];
  const pngBySize = new Map();
  for (const size of sizes) {
    const output = path.join(iconset, `${size}.png`);
    await execFileAsync("sips", ["-z", String(size), String(size), source, "--out", output]);
    pngBySize.set(size, await fs.readFile(output));
  }
  for (const [size, name] of icnsImages) {
    await fs.copyFile(path.join(iconset, `${size}.png`), path.join(iconset, name));
  }

  const icnsPath = path.join(root, "build", "app-icon.icns");
  const icoPath = path.join(root, "build", "app-icon.ico");
  await execFileAsync("iconutil", ["-c", "icns", iconset, "-o", icnsPath]);

  let offset = 6 + 16 * icoSizes.length;
  const directories = [];
  const images = [];
  for (const size of icoSizes) {
    const png = pngBySize.get(size);
    const entry = Buffer.alloc(16);
    entry[0] = size === 256 ? 0 : size;
    entry[1] = size === 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    directories.push(entry);
    images.push(png);
    offset += png.length;
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(icoSizes.length, 4);
  await fs.writeFile(icoPath, Buffer.concat([header, ...directories, ...images]));
  await fs.rm(iconset, { recursive: true, force: true });
  console.log(`Created ${path.relative(root, icnsPath)} and ${path.relative(root, icoPath)}`);
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
