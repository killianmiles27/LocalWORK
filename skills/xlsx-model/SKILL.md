---
name: xlsx-model
description: Build spreadsheets with real formulas, clear headers and totals
---
1. Plan the layout: one header row, one record per row, units in the header, inputs separate from calculations.
2. Use formulas, never typed results: "formula":"C2-B2", totals as SUM(B2:B5). Percentages as a fraction with numberformat 0.0%. Money as #,##0.00.
3. Bold header row, bold Total row. Create the cells in one batch (see the built-in Excel recipe).
4. Verify: validate, then view the file as text and check that the computed values match what you expect by hand.
5. Say in the answer which cells hold formulas so the user can change the inputs.
