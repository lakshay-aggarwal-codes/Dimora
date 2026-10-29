// The seasonal-price rows of the pricing form (P08-T04). The form is flat (no
// nested names), so season N is four boxes: season1Name, season1From,
// season1To, season1Price. This turns them into the stored shape and checks
// them; the browser is never trusted. Pure: no database, no clock.
const { tryParseDateOnly, formatDateOnly, nightsBetween } = require("./dates");
const { rupeesToMinor, minorToRupees } = require("./listingFields");

const MAX_SEASONS = 5;
const NAME_MAX = 40;
const MIN_RUPEES = 100;
const MAX_RUPEES = 1000000;
const MAX_SPAN_DAYS = 366;

const FIELD = (n) => ({
  name: `season${n}Name`,
  from: `season${n}From`,
  to: `season${n}To`,
  price: `season${n}Price`,
});
const ROWS = Array.from({ length: MAX_SEASONS }, (_, i) => i + 1);
const SEASON_FIELD_NAMES = ROWS.flatMap((n) => Object.values(FIELD(n)));

const str = (v) => (typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v).trim());

/**
 * @param {object} body the step's submitted fields
 * @returns {{ seasons: {name:string, from:Date, to:Date, nightlyMinor:number}[], errors: Record<string,string> }}
 *   `errors` is keyed by form field id; seasons are sorted by start date.
 */
function parseSeasons(body = {}) {
  const errors = {};
  const rows = [];
  for (const n of ROWS) {
    const f = FIELD(n);
    const v = { name: str(body[f.name]), from: str(body[f.from]), to: str(body[f.to]), price: str(body[f.price]) };
    const filled = Object.values(v).filter(Boolean).length;
    if (filled === 0) continue;
    if (filled < 4) {
      const firstEmpty = ["name", "from", "to", "price"].find((k) => !v[k]);
      errors[f[firstEmpty]] = "Fill in all four boxes of this season, or clear them all.";
      continue;
    }
    let ok = true;
    const fail = (key, message) => {
      if (!errors[f[key]]) errors[f[key]] = message;
      ok = false;
    };
    if (v.name.length > NAME_MAX) fail("name", `The name can be at most ${NAME_MAX} characters.`);
    const from = tryParseDateOnly(v.from);
    const to = tryParseDateOnly(v.to);
    if (!from) fail("from", "Use a date like 2026-12-20.");
    if (!to) fail("to", "Use a date like 2027-01-05.");
    if (from && to) {
      if (to < from) fail("to", "A season cannot end before it starts.");
      else if (nightsBetween(from, new Date(to.getTime() + 86400000)) > MAX_SPAN_DAYS) {
        fail("to", `A season can last at most ${MAX_SPAN_DAYS} days.`);
      }
    }
    const price = Number(v.price);
    if (!Number.isFinite(price) || price < MIN_RUPEES || price > MAX_RUPEES) {
      fail("price", `The price must be a number from ₹${MIN_RUPEES} to ₹${MAX_RUPEES.toLocaleString("en-IN")}.`);
    }
    if (ok) rows.push({ n, name: v.name, from, to, nightlyMinor: rupeesToMinor(price) });
  }

  // Seasons may not overlap: report the later one, on its start date.
  const byStart = [...rows].sort((a, b) => a.from - b.from || a.n - b.n);
  for (let i = 1; i < byStart.length; i += 1) {
    const before = byStart[i - 1];
    const row = byStart[i];
    if (row.from <= before.to && !errors[FIELD(row.n).from]) {
      errors[FIELD(row.n).from] = `This overlaps the season "${before.name}". Seasons cannot share a night.`;
    }
  }
  const seasons = byStart.map(({ name, from, to, nightlyMinor }) => ({ name, from, to, nightlyMinor }));
  return { seasons, errors };
}

/** The flat form values (season1Name ... season5Price) for the stored seasons. */
function seasonFormValues(stored) {
  const out = {};
  const list = Array.isArray(stored) ? stored : [];
  for (const n of ROWS) {
    const f = FIELD(n);
    const season = list[n - 1];
    out[f.name] = season ? season.name : "";
    out[f.from] = season && season.from ? formatDateOnly(season.from) : "";
    out[f.to] = season && season.to ? formatDateOnly(season.to) : "";
    const rupees = season ? minorToRupees(season.nightlyMinor) : null;
    out[f.price] = rupees === null ? "" : rupees;
  }
  return out;
}

module.exports = { parseSeasons, seasonFormValues, SEASON_FIELD_NAMES, MAX_SEASONS, FIELD, ROWS };
