# Accessibility (P18-T03)

Target: WCAG 2.2 level AA. This file says what is checked automatically, what was found and fixed, and what still needs a person with a keyboard, a screen reader and a phone.

## What runs on every `npm test`
| Check | File | What it covers |
|---|---|---|
| **axe-core on page types** (WCAG 2.0/2.1/2.2 A and AA, plus axe best practices) | `tests/integration/a11y.public.test.js`, `a11y.members.test.js`, `a11y.hosting.test.js` | Home, search (results, empty), a listing page (full and minimal), about / privacy / terms / log in / sign up / not found; account settings, edit profile, public profile, notifications, messages (list, empty, thread), reports (yours, the form), your trips (tab, empty), a booking page (completed with the review form, with a review, pending), booking requests, host overview, the all-listings calendar, the admin pages (index, users, user, listings, listing, reports, report, audit log); the listing wizard (all six steps, an unsaved first step, a step with errors), the older create form, edit, confirm location, the four status pages, my listings, a listing's availability calendar, compare (with dates, without, a stay that is gone), saved stays, checkout (request, instant, price changed). The pages are rendered by the real views and the real layout; the public ones by the real app. |
| **Colour contrast, from the design tokens** | `tests/unit/contrast.test.js` | Every text pair the pages use (body, muted, link, danger, accent, text on buttons and badges, on all three surfaces) is at least 4.5:1; control outlines, the focus ring and icons are at least 3:1. axe cannot judge colour without a layout engine, so the WCAG formula is applied to `public/css/tokens.css`. |
| **The date picker with a keyboard** | `tests/integration/a11y.widgets.test.js` | The real `date-picker.js` in jsdom: one tab stop (roving tabindex), arrow keys, Home / End, PageUp / PageDown, the status and summary announcements, taken days named "unavailable", the month buttons keep focus, a load failure is explained, axe on the live DOM. |
| **Form validation focus** | same file | `script.js` stops an invalid submit and puts focus on the first problem; the star-rating message appears and disappears. |
| **Every template compiles** | `tests/unit/viewsCompile.test.js` | Catches a template that cannot render at all (see finding 1). |

jsdom has no layout, so nothing automatic judges target size, zoom, reflow, motion or real focus order across a page.

## Findings and fixes
1. **Two pages could not render at all.** An EJS comment that contained a tag (`<%# ... <%= %> ... %>`) ends at its first `%>`, so `views/partials/nearby-status.ejs` (the host status page of a published listing) and `views/compare/index.ejs` (the comparison page) failed with "Could not find matching close tag". Fixed; `viewsCompile.test.js` now fails for any template that does not compile or has a tag inside a comment. Six tests that had been failing before now pass.
2. **Message list**: `role="log"` on the `<ol>` removed the list semantics from the messages (axe `aria-allowed-role`). The role is on a wrapper `<div>`; the list keeps its items and the new messages are still announced.
3. **Search landmarks**: the quick search in the navbar, the home hero search and the admin account search were unnamed `role="search"` landmarks next to others. Each now has its own name ("Quick search", "Search stays", "Search accounts").
4. **Date picker, keyboard focus**: pressing "Next month" or "Previous month" rebuilt the calendar and dropped keyboard focus to the page. Focus now stays on the pressed button, or moves to the other one when it has just become disabled.
5. **Date picker, spoken names**: a day was announced as "2 November 2026"; it is now "Monday, 2 November 2026" (the weekday first), and the column headers "Su", "Mo", ... carry the full day name.
6. **The test harness found nothing else** on the page types listed above: the P03-T04 work (labels, fieldsets, landmarks, skip link, heading order) holds up. Error states (wizard step, edit section, account, report form, calendar, admin) were audited too.

## Not covered by a test: check by hand before a demo
These need a browser, a keyboard and ideally a screen reader (NVDA on Windows is free).
1. **Keyboard only** (unplug the mouse). From the top of each of: home, search, a listing, the date picker, checkout, the wizard, your trips, messages, the admin reports page: Tab reaches every control in a sensible order; the focus outline is always visible; nothing needs a mouse; no keyboard trap (the photo viewer closes with Escape and returns focus to the photo you opened).
2. **Skip link**: the first Tab on any page offers "Skip to content" and it works.
3. **Zoom and reflow**: at 200% and at 400% zoom (a 320 px wide window) there is no horizontal scrolling of the page, except the tables and calendars, which scroll inside their own box.
4. **Screen reader, 10 minutes**: sign up with an error (is it read out?), search and open a listing, choose dates (are the weekday, the date and "unavailable" read?), watch the price breakdown change (is it announced once?), send a message (is the new message read out?), submit a review without stars (is "Please choose a rating" read?).
5. **Motion**: with the system setting "reduce motion" on, nothing slides or fades in a way that matters.
6. **Phone**: tap targets are comfortable (about 44 px); the date picker and the calendars work with touch.
7. **Not checked anywhere**: the map (Mapbox) and its list alternative with a screen reader; the notification count badge, which changes without an announcement.

## When you add a page
Add it to one of the three `a11y.*.test.js` files with a realistic view model. If it uses a new colour pair for text, add the pair to `TEXT_PAIRS` in `contrast.test.js`. If it has a script that moves or redraws things, add a keyboard test next to the date picker's.
