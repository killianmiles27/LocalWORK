# Maintaining LocalWORK across machines

This guide is for running your own customized LocalWORK on more than one PC while also contributing to the public app. The idea is to keep three things apart.

| Thing | Lives in | Contains | Shared |
|---|---|---|---|
| **Core app** | this repository | code, general skills, gallery plugins, docs | public (GitHub) |
| **Your setup** | a private repository of your own, e.g. `personal-plugins/` | plugins with your model paths, per-PC launch profiles, private skills | private (your machines only) |
| **Installed app** | an install folder per PC | the built app, updated from a release or deployed from the core repository | not in Git |

Rule of thumb: if a change would work unchanged on a stranger's PC, it belongs in the core app. If it names your hardware, your paths or your models, or reflects only your taste, it belongs in your private repository as a plugin. Plugins can add model modes, skills, system-prompt text, MCP servers and status items (see [PLUGINS.md](PLUGINS.md)), so personal setup never needs a fork.

## Folder layout

```
LocalWORK/                    any parent folder
  app/                        clone of this repository (public)
  personal-plugins/           your private repository
    my-model/plugin.json      a plugin with your mode menu, e.g. Sprint, 64K, 128K
    machines/<COMPUTERNAME>/profiles/*.json   each PC's tuned Strata run configs
    sync.ps1                  installs plugins and this PC's profiles
```

A `sync.ps1` for this layout:
- copies every plugin folder (and, optionally, the gallery plugins from `app/plugins`) into `%LOCALAPPDATA%\Workbench\plugins`;
- copies `machines\<COMPUTERNAME>\profiles\*.json` into the Strata `profiles` folder;
- backs up whatever it replaces.

With `-Collect`, it copies the current PC's Strata profiles back into the repository instead. Modes in your plugin point at `${strataRoot}/profiles/<Name>.json`, so the same plugin works on every PC as long as each PC has its own profiles with the same names.

## Daily work

1. Change the core in `app/`, then build and test (see [CONTRIBUTING.md](../CONTRIBUTING.md)).
2. Update the copy you use every day without reinstalling: close LocalWORK, then run
   ```powershell
   npm run tauri -- build --no-bundle
   pwsh -NoProfile -File scripts/deploy-local.ps1 -Destination '<your install folder>'
   ```
   The script backs up the installed files first, copies the build and its resources, and verifies each copy by hash. It never touches app data, settings, chats or models.
3. Commit and push general changes. Commit personal changes to the private repository, then run `sync.ps1` on each PC.

## Adding a second PC

1. Install LocalWORK from the latest release, or build it from `app/`.
2. Install Strata. The first-run wizard walks you through it.
3. Clone your private repository and run `sync.ps1` to install your plugins.
4. Ask LocalWORK to *tune yourself for this PC*. The model-tuning skill writes profiles for this hardware. Give them the names your plugin's modes expect, then run `sync.ps1 -Collect` and commit, so the PC's profiles are kept.

## Cleaning up

Keep build output, logs, benchmark results and old notes out of `app/`. They belong in ignored folders or outside the repository. `deploy-local.ps1` lists files that an older version installed and a newer one no longer ships, in `$retiredFiles`. It removes those files after backing them up.
