// Review ratings for the listing page (P04-T07).

/**
 * { average, count } from a list of reviews. Only whole ratings 1-5 count;
 * anything else (missing, text, out of range) is ignored. `average` has one
 * decimal and is null when there is nothing to average.
 */
function summarizeRatings(reviews) {
  const ratings = (Array.isArray(reviews) ? reviews : [])
    .map((review) => (review ? review.rating : undefined))
    .filter((r) => Number.isInteger(r) && r >= 1 && r <= 5);
  if (ratings.length === 0) return { average: null, count: 0 };
  const sum = ratings.reduce((total, r) => total + r, 0);
  return {
    average: Math.round((sum / ratings.length) * 10) / 10,
    count: ratings.length,
  };
}

module.exports = { summarizeRatings };
