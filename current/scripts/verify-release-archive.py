#!/usr/bin/env python3
import json
import pathlib
import stat
import sys
import zipfile

if len(sys.argv) != 2:
    raise SystemExit("Usage: verify-release-archive.py ARCHIVE.zip")

target = pathlib.Path(sys.argv[1]).resolve(strict=True)
if not target.is_file() or target.is_symlink():
    raise SystemExit("archive must be a regular non-symlink file")

seen = set()
with zipfile.ZipFile(target, "r") as archive:
    infos = archive.infolist()
    for info in infos:
        name = info.filename
        if not name or "\\" in name or name.startswith("/"):
            raise SystemExit(f"unsafe archive path: {name!r}")
        parts = pathlib.PurePosixPath(name.rstrip("/")).parts
        if not parts or any(part in ("", ".", "..") for part in parts):
            raise SystemExit(f"unsafe archive path: {name!r}")
        lower = [part.lower() for part in parts]
        if ".gitmodules" in lower:
            raise SystemExit(f"archive contains forbidden .gitmodules: {name}")
        if ".git" in lower:
            raise SystemExit(f"archive contains forbidden nested .git metadata: {name}")
        if name in seen:
            raise SystemExit(f"archive contains duplicate path: {name}")
        seen.add(name)
        mode = (info.external_attr >> 16) & 0xFFFF
        if mode == 0o160000:
            raise SystemExit(f"archive contains forbidden mode-160000 gitlink: {name}")
        kind = stat.S_IFMT(mode)
        if kind == stat.S_IFLNK:
            raise SystemExit(f"archive contains forbidden symlink: {name}")
        if info.is_dir():
            if kind not in (0, stat.S_IFDIR):
                raise SystemExit(f"archive directory has unsupported mode {mode:o}: {name}")
        elif kind not in (0, stat.S_IFREG):
            raise SystemExit(f"archive file has unsupported mode {mode:o}: {name}")

print(json.dumps({
    "result": "PASS",
    "scope": "FINAL_ZIP",
    "entryCount": len(seen),
    "gitlinkCount": 0,
    "gitmodulesCount": 0,
    "nestedGitMetadataCount": 0,
    "symlinkCount": 0,
    "duplicateCount": 0,
}, indent=2, sort_keys=True))
