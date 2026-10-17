# Notices

LocalWORK
Copyright 2026 LocalWORK contributors

LocalWORK's original code is licensed under Apache-2.0; see LICENSE. This does
not relicense third-party components or model weights. Full collected dependency
license texts and an inventory are under third-party/. Missing entries must be
resolved before distributing an installer.

The bundled aionrs agent is Apache-2.0, copyright 2026 iOfficeAI. LocalWORK modifies
its compaction prompt, summary limit/truncation handling, related tests, and
networking dependency lockfile. patches/aionrs-localwork.patch records the changes
against the exact source revision in vendor/manifest.json. Its upstream license
is retained in third-party/aionrs-LICENSE.txt. OfficeCLI's upstream license is
retained in third-party/officecli-LICENSE.txt.

Voice transcription uses whisper.cpp (MIT) and a quantized OpenAI Whisper small
model (MIT). OpenAI's model-weight license is retained in
third-party/upstream-cache/whisper-model-LICENSE.txt; model file hashes are in
vendor/manifest.json. These are distinct from the separately installed Strata
model, whose weights and license are not bundled by LocalWORK.

The interface follows common chat-app conventions (sidebar of recents, centered message column,
rounded composer, collapsible tool calls).

Open Intelligent UI (CopilotKit/OpenIntelligentUI, MIT, copyright Atai Barkai):
the theme, SVG helpers, form CSS, document assembly pattern and response playbook
are adapted from commit 8391a94c1c3939c679e40ddd7bfc08a9ef690e70.
Source: https://github.com/CopilotKit/OpenIntelligentUI
The full MIT license is included in src/vendor/open-intelligent-ui/LICENSE and
skills/intelligent-ui/LICENSE. See the vendored README for exact paths and local
changes. The upstream server, cloud router and CDN libraries are not included.

Office document previews reuse the already bundled OfficeCLI (Apache-2.0),
https://github.com/iOfficeAI/OfficeCLI (version and checksum in vendor/manifest.json).
HTML previews are approximations, rendered in an opaque-origin sandbox.

Third-party libraries used by the UI:
- lucide-react (ISC) - icons
- @tailwindcss/typography (MIT) - Markdown styling
- react-markdown, remark-gfm (MIT)
- Tailwind CSS (MIT), React (MIT), Tauri (MIT/Apache-2.0)
- sysinfo (MIT) - CPU and memory readings in Settings
- ddgs (MIT), httpx (BSD-3), beautifulsoup4 (MIT), markdownify (MIT), pypdf (BSD-3) - web search and page reading tools, installed into workbench-mcp/libs
