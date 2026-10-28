const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");
const uninstallerPath = path.join(distDir, "__uninstaller-nsis-huiyi-jiyao.exe");
const signature = Buffer.from("efbeadde4e756c6c736f6674496e7374", "hex");
const noCrcFlag = 4;
const forceCrcFlag = 8;

function makeCrcTable() {
  return Array.from({ length: 256 }, (_, n) => {
    let value = n;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    return value >>> 0;
  });
}

const crcTable = makeCrcTable();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function main() {
  const data = await fs.readFile(uninstallerPath).catch(() => {
    throw new Error(`The build did not retain the standalone NSIS uninstaller: ${uninstallerPath}`);
  });
  let checked = false;
  for (let offset = 0; offset + 28 <= data.length; offset += 512) {
    const flags = data.readUInt32LE(offset);
    if ((flags & ~15) !== 0 || !data.subarray(offset + 4, offset + 20).equals(signature)) continue;
    if ((flags & noCrcFlag) !== 0 && (flags & forceCrcFlag) === 0) {
      throw new Error("NSIS CRC is disabled in the generated uninstaller.");
    }
    const length = data.readUInt32LE(offset + 24);
    if (length < 32 || length > data.length - offset) {
      throw new Error("Generated NSIS uninstaller has an invalid data length.");
    }
    const crcOffset = offset + length - 4;
    const actual = crc32(data.subarray(offset === 0 ? 0 : 512, crcOffset));
    const expected = data.readUInt32LE(crcOffset);
    if (actual !== expected) {
      throw new Error(`NSIS uninstaller CRC mismatch: got 0x${actual.toString(16)}, expected 0x${expected.toString(16)}.`);
    }
    checked = true;
    break;
  }
  if (!checked) throw new Error("No CRC-protected NSIS header found in generated uninstaller.");
  const sha256 = crypto.createHash("sha256").update(data).digest("hex");
  await fs.writeFile(`${uninstallerPath}.sha256`, `${sha256}  ${path.basename(uninstallerPath)}\n`);
  const repairScript = await fs.readFile(path.join(root, "scripts", "repair-nsis-uninstaller.ps1"));
  const utf8Bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const hasBom = repairScript.subarray(0, 3).equals(utf8Bom);
  await fs.writeFile(path.join(distDir, "repair-nsis-uninstaller.ps1"), hasBom ? repairScript : Buffer.concat([utf8Bom, repairScript]));
  await fs.copyFile(path.join(root, "scripts", "repair-nsis-uninstaller.cmd"), path.join(distDir, "repair-nsis-uninstaller.cmd"));
  console.log("NSIS uninstaller CRC verified.");
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
