# Third-party notices

LocalWORK's root LICENSE applies to its original code. It does not replace the licenses of dependencies, fonts, bundled tools, browser components, or model weights.

- `aionrs-LICENSE.txt` and `officecli-LICENSE.txt` retain the pinned upstream Apache-2.0 texts.
- `dependency-notices.txt` contains full collected license/copyright texts, deduplicated by content hash, with component names and provenance.
- `dependency-inventory.json` records versions, declarations, notice links, component availability and unresolved entries.
- `upstream-cache/manifest.json` records exact upstream sources/revisions and SHA-256 hashes for license texts missing from published packages. Cached texts preserve their upstream copyright notices.

Regenerate the inventory from prepared runtime/build dependencies:

```powershell
python scripts/collect-notices.py --agent-source ../.agent-build/release-agent --strict
```

Point `--agent-source` at the exact patched checkout used to build the shipped executable. The collector runs offline; prepare Cargo metadata first if needed. Missing installed components, declarations or license texts fail strict mode. Do not remove or ignore missing entries just to make a release pass.

The inventory intentionally includes build-time and platform-specific metadata as well as bundled runtime components. Its `complete` flag means the configured collection checks found their required inputs and license texts. It does not prove that every possible distribution obligation has been fulfilled or that every listed crate is linked into the Windows app.

For installer distribution, review the exact files actually shipped. Some components have MPL/LGPL terms or corresponding-source requirements; preserving a license file alone may not fulfill those obligations. Keep source locations and build provenance available. Review new dependencies and updated binaries again before release.

Strata's inference model weights are external and have their own licenses. The voice model is a separate quantization of OpenAI Whisper; its original MIT model-weight license is included in the cache and inventory.
