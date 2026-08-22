// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// The Muse provider — public, zero-auth JSON jobs feed.
// Endpoint: https://www.themuse.com/api/public/jobs?page={n}
// Response shape: { results: [...], page: n, page_count: N }
// All pages are fetched sequentially and aggregated before normalizing.
//
// Wire in via a `job_boards:` entry with `provider: themuse`.

import { fetchJsonWithRetry } from './_http.mjs';

const FEED_BASE = 'https://www.themuse.com/api/public/jobs';
const TRUSTED_HOST = 'www.themuse.com';

// Safety cap on pagination. The feed can carry tens of thousands of pages;
// this board only ever samples the first slice of it regardless of retry
// behavior below.
const MAX_PAGES = 100;

// Retry policy for transient page failures (429 rate-limit, 5xx,
// timeouts/aborts) — the shared _http.mjs fetchJsonWithRetry provides the
// backoff, Retry-After handling, non-retryable (incl. refused-redirect)
// classification and `.attempts` reporting. The policy mirrors the local
// policy this provider used to carry: 3 retries (4 attempts), 500ms base,
// 8s cap.
const RETRY_POLICY = { retries: 3, baseDelayMs: 500, maxDelayMs: 8_000 };

// Delay between successive pages so a 100-page walk doesn't fire as a burst
// against the same host (mirrors workday.mjs / oraclecloud.mjs).
const INTER_PAGE_DELAY_MS = 250;

function sleep(ms, ctx) {
  if (typeof ctx?.sleep === 'function') return ctx.sleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {string} url */
function assertMuseUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`themuse: invalid URL: ${url}`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`themuse: URL must use HTTPS: ${url}`);
  if (parsed.hostname !== TRUSTED_HOST) {
    throw new Error(`themuse: untrusted hostname "${parsed.hostname}" — must be ${TRUSTED_HOST}`);
  }
  return url;
}

/**
 * Normalize a single result from the Muse API response. Exported for unit tests.
 *
 * Field mapping:
 *   name              → title
 *   refs.landing_page → url
 *   company.name      → company
 *   locations[0].name → location
 *
 * Returns null when required fields (title or url) are missing or invalid.
 *
 * @param {any} j
 * @returns {{ title: string, url: string, company: string, location: string } | null}
 */
export function normalizeMuseJob(j) {
  if (!j || typeof j !== 'object') return null;
  const title = typeof j.name === 'string' ? j.name.trim() : '';
  if (!title) return null;
  const url = typeof j.refs?.landing_page === 'string' ? j.refs.landing_page.trim() : '';
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const company =
    typeof j.company?.name === 'string' && j.company.name.trim()
      ? j.company.name.trim()
      : 'The Muse';
  const location =
    Array.isArray(j.locations) && j.locations.length > 0 && typeof j.locations[0]?.name === 'string'
      ? j.locations[0].name.trim()
      : '';
  return { title, url, company, location };
}

/** @type {Provider} */
export default {
  id: 'themuse',

  async fetch(_entry, ctx) {
    assertMuseUrl(FEED_BASE);

    // Page 0 is fetched outside the tolerant loop below and its failure is
    // NOT caught: a completely dead board must throw, not return []. A
    // caught page-0 failure would return an empty array indistinguishable
    // from a healthy "0 jobs today" result -- scan.mjs's consecutive-failure
    // detector resets its streak on any non-throwing fetch, so a themuse
    // outage would silently reset the very detector meant to catch it.
    // Mirrors workday.mjs, which fetches its first page outside the
    // retry-tolerant loop (`page = 1` start) for the same reason.
    const firstUrl = `${FEED_BASE}?page=0`;
    // redirect:'error' prevents SSRF via server-side redirects
    const first = await fetchJsonWithRetry(ctx, firstUrl, { redirect: 'error' }, RETRY_POLICY);
    if (!first || !Array.isArray(first.results)) {
      throw new Error(
        `themuse: unexpected API response on page 0 — expected { results: [...] }, got keys: [${first ? Object.keys(first).join(', ') : 'null'}]`,
      );
    }
    const allResults = [...first.results];
    const pageCount = Number.isInteger(first.page_count) && first.page_count > 1
      ? Math.min(first.page_count, MAX_PAGES)
      : 1;

    // Pages 1+ stay tolerant: a page that exhausts retries, OR comes back
    // with an unexpected shape (a successful fetch, no retry involved --
    // caught here so it lands in the same truncation path instead of
    // escaping uncaught and discarding allResults), truncates with a warning
    // and returns whatever was already gathered instead of discarding it.
    for (let page = 1; page < pageCount; page++) {
      await sleep(INTER_PAGE_DELAY_MS, ctx);
      const url = `${FEED_BASE}?page=${page}`;
      let json;
      try {
        json = await fetchJsonWithRetry(ctx, url, { redirect: 'error' }, RETRY_POLICY);
        if (!json || !Array.isArray(json.results)) {
          throw new Error(
            `themuse: unexpected API response on page ${page} — expected { results: [...] }, got keys: [${json ? Object.keys(json).join(', ') : 'null'}]`,
          );
        }
      } catch (err) {
        const attempts = Number.isInteger(err?.attempts) ? err.attempts : 1;
        console.error(`⚠️  themuse: truncated at page ${page} of ${pageCount} after ${attempts} attempt${attempts === 1 ? '' : 's'} (${allResults.length} jobs gathered so far): ${err.message}`);
        break;
      }
      allResults.push(...json.results);
    }
    return allResults.map(normalizeMuseJob).filter(Boolean);
  },
};
