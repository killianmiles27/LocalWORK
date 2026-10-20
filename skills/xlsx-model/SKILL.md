---
name: xlsx-model
description: Build spreadsheets with real formulas, clear headers and totals
---
1. Load office-recipes. Start with tabular inspect for sheet names, headers, types and a small sample; aggregate named columns using explicit date formats when needed. Read only a bounded range for uncertainties. Do not write a ZIP parser or transcribe a table of expected results.
2. Preserve the source. Build a compact summary in a copied workbook with office_recipe table, using the aggregate dataset for keys and a formula_columns template per calculated column. Formulas must reference the copied source. The template substitutes row numbers without handwritten cell lists or generator scripts. For unsupported/custom structures, use one OfficeCLI batch.
3. Use appropriate numeric formats and units; percentages are fractions. Never invent a currency. Keep original source data and calculations separate.
4. Independently verify: aggregate source data once, read the output's evaluated range using officecli read-ranges, then tabular compare the saved datasets with explicit keys/columns and tolerance. Cached XML values may be stale. Resolve every mismatch; do not substitute constants for broken formulas or claim file validation proves calculations.
5. Verify the file, close it, show_document and identify formula locations. Keep the plan current at verified stages.
