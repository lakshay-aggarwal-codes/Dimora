// The comparison workspace (P10-T03): 2 to 4 stays side by side.
//
// Prices are never worked out here. With dates, every column gets exactly what
// quoteService.getQuote returns (the call the booking panel and reservations
// use), so the total in a column is the total a guest would pay. Without
// dates only the nightly price is shown.
//
// Only a whitelist of fields reaches the view (never the precise point or the
// street address), and a stay that is not public any more becomes a column that
// says so, without its title.
const {
  AMENITIES,
  CANCELLATION_POLICIES,
  CANCELLATION_TERMS,
} = require("../config/constants");
const { parseCompareQuery } = require("../validation/compareQuery");
const { QuoteRefusedError } = require("../utils/errors");
const { neighborhoodFor } = require("./neighborhood");
const { SOURCE: NEARBY_SOURCE } = require("../config/nearby");

const label = (list, value) => (list.find((i) => i.value === value) || {}).label;

// Real collaborators, loaded only when a test has not supplied a fake.
const LOADERS = {
  Listing: () => require("../models/listing"),
  getQuote: () => require("./quoteService").getQuote,
  distanceMeters: () => require("../utils/geo").distanceMeters,
  publicPointOf: () => require("../utils/geo").publicPointOf,
  LocationNotFoundError: () => require("./geocoding").LocationNotFoundError,
  GeocoderUnavailableError: () => require("./geocoding").GeocoderUnavailableError,
  lookupPlace: () => async (text) => {
    const found = await require("./geocoding").lookupAddress({ location: text });
    const [lng, lat] = found.geometry.coordinates;
    return { point: { lng, lat }, name: found.placeName };
  },
};

function resolveDeps(override) {
  const deps = { ...override };
  for (const [name, load] of Object.entries(LOADERS)) {
    if (!(name in deps)) deps[name] = load();
  }
  return deps;
}

const isPublic = (listing) =>
  Boolean(listing) && listing.status === "published" && !listing.deletedAt;

/** "about 1.4 km" / "about 650 m": the public point is approximate on purpose. */
function distanceLabel(meters) {
  if (!Number.isFinite(meters)) return "";
  if (meters < 1000) return `about ${Math.max(10, Math.round(meters / 10) * 10)} m`;
  return `about ${(meters / 1000).toFixed(1)} km`;
}

/** Cleaning + service fee as a share of the total, one decimal ("12.5%"). */
function feesPercent(quote) {
  if (!quote || !(quote.totalMinor > 0)) return "";
  const fees = (quote.cleaningMinor || 0) + (quote.serviceFeeMinor || 0);
  const tenths = Math.round((fees * 1000) / quote.totalMinor);
  return `${tenths / 10}%`;
}

/**
 * One row per amenity at least one public stay has. `has` lines up with
 * `columns`. `onlyId` is set when exactly one of two or more public stays has
 * it ("only in this one").
 */
function amenityMatrix(columns, catalogue = AMENITIES) {
  const live = columns.filter((c) => c.available);
  return catalogue
    .filter((a) => live.some((c) => c.amenities.includes(a.value)))
    .map((a) => {
      const holders = live.filter((c) => c.amenities.includes(a.value));
      return {
        value: a.value,
        label: a.label,
        has: columns.map((c) => c.available && c.amenities.includes(a.value)),
        onlyId: live.length >= 2 && holders.length === 1 ? holders[0].id : null,
        inAll: holders.length === live.length,
      };
    });
}

/** The compare URL for these stays (used by "remove" and the change-dates form). */
function compareUrl({ ids, dates, place }) {
  const params = new URLSearchParams();
  params.set("ids", ids.join(","));
  if (dates) {
    params.set("in", dates.in);
    params.set("out", dates.out);
    params.set("guests", String(dates.guests));
  }
  if (place) params.set("place", place);
  return `/compare?${params.toString()}`;
}

async function quoteFor(deps, listing, dates, now) {
  if (!dates) return { state: "none" };
  try {
    const result = await deps.getQuote(
      listing,
      { in: dates.in, out: dates.out, guests: String(dates.guests) },
      { now },
    );
    if (!result.bookable) {
      return {
        state: "unavailable",
        note: result.problems.map((p) => p.message).join(" "),
      };
    }
    const q = result.quote;
    return {
      state: "total",
      totalMinor: q.totalMinor,
      avgPerNightMinor: q.avgPerNightMinor,
      nights: q.nights,
      feesPercent: feesPercent(q),
      taxIncluded: q.taxIncluded,
      currency: q.currency,
    };
  } catch (err) {
    if (err instanceof QuoteRefusedError) {
      return { state: "noprice", note: "This stay has no valid price yet." };
    }
    throw err;
  }
}

// The two nearby rows (P15-T03): the nearest place of each category, read from
// what the host's listing already stored (P15-T01). Nothing is fetched here.
// Distances come from neighborhoodFor: measured from the public (approximate)
// point and rounded to 50 m, so a row never gives away more than the listing
// page does.
const NEARBY_ROWS = Object.freeze([
  { id: "transit", label: "Nearest transit", empty: "None found nearby" },
  { id: "grocery", label: "Nearest grocery", empty: "None found nearby" },
]);

/** { fetchedOn, transit, grocery }; each of the two is null (none found) or { name, kindLabel, distanceLabel }. null = nothing stored. */
function nearbyFor(listing) {
  const hood = neighborhoodFor(listing);
  if (!hood) return null;
  const nearest = (id) => {
    const category = hood.categories.find((c) => c.id === id);
    if (!category) return null;
    const { name, kindLabel, distanceLabel: distance } = category.items[0];
    return { name, kindLabel, distanceLabel: distance };
  };
  const out = { fetchedOn: hood.fetchedOn };
  for (const row of NEARBY_ROWS) out[row.id] = nearest(row.id);
  return out;
}

function toColumn(id, listing) {
  if (!isPublic(listing)) {
    return { id, available: false, amenities: [] };
  }
  const cap = listing.capacity || {};
  const policy = listing.cancellationPolicy || "moderate";
  return {
    id,
    available: true,
    title: listing.title,
    href: `/listings/${id}`,
    imageUrl: listing.image && listing.image.url ? listing.image.url : null,
    where: [listing.location, listing.country].filter(Boolean).join(", "),
    currency: (listing.pricing && listing.pricing.currency) || "INR",
    nightlyMinor:
      Number.isInteger(listing.pricing && listing.pricing.nightlyMinor)
        ? listing.pricing.nightlyMinor
        : null,
    capacity: {
      guests: cap.guests ?? null,
      bedrooms: cap.bedrooms ?? null,
      beds: cap.beds ?? null,
      bathrooms: cap.bathrooms ?? null,
    },
    amenities: Array.isArray(listing.amenities) ? listing.amenities.map(String) : [],
    houseRules: typeof listing.houseRules === "string" ? listing.houseRules.trim() : "",
    cancellation: {
      label: label(CANCELLATION_POLICIES, policy) || policy,
      terms: CANCELLATION_TERMS[policy] || "",
    },
    rating: {
      average: Number(listing.ratingAvg) || 0,
      count: Number(listing.ratingCount) || 0,
    },
    nearby: nearbyFor(listing),
  };
}

/** The rows to show, or null when no stay in the comparison has nearby data. */
function nearbySection(columns) {
  const withData = columns.filter((c) => c.available && c.nearby);
  if (!withData.length) return null;
  const dates = withData.map((c) => c.nearby.fetchedOn).sort();
  return {
    rows: NEARBY_ROWS.map(({ id, label, empty }) => ({ id, label, empty })),
    source: NEARBY_SOURCE,
    from: dates[0],
    to: dates[dates.length - 1],
  };
}

/**
 * @param {object} input
 * @param {object} input.query  req.query
 * @param {Date}   [input.now]
 * @param {object} [input.deps] fakes for tests
 */
async function compare({ query, now = new Date(), deps: override = {} }) {
  const deps = resolveDeps(override);
  const parsed = parseCompareQuery(query);
  const { ids, dates } = parsed;

  const found = await deps.Listing.find({ _id: { $in: ids } }).lean();
  const byId = new Map(found.map((l) => [String(l._id), l]));
  const columns = ids.map((id) => toColumn(id, byId.get(id)));
  const live = columns.filter((c) => c.available);

  const base = {
    ids,
    dates: dates ? { in: dates.in, out: dates.out, guests: dates.guests } : null,
    columns,
    removable: ids.length > 2,
    removeHref: Object.fromEntries(
      ids.map((id) => [
        id,
        compareUrl({
          ids: ids.filter((other) => other !== id),
          dates,
          place: parsed.place,
        }),
      ]),
    ),
    place: null,
    amenities: [],
    nearby: null,
    cheapestId: null,
    blocked: null,
  };

  // Prices in different currencies cannot be added or ranked: say so, show nothing else.
  const currencies = new Set(live.map((c) => c.currency));
  if (currencies.size > 1) {
    return {
      ...base,
      blocked:
        "These stays are priced in different currencies, and comparing them is not supported yet. Remove one to compare the rest.",
    };
  }

  await Promise.all(
    live.map(async (column) => {
      column.quote = await quoteFor(deps, byId.get(column.id), dates, now);
    }),
  );

  // Distance to a place the visitor named (straight line, not a route).
  if (parsed.place) {
    base.place = { text: parsed.place, name: "", note: "" };
    try {
      const target = await deps.lookupPlace(parsed.place);
      base.place.name = target.name || parsed.place;
      for (const column of live) {
        const point = deps.publicPointOf(byId.get(column.id));
        column.distance = point
          ? distanceLabel(deps.distanceMeters(point, target.point))
          : "";
      }
    } catch (err) {
      if (err instanceof deps.LocationNotFoundError) {
        base.place.note = "We could not find that place. Try a town, area or landmark.";
      } else if (err instanceof deps.GeocoderUnavailableError) {
        base.place.note = "Place search is not available right now. The other rows still work.";
      } else {
        throw err;
      }
    }
  }

  const priced = live.filter((c) => c.quote && c.quote.state === "total");
  if (priced.length >= 2) {
    base.cheapestId = priced.reduce((a, b) =>
      b.quote.totalMinor < a.quote.totalMinor ? b : a,
    ).id;
  }
  base.amenities = amenityMatrix(columns);
  base.nearby = nearbySection(columns);
  return base;
}

module.exports = {
  compare,
  amenityMatrix,
  compareUrl,
  distanceLabel,
  feesPercent,
  nearbyFor,
  nearbySection,
  NEARBY_ROWS,
};
