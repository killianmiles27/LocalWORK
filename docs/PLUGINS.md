# Plugins

Plugins keep the core app generic. Anything specific to one machine (model files, launch profiles, sensors, private skills) lives in a plugin folder, so the core can be published without private paths.

Plugins are **declarative**: a folder with a `plugin.json`. They inject no code into the UI or the Rust host. They can add model modes, skills, system-prompt text, stdio MCP servers and composer status items. Only install plugins you trust. Third-party plugins can add system-prompt text and skills even if they don't start programs.

Code: `src-tauri/src/plugins.rs` (loading, modes, effort), `src/StatusItems.tsx` (status bar), `src/ModeSwitcher.tsx` (mode and effort menu), `src/SettingsModel.tsx` (Plugins and Tuning tabs in Settings), `src/settings-ui.tsx` (shared Settings rows, sections and switches).

## Where plugins are found

| Order | Folder | Source label |
|---|---|---|
| 1 | `<app resources>/plugins` | bundled (empty in official builds; for custom builds) |
| 2 | Windows: `%LOCALAPPDATA%/Workbench/plugins`; Linux: `$XDG_DATA_HOME/Workbench/plugins` (usually `~/.local/share/Workbench/plugins`) | user (installed with Import, or copied in) |

A later folder overrides an earlier plugin with the same `id`. The app ships without plugins. The official plugins live in [LocalWORK-plugins](https://github.com/killianmiles27/LocalWORK-plugins), one folder per plugin, and Settings → Plugins → *Get plugins* installs from it (see *Sharing plugins* below). Keep personal plugins (your model paths, your profiles) in a separate private repository; [MAINTAINING.md](MAINTAINING.md) describes that setup.

## plugin.json

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "description": "One line shown in Settings → Plugins.",
  "enabledByDefault": true,
  "settings": [
    { "key": "pricePerKwh", "label": "Price per kWh", "type": "number", "default": 0.17, "help": "Shown under the field." }
  ],
  "contributes": {
    "modes": [
      { "id": "fast", "group": "My model", "label": "Fast · 32K", "description": "Short tasks.", "config": "${strataRoot}/profiles/Fast.json" }
    ],
    "skills": "skills",
    "systemPrompt": "prompt.md",
    "mcpServers": { "mytools": { "command": "${pluginDir}/server.exe", "args": [], "env": {} } },
    "statusItems": [
      { "id": "cpu", "label": "CPU", "source": "host:system_stats", "value": "cpu.load", "unit": "%", "secondary": "cpu.temp", "secondaryUnit": "°C", "warn": 85, "secondaryWarn": 85 }
    ]
  }
}
```

- `id`: 1–64 characters from letters, digits, `-`, `_` and `.`. This is required.
- **Paths:** use `/`, or `\\` inside JSON. A single `\` is an invalid JSON escape and the whole manifest fails to load. Settings → Plugins shows such a plugin as *Not loaded* with the parser error.
- **Placeholders:** `${pluginDir}`, `${dataDir}` (`%LOCALAPPDATA%/Workbench` on Windows; `$XDG_DATA_HOME/Workbench` on Linux, usually `~/.local/share/Workbench`), `${strataRoot}` (from settings) and `${env:NAME}` are all expanded. A relative path resolves against the plugin folder.
- **Enabling:** `enabledByDefault: false` keeps a plugin off until the user turns it on. The on/off state is stored in `settings.json` as `enabledPlugins` / `disabledPlugins`, written atomically. A plugin that declares `mcpServers` is always imported turned off, because it starts programs.
- **Settings:** `settings` adds fields (`type` is `number`, `text` or `boolean`) to the plugin's entry in Settings → Plugins. Values are stored per plugin in `settings.json` and can be used in status items as `${setting:key}`.

## Contributions

| Key | What it does | When it applies |
|---|---|---|
| `modes` | Adds entries to the mode menu. Each points at a Strata run config; the context size is read from its `--max-context`. | Immediately |
| `skills` | A folder of `<name>/SKILL.md` skills. Core skills come first; on a name clash the first one wins. The folders reach `load_skill` as an `os.pathsep`-joined `WORKBENCH_SKILLS`. | Next new chat |
| `systemPrompt` | A text file appended to the system prompt, capped at 4,000 characters per plugin. | Next new chat |
| `mcpServers` | Stdio MCP servers added to each chat's agent. The name `workbench` is reserved. | Next new chat |
| `statusItems` | Small readouts in the composer bar. `value`, `secondary` and `pct` are dotted paths into the source's JSON. `warn` thresholds turn the value amber. | After reopening the app |

**Status sources are allowlisted.** A plugin can only name host sources listed in `HOST_SOURCES` in `src/StatusItems.tsx`:
- `host:system_stats`: `cpu.load`, `cpu.temp`, `ram.used_gib`, `ram.pct`, `gpu.load`, `gpu.temp`, `gpu.vram_used_gib`, `gpu.vram_pct`.
- `host:power_stats`: an electricity estimate computed from the plugin's own settings (`pricePerKwh`, `cpuWatts`, `baseWatts`, `currency`): `watts`, `cost_per_hour`, `price_per_kwh`, `task.cost` (the current or last task), `session.cost`.

A `tooltip` can include `${path}` values from the source. To add a source, write a read-only Tauri command, register it in `lib.rs`, then add it to the allowlist. Never allowlist a command that changes state.

Run configs in `<strataRoot>/profiles` and root-level model configs remain discoverable even when no plugin names them. Settings → Tuning → *Duplicate* creates a profile. The chat picker groups configs by their `model_name` (optional `model_display_name` supplies the label) and opens context profiles beside each model. Settings → Model controls which profiles appear; hiding never deletes the config or removes it from tuning.

## Mode switching and effort

- `modes_list` returns all modes plus the effective reasoning effort. Each mode has `modelId`, `modelLabel`, `profileLabel`, `local` and `pickerVisible`; apply visibility only to the chat picker.
- `mode_switch {id, reload}` points `modelConfig` at the mode's config. With `reload`, it restarts Strata, and only one model instance ever runs.
- `effort_set {effort}` changes the running server's shared default (`none|low|medium|high`) with no reload. `null` reverts to the run config's value.

## Run configs from Settings

`run_config_read` and `run_config_save` (in `src-tauri/src/runconfig.rs`) only touch the current config, a mode's config or a file in the profiles folder:
- Saving over an existing file backs it up first (`.json.bak-<unix time>`).
- The editor cannot change `exe`, `cwd`, `lib_dirs` or `env`.
- *Duplicate* (Settings → Tuning) writes `<profiles>/<name>.json` and gives the copy its own engine log.

## The official plugins

- `system-stats` shows CPU, RAM, GPU and VRAM readouts. A sensor the machine cannot read shows a dash. Many desktops (AMD Ryzen in particular) expose no CPU temperature to Windows without a kernel driver, so there the CPU temperature shows a dash.
- `power-cost` shows what each task costs in electricity. GPU watts are measured with `nvidia-smi`; the CPU's share is its rated watts scaled by its load; the rest of the machine is a fixed figure you set. It is an estimate, not a meter reading. Off by default.

## Sharing plugins

- **Import:** Settings → Plugins → *Import .zip* or *Import folder*. The zip or folder can hold one plugin (its `plugin.json` at the top or in one subfolder) or a pack: several subfolders, each with a `plugin.json`. Importing replaces an installed copy with the same `id`.
- **Export:** each plugin's *Export* button writes a zip that Import accepts.
- **Get plugins:** Settings → Plugins → *Get plugins* lists every folder with a `plugin.json` in the GitHub repositories you add (`owner/repo`, a repository link, or a `/tree/<branch>/<folder>` link). The official repository is listed by default. *Install* downloads the repository from GitHub and imports that folder like *Import folder…*; when the repository has a higher `version` than the installed copy, the button reads *Update*. Progress shows connection, ZIP bytes and extraction beside the plugin being installed. Plugins that start programs arrive turned off. The list of repositories is saved as `pluginSources` in `settings.json`. Nothing is fetched while offline mode is on.
- **Publish:** put the plugin in a public GitHub repository, one folder per plugin with the folder name equal to the `id`, and share the link. For an official plugin, open a pull request on [LocalWORK-plugins](https://github.com/killianmiles27/LocalWORK-plugins). `scripts/package-plugins.ps1` (reading a checkout of that repository) writes `dist-plugins/<id>_<version>.zip` for each plugin and `LocalWORK-recommended-plugins_<app version>.zip` with all of them, for the release.

## Checklist for a new plugin

1. Create the folder and `plugin.json`, then validate it: `python -c "import json;json.load(open('plugin.json'))"`.
2. Drop the folder into the user plugins folder and open Settings → Plugins. Confirm it is listed, not marked *Not loaded*, and that its contribution tags appear.
3. For modes: open the model menu and check that model/profile labels and context appear and that `found` is true. A missing config file shows as unavailable. Confirm the profile is checked in Settings → Model if it is hidden from the picker.
4. For skills, prompt text or MCP: start a **new** chat.
5. Keep machine paths, logs and benchmark output in the plugin, never in `app/`.
