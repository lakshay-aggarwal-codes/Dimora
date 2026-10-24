# Dimora Dataset Manifest

Generated automatically from the local data files.

## airbnb-properties-information.csv
- Format: CSV
- Size: 26,181,531 bytes
- Records (excluding header): 1,000

### Columns
name, price, image, description, category, availability, discount, reviews, ratings, seller_info, breadcrumbs, location, lat, long, guests, pets_allowed, description_items, category_rating, house_rules, details, highlights, arrangement_details, amenities, images, available_dates, url, final_url, listing_title, property_id, listing_name, location_details, description_by_sections, description_html, location_details_html, is_supperhost, host_number_of_reviews, host_rating, hosts_year, host_response_rate, is_guest_favorite, travel_details, pricing_details, total_price, currency

## nyc-listings.csv
- Format: CSV
- Size: 77,654,490 bytes
- Records (excluding header): 29,918

### Columns
id, listing_url, scrape_id, last_scraped, source, name, description, neighborhood_overview, picture_url, host_id, host_url, host_profile_id, host_profile_url, host_name, host_since, hosts_time_as_user_years, hosts_time_as_user_months, hosts_time_as_host_years, hosts_time_as_host_months, host_location, host_about, host_response_time, host_response_rate, host_acceptance_rate, host_is_superhost, host_thumbnail_url, host_picture_url, host_neighbourhood, host_listings_count, host_total_listings_count, host_verifications, host_has_profile_pic, host_identity_verified, neighbourhood, neighbourhood_cleansed, neighbourhood_group_cleansed, latitude, longitude, property_type, room_type, accommodates, bathrooms, bathrooms_text, bedrooms, beds, amenities, price, price_quote_checkin_date, price_quote_checkout_date, price_quote_total_price, price_quote_price_per_night, price_quote_raw, minimum_nights, maximum_nights, minimum_minimum_nights, maximum_minimum_nights, minimum_maximum_nights, maximum_maximum_nights, minimum_nights_avg_ntm, maximum_nights_avg_ntm, calendar_updated, has_availability, availability_30, availability_60, availability_90, availability_365, calendar_last_scraped, number_of_reviews, number_of_reviews_ltm, number_of_reviews_l30d, availability_eoy, number_of_reviews_ly, estimated_occupancy_l365d, estimated_revenue_l365d, first_review, last_review, review_scores_rating, review_scores_accuracy, review_scores_cleanliness, review_scores_checkin, review_scores_communication, review_scores_location, review_scores_value, license, instant_bookable, calculated_host_listings_count, calculated_host_listings_count_entire_homes, calculated_host_listings_count_private_rooms, calculated_host_listings_count_shared_rooms, reviews_per_month

## nyc-reviews.csv
- Format: CSV
- Size: 311,633,400 bytes
- Records (excluding header): 999,099

### Columns
listing_id, id, date, reviewer_id, reviewer_name, comments

## nyc-calendar.csv
- Format: CSV
- Size: 379,063,080 bytes
- Records (excluding header): 10,920,077

### Columns
listing_id, date, available, minimum_nights, maximum_nights

## nyc-neighbourhoods.csv
- Format: CSV
- Size: 4,962 bytes
- Records (excluding header): 230

### Columns
neighbourhood_group, neighbourhood

## listingsAndReviews.json
- Format: NDJSON (one JSON object per line)
- Size: 99,656,721 bytes
- Records: 5,555

### Columns
_id, listing_url, name, summary, space, description, neighborhood_overview, notes, transit, access, interaction, house_rules, property_type, room_type, bed_type, minimum_nights, maximum_nights, cancellation_policy, last_scraped, calendar_last_scraped, first_review, last_review, accommodates, bedrooms, beds, number_of_reviews, bathrooms, amenities, price, security_deposit, cleaning_fee, extra_people, guests_included, images, host, address, availability, review_scores, reviews

## nyc-listings.csv.gz
- Format: GZIP-compressed CSV backup
- Size: 16,005,851 bytes
- Compressed backup of: nyc-listings.csv

## nyc-reviews.csv.gz
- Format: GZIP-compressed CSV backup
- Size: 120,318,684 bytes
- Compressed backup of: nyc-reviews.csv

## nyc-calendar.csv.gz
- Format: GZIP-compressed CSV backup
- Size: 25,603,399 bytes
- Compressed backup of: nyc-calendar.csv
