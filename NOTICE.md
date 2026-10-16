# Notices

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
