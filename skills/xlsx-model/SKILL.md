---
name: xlsx-model
description: Build spreadsheets with real formulas, clear headers and totals
---
1. Plan the layout: one header row, one record per row, units in the header, inputs separate from calculations.
2. Use formulas, never typed results: "formula":"C2-B2", totals as SUM(B2:B5). Percentages as a fraction with numberformat 0.0%. Money as #,##0.00.
3. Bold header row, bold Total row. Create the cells in one batch (see the built-in Excel recipe).
4. Verify: validate, then view the file as text and check that the computed values match what you expect by hand.
5. Say in the answer which cells hold formulas so the user can change the inputs.

For an attached workbook, inspect its sheet names, headers and formulas, then make a copy and preserve the original data. Do not rebuild a large source table cell by cell. Put only the requested rollup in a small summary table, with formulas that reference the copied source sheet, and chart that summary range. Example batch operations:

```json
[{"command":"add","parent":"/","type":"sheet","props":{"name":"Summary"}},
 {"command":"set","path":"/Summary/A1","props":{"value":"Month"}},
 {"command":"set","path":"/Summary/B1","props":{"value":"Total"}},
 {"command":"set","path":"/Summary/A2","props":{"value":"Jan"}},
 {"command":"set","path":"/Summary/B2","props":{"formula":"SUM('Source Data'!B2:B500)"}},
 {"command":"add","parent":"/Summary","type":"chart","props":{"chartType":"column","dataRange":"Summary!A1:B2","title":"Monthly total","anchor":"D2:J18"}}]
```

Replace the example sheet, ranges, labels and aggregation with values verified from the workbook. Use formulas over source ranges; expand the summary rows only to the number of categories requested. Batch operation results are summarized by the tool; if one fails, fix the first reported operation and rerun the batch.
