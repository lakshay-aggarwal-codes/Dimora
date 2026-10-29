# Trip-purpose ranking (P15-T06)

## What it is

On `/listings`, the "Plan for" bar offers **Work trip**, **Family trip**, **Weekend getaway** or **Any trip**. A purpose does not filter: every stay that matched the search is still there. It changes the order of **Best match** by giving each stay points for things the listing states. The rules are the whole algorithm, and the page shows them (a "how the stays are ordered" box).

| Purpose | Points (max) | Rules |
|---|---|---|
| Work trip | 8 | Wi-Fi +3, Dedicated workspace +3, whole place +1, air conditioning +1 |
| Family trip | 13 | 2+ bedrooms +3, sleeps 4+ +2, kitchen +2, whole place +2, washing machine +1, free parking +1, smoke alarm +1, first aid kit +1 |
| Weekend getaway | 8 | Pool +2, balcony/terrace +2, instant book +2, free parking +1, air conditioning +1 |

Stays are sorted by points, highest first; equal points keep the normal Best-match order (rating, number of reviews, newest). No machine learning, no personalisation, no history of the visitor, no hidden weight, nothing paid.

The rules live in `src/config/purposes.js`; scoring is `src/services/purposeRank.js`. Changing a rule changes the page text with it, because the page prints the same list.

## When it acts

- Only for the **Best match** order and a search **without** words. With another sort order, or with `keywords`, the purpose is kept in the URL but the page says it is not acting.
- It scores at most the **2,000** best-matching stays (normal order); beyond that the normal order applies.
- URL: `/listings?purpose=work` (`family`, `weekend`). Anything else is an error message and the page works as without it.

## What the rules do not mean

"Wi-Fi" is a box a host ticked, not a measured speed. "Dedicated workspace" is what the host declared. Points are a convenience for ordering, not a quality rating, and the Work/Family/Weekend names are guesses at what people want, not findings.

## The metric: click-through compared with the default order

`ListingStat.ranking.<ordering>.{shown, clicked}` for `default`, `work`, `family`, `weekend`:

- **shown**: +1 for each stay on a results page ordered by Best match (not for other sorts, not for word searches, not for crawlers).
- **clicked**: +1 when a stay's page is opened from such a page (`?from=<ordering>` on the card link), once per stay per session.
- Counters only: no user, no time, no search text is stored.

Read it with `npm run report:ranking` (needs `MONGODB_URI`). The script refuses to suggest a comparison under 200 default impressions.

How to read the figures honestly:

- Click-through here is clicks per stay shown. A purpose page and the default page show **different people** at **different times** looking for **different things**; nothing is randomised. A higher rate for "work" does not prove that the ranking works, and a lower one does not prove that it fails.
- To compare properly, one would split visitors at random (an A/B split). That was not built: it needs a visitor identifier, which this site avoids storing (docs/RETENTION.md).
- Position matters more than anything else: the first row is clicked more whatever it contains.
- A refresh does not count twice (session), but a new session does; bots that hide their user-agent are counted.
- Counters are incremented in the background; a failure never shows on the page and can lose a count.
- Rows exist only for stays that were shown at least once.

## Limits

- Three presets, no combination of purposes.
- Not enabled on the map list or the comparison workspace.
- Stays are not labelled with their score or the rules they matched (the box lists the rules).
- Writes per results page: up to 12 counter updates in one bulk call. At the Atlas free tier's 100 operations a second that is fine for a class; it is not for a busy site.
