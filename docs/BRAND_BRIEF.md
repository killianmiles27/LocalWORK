# Claude Design brief: full rebrand of the local AI desktop app (currently "LocalWORK")

Start from scratch on identity; keep the interface style described below.

## What the product is
A private, local-first AI assistant for Windows. One launch, a model runs on the user's own machine, nothing leaves it.
It chats, researches the web, reads and writes documents, spreadsheets and slides, and makes small interactive visuals.
Audience: curious non-experts who want a capable assistant without accounts, subscriptions or cloud.

## Deliverables
1. A new product name (6 candidates, 1 recommended; check it is not an obvious existing AI product). It should feel calm, local, sturdy, a little mountain-like.
2. Logo: 3 concepts, then 1 refined mark. Must work at 16px (tray, title bar), as a monochrome mark, and on light and dark. Ideas worth exploring: a glyph-dithered peak, a single ridge line, a hex/glyph cell that forms a summit.
3. Wordmark and typography (Manrope is the current UI font; keep it or propose a pairing).
4. Color system, light and dark, with tokens (below is the starting point).
5. App icon (Windows .ico sizes), installer/splash artwork, empty-state and onboarding illustration direction.
6. Voice: one-line tagline, 3 short UI microcopy examples (greeting, empty chat, "thinking").
7. Motion rules.

## Design language we arrived at (keep)
- Flat. No gradients, no heavy shadows, no glassy cards. Thin 1px borders.
- A dithered-glyph mountain (hex characters 0-9 a-f as grain) painted behind everything: a castle on the left under an Alpine ridge, faint but legible, drawn once, no animation loop.
- Text sits on only a whisper of frosted backing (about 3px blur, 14% tint), feathered and rounded, so the mountain shows through.
- Compact, quiet type scale (13px body), Manrope.
- Delight, not noise: instant, lag-free sidebar collapse; no cursor or click effects (a text wave was tried and rejected).
- No icon rail, no Chat/Work switch. A collapsible chats sidebar only.
- Performance is part of the brand: nothing that burns CPU/GPU at rest.

## Color starting point (tokens)
| token | light | dark |
|---|---|---|
| bg | #f4f1ea | #171717 |
| panel | #ece8de | #1c1c1c |
| panel-2 | #e2ddd0 | #262628 |
| line | #dedacc | #2b2b31 |
| ink | #22212b | #ececf1 |
| muted | #7a778a | #8d8d9a |
| accent (indigo, keep) | #3a47c4 | #9fb0ff |
| mountain ink | #3a47c4 | #9fb0ff |
| ember (extra) | #d9663a | #ff9a6b |
| sage (extra) | #3f8f6b | #7fd0a4 |
| gold (extra) | #c9962b | #f0c36a |
The indigo palette is liked and stays the core. Teal was tried and rejected. Propose additional supporting colors that sit with it.

## Constraints
- Windows desktop (Tauri), offline-first; assets as SVG/PNG/ICO, no web fonts beyond bundled ones.
- Name must be pronounceable and short enough for a title bar.
