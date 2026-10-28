#!/usr/bin/env python3
"""Prepare redistributable uv and ffmpeg binaries for Electron resources."""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
DOWNLOADS = ROOT / "work" / "downloads"
UV_VERSION = "0.13.5"
IMAGEIO_FFMPEG_VERSION = "0.6.0"


def run(command: list[str], *, cwd: Path = ROOT) -> None:
    print("Running:", " ".join(str(x) for x in command), flush=True)
    subprocess.run(command, cwd=cwd, check=True)


def safe_member(name: str) -> bool:
    path = PurePosixPath(name.replace("\\", "/"))
    return not path.is_absolute() and ".." not in path.parts


def get_uv(platform: str, arch: str, destination: Path) -> None:
    executable = "uv.exe" if platform == "win" else "uv"
    # Prefer the already-installed host uv when it matches the requested target.
    host_platform = "mac" if sys.platform == "darwin" else ("win" if os.name == "nt" else "linux")
    host_arch = "arm64" if (os.uname().machine if hasattr(os, "uname") else "") in ("arm64", "aarch64") else "x64"
    local_uv = ROOT / "work" / "python" / "bin" / "uv"
    if platform == host_platform and arch == host_arch and local_uv.is_file():
        try:
            local_version = subprocess.run([str(local_uv), "--version"], check=True,
                                           capture_output=True, text=True).stdout.split()[1]
        except (OSError, subprocess.CalledProcessError, IndexError):
            local_version = None
        if local_version == UV_VERSION:
            shutil.copy2(local_uv, destination / executable)
            uv_licenses = ROOT / "licenses" / "UV-LICENSES.txt"
            if uv_licenses.is_file():
                shutil.copy2(uv_licenses, destination / "UV-LICENSES.txt")
            print(f"Copied host uv {UV_VERSION}: {local_uv}")
            return
        print(f"Host uv version {local_version or 'unknown'} does not match pinned {UV_VERSION}; downloading pinned wheel")

    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="uv-wheel-") as tmp:
        wheel_dir = Path(tmp)
        if platform == "mac":
            wheel_platform = "macosx_11_0_arm64" if arch == "arm64" else "macosx_10_12_x86_64"
        else:
            wheel_platform = "win_arm64" if arch == "arm64" else "win_amd64"
        run([sys.executable, "-m", "pip", "download", f"uv=={UV_VERSION}", "--platform", wheel_platform,
             "--only-binary=:all:", "--no-deps", "--dest", str(wheel_dir)], cwd=ROOT)
        wheels = list(wheel_dir.glob("uv-*.whl"))
        if len(wheels) != 1 or not wheels[0].name.startswith(f"uv-{UV_VERSION}-"):
            raise RuntimeError(f"Expected one uv {UV_VERSION} wheel for {wheel_platform}, found {[w.name for w in wheels]}")
        member = "uv.exe" if platform == "win" else "uv"
        with zipfile.ZipFile(wheels[0]) as archive:
            matches = [n for n in archive.namelist() if PurePosixPath(n).name.lower() == member.lower()]
            if not matches:
                raise RuntimeError(f"No {member} binary found in {wheels[0].name}")
            selected = matches[0]
            if not safe_member(selected):
                raise RuntimeError(f"Unsafe wheel path: {selected}")
            output = destination / member
            with archive.open(selected) as source, output.open("wb") as target:
                shutil.copyfileobj(source, target)
            output.chmod(0o755)
            license_members = [n for n in archive.namelist()
                               if ".dist-info/licenses/" in n and PurePosixPath(n).name.upper().startswith("LICENSE")]
            if license_members:
                chunks = []
                for license_name in license_members:
                    if not safe_member(license_name):
                        raise RuntimeError(f"Unsafe wheel path: {license_name}")
                    chunks.append(f"--- {PurePosixPath(license_name).name} ---\n".encode() + archive.read(license_name))
                (destination / "UV-LICENSES.txt").write_bytes(b"\n\n".join(chunks) + b"\n")
        print(f"Extracted {member} from {wheels[0].name}")


def get_ffmpeg(platform: str, arch: str, destination: Path) -> None:
    for stale in ("ffmpeg", "ffmpeg.exe", "FFMPEG-LICENSE.txt", "FFMPEG-BUILD.txt",
                  "FFMPEG-PACKAGE.json", "FFMPEG-PACKAGE-README.md", "IMAGEIO-FFMPEG-LICENSE.txt",
                  "IMAGEIO-FFMPEG-METADATA.txt"):
        path = destination / stale
        if path.is_file():
            path.unlink()
    if platform == "win" and arch != "x64":
        raise RuntimeError("The requested imageio-ffmpeg Windows wheel is available only for x64")
    if platform == "mac" and arch != "arm64":
        raise RuntimeError("The requested imageio-ffmpeg macOS wheel is available only for arm64")
    DOWNLOADS.mkdir(parents=True, exist_ok=True)
    wheel_platform = "macosx_11_0_arm64" if platform == "mac" else "win_amd64"
    with tempfile.TemporaryDirectory(prefix="imageio-ffmpeg-wheel-") as tmp:
        wheel_dir = Path(tmp)
        run([sys.executable, "-m", "pip", "download", f"imageio-ffmpeg=={IMAGEIO_FFMPEG_VERSION}", "--platform", wheel_platform,
             "--only-binary=:all:", "--no-deps", "--dest", str(wheel_dir)], cwd=ROOT)
        wheels = list(wheel_dir.glob("imageio_ffmpeg-*.whl"))
        if len(wheels) != 1 or not wheels[0].name.startswith(f"imageio_ffmpeg-{IMAGEIO_FFMPEG_VERSION}-"):
            raise RuntimeError(f"Expected one imageio-ffmpeg {IMAGEIO_FFMPEG_VERSION} wheel for {wheel_platform}, found {[w.name for w in wheels]}")
        with zipfile.ZipFile(wheels[0]) as archive:
            binary_members = [n for n in archive.namelist()
                              if n.startswith("imageio_ffmpeg/binaries/ffmpeg-") and not n.endswith("/")]
            if len(binary_members) != 1 or not safe_member(binary_members[0]):
                raise RuntimeError(f"Expected one safe ffmpeg binary in {wheels[0].name}")
            member = binary_members[0]
            binary = "ffmpeg.exe" if platform == "win" else "ffmpeg"
            output = destination / binary
            with archive.open(member) as source, output.open("wb") as target:
                shutil.copyfileobj(source, target)
            output.chmod(0o755)
            license_member = next((n for n in archive.namelist() if n.endswith(".dist-info/LICENSE")), None)
            if license_member:
                (destination / "IMAGEIO-FFMPEG-LICENSE.txt").write_bytes(archive.read(license_member))
            readme = next((n for n in archive.namelist() if n == "imageio_ffmpeg/binaries/README.md"), None)
            if readme:
                (destination / "FFMPEG-PACKAGE-README.md").write_bytes(archive.read(readme))
            metadata = next((n for n in archive.namelist() if n.endswith(".dist-info/METADATA")), None)
            if metadata:
                (destination / "IMAGEIO-FFMPEG-METADATA.txt").write_bytes(archive.read(metadata))
        (destination / "FFMPEG-BUILD.txt").write_text(
            f"Source: imageio-ffmpeg wheel from https://pypi.org/project/imageio-ffmpeg/\n"
            f"Wheel: {wheels[0].name}\nBinary member: {member}\n"
            "FFmpeg binary license and build configuration must be checked separately from imageio-ffmpeg's BSD license.\n",
            encoding="utf-8")
        # macOS can execute this target binary on the host. Refuse builds marked nonfree.
        if platform == "mac":
            result = subprocess.run([str(output), "-L"], text=True, capture_output=True, check=True)
            report = result.stdout + result.stderr
            (destination / "FFMPEG-LICENSE.txt").write_text(report, encoding="utf-8")
            if "--enable-nonfree" in report or "not legally redistributable" in report.lower():
                raise RuntimeError("The extracted FFmpeg build is marked nonfree and cannot be redistributed")
            print("Verified macOS ffmpeg -L: no --enable-nonfree configuration")
        else:
            # Check visible ASCII in PE binaries for an explicit nonfree build marker.
            contents = output.read_bytes().lower()
            if b"--enable-nonfree" in contents or b"not legally redistributable" in contents:
                raise RuntimeError("The extracted Windows FFmpeg build contains a nonfree marker")
        print(f"Extracted ffmpeg from {wheels[0].name}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--platform", choices=("mac", "win"), required=True)
    parser.add_argument("--arch", choices=("arm64", "x64"), required=True)
    args = parser.parse_args()
    if args.platform == "win" and args.arch == "arm64":
        parser.error("Windows arm64 is not part of the current release targets")
    destination = ROOT / "runtime" / f"{args.platform}-{args.arch}"
    destination.mkdir(parents=True, exist_ok=True)
    try:
        get_uv(args.platform, args.arch, destination)
        get_ffmpeg(args.platform, args.arch, destination)
    except (OSError, subprocess.CalledProcessError, RuntimeError, zipfile.BadZipFile, tarfile.TarError) as exc:
        print(f"Runtime preparation failed for {args.platform}-{args.arch}: {exc}", file=sys.stderr)
        return 1
    print(f"Prepared runtime resources in {destination}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
