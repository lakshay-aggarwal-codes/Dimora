// How often a stay was shown and clicked under each ordering (P15-T06), kept
// in ListingStat so the trip-purpose ranking can be compared with the default
// order. Counters only: no user, no session, no time. A stay is "shown" when it
// is on a results page ordered by Best match (with or without a purpose), and
// "clicked" when its page is opened from that results page (`?from=<variant>`),
// once per listing per session.
//
// Reading the numbers (docs/RANKING.md): shown/clicked are per STAY, so one
// results page adds up to 12 "shown". Position, who is searching and refreshes
// all move click-through; the figure says what happened, not why.
const mongoose = require("mongoose");
const { PURPOSE_SLUGS } = require("../config/purposes");

const VARIANTS = Object.freeze(["default", ...PURPOSE_SLUGS]);
const isReady = () => mongoose.connection.readyState === 1;

async function recordShown({ ListingStat, ids, variant, ready = isReady }) {
  if (!VARIANTS.includes(variant) || !Array.isArray(ids) || ids.length === 0 || !ready()) return;
  await ListingStat.bulkWrite(
    ids.map((id) => ({
      updateOne: { filter: { listing: id }, update: { $inc: { [`ranking.${variant}.shown`]: 1 } }, upsert: true },
    })),
    { ordered: false },
  );
}

async function recordClick({ ListingStat, listingId, variant, ready = isReady }) {
  if (!VARIANTS.includes(variant) || !listingId || !ready()) return;
  await ListingStat.updateOne(
    { listing: listingId },
    { $inc: { [`ranking.${variant}.clicked`]: 1 } },
    { upsert: true },
  );
}

/** @returns {Promise<Array<{variant: string, shown: number, clicked: number, ctr: number|null}>>} */
async function summary({ ListingStat }) {
  const group = { _id: null };
  for (const v of VARIANTS) {
    group[`${v}_shown`] = { $sum: `$ranking.${v}.shown` };
    group[`${v}_clicked`] = { $sum: `$ranking.${v}.clicked` };
  }
  const [row] = await ListingStat.aggregate([{ $group: group }]);
  return VARIANTS.map((variant) => {
    const shown = (row && row[`${variant}_shown`]) || 0;
    const clicked = (row && row[`${variant}_clicked`]) || 0;
    return { variant, shown, clicked, ctr: shown > 0 ? clicked / shown : null };
  });
}

module.exports = { VARIANTS, recordShown, recordClick, summary };
