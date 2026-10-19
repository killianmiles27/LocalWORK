# LocalWORK plugins

This folder is the public plugin gallery (Settings → Plugins → *Browse shared plugins* opens it). The app itself ships without plugins. Pick the ones you want here.

| Plugin | What it adds | Default |
|---|---|---|
| [system-stats](system-stats/plugin.json) | CPU, RAM, GPU and VRAM load and temperature in the composer bar. Sensors the machine cannot read show a dash. | on |
| [power-cost](power-cost/plugin.json) | What each task costs in electricity, based on measured GPU watts, the CPU's rated watts scaled by its load, and your price per kWh. It is an estimate, not a meter reading. | off |

## Install

- **All recommended plugins:** download `LocalWORK-recommended-plugins_<version>.zip` from the [latest release](https://github.com/killianmiles27/LocalWORK/releases/latest), then choose Settings → Plugins → *Import .zip…* and pick it. One import installs every plugin in it.
- **One plugin:** download `<id>_<version>.zip` from the release, or copy the plugin's folder from this repository, then use *Import .zip…* or *Import folder…*.
- **Remove or turn off:** Settings → Plugins. Turning a plugin off keeps its settings, and *Remove* deletes its folder.

If a plugin starts programs on your computer (it declares MCP servers), it is installed turned off. Turn it on only if you trust where it came from.

## Make your own

A plugin is a folder holding a `plugin.json`, with no code injected into the app. See [docs/PLUGINS.md](../docs/PLUGINS.md) for the format. *Export* in Settings → Plugins zips any plugin so you can share it.

To add a plugin to this gallery, open a pull request with its folder. The folder name must match its `id`, and it must contain no personal paths, keys or logs. Releases are packaged with `scripts/package-plugins.ps1`.
