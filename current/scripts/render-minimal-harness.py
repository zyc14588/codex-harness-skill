#!/usr/bin/env python3
"""Install or remove the Bridge-managed Harness minimal profile and preset."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import stat
import sys
import tempfile
from pathlib import Path

MARKER = ".codex-harness-bridge-managed.json"
MANAGED_BY = "codex-harness-bridge"
VERSION = "0.6.6"


def read_marker(directory: Path) -> dict | None:
    path = directory / MARKER
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return None
    return data if isinstance(data, dict) and data.get("managedBy") == MANAGED_BY else None


def assert_replaceable(directory: Path) -> None:
    if directory.exists() and read_marker(directory) is None:
        raise SystemExit(f"refusing to replace unmanaged Harness integration directory: {directory}")


def tighten_tree(root: Path) -> None:
    for current, dirs, files in os.walk(root):
        os.chmod(current, 0o700)
        for name in dirs:
            os.chmod(Path(current) / name, 0o700)
        for name in files:
            path = Path(current) / name
            mode = path.stat().st_mode
            os.chmod(path, 0o700 if mode & stat.S_IXUSR else 0o600)


def write_marker(directory: Path, kind: str) -> None:
    payload = {
        "managedBy": MANAGED_BY,
        "version": VERSION,
        "kind": kind,
    }
    (directory / MARKER).write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def install(args: argparse.Namespace) -> None:
    template_root = Path(args.template_root).resolve()
    profile_dir = Path(args.profile_dir).resolve()
    preset_dir = Path(args.preset_dir).resolve()
    runtime = Path(args.runtime).resolve()
    config = Path(args.config).resolve()
    broker_host = runtime / "bridge" / "dist" / "brokered-tool-host.js"
    broker_plugin = template_root / "profile" / "bridge-brokered-tools.mjs"
    if not broker_host.is_file():
        raise SystemExit(f"brokered tool host is missing: {broker_host}")
    if not broker_plugin.is_file():
        raise SystemExit(f"brokered tool plugin is missing: {broker_plugin}")
    for target in (profile_dir, preset_dir):
        assert_replaceable(target)
        target.parent.mkdir(parents=True, exist_ok=True)

    staging = Path(tempfile.mkdtemp(prefix="codex-harness-minimal-", dir=str(profile_dir.parent)))
    staged_profile = staging / "profile"
    staged_preset = staging / "preset"
    try:
        shutil.copytree(template_root / "profile", staged_profile, symlinks=False)
        staged_preset.mkdir(parents=True)
        shutil.copy2(template_root / "preset" / "preset.yml", staged_preset / "preset.yml")
        source = (template_root / "preset" / "agent.cordis.yml.in").read_text(encoding="utf-8")
        placeholder = "{{CODEX_HARNESS_BROKER_PLUGIN}}"
        if source.count(placeholder) != 1 or "command:" in source:
            raise SystemExit("minimal preset does not contain the frozen in-process Bridge tool broker composition")
        profile_name = profile_dir.name
        if not re.fullmatch(r"[A-Za-z0-9._-]{1,80}", profile_name):
            raise SystemExit(f"unsafe managed profile name: {profile_name}")
        broker_sandbox_path = f"/sandbox/dsh/profiles/{profile_name}/bridge-brokered-tools.mjs"
        rendered_source = source.replace(placeholder, broker_sandbox_path)
        (staged_preset / "agent.cordis.yml").write_text(rendered_source, encoding="utf-8")
        write_marker(staged_profile, "profile")
        write_marker(staged_preset, "preset")
        metadata = {
            "managedBy": MANAGED_BY,
            "version": VERSION,
            "config": str(config),
            "runtime": str(runtime),
        }
        (staged_profile / "bridge-install.json").write_text(json.dumps(metadata, indent=2) + "\n", encoding="utf-8")
        tighten_tree(staged_profile)
        tighten_tree(staged_preset)
        if profile_dir.exists():
            shutil.rmtree(profile_dir)
        if preset_dir.exists():
            shutil.rmtree(preset_dir)
        os.replace(staged_profile, profile_dir)
        os.replace(staged_preset, preset_dir)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
    print(json.dumps({
        "result": "installed",
        "version": VERSION,
        "profile": str(profile_dir),
        "preset": str(preset_dir),
    }))


def remove(args: argparse.Namespace) -> None:
    removed: list[str] = []
    for raw in (args.profile_dir, args.preset_dir):
        directory = Path(raw).resolve()
        if not directory.exists():
            continue
        if read_marker(directory) is None:
            raise SystemExit(f"refusing to remove unmanaged Harness integration directory: {directory}")
        shutil.rmtree(directory)
        removed.append(str(directory))
    print(json.dumps({"result": "removed", "paths": removed}))


def status(args: argparse.Namespace) -> None:
    result = {}
    for key, raw in (("profile", args.profile_dir), ("preset", args.preset_dir)):
        directory = Path(raw).resolve()
        result[key] = {
            "path": str(directory),
            "exists": directory.exists(),
            "managed": read_marker(directory) is not None if directory.exists() else False,
        }
    ok = all(item["exists"] and item["managed"] for item in result.values())
    print(json.dumps({"ok": ok, **result}, indent=2))
    if not ok:
        raise SystemExit(1)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser()
    sub = root.add_subparsers(dest="command", required=True)
    install_parser = sub.add_parser("install")
    install_parser.add_argument("--template-root", required=True)
    install_parser.add_argument("--profile-dir", required=True)
    install_parser.add_argument("--preset-dir", required=True)
    install_parser.add_argument("--runtime", required=True)
    install_parser.add_argument("--config", required=True)
    # Accepted for compatibility with older callers; no child process is launched.
    install_parser.add_argument("--node")
    install_parser.set_defaults(handler=install)
    for name, handler in (("remove", remove), ("status", status)):
        child = sub.add_parser(name)
        child.add_argument("--profile-dir", required=True)
        child.add_argument("--preset-dir", required=True)
        child.set_defaults(handler=handler)
    return root


def main() -> None:
    args = parser().parse_args()
    args.handler(args)


if __name__ == "__main__":
    main()
