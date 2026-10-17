#!/usr/bin/env python3
"""Collect licenses already present in the Windows release tree; never uses the network."""

from __future__ import annotations

import argparse
import email.parser
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any


REPO = Path(__file__).resolve().parents[1]
NOTICES = REPO / "third-party" / "dependency-notices.txt"
INVENTORY = REPO / "third-party" / "dependency-inventory.json"
LICENSE_NAMES = re.compile(r"^(licenses?|licences?|copying|copyright|notice)([-_.].*)?$", re.I)
WHISPER_LICENSE = """MIT License

Copyright (c) 2023-2026 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE."""
WHISPER_LICENSE_SOURCE = "https://github.com/ggml-org/whisper.cpp/blob/b5454/LICENSE"


def rel(path: Path) -> str:
    """Return a repository-relative POSIX path, never an external absolute path."""
    try:
        return path.resolve().relative_to(REPO.resolve()).as_posix()
    except (OSError, ValueError):
        return ""


def read_text(path: Path) -> str | None:
    try:
        data = path.read_bytes()
        return data.decode("utf-8-sig")
    except (OSError, UnicodeError):
        try:
            return path.read_bytes().decode("latin-1")
        except OSError:
            return None


def metadata_files(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    found: list[Path] = []
    for path in root.rglob("*"):
        if not path.is_file() or path.is_symlink():
            continue
        name = path.name
        suffix = path.suffix.lower()
        stem = path.stem.lower()
        if LICENSE_NAMES.match(stem) or LICENSE_NAMES.match(name):
            found.append(path)
    return sorted(found, key=lambda p: p.as_posix().lower())


def top_license_files(root: Path) -> list[Path]:
    if not root.is_dir():
        return []
    found: list[Path] = []
    for path in root.iterdir():
        if path.is_file() and not path.is_symlink():
            suffix = path.suffix.lower()
            if LICENSE_NAMES.match(path.stem) or LICENSE_NAMES.match(path.name):
                found.append(path)
        elif path.is_dir() and not path.is_symlink() and path.name.lower() in {"licenses", "license"}:
            found.extend(metadata_files(path))
    return sorted(set(found), key=lambda p: p.as_posix().lower())


def add_package(
    records: list[dict[str, Any]],
    *,
    ecosystem: str,
    name: str,
    version: str,
    license_spdx: str | None,
    source_path: str,
    license_paths: list[Path],
    missing_reason: str | None = None,
) -> None:
    texts: list[dict[str, str]] = []
    for path in license_paths:
        text = read_text(path)
        if not text or not text.strip():
            continue
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        texts.append({"sha256": digest, "path": rel(path) or "external cached package metadata", "content": text})
    # The full license contents are consolidated in dependency-notices.txt. Inventory pointers
    # are relative section references, so no developer or build-machine paths are serialized.
    ids = sorted({item["sha256"] for item in texts})
    reason = missing_reason
    if not ids and not reason:
        reason = "No license text was found in the locally installed package files."
    if not license_spdx and not reason:
        reason = "License text exists, but package metadata does not declare an SPDX identifier."
    records.append(
        {
            "ecosystem": ecosystem,
            "name": name,
            "version": version or "unknown",
            "licenseSpdx": license_spdx,
            "source": source_path,
            "licenseText": [f"third-party/dependency-notices.txt#license-{digest[:12]}" for digest in ids],
            "missing": reason,
            "_text": texts,
        }
    )


def collect_npm(records: list[dict[str, Any]]) -> dict[str, Any]:
    frontend_count = collect_npm_tree(
        records,
        lock_path=REPO / "package-lock.json",
        modules=REPO / "node_modules",
        source_prefix="node_modules",
        display="LocalWORK frontend",
    )
    browser_count = collect_npm_tree(
        records,
        lock_path=REPO / "scripts" / "vendor-browser" / "package-lock.json",
        modules=REPO / "vendor" / "playwright" / "node_modules",
        source_prefix="vendor/playwright/node_modules",
        display="Playwright browser tools",
    )
    return {
        "frontend": {"status": "available" if frontend_count else "unavailable", "installedPackages": frontend_count, "requiredForComplete": True},
        "browserTools": {"status": "available" if browser_count else "unavailable", "installedPackages": browser_count, "requiredForComplete": True},
    }


def collect_npm_tree(
    records: list[dict[str, Any]], *, lock_path: Path, modules: Path, source_prefix: str, display: str
) -> int:
    try:
        lock = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        add_package(records, ecosystem="npm", name=display, version="unknown", license_spdx=None,
                    source_path=rel(lock_path), license_paths=[], missing_reason="Pinned npm lockfile is unavailable or invalid.")
        return 0
    count = 0
    for key, entry in sorted(lock.get("packages", {}).items()):
        if not key.startswith("node_modules/"):
            continue
        package_name = key.removeprefix("node_modules/")
        package_path = modules.joinpath(*package_name.split("/"))
        manifest_path = package_path / "package.json"
        # npm lockfiles include optional packages for other operating systems; inventory only
        # package contents actually installed in this Windows release tree.
        if not manifest_path.is_file():
            continue
        try:
            package = json.loads(manifest_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            package = {}
        name = str(package.get("name") or package_name)
        version = str(package.get("version") or entry.get("version") or "unknown")
        declared = package.get("license", entry.get("license"))
        if isinstance(declared, dict):
            declared = declared.get("type")
        license_paths = top_license_files(package_path)
        # These optional native packages publish their binary-only tarballs without
        # the text, while the same lock pins their parent package with the license.
        parent_license_sources = {
            ("@rolldown/binding-win32-x64-msvc", "1.2.14", "MIT"): REPO / "node_modules" / "rolldown",
            ("@tauri-apps/cli-win32-x64-msvc", "2.12.3", "Apache-2.0 OR MIT"): REPO / "node_modules" / "@tauri-apps" / "cli",
        }
        parent = parent_license_sources.get((name, version, str(declared)))
        if not license_paths and parent:
            try:
                parent_info = json.loads((parent / "package.json").read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                parent_info = {}
            if parent_info.get("version") == version and parent_info.get("license") == declared:
                license_paths = top_license_files(parent)
        add_package(records, ecosystem="npm", name=name, version=version,
                    license_spdx=str(declared) if declared else None,
                    source_path=f"{source_prefix}/{package_name}",
                    license_paths=license_paths)
        count += 1
    if count == 0:
        add_package(records, ecosystem="npm", name=display, version=str(lock.get("version", "unknown")),
                    license_spdx=None, source_path=rel(lock_path), license_paths=[],
                    missing_reason="Lockfile exists, but no installed packages were found in its node_modules tree.")
    return count


def python_spdx(msg: email.message.Message, license_files: list[Path]) -> str | None:
    expression = msg.get("License-Expression")
    if expression:
        return str(expression)
    value = str(msg.get("License") or "").strip()
    exact_ids = {
        "MIT", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "ISC", "MPL-2.0",
        "0BSD", "LGPL-2.1-only", "LGPL-2.1-or-later", "GPL-2.0-only", "GPL-2.0-or-later",
        "GPL-3.0-only", "GPL-3.0-or-later", "PSF-2.0", "Unlicense",
    }
    text = "\n".join(read_text(path) or "" for path in license_files)
    if value in exact_ids:
        if value == "MIT" and "Permission is hereby granted" in text:
            return value
        if value == "Apache-2.0" and "Apache License" in text and "Version 2.0" in text:
            return value
        if value == "BSD-3-Clause" and "Redistribution and use" in text and "Neither the name" in text:
            return value
        if value == "MPL-2.0" and "Mozilla Public License" in text and "Version 2.0" in text:
            return value
    if value == "MIT License" and "Permission is hereby granted" in text and "SOFTWARE." in text:
        return "MIT"
    # METADATA line folding can insert newlines into long classifier values.
    classifiers = {re.sub(r"\s+", " ", value).strip() for value in msg.get_all("Classifier", [])}
    if value == "MPL-2.0" and "License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)" in classifiers:
        return "MPL-2.0"
    if "License :: OSI Approved :: MIT License" in classifiers and "Permission is hereby granted" in text:
        return "MIT"
    if "License :: OSI Approved :: Mozilla Public License 2.0 (MPL 2.0)" in classifiers and "Mozilla Public License" in text and "Version 2.0" in text:
        return "MPL-2.0"
    if "License :: OSI Approved :: BSD 3-Clause License" in classifiers and "Redistribution and use" in text and "Neither the name" in text:
        return "BSD-3-Clause"
    if "License :: OSI Approved :: BSD 2-Clause License" in classifiers and "Redistribution and use" in text and "Neither the name" not in text:
        return "BSD-2-Clause"
    if "Apache Software License" in value and "Apache License" in text and "Version 2.0" in text:
        return "Apache-2.0"
    return None


def collect_python(records: list[dict[str, Any]]) -> None:
    root = REPO / "workbench-mcp" / "libs"
    for dist in sorted(root.glob("*.dist-info"), key=lambda p: p.name.lower()):
        metadata = dist / "METADATA"
        try:
            msg = email.parser.Parser().parsestr(metadata.read_text(encoding="utf-8", errors="replace"))
        except OSError:
            msg = {}
        name = str(msg.get("Name") or dist.name.rsplit("-", 1)[0])
        version = str(msg.get("Version") or dist.name.rsplit("-", 1)[-1])
        licenses = top_license_files(dist)
        # Some wheel installers place license files next to dist-info rather than inside it.
        if not licenses:
            licenses = top_license_files(root / name.replace("-", "_").lower())
        if not licenses and name.lower() == "primp" and version == "2.0.1":
            licenses = [REPO / "third-party" / "upstream-cache" / "primp-2.0.1-LICENSE.txt"]
            if not licenses[0].is_file():
                licenses = []
        add_package(records, ecosystem="python", name=name, version=version,
                    license_spdx=python_spdx(msg, licenses),
                    source_path=f"workbench-mcp/libs/{dist.name}", license_paths=licenses)


def collect_rust(records: list[dict[str, Any]], *, agent_source: Path | None = None) -> dict[str, Any]:
    component_status: dict[str, Any] = {"localwork": "unavailable", "agentSource": "not-supplied"}
    if not (REPO / "src-tauri" / "Cargo.toml").is_file():
        return component_status
    command = [
        "cargo", "metadata", "--offline", "--format-version", "1",
        "--filter-platform", "x86_64-pc-windows-msvc",
        "--manifest-path", str(REPO / "src-tauri" / "Cargo.toml"),
    ]
    metadata = None
    try:
        result = subprocess.run(command, cwd=REPO, capture_output=True, check=True)
        metadata = json.loads(result.stdout)
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError) as exc:
        message = "Rust crate inventory unavailable from the offline Cargo cache."
        add_package(records, ecosystem="cargo", name="Windows Rust dependency graph", version="unknown",
                    license_spdx=None, source_path="src-tauri/Cargo.lock", license_paths=[], missing_reason=message)
    else:
        component_status["localwork"] = "available"
    for package in sorted(resolved_packages(metadata), key=lambda item: (item["name"].lower(), item["version"])):
        # Exclude LocalWORK itself; source-less packages are registry/git dependencies.
        if not package.get("source"):
            continue
        manifest = Path(package["manifest_path"])
        package_root = manifest.parent
        license_paths: list[Path] = []
        if package.get("license_file"):
            candidate = package_root / package["license_file"]
            if candidate.is_file():
                license_paths.append(candidate)
        if not license_paths:
            license_paths = top_license_files(package_root)
        license_paths = license_paths or cached_cargo_license(package["name"], package["version"], package.get("license"))
        add_package(records, ecosystem="cargo", name=package["name"], version=package["version"],
                    license_spdx=package.get("license"),
                    source_path="src-tauri/Cargo.lock",
                    license_paths=license_paths)
    if agent_source:
        agent_source = agent_source.resolve()
        cargo_manifest = agent_source / "Cargo.toml"
        if cargo_manifest.is_file():
            agent_command = [
                "cargo", "metadata", "--offline", "--format-version", "1",
                "--filter-platform", "x86_64-pc-windows-msvc",
                "--manifest-path", str(cargo_manifest),
            ]
            try:
                agent_result = subprocess.run(agent_command, cwd=agent_source, capture_output=True, check=True)
                agent_metadata = json.loads(agent_result.stdout)
                component_status["agentSource"] = "available"
                for package in sorted(resolved_packages(agent_metadata), key=lambda item: (item["name"].lower(), item["version"])):
                    if not package.get("source"):
                        continue
                    manifest = Path(package["manifest_path"])
                    package_root = manifest.parent
                    files: list[Path] = []
                    if package.get("license_file"):
                        candidate = package_root / package["license_file"]
                        if candidate.is_file():
                            files.append(candidate)
                    if not files:
                        files = top_license_files(package_root)
                    files = files or cached_cargo_license(package["name"], package["version"], package.get("license"))
                    add_package(records, ecosystem="cargo-agent", name=package["name"], version=package["version"],
                                license_spdx=package.get("license"), source_path="vendor/aionrs.exe", license_paths=files)
            except (OSError, subprocess.CalledProcessError, json.JSONDecodeError):
                component_status["agentSource"] = "unavailable-offline"
    if component_status["agentSource"] != "available":
        add_package(records, ecosystem="cargo-agent", name="aionrs model-agent source dependency graph", version="unknown",
                    license_spdx=None, source_path="vendor/aionrs.exe", license_paths=[],
                    missing_reason="Pass --agent-source with the matching aionrs source checkout; release inventory is incomplete without its dependencies.")
    return component_status


def resolved_packages(metadata: dict[str, Any] | None) -> list[dict[str, Any]]:
    """Limit package records to target-resolved nodes when Cargo provides them."""
    if not metadata:
        return []
    packages = metadata.get("packages", [])
    resolve = metadata.get("resolve") or {}
    nodes = resolve.get("nodes") or []
    if not nodes:
        return packages
    resolved_ids = {node.get("id") for node in nodes}
    return [package for package in packages if package.get("id") in resolved_ids]


def cached_cargo_license(name: str, version: str, expression: str | None) -> list[Path]:
    cache = REPO / "third-party" / "upstream-cache"
    mapping = {
        ("relative-path", "1.9.3", "MIT OR Apache-2.0"): ["relative-path-1.9.3-LICENSE-APACHE.txt", "relative-path-1.9.3-LICENSE-MIT.txt"],
        ("base64-simd", "0.8.0", "MIT"): ["nugine-simd-LICENSE.txt"],
        ("vsimd", "0.8.0", "MIT"): ["nugine-simd-LICENSE.txt"],
        ("alloc-stdlib", "0.3.0", "BSD-3-Clause"): ["alloc-stdlib-0.3.0-LICENSE.txt"],
        ("selectors", "0.38.0", "MPL-2.0"): ["MPL-2.0.txt"],
        ("tauri-plugin", "2.7.2", "Apache-2.0 OR MIT"): ["Tauri-LICENSE-APACHE-2.0.txt", "Tauri-LICENSE-MIT.txt"],
        ("webview2-com", "0.39.1", "MIT"): ["webview2-rs-LICENSE.txt"],
        ("webview2-com-macros", "0.8.1", "MIT"): ["webview2-rs-LICENSE.txt"],
        ("webview2-com-sys", "0.39.1", "MIT"): ["webview2-rs-LICENSE.txt"],
    }
    filenames = mapping.get((name, version, str(expression)), [])
    paths = [cache / filename for filename in filenames]
    return paths if paths and all(path.is_file() for path in paths) else []


def collect_runtime(records: list[dict[str, Any]]) -> None:
    manifest_path = REPO / "vendor" / "manifest.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        manifest = {}
    for key, version, path, licenses in [
        ("Node.js", manifest.get("node", {}).get("version", "unknown"), REPO / "vendor" / "node", [REPO / "vendor" / "node" / "LICENSE"]),
        ("Chromium headless shell", manifest.get("chromium", {}).get("version", "unknown"), REPO / "vendor" / "browsers" / manifest.get("chromium", {}).get("version", ""), []),
        ("FFmpeg bundled with Playwright", "ffmpeg-1011", REPO / "vendor" / "browsers" / "ffmpeg-1011", []),
    ]:
        if key.startswith("Chromium"):
            licenses = metadata_files(path)
        elif key.startswith("FFmpeg"):
            licenses = [p for p in path.glob("COPYING*") if p.is_file()]
        else:
            licenses = licenses if all(p.is_file() for p in licenses) else top_license_files(path)
        runtime_spdx = None
        if key == "Node.js" and licenses:
            text = read_text(licenses[0]) or ""
            if "Copyright Node.js contributors" in text and "Permission is hereby granted" in text:
                runtime_spdx = "MIT"
        if key.startswith("Chromium") and licenses:
            runtime_spdx = "LicenseRef-Chromium-ThirdParty"
        if key.startswith("FFmpeg") and licenses:
            text = read_text(licenses[0]) or ""
            if "GNU LESSER GENERAL PUBLIC LICENSE" in text and "Version 2.1" in text:
                runtime_spdx = "LGPL-2.1-only"
        add_package(records, ecosystem="runtime", name=key, version=str(version), license_spdx=runtime_spdx,
                    source_path=rel(path) or "vendor/manifest.json", license_paths=licenses)

    for name, version, source in [
        ("aionrs", manifest.get("aionrs", {}).get("version", "unknown"), REPO / "third-party" / "aionrs-LICENSE.txt"),
        ("OfficeCLI", manifest.get("officecli", {}).get("version", "unknown"), REPO / "third-party" / "officecli-LICENSE.txt"),
    ]:
        text = read_text(source) if source.is_file() else None
        is_apache = bool(text and "Apache License" in text and "Version 2.0" in text)
        add_package(records, ecosystem="runtime", name=name, version=str(version), license_spdx="Apache-2.0" if is_apache else None,
                    source_path=rel(source) if source.is_file() else "vendor/manifest.json",
                    license_paths=[source] if source.is_file() else [])

    whisper_version = str(manifest.get("whisper", {}).get("version", "unknown"))
    model = manifest.get("whisperModel", {})
    model_license = REPO / "third-party" / "upstream-cache" / "whisper-model-LICENSE.txt"
    add_package(records, ecosystem="runtime", name="Whisper small model", version=str(model.get("file", "unknown")),
                license_spdx="MIT", source_path="vendor/manifest.json",
                license_paths=[model_license] if model_license.is_file() else [])
    whisper_path = REPO / "vendor" / "whisper"
    if whisper_version == "b5454" and whisper_path.exists():
        text = WHISPER_LICENSE
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        records.append({
            "ecosystem": "runtime", "name": "Whisper.cpp", "version": whisper_version,
            "licenseSpdx": "MIT", "source": "vendor/manifest.json",
            "licenseText": [f"third-party/dependency-notices.txt#license-{digest[:12]}"],
            "missing": None,
            "_text": [{"sha256": digest, "path": WHISPER_LICENSE_SOURCE, "content": text}],
        })
    else:
        add_package(records, ecosystem="runtime", name="Whisper.cpp", version=whisper_version,
                    license_spdx=None, source_path="vendor/manifest.json", license_paths=[],
                    missing_reason="No verified matching upstream license text is configured for this Whisper runtime version.")


def render(records: list[dict[str, Any]], component_sets: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    by_hash: dict[str, dict[str, Any]] = {}
    for item in records:
        for text in item.pop("_text"):
            group = by_hash.setdefault(text["sha256"], {"text": text["content"], "packages": set(), "sources": set()})
            group["packages"].add(f"{item['name']} {item['version']}")
            if text["path"]:
                group["sources"].add(text["path"])
        item.pop("_text", None)

    notices: list[str] = [
        "LocalWORK third-party dependency notices",
        "===========================================",
        "",
        "Generated from files and offline package metadata present on this machine. This file does not claim that the inventory is complete.",
        "Packages without an SPDX declaration or locally available license text are listed in dependency-inventory.json and must be reviewed before release.",
        "",
    ]
    for digest, group in sorted(by_hash.items(), key=lambda kv: sorted(kv[1]["packages"])):
        notices.extend([f"## License text {digest[:12]}", "", "Packages:"])
        notices.extend(f"- {name}" for name in sorted(group["packages"], key=str.lower))
        notices.extend(["", "Sources:"])
        notices.extend(f"- {source}" for source in sorted(group["sources"], key=str.lower))
        notices.extend(["", "```text", group["text"].rstrip(), "```", ""])
    missing = [
        {key: value for key, value in item.items() if key != "licenseText"}
        for item in records if item.get("missing")
    ]
    required_sets_available = all(
        component.get("status") == "available"
        for component in component_sets.values()
        if component.get("requiredForComplete")
    )
    inventory = {
        "generatedBy": "scripts/collect-notices.py",
        "target": "Windows x64 (x86_64-pc-windows-msvc)",
        "complete": not missing and required_sets_available,
        "componentSets": component_sets,
        "packages": sorted(records, key=lambda item: (item["ecosystem"], item["name"].lower(), item["version"])),
        "missing": missing,
    }
    return "\n".join(notices), inventory


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--strict", action="store_true", help="return failure if any package lacks an SPDX declaration or local license text")
    parser.add_argument("--agent-source", type=Path, help="path to the matching aionrs source checkout, for its Cargo dependency graph")
    args = parser.parse_args()
    records: list[dict[str, Any]] = []
    component_sets = collect_npm(records)
    collect_python(records)
    rust_components = collect_rust(records, agent_source=args.agent_source)
    component_sets["localworkRust"] = {"status": rust_components["localwork"], "requiredForComplete": True}
    component_sets["agentModelRuntimeSource"] = {"status": rust_components["agentSource"], "requiredForComplete": True}
    component_sets["bundledRuntimeFiles"] = {
        "status": "available" if (REPO / "vendor" / "manifest.json").is_file() else "unavailable",
        "requiredForComplete": True,
    }
    collect_runtime(records)
    notices, inventory = render(records, component_sets)
    NOTICES.parent.mkdir(parents=True, exist_ok=True)
    NOTICES.write_text(notices, encoding="utf-8", newline="\n")
    INVENTORY.write_text(json.dumps(inventory, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    print(f"Collected {len(records)} packages/components; {len(inventory['missing'])} need review.")
    for item in inventory["missing"]:
        print(f"MISSING {item['ecosystem']} {item['name']} {item['version']}: {item['missing']}")
    if args.strict and inventory["missing"]:
        print("Strict release notice check failed; review missing licenses before publishing.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
