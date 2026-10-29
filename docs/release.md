# Building a release

Source publication and binary distribution are separate checks. Keep the repository private until its current diff/history has been reviewed; do not publish a binary while its license inventory has unresolved items. See PUBLIC_READINESS.md.

## Prepare

1. Follow SETUP.md and verify the pinned runtime tools and patched agent. Commit source, lockfiles, notices and hashes together; executables stay out of Git.
2. Run the checks in CONTRIBUTING.md, plus the real-agent context protocol and Windows CDP acceptance suite. Test the installer on a separate Windows user profile or clean VM. Do not infer clean-machine support from an already configured development PC.
3. Run `python scripts/collect-notices.py --agent-source ../.agent-build/release-agent --strict`, pointing at the exact patched checkout used to build your agent. Use `build-agent.ps1 -SourceDirectory` to choose that checkout location. Keep installed frontend/browser/Python dependencies and Cargo metadata available. Review all missing components. Include their full copyright/license texts and upstream notices before distributing them. The generated inventory is evidence, not legal clearance.
4. Recheck the licenses for the exact model and other assets if you distribute any. LocalWORK does not bundle the Strata model weights.

## Version and signatures

Update package.json, package-lock.json, src-tauri/Cargo.toml, Cargo.lock and tauri.conf.json consistently. Release tags use v followed by the version.

The Tauri updater key is separate from a Windows Authenticode certificate. Keep the private signing key outside the repository and back it up securely. Generate it with `npm run tauri -- signer generate`; use the command's password prompt rather than putting a password into shell history. Store its public key in tauri.conf.json. Forks must replace both the key and the update endpoint before distributing their builds.

Use TAURI_SIGNING_PRIVATE_KEY and TAURI_SIGNING_PRIVATE_KEY_PASSWORD only in a trusted release environment. For GitHub builds, keep them in repository secrets, never files or workflow text. Do not expose secrets to pull-request workflows. The checked-in CI does not publish releases or use signing keys.

## Build

With dependencies and notices prepared, set the signing environment variables in your trusted release environment and run:

```powershell
npm ci
npm run tauri -- build
```

Unsigned local development uses `npm run tauri -- build --no-bundle` and does not publish an installer. The installer and its updater signature are produced under src-tauri/target/release/bundle/nsis. Authenticode signing, if used, is a separate distribution step.

The supported updater download is a signed Windows installer EXE. ZIP updater extraction is disabled, removing an unused vulnerable dependency. Do not publish ZIP update artifacts or enable that feature without reviewing its dependency advisories.

## Linux packages

The Linux build workflow (`.github/workflows/linux-release.yml`) builds unsigned AppImage, deb and rpm packages on Ubuntu 22.04 for every push to `main`, or on demand from the Actions tab. It checks that the bundled tools keep their executable bit and uses no secrets. Download its `linux-bundles` artifact with `gh run download <run id> -n linux-bundles`, then sign the AppImage on the trusted machine:

```bash
npx tauri signer sign -f <path to the private key> LocalWORK_<version>_amd64.AppImage
```

That writes `LocalWORK_<version>_amd64.AppImage.sig`. Add a `linux-x86_64` entry to latest.json whose URL is the AppImage and whose signature is the content of that file. Deb and rpm installs do not self-update. Put the deb's SHA-256 into `packaging/arch/PKGBUILD` (`sha256sums`) and the version into `pkgver`, then attach the PKGBUILD to the release before running the publish workflow.

The packages are large, so let GitHub copy them into the release instead of uploading them from your machine. After the release exists, run:

```bash
gh workflow run linux-publish.yml -f run_id=<run id> -f tag=v<version>
```

`.github/workflows/linux-publish.yml` downloads that run's `linux-bundles` artifact and the release's PKGBUILD, then uploads the AppImage, deb, rpm, PKGBUILD and `SHA256SUMS`. If a Windows run is supplied, its installer is included too. Use the same run whose AppImage you signed: a rebuilt AppImage has different bytes and the signature would not match. The job also prints the SHA-256 of each file, so you can compare it with the AppImage you signed. Upload the `.sig` and latest.json yourself. The checksum file does not cover signatures, latest.json, plugins or other manually attached assets.

Download `SHA256SUMS` and the covered assets into the same directory, then run `sha256sum -c SHA256SUMS`. This checks their bytes against the checksum file; it does not authenticate the file or replace updater signature verification.

The publish job also creates GitHub provenance attestations for the AppImage, deb, rpm, PKGBUILD, `SHA256SUMS`, and optional Windows installer. Verify each downloaded file, for example:

```bash
gh attestation verify LocalWORK_<version>_amd64.AppImage -R killianmiles27/LocalWORK
```

These attestations identify the **publish workflow**, which copies artifacts from separate Linux and Windows build runs and downloads the locally prepared PKGBUILD; they do not attest how those artifacts were built. The Windows workflow uploads a CI artifact, not release assets, so the publish job attests the installer when included. Signatures, latest.json and plugins attached separately are not covered by this job's attestations. Attestations do not replace updater signatures.

## Windows installer from any machine

The Windows build workflow (`.github/workflows/windows-release.yml`) builds the unsigned NSIS installer on a GitHub Windows runner, for every push to `main` or on demand. It fetches the pinned tools, builds the patched agent, installs the web libraries for Python 3.11 to 3.14 (`install-mcp-libs.ps1 -PythonVersions`, so no Strata is needed on the runner), and checks the installer contains the bundled tools. It uses no secrets, so you can release Windows from a Linux machine:

```bash
gh run download <windows run id> -n windows-installer
npx tauri signer sign -f <path to the private key> LocalWORK_<version>_x64-setup.exe
```

Add a `windows-x86_64` entry to latest.json whose URL is the installer and whose signature is the content of the `.sig`. Then pass the same run to the publish workflow, which copies the installer into the release next to the Linux packages:

```bash
gh workflow run linux-publish.yml -f run_id=<linux run id> -f windows_run_id=<windows run id> -f tag=v<version>
```

As with the AppImage, sign the installer from the same run you publish. Before a release, also install it on a real Windows PC or test account; the build checks do not run the app.

## Publish deliberately

After reviewing and testing the actual release artifacts, create a GitHub release for the matching tag. Attach the installer, its signature, and latest.json.

The installer is the plain app with no plugins. Plugins ship as separate assets: run `pwsh -NoProfile -File scripts/package-plugins.ps1`, then attach everything in `dist-plugins/`. That is `LocalWORK-recommended-plugins_<version>.zip`, which installs every gallery plugin in one import, plus one `<id>_<version>.zip` per plugin. The script reads a checkout of [LocalWORK-plugins](https://github.com/killianmiles27/LocalWORK-plugins) next to this repository (or pass `-Source <folder>`). Keeping plugins out of the installer means updates never overwrite or remove a user's plugins, and one updater feed serves everyone. No script here automatically makes the repository public or publishes a release.

```json
{
  "version": "0.1.0",
  "notes": "Describe this release's changes and known limitations.",
  "pub_date": "2026-10-17T00:00:00Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "CONTENTS OF THE GENERATED SIGNATURE FILE",
      "url": "https://github.com/OWNER/REPOSITORY/releases/download/v0.1.0/INSTALLER.exe"
    },
    "linux-x86_64": {
      "signature": "CONTENTS OF THE APPIMAGE SIGNATURE FILE",
      "url": "https://github.com/OWNER/REPOSITORY/releases/download/v0.1.0/LocalWORK_0.1.0_amd64.AppImage"
    }
  }
}
```

Use the real version, UTC publication time, repository URL, installer filename and signature. Check that the update feed, artifact URL and signature work on a disposable installation before announcing the release. Never remove signature checks to make an update install.

## Retained data and rollback

The per-user installer stores program files separately from %LOCALAPPDATA%/Workbench. Uninstall normally retains app data unless its deletion is selected. Project deliverables, Strata and model weights are external and must not be removed by uninstall.

The current in-app rollback saves executables and database backups; it does not restore a complete old resource tree. It is not a guarantee that an old executable works with newer runtime files. Keep full installer backups and test recovery before promising rollback compatibility.
