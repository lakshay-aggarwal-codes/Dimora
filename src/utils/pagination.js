// Page links for the pagination partial (P03-T03); sorting and the real query
// handling arrive in P05-T02/T03. Pure functions, no Express.

function toPageCount(totalPages) {
  const n = Math.floor(Number(totalPages));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

function toPage(page, totalPages) {
  const n = Math.floor(Number(page));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(n, totalPages);
}

/**
 * Which links to show: first, last, the current page and `windowSize` pages on
 * each side; "gap" items stand for skipped ranges (a gap that would hide a
 * single page shows that page instead).
 * pageItems(5, 10) -> 1 … 4 5 6 … 10
 */
function pageItems(page, totalPages, windowSize = 1) {
  const last = toPageCount(totalPages);
  const current = toPage(page, last);
  const wanted = new Set([1, last]);
  for (let n = current - windowSize; n <= current + windowSize; n += 1) {
    if (n >= 1 && n <= last) wanted.add(n);
  }
  const numbers = [...wanted].sort((a, b) => a - b);
  const items = [];
  let previous = 0;
  for (const n of numbers) {
    if (n - previous === 2)
      items.push({
        type: "page",
        number: previous + 1,
        current: previous + 1 === current,
      });
    else if (n - previous > 2) items.push({ type: "gap" });
    items.push({ type: "page", number: n, current: n === current });
    previous = n;
  }
  return items;
}

// Only a same-site path may be the base of a link.
function safeBase(baseUrl) {
  if (
    typeof baseUrl !== "string" ||
    baseUrl[0] !== "/" ||
    baseUrl[1] === "/" ||
    baseUrl[1] === "\\"
  )
    return "/";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\?#]/.test(baseUrl)) return "/";
  return baseUrl;
}

/**
 * Link to page `number`, keeping the other query parameters. Page 1 has no
 * `page` parameter (one canonical URL per page).
 */
function pageHref(baseUrl, query, number, param = "page") {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query || {})) {
    if (key === param) continue;
    for (const v of Array.isArray(value) ? value : [value]) {
      if (
        typeof v === "string" ||
        typeof v === "number" ||
        typeof v === "boolean"
      ) {
        if (String(v) !== "") params.append(key, String(v));
      }
    }
  }
  if (number > 1) params.set(param, String(number));
  const qs = params.toString();
  return `${safeBase(baseUrl)}${qs ? `?${qs}` : ""}`;
}

module.exports = { pageItems, pageHref, toPage, toPageCount };
