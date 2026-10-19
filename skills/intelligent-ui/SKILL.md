---
name: intelligent-ui
description: Interactive explanations, dashboards, comparisons, calculators, forms and small tools using Open Intelligent UI.
---

Prefer `render_ui` (title, spec, state?) for dashboards, calculators, forms and
comparisons: a compact JSON spec, no HTML. Use `assemble_document` (title,
description, html fragment) only for bespoke visuals. Use plain text for simple
answers. Label sample data and assumptions; never invent retrieved facts.

Node: `{"t":"Col","gap":3,"c":[...]}`. A plain string is text. Types:
Col Row(justify) Grid(cols) Card(title) Tabs(items:[{label,c}]) Divider Title Text
Caption Badge(tone info|success|warning|danger) List(items) Markdown(text; **b** *i*
`code` [t](https://..) - lists #heads) Link(href,text; http(s), opens in the browser after the user confirms) Code Table(columns,rows,sortable) Chart(kind bar|line|area|
pie|donut|scatter, data, x, y:[..]) Stat(label,value,delta) Progress(value,max)
Svg(w,h,c:[Rect Circle Line Path Text]) Flashcard(front,back) Timer(seconds)
Button(label,action,variant:"primary") Form(submit,action,c).
Inputs need `"bind":"$name"` and `label`: Input(type) TextArea Select(options)
Slider(min,max,step,unit) Checkbox RadioGroup(options) SegmentedControl(options)
DatePicker. options: ["a","b"] or [{label,value}]. Any node: `"show":expr`.
`state` gives initial values: `{"amt":200000}`; unset inputs default sensibly.

Expressions: a string starting with `=` (e.g. `"=$price*$qty"`) in any prop.
Text also interpolates `{...}`: `"Total {fixed($t,2)}"`. Syntax: $vars, numbers,
'strings', + - * / %, == != < > <= >=, && || !, `c ? a : b`, `$o.k`, `$a[0]`,
`[1,2]`. Functions: sum avg min max round fixed format(x,'currency'|'percent'|
'compact') len join map(arr,'field') filter(arr,'field',value) sort(arr,'field',
'desc') range concat upper lower clamp abs floor ceil pow sqrt pmt(rate,n,pv)
contains slice unique date today addDays. Bad math gives empty, not a crash.
Chart/Table `data`/`rows` are arrays of objects: `"data":"=$rows"`.

Actions (Button, Form): `{"set":{"$x":"=$x+1"}}` `{"reset":["$x"]}` `{"toggle":"$f"}`
`{"copy":"=expr"}` `{"toAssistant":"Explain {$x}"}`; or a list of these. toAssistant
only offers a follow-up for the user to review; it never sends. Add a Reset button.

Loan calculator:
`{"t":"Card","title":"Loan","c":[{"t":"Slider","bind":"$amt","label":"Amount","min":1000,"max":500000,"step":1000},{"t":"Slider","bind":"$rate","label":"Rate %","min":1,"max":15,"step":0.1},{"t":"Slider","bind":"$yrs","label":"Years","min":1,"max":40},{"t":"Stat","label":"Monthly","value":"=format(pmt($rate/1200,$yrs*12,$amt),'currency')"},{"t":"Button","label":"Reset","action":{"reset":["$amt","$rate","$yrs"]}}]}`
with state `{"amt":200000,"rate":6,"yrs":30}`.

Comparison dashboard:
`{"t":"Col","c":[{"t":"Title","text":"Plans"},{"t":"SegmentedControl","bind":"$m","options":["a","b"]},{"t":"Tabs","items":[{"label":"Chart","c":[{"t":"Chart","kind":"bar","data":"=$d","x":"n","y":["a","b"]}]},{"label":"Table","c":[{"t":"Table","columns":["n","a","b"],"rows":"=$d","sortable":true}]}]}]}`
with state `{"m":"a","d":[{"n":"Q1","a":3,"b":5},{"n":"Q2","a":4,"b":2}]}`.

If render_ui returns an error, fix the named path and call again. For assemble_document:
host theme vars (--color-text-primary, --color-background-secondary, --color-border-tertiary,
--font-sans) and styled controls are available; no CDN, fetch or remote assets; use
textContent for untrusted values; `sendPrompt(text)` from a deliberate click only.
For saved deliverables create a real file and call `show_document`.

Adapted from CopilotKit/OpenIntelligentUI at 8391a94c1c3939c679e40ddd7bfc08a9ef690e70
(MIT; license bundled here) and thesysdev/open-intelligent-ui at
03213439358bf3408ad61a46ec9e3230c5572e48 (MIT, Thesys Inc.; see NOTICE.md).
