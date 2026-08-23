#!/usr/bin/env python3
import os
import pathlib
import stat
import sys
import zipfile

if len(sys.argv) != 4:
    raise SystemExit("Usage: deterministic-zip.py SOURCE_ROOT OUTPUT.zip ARCHIVE_ROOT")

source = pathlib.Path(sys.argv[1]).resolve(strict=True)
output = pathlib.Path(sys.argv[2]).resolve()
archive_root = sys.argv[3].strip("/")
if not archive_root or "/" in archive_root or "\\" in archive_root:
    raise SystemExit("ARCHIVE_ROOT must be one safe path component")

excluded_dirs = {".git", "node_modules"}
excluded_files = {".DS_Store"}
files = []
for current, directories, names in os.walk(source, topdown=True, followlinks=False):
    directories[:] = sorted(name for name in directories if name not in excluded_dirs)
    current_path = pathlib.Path(current)
    for name in directories:
        target = current_path / name
        if target.is_symlink(): raise SystemExit(f"package must not contain symlink: {target.relative_to(source)}")
    for name in sorted(names):
        if name in excluded_files: continue
        target = current_path / name
        info = target.lstat()
        if stat.S_ISLNK(info.st_mode): raise SystemExit(f"package must not contain symlink: {target.relative_to(source)}")
        if not stat.S_ISREG(info.st_mode): raise SystemExit(f"unsupported package entry: {target.relative_to(source)}")
        files.append(target)

output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9, strict_timestamps=True) as archive:
    for target in sorted(files, key=lambda item: item.relative_to(source).as_posix()):
        relative = target.relative_to(source).as_posix()
        entry = zipfile.ZipInfo(f"{archive_root}/{relative}", date_time=(1980, 1, 1, 0, 0, 0))
        mode = 0o755 if target.stat().st_mode & 0o111 else 0o644
        entry.create_system = 3
        entry.external_attr = (stat.S_IFREG | mode) << 16
        entry.compress_type = zipfile.ZIP_DEFLATED
        with target.open("rb") as handle:
            archive.writestr(entry, handle.read(), compress_type=zipfile.ZIP_DEFLATED, compresslevel=9)
