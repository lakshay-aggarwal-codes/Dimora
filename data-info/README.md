# Dimora Dataset Handoff

## Project context
Dimora is an Airbnb-style property rental application.
The local project uses Node.js, Express, EJS, MongoDB and Mongoose.

## Source datasets

1. listingsAndReviews.json
   - Newline-delimited JSON (NDJSON), not a single JSON document.
   - 5,555 property records.
   - Includes property details, prices, amenities, images, host data,
     availability, ratings and embedded reviews.

2. airbnb-properties-information.csv
   - Additional Airbnb property sample.
   - CSV format. Inspect its headers before importing.

3. nyc-listings.csv
   - Inside Airbnb New York City listings snapshot.
   - Snapshot date: 2026-09-14.
   - Includes listing IDs, names, descriptions, prices, hosts,
     property types, coordinates, amenities and availability indicators.

4. nyc-reviews.csv
   - Listing reviews with listing_id, review ID, date, reviewer
     information and comments.
   - Join to listings using listing_id.

5. nyc-calendar.csv
   - Nightly availability with listing_id, date, available,
     minimum_nights and maximum_nights.
   - Join to listings using listing_id.

6. nyc-neighbourhoods.csv
   - Neighbourhood reference data.

## Compressed backups
nyc-listings.csv.gz, nyc-reviews.csv.gz and nyc-calendar.csv.gz
are compressed copies of the corresponding extracted CSV files.
Do not treat them as additional datasets.

## Important cautions
- These are snapshots, not live Airbnb inventory.
- Prices and availability may be stale.
- Listing IDs from different sources are not guaranteed to match.
- Inspect and normalize prices, dates, booleans and missing values.
- Do not import raw data directly into application models without
  validating the existing Mongoose schemas.
- Keep real user accounts and bookings separate from sample data.
- Check applicable dataset licenses and terms before redistribution.

## Recommended workflow
1. Inspect existing Mongoose schemas and migration scripts.
2. Inspect the complete headers of each CSV.
3. Build data quality reports and identify duplicates.
4. Map source fields into Dimora's listing and review models.
5. Keep large source files outside Git.
6. Test imports on a small sample before bulk importing.
