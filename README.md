# LocalWORK

A Windows desktop assistant for working with files, researching on the web, and creating documents with a model running on your own computer.

LocalWORK is in alpha. A small ALPHA badge beside the app name identifies this development stage.

LocalWORK uses [Strata](https://github.com/Niko1221/Strata) for inference (or [PolyStrata](https://github.com/VecSzn/PolyStrata) for models beyond Qwen), a local agent for tool use, and a background Chromium browser for interactive websites. There is no hosted model service or subscription built into the app. You install the model separately.

**Yes, this is vibe-coded slop.** It was built heavily with AI assistance and is still a work in progress. Expect bugs, especially on long tasks, and check generated work before relying on it. Windows x64 is the supported target.

## What it does

- Chats tied to a working folder, with file attachments and saved conversation history.
- A searchable chat sidebar grouped by date, with pin and rename. You can edit an earlier message or regenerate the last reply, and keyboard shortcuts cover the common actions.
- Compact CSV/TSV/Excel inspection, reusable aggregates and evaluated-value comparisons, plus validated Word and Excel construction recipes.
- Word, Excel, and PowerPoint creation through OfficeCLI, with directly editable previews, document zoom, revision history, and an optional Check related files button after saved edits.
- Web search, page reading, browser interaction, and screenshots.
- Tables, charts, diagrams, and small interactive HTML documents.
- Local voice transcription through whisper.cpp.
- Optional SSH access to servers you add yourself.
- Context usage estimates, automatic compaction, bounded recovery from interrupted generation, and a Stop button. Unfinished plans remain visibly paused.
- Markdown chat downloads include saved thinking, tool durations and per-request timing/token diagnostics. Live thinking follows new output until you scroll up.
- Plugins for model modes, skills, status readouts and tools, imported and exported as zips. Install them from Settings → Plugins → *Get plugins*, which lists the [official plugins](https://github.com/killianmiles27/LocalWORK-plugins) and any GitHub plugin repository you add.
- Office templates: attach a company template or example document, and results come back in that format.

## Getting started

Start with the [setup guide](docs/SETUP.md). It covers Strata, model configuration, building the app, and the first-run wizard. Once installed, see the [usage guide](docs/USAGE.md). Optional extras, such as a CPU/GPU bar and an electricity cost per task, are [plugins](https://github.com/killianmiles27/LocalWORK-plugins). Running a customized copy on several PCs is covered in [MAINTAINING.md](docs/MAINTAINING.md).

The repository contains source and build scripts. Model weights and runtime executables are not checked in. An app build needs the pinned tools described in [vendor/README.md](vendor/README.md).

## Before you give it a task

Automatic mode is on by default. It lets ordinary work proceed without repeated approval prompts. The app still asks about recognized destructive or consequential actions, but those checks are heuristics. **The agent is not an OS sandbox:** tools run with your Windows user's permissions. Use a separate working folder, keep backups, and use a VM or separate account for untrusted work.

Model inference is local. Web searches, websites, downloads, updates, and SSH use the network. Browser profiles and chats are stored locally and are not encrypted by LocalWORK. See [SECURITY.md](SECURITY.md) for the boundaries and reporting instructions.

## Development

Windows build prerequisites and commands are in [docs/SETUP.md](docs/SETUP.md#build-from-source). Start with `npm ci`, the pinned tool setup, and `npm run tauri -- dev`. Run `npm run build`, `npm run test:workspace`, and `cargo test --locked --lib --manifest-path src-tauri/Cargo.toml` before opening a pull request. Python tool tests are listed in [CONTRIBUTING.md](CONTRIBUTING.md).

## Current limits

- Hardware and model support depend on Strata. A model that loads successfully can still be too slow for practical agent work.
- Long workflows can repeat steps or lose useful detail during compaction. There is no broad task-success guarantee.
- Office previews approximate layout. Word page counting needs a working Word installation and may time out.
- The browser runs in the background. Its network filters do not provide complete private-network isolation.
- macOS and Linux builds have not been implemented or tested.

## License

LocalWORK is licensed under [Apache-2.0](LICENSE). Dependencies, bundled tools, fonts, and model weights retain their own licenses. See [NOTICE.md](NOTICE.md) and [third-party](third-party/). The app does not grant rights to third-party models or trademarks.
