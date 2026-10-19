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
    }
  }
}
```

Use the real version, UTC publication time, repository URL, installer filename and signature. Check that the update feed, artifact URL and signature work on a disposable installation before announcing the release. Never remove signature checks to make an update install.

## Retained data and rollback

The per-user installer stores program files separately from %LOCALAPPDATA%/Workbench. Uninstall normally retains app data unless its deletion is selected. Project deliverables, Strata and model weights are external and must not be removed by uninstall.

The current in-app rollback saves executables and database backups; it does not restore a complete old resource tree. It is not a guarantee that an old executable works with newer runtime files. Keep full installer backups and test recovery before promising rollback compatibility.
