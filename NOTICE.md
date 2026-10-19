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

Open Intelligent UI declarative components (thesysdev/open-intelligent-ui, MIT, commit
03213439358bf3408ad61a46ec9e3230c5572e48, https://github.com/thesysdev/open-intelligent-ui):
the render_ui component vocabulary, expression/function-library semantics and button-action
model are re-implemented in src/ui-runtime.ts (no upstream files are bundled).

  MIT License - Copyright (c) 2026 Thesys Inc.
  Permission is hereby granted, free of charge, to any person obtaining a copy of this
  software and associated documentation files (the "Software"), to deal in the Software
  without restriction, including without limitation the rights to use, copy, modify, merge,
  publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons
  to whom the Software is furnished to do so, subject to the following conditions: The above
  copyright notice and this permission notice shall be included in all copies or substantial
  portions of the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
  EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
  FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
  HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
  CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
  USE OR OTHER DEALINGS IN THE SOFTWARE.

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

Hermes Agent (NousResearch/hermes-agent, MIT, copyright 2025 Nous Research): the
citations, blocked-pages, arxiv, action-items, debugging and knowledge-base skills
are shortened adaptations of its grounded-citations, blocked-page-recovery, arxiv,
document-to-action-items, meeting-action-items, systematic-debugging and llm-wiki
skills. Its license is retained in third-party/hermes-agent-LICENSE.txt.
Source: https://github.com/NousResearch/hermes-agent
