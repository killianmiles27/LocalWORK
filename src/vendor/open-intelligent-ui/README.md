# Open Intelligent UI — offline subset

Source: https://github.com/CopilotKit/OpenIntelligentUI
Pinned commit: `8391a94c1c3939c679e40ddd7bfc08a9ef690e70` (retrieved 2026-10-16).
License: MIT, copyright Atai Barkai; see LICENSE.

`design-system.ts` contains the theme, SVG helpers and form CSS from
`packages/design-system/src/index.ts`. The CDN import map and duplicate streaming
styles were excluded. `../../intelligent-ui.ts` adapts `apps/mcp/src/renderer.ts`:
offline CSP, opaque sandbox, bounded resize messages, and follow-ups staged for
explicit review in the normal composer. It does not auto-send messages or open URLs.
The upstream response playbook is preserved under `skills/intelligent-ui/`.

LocalWORK uses its existing agent and MCP transport. It does not ship the upstream
Next.js/FastAPI application, cloud visualization router, remote libraries, or
Websandbox streaming runtime. Native charts/tables remain available alongside the
upstream-styled interactive UI. Updates to these pinned files require source and
license review; do not automatically fetch `main` during startup or builds.
