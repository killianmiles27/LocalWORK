#!/usr/bin/env bash
# Install the pinned Linux x64 runtime tools into vendor/ (the Linux counterpart of fetch-vendor.ps1
# and build-agent.ps1). Every download is checked against a pinned SHA-256 before it is used.
# Needs: curl, tar, xz, git, cargo, npm, python3 with pip.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
vendor="$root/vendor"
work="$(mktemp -d -t localwork-vendor-XXXXXX)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$vendor"

verify() { # file sha256
  echo "$2  $1" | sha256sum -c --status || { echo "Checksum mismatch for $1" >&2; exit 1; }
}
fetch() { # url dest sha256
  if [ -f "$2" ] && echo "$3  $2" | sha256sum -c --status; then echo "$(basename "$2") already present and verified"; return; fi
  curl -fL --retry 3 -o "$work/download" "$1"
  verify "$work/download" "$3"
  mkdir -p "$(dirname "$2")"
  mv "$work/download" "$2"
}

# OfficeCLI 1.0.157 (hash from the release's SHA256SUMS).
fetch https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.157/officecli-linux-x64 \
  "$vendor/officecli" f8eefe88dbfa7464bee421e5421efe57fc26bc3180b30e56eef58594c8245c94
chmod 755 "$vendor/officecli"

# whisper.cpp b5454 CPU build. Symlinked libraries are copied as plain files so bundling keeps them.
model_sha=ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb
if [ ! -x "$vendor/whisper/whisper-cli" ]; then
  fetch https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-ubuntu-x64.tar.gz \
    "$work/whisper.tgz" a72becf15d7917f990f6313867a52638b82b7f9ef237fb0c980dac56a135781c
  tar -xzf "$work/whisper.tgz" -C "$work"
  mkdir -p "$vendor/whisper"
  src="$work/whisper-bin-ubuntu-x64"
  cp -L "$src/whisper-cli" "$src/LICENSE" "$vendor/whisper/"
  for f in "$src"/*.so*; do cp -L "$f" "$vendor/whisper/"; done
fi
fetch https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small-q5_1.bin \
  "$vendor/whisper/ggml-small-q5_1.bin" "$model_sha"

# Node.js 24.22.0 (hash from the release's SHASUMS256.txt).
if [ "$("$vendor/node/node" --version 2>/dev/null || true)" != "v24.22.0" ]; then
  fetch https://nodejs.org/dist/v24.22.0/node-v24.22.0-linux-x64.tar.xz \
    "$work/node.tar.xz" cc2f601cee82d9a5a233302fe307abc600727035fd7d2c3a3571755989e95008
  tar -xJf "$work/node.tar.xz" -C "$work"
  mkdir -p "$vendor/node"
  cp "$work/node-v24.22.0-linux-x64/bin/node" "$work/node-v24.22.0-linux-x64/LICENSE" "$vendor/node/"
fi

# Playwright CLI from the locked package list, and its headless Chromium.
mkdir -p "$vendor/playwright"
cp "$root/scripts/vendor-browser/package.json" "$root/scripts/vendor-browser/package-lock.json" "$vendor/playwright/"
(cd "$vendor/playwright" && PATH="$vendor/node:$PATH" npm ci --no-audit --no-fund)
PLAYWRIGHT_BROWSERS_PATH="$vendor/browsers" "$vendor/node/node" "$vendor/playwright/node_modules/playwright-core/cli.js" install chromium-headless-shell
find "$vendor/browsers" -name chrome-headless-shell -type f -perm -u+x | grep -q . || { echo "Headless Chromium did not install" >&2; exit 1; }

# The patched agent, built from the pinned revision (same steps as build-agent.ps1).
if [ ! -x "$vendor/aionrs" ] || [ "${LOCALWORK_REBUILD_AGENT:-}" = 1 ]; then
  git clone --depth 1 --branch v0.2.11 https://github.com/iOfficeAI/aionrs.git "$work/aionrs"
  [ "$(git -C "$work/aionrs" rev-parse HEAD)" = 8e61a90329fa9f67c4fdf7e97fe02c24dba33f75 ] || { echo "Agent source is not the pinned revision" >&2; exit 1; }
  git -C "$work/aionrs" apply "$root/patches/aionrs-localwork.patch"
  (cd "$work/aionrs" && cargo build --locked --release -p aion-cli)
  cp "$work/aionrs/target/release/aionrs" "$vendor/aionrs"
fi

# Web tool libraries for the workbench MCP server. The model's Python version differs between
# distributions, so binary wheels for several CPython versions go into one folder: their compiled
# modules carry the version in the file name and sit side by side. Each version is installed into its
# own staging folder and merged without overwriting: pip --target --upgrade replaces whole package
# folders, which would delete the compiled modules of every version installed before it.
libs="$root/workbench-mcp/libs"
mkdir -p "$libs"
for v in 3.12 3.13 3.11 3.14; do
  stage="$work/libs-$v"
  if ! python3 -m pip install --disable-pip-version-check --no-input --only-binary=:all: \
    --implementation cp --python-version "$v" --platform manylinux2014_x86_64 --platform manylinux_2_28_x86_64 \
    --requirement "$root/workbench-mcp/requirements-web.txt" --target "$stage"; then
    case "$v" in 3.12|3.13) echo "Web libraries for Python $v failed" >&2; exit 1;; *) echo "No wheels for Python $v; skipped"; continue;; esac
  fi
  (cd "$stage" && find . -type f -print0) | while IFS= read -r -d '' f; do
    [ -e "$libs/$f" ] || { mkdir -p "$(dirname "$libs/$f")"; cp -p "$stage/$f" "$libs/$f"; }
  done
done

echo "Pinned Linux vendor setup verified"
