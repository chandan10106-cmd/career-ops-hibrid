// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Uber careers provider — hits the public www.uber.com job-search JSON API.
// Zero-token, no auth, no browser. Verified 2026-08: POST returns structured
// JSON with title, department, location (city/country), and posting time.
//
// Uber runs its own careers stack rather than a third-party ATS, so none of
// the generic ATS providers (greenhouse/ashby/lever/workday) can reach it.
//
// portals.yml entry example:
//   - name: Uber
//     careers_url: https://www.uber.com/global/en/careers/list/   # auto-detected
//     countries: ["NLD", "IND", "GBR", "DEU"]  # ISO-3166 alpha-3; omit to pull the whole board
//     max_pages: 10                            # per country, 100 results/page
//
// The `countries` filter is applied server-side, which keeps the response
// small when only a few markets matter. Omitting it pulls every posting and
// lets scan.mjs's location_filter do the work instead.

import { BROWSER_LIKE_USER_AGENT } from './_http.mjs';

const API_HOST = 'www.uber.com';
const API_PATH = '/api/loadSearchJobsResults';
const CAREERS_HOST_RE = /^(www\.)?uber\.com$/i;
const PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 10;
// Uber's edge is rate-sensitive; the same inter-page courtesy delay other
// paginating providers use (tencent/avature/workday).
const INTER_PAGE_DELAY_MS = 200;

// The endpoint rejects requests without a CSRF header. It does not validate
// the value for unauthenticated search — any non-empty token is accepted —
// so this is a required-header formality, not an auth bypass.
const CSRF_HEADER_VALUE = 'x';

function buildUrl() {
  return `https://${API_HOST}${API_PATH}?localeCode=en`;
}

function buildBody(countries, page) {
  /** @type {Record<string, any>} */
  const params = {};
  if (Array.isArray(countries) && countries.length) {
    params.location = countries.map((c) => ({ country: String(c).toUpperCase() }));
  }
  return JSON.stringify({ params, page, limit: PAGE_SIZE });
}

/** Join Uber's split location fields into one display string. */
function formatLocation(loc) {
  if (!loc || typeof loc !== 'object') return '';
  return [loc.city, loc.region, loc.countryName || loc.country]
    .filter(Boolean)
    .join(', ');
}

/**
 * Uber exposes a `creationDate`/`updatedDate` in epoch **seconds** on some
 * payload shapes and ISO strings on others. Normalize both to epoch ms, and
 * return undefined for anything unparseable so the caller simply omits the
 * field (scan.mjs treats a missing date as "don't penalize missing data").
 */
function parsePostedAt(job) {
  const raw = job?.creationDate ?? job?.updatedDate ?? job?.postedDate;
  if (raw == null) return undefined;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Values below ~1e12 are seconds, above are already milliseconds.
    const ms = raw < 1e12 ? raw * 1000 : raw;
    return Number.isFinite(ms) ? ms : undefined;
  }
  const ts = Date.parse(String(raw));
  return Number.isNaN(ts) ? undefined : ts;
}

/**
 * Parse one page of the loadSearchJobsResults payload.
 * Exported for tests.
 * @param {any} json
 * @param {string} companyName
 * @returns {{ jobs: import('./_types.js').Job[], total: number }}
 */
export function parseUberResponse(json, companyName) {
  const results = json?.data?.results;
  // totalResults arrives as a Long-ish {low, high} pair from their backend.
  const total = Number(json?.data?.totalResults?.low ?? json?.data?.totalResults ?? 0) || 0;
  if (!Array.isArray(results)) return { jobs: [], total };

  const jobs = [];
  for (const r of results) {
    const title = String(r?.title || '').trim();
    const id = r?.id;
    if (!title || id == null) continue;
    jobs.push({
      title,
      url: `https://www.uber.com/global/en/careers/list/${id}/`,
      company: companyName || 'Uber',
      location: formatLocation(r?.location),
      // The list payload carries a description for most postings — free to
      // include (no extra request), and it feeds scan.mjs's content_filter
      // and the #1597 cross-listing fingerprint.
      description: String(r?.description || '').trim() || undefined,
      postedAt: parsePostedAt(r),
    });
  }
  return { jobs, total };
}

/** @type {Provider} */
export default {
  id: 'uber',

  detect(entry) {
    // Explicit opt-in wins, so a portals.yml entry can name the provider
    // without depending on URL shape.
    if (entry?.provider === 'uber') return { url: `https://${API_HOST}/global/en/careers/list/` };

    // Otherwise match on host, not a path segment, to avoid spoofed URLs.
    const url = entry?.careers_url;
    if (typeof url !== 'string') return null;
    let u;
    try { u = new URL(url); } catch { return null; }
    if (u.protocol !== 'https:' || !CAREERS_HOST_RE.test(u.hostname)) return null;
    if (!/\/careers(\/|$)/i.test(u.pathname)) return null;
    return { url };
  },

  async fetch(entry, ctx) {
    const countries = Array.isArray(entry?.countries) ? entry.countries : null;
    const entryMaxPages = Number(entry?.max_pages) > 0 ? Number(entry.max_pages) : DEFAULT_MAX_PAGES;
    // Honor the ctx.maxPages pagination hint (verify-portals' health probe passes 1).
    const maxPages = Math.min(
      entryMaxPages,
      Number(ctx?.maxPages) > 0 ? Number(ctx.maxPages) : Infinity,
    );
    const companyName = entry?.name || 'Uber';
    const sleep = (ms) =>
      (typeof ctx?.sleep === 'function' ? ctx.sleep(ms) : new Promise((r) => setTimeout(r, ms)));

    // Query each country separately when a filter is present: the API accepts
    // a multi-country array, but splitting keeps each response inside one page
    // budget and stops a single large market from starving the others.
    const batches = countries && countries.length ? countries.map((c) => [c]) : [null];

    /** @type {Map<string, import('./_types.js').Job>} */
    const seen = new Map();
    let firstRequest = true;
    let succeededOnce = false;

    for (const batch of batches) {
      for (let page = 0; page < maxPages; page++) {
        if (firstRequest) firstRequest = false;
        else await sleep(INTER_PAGE_DELAY_MS);

        let json;
        try {
          json = /** @type {any} */ (await ctx.fetchJson(buildUrl(), {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-csrf-token': CSRF_HEADER_VALUE,
              'user-agent': BROWSER_LIKE_USER_AGENT,
            },
            body: buildBody(batch, page),
            redirect: 'error',
          }));
        } catch (err) {
          // A dead board should still read as a failure, but a mid-run blip
          // must not discard what's already collected (same idiom as
          // tencent/workday/jobstreet).
          if (succeededOnce) break;
          throw err;
        }
        succeededOnce = true;

        const { jobs, total } = parseUberResponse(json, companyName);
        for (const job of jobs) {
          if (!seen.has(job.url)) seen.set(job.url, job);
        }

        // Stop when this page was short or we've seen everything the API says
        // exists — whichever comes first.
        if (jobs.length < PAGE_SIZE) break;
        if (total && seen.size >= total) break;
      }
    }

    return [...seen.values()];
  },
};
