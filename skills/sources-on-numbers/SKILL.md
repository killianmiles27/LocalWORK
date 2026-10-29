---
name: sources-on-numbers
description: Trace numbers in generated reports and tables to source cells, rows or pages
---

Read the source before calculating. For spreadsheet formulas use `officecli` `read-ranges` to obtain evaluated values, file fingerprint, sheet, range, row and cell references; do not treat saved formula caches as evaluated. For other data use `tabular` and retain the file and row references; for web/PDF sources record the URL or file and exact page or location yourself.

Carry each figure's returned `sources` through every sum, mean, count, min/max, grouping and comparison. Check `sources_truncated` and each reference's `truncated` flag: do not present a partial list as complete. Saved dataset lineage is bounded and source fingerprints are checked; re-read changed inputs. Cell precision is available only where explicit cell references were retained; otherwise identify row-level sources honestly.

When creating a document or table with `office_recipe`, pass `sources` as an array of `{figure, value, references:[{file, sheet, range, rows, page, ...}]}`. Use the returned references without inventing extra precision; include a URL in `file` for a web page. Include every derived figure explicitly. If no reference is known, supply an empty `references` array: the output labels it `source not supplied`. A number without a source must be labelled as such. Verify values, references and the final document; the Sources notes are not independently fact-checked.
