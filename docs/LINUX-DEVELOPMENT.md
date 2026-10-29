# Developing on Linux and building for Windows

Use one checkout for both operating systems. React/TypeScript, Rust and Python changes belong in the same branch. Platform-specific behavior uses Rust `cfg` branches and the corresponding Linux or PowerShell packaging scripts.

## Make a change

```bash
cd ~/Work/LocalWORK
git switch main
git pull --ff-only
git switch -c fix/short-description
npm ci
npm run tauri -- dev
```

The prerequisites and pinned runtime downloads are in [SETUP.md](SETUP.md). Run `bash scripts/fetch-vendor-linux.sh` when setting up a new development checkout; it downloads the tools and builds the patched agent. It does not download model weights. After changing `patches/aionrs-localwork.patch`, rebuild with `LOCALWORK_REBUILD_AGENT=1 bash scripts/fetch-vendor-linux.sh`.

Check the change before pushing:

```bash
npm run build
npm run test:workspace
python -m unittest discover -s scripts/tests -p 'test_*.py'
TAURI_CONFIG='{"bundle":{"resources":[]}}' cargo test --locked --lib --manifest-path src-tauri/Cargo.toml
git diff --check
git add <the-files-you-changed>
git commit -m "Fix the concrete problem"
git push -u origin HEAD
```

Use a Python virtual environment with `workbench-mcp/requirements-web.txt` installed. Open one pull request from that branch to `main`. GitHub **Checks** tests both Linux and Windows, including Windows Python library packaging. Wait for both jobs to pass, then merge. Updating the same branch updates its existing pull request; another pull request is unnecessary. Update local `main` with `git pull --ff-only` before the next change. Avoid force-pushing `main`.

If `gh` reports an invalid login, run `gh auth login --hostname github.com --web --git-protocol https`, then `gh auth setup-git`. GitHub account authentication must be completed by the account owner. The browser can also open and merge pull requests.

## Use an already tuned model

Keep the validated Strata profile and its engine pin. Start its existing launcher, then select **I run my own model server** in LocalWORK. Set its loopback port and complete context limit, including input and output. Choose a Python 3.11+ interpreter under **Settings → Model → Python for tools**; a legacy Strata source folder is unnecessary in this mode.

LocalWORK connects to that server and leaves its lifecycle to the launcher. Closing LocalWORK does not stop an external server; stop the server terminal with Ctrl+C to release its memory. Do not launch a second model instance. Hardware-specific profiles and absolute model paths stay outside this repository.

## Get the Windows installer

Every merge/push to `main` starts **Linux build** and **Windows build** in GitHub Actions. Windows runs on GitHub's Windows machine, so developing on Linux does not require Windows or cross-compiling locally. Both workflows also support **Run workflow** for a chosen branch, which is useful before merging packaging changes.

In **Actions → Windows build → the successful run → Artifacts**, download `windows-installer` and unzip it to find the setup EXE. Linux packages are in `linux-bundles`. Artifacts expire after seven days. A green Checks run verifies tests; a green Windows build verifies that an installer was actually produced. Check both.

These builds do not create a public release or update existing installations. For a release, bump all version files, build and test the exact artifacts, sign them on the trusted machine, and publish the matching tag and updater feed as described in [release.md](release.md). Test the Windows installer on a real Windows PC or clean VM before calling it desktop-validated. Keep the signing key outside Git.
