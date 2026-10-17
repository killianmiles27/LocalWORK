# Gapminder integration-test fixture

This recipe is for the deterministic browser integration probe only. It is not
an agent skill, is not packaged with the app, and must not be supplied to the
model during general workflow evaluations.

Use the background browser tool. It renders the real chart and can save screenshots without showing a browser window. Preserve the default axes and bubble size when the user requests them. Select a country with data back to the requested start year. Do not invent URL fragments or repeatedly enumerate internal objects.

1. Open https://www.gapminder.org/tools/#$chart-type=bubbles&url=v1 and wait for the chart/data to load. Use a small eval to confirm `window.Vizabi?.stores?.markers?.models?.bubble?.encoding?.frame` is available; wait and retry if it is still loading. Always use this visible marker's encodings. `Vizabi.stores.encodings.models.frame` can point to the splash/thumbnail frame with a one-year domain; it cannot animate the main chart.
2. Choose a country. Find its ISO key in the existing country list (for example Japan is `jpn`). The animation must select the country **after rewinding**, otherwise Gapminder may clear its trail selection. Enabling `trail.show` alone does not select a country.
3. Run this browser eval, replacing COUNTRY_ISO with the selected country's ISO key. Pass the whole function as one string in the browser tool's args array. It uses the same chart state as the controls; it does not change source observations, axes, size, or playback speed.

```js
() => {
  const iso = "COUNTRY_ISO";
  const M = window.Vizabi?.stores?.markers?.models?.bubble?.encoding;
  if (!M?.frame?.setValue || !M?.trail?.data?.filter?.set || M.frame.stepCount < 2) throw new Error("Main chart data not ready; wait or use the visible controls.");
  const baselineBubbleCircles = document.querySelectorAll('.vzb-bc-bubbles circle').length;
  M.frame.stopPlaying();
  M.frame.setValue(1800);
  M.trail.setShow(true);
  M.trail.data.filter.clear();
  M.trail.data.filter.set(iso, M.frame.value);
  M.frame.config.loop = false;
  M.frame.startPlaying();
  return {country: iso, year: M.frame.value, end: M.frame.scale.domain.at(-1), playing: M.frame.playing, baselineBubbleCircles, selected: Array.from(M.trail.data.filter.markers), x: M.x.data.concept, y: M.y.data.concept, size: M.size.data.concept};
}
```

4. Wait in at most 30-second increments, then use this small eval. When playback stops, verify year equals end, the selected country is still present, its start is 1800, and the historical bubble count increased over the returned baseline. Do not reset the country at the endpoint: that would start its trail at the endpoint again. Do not enumerate other model stores or repeat identical empty inspections.

```js
() => {
  const M = window.Vizabi.stores.markers.models.bubble.encoding;
  return {year: M.frame.value, end: M.frame.scale.domain.at(-1), playing: M.frame.playing, selected: Array.from(M.trail.data.filter.markers), starts: M.trail.starts, bubbleCircles: document.querySelectorAll('.vzb-bc-bubbles circle').length};
}
```
5. Take a browser screenshot of the actual final frame. A single selected bubble is not a historical trajectory. In this chart, historical bubbles render inside `.vzb-bc-bubbles`, and `.vzb-bc-trails` can be empty even when the full trail is visible. Verify that `document.querySelectorAll('.vzb-bc-bubbles circle').length` increased over the baseline, with the selected country's start still 1800 and playback stopped at the reported endpoint. Inspect the saved image when image viewing is available. If incomplete, correct the selection/start and replay once; report a remaining failure instead of exploring indefinitely.
6. Research and write the requested story with the research and academic-docx skills. Use the observed axes, units and latest data year; distinguish historical interpretation from observations. Do not substitute another site's life-expectancy or income series for values in this chart. If exact chart values cannot be read, describe the observed pattern qualitatively rather than inventing numbers or importing incompatible estimates. A rise in life expectancy with flat income is a vertical movement, not horizontal. Do not infer a precise historical date solely from an undated position in a bubble trail. Missing course readings and student details must be identified, never invented. Keep the requested word/paragraph/page limits, embed the screenshot with figure number/title/source note, validate, close and show_document. A screenshot alone does not complete a written assignment. Do not submit to a course platform without its destination and the user's review.

API reference: https://github.com/vizabi/core/blob/master/src/core/encoding/frame.js and https://github.com/vizabi/core/blob/master/src/core/filter/trailfilter.js . Live integration check: scripts/e2e/check-gapminder.py. If these APIs change, use visible controls and report the mismatch; do not explore endlessly.
