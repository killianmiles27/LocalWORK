# Skills

Task recipes the agent loads with `load_skill` when a task calls for one. Each folder holds a `SKILL.md`: front matter with `name` and `description`, then short instructions. The system prompt (`src-tauri/system-prompt.md`) says when to load which. Plugins can add more skills (see [docs/PLUGINS.md](../docs/PLUGINS.md)).

| Skill | Use |
|---|---|
| officecli-basics | Word, Excel and PowerPoint through the `officecli` tool |
| academic-docx | Essays and papers with academic formatting |
| document-template | Fill a user's .docx/.pptx/.xlsx template or match an example's format |
| verify-document | Check an Office file against the original requirements before presenting it |
| check-my-work | Independently check finished deliverables against the request and sources |
| pptx-deck | Slide decks |
| xlsx-model | Spreadsheet models with formulas |
| sources-on-numbers | Carry source cells, rows and pages through calculations into reports |
| intelligent-ui | Dashboards, calculators and forms rendered in the chat |
| research | Multi-source web research |
| citations | Reports with a source ledger and numbered citations, and fact-checking |
| blocked-pages | Archives and fallbacks when a page is blocked, paywalled or gone |
| arxiv | Search and cite scientific papers on arXiv |
| action-items | Decisions, deadlines and owners from notes, meetings and documents |
| email | Summarise email exports, extract actions and draft replies locally |
| knowledge-base | A linked markdown wiki built from the user's sources |
| local-search | Index/search a workspace offline with `index_workspace` / `search_workspace`, then open and cite only the best sources |
| debugging | Root-cause debugging before changing code |
| coding | Working in a code project |
| ssh-admin | Servers the user has added in Settings |
| model-tuning | Measure this PC and write faster Strata launch profiles as switchable modes |

citations, blocked-pages, arxiv, action-items, knowledge-base and debugging are adapted from [Hermes Agent](https://github.com/NousResearch/hermes-agent) skills (MIT, Nous Research); see [NOTICE.md](../NOTICE.md).

Keep skills short. Every line is read by a local model with a limited context. Do not add skills tied to one website or benchmark.
