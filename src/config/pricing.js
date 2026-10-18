// Pricing configuration (P08-T01). Read by src/services/pricing.js only.
//
// THE TAX NUMBERS HERE ARE ILLUSTRATIVE, not tax advice. Real Indian hotel GST
// depends on the tariff slab and on the host's registration; verify the current
// rules before presenting any of this as fact. The UI says "Taxes
// (illustrative)" (ADR-008). Rates are basis points: 100 = 1 %, 1800 = 18 %.
module.exports = Object.freeze({
  currency: "INR",

  // Guest service fee: a percentage of accommodation (nights + cleaning).
  serviceFeeBps: 1000, // 10 %

  // "exclusive": tax is added on top of the prices a host sets.
  // "inclusive": the prices already contain tax; the tax line is informational.
  taxMode: "exclusive",

  // The slab is chosen by the average price per night; the first slab whose
  // `upToMinor` is at least that average applies (`null` = no upper limit).
  // One flat slab matches the "+18% GST" note on the listing cards.
  taxSlabs: Object.freeze([Object.freeze({ upToMinor: null, rateBps: 1800 })]),

  // Nights that use a listing's weekend price: the night that STARTS on these
  // days (0 = Sunday ... 6 = Saturday). 5 and 6 are Friday and Saturday nights.
  weekendDays: Object.freeze([5, 6]),
});
