# Responsive and motion checklist (P18-T04)

`tests/unit/responsiveMotion.test.js` guards the rules that make this walk pass (no fixed width wider than a phone, tables in scroll wrappers, Bootstrap's breakpoints, no animation over 300 ms, reduced motion honoured, skeleton states). It cannot see a screen. **This walk is the part that needs a browser**; it was not done by the person who wrote the task (no browser was available), so do it once and tick the table.

## How
1. Chrome/Edge: open DevTools (F12), toggle the device toolbar (Ctrl+Shift+M), choose "Responsive" and set the width to each of **360, 414, 768, 1024, 1440** (height 800).
2. On every page below, paste this in the Console. It prints the elements that stick out past the right edge (an empty list is a pass):
   ```js
   [...document.querySelectorAll("body *")].filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && getComputedStyle(e).position !== "fixed").slice(0, 10).map((e) => [e.tagName, e.className, Math.round(e.getBoundingClientRect().right)])
   ```
   and check `document.documentElement.scrollWidth <= document.documentElement.clientWidth` (also `true` = pass).
3. **Reduced motion**: DevTools, Rendering tab (three dots, More tools, Rendering), "Emulate CSS media feature prefers-reduced-motion" = reduce. Nothing should slide, fade, pulse or scroll smoothly: the category strip jumps, the map jumps when you open a cluster, grey loading blocks are still (not pulsing).
4. **Skeletons**: Network tab, throttling "Slow 3G". Open a listing, pick dates: grey blocks appear under "Checking the price…" and are replaced by the price. On `/listings`, "Show map": the map area is grey until the stays arrive.

## What to look at
| Page | 360 | 414 | 768 | 1024 | 1440 | Notes |
|---|:-:|:-:|:-:|:-:|:-:|---|
| Home, `/listings` (search form, filter panel, cards, pagination, map) | | | | | | form fields wrap, chips wrap, the category strip scrolls sideways inside itself |
| Listing detail (gallery, facts, booking panel, date picker, reviews) | | | | | | the date picker popup fits the screen; Reserve reachable without sideways scrolling |
| Checkout `/listings/:id/checkout?...` | | | | | | price card under the details on a phone |
| Your trips, a trip, cancel form | | | | | | cards stack, buttons full width |
| Host: listings table, wizard, booking requests, calendar, month overview | | | | | | tables scroll inside their box; the page itself does not |
| Admin: users, listing moderation, audit, reports | | | | | | same |
| Login, signup, profile | | | | | | |

## Known limits
- The month calendar (`.cal-grid`, 28 rem) and the all-listings overview (`.ocal`) are wider than a phone **on purpose** and scroll inside `.table-responsive`; that is the only fixed width above 320 px the test allows.
- Mapbox decides some of its own animation (kinetic panning after a drag, fade of labels). The site's own moves (open a cluster) take 250 ms, or 0 under reduced motion.
- The loading pulse (1.2 s, repeating) is a loading indicator, not feedback, so it is the one animation over 300 ms; it stops under reduced motion.
