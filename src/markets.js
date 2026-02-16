const axios = require('axios');
const config = require('./config');

const INTERVAL_SECS = 300; // 5 minutes

/**
 * Build the slug for a given 5-minute window timestamp.
 */
function buildSlug(ts) {
  return `btc-updown-5m-${ts}`;
}

/**
 * Get the unix timestamp for the current 5-minute window start.
 */
function currentWindowTs() {
  return Math.floor(Date.now() / 1000 / INTERVAL_SECS) * INTERVAL_SECS;
}

/**
 * Fetch the "price to beat" (openPrice) for a market from Polymarket's event page.
 * This is the Chainlink BTC/USD price at the start of the 5-minute window.
 */
async function fetchPriceToBeat(slug) {
  try {
    const { data: html } = await axios.get(`https://polymarket.com/event/${slug}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000
    });

    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/);
    if (!match) return null;

    const nextData = JSON.parse(match[1]);
    const queries = nextData?.props?.pageProps?.dehydratedState?.queries || [];

    for (const q of queries) {
      const key = q.queryKey || [];
      if (Array.isArray(key) && key[0] === 'crypto-prices') {
        const openPrice = q.state?.data?.openPrice;
        if (typeof openPrice === 'number' && openPrice > 0) {
          return openPrice;
        }
      }
    }

    return null;
  } catch (error) {
    console.error(`  Error fetching price to beat:`, error.message);
    return null;
  }
}

/**
 * Fetch a BTC 5m market by its window timestamp.
 * Returns parsed market object or null.
 */
async function fetchMarketByTimestamp(ts) {
  const slug = buildSlug(ts);
  try {
    const { data: events } = await axios.get(`${config.GAMMA_HOST}/events`, {
      params: { slug }
    });

    if (!events || events.length === 0) return null;

    const event = events[0];
    if (event.closed) return null;

    const market = event.markets?.[0];
    if (!market) return null;

    return {
      eventId: event.id,
      slug: event.slug,
      title: event.title,
      marketId: market.id,
      conditionId: market.conditionId,
      outcomes: JSON.parse(market.outcomes || '["Up","Down"]'),
      outcomePrices: JSON.parse(market.outcomePrices || '["0.5","0.5"]').map(Number),
      endDate: event.endDate,
      startTime: event.startTime || market.eventStartTime,
      tokens: JSON.parse(market.clobTokenIds || '[]'),
      acceptingOrders: market.acceptingOrders
    };
  } catch (error) {
    if (error.response?.status !== 404) {
      console.error(`  Error fetching ${slug}:`, error.message);
    }
    return null;
  }
}

/**
 * Fetch the current active BTC 5m market (tries current window, then next).
 */
async function fetchCurrentMarket() {
  const ts = currentWindowTs();

  let market = await fetchMarketByTimestamp(ts);
  if (market) return market;

  return fetchMarketByTimestamp(ts + INTERVAL_SECS);
}

/**
 * Seconds remaining until endDate.
 */
function getSecondsRemaining(endDate) {
  if (!endDate) return Infinity;
  return Math.max(0, Math.floor((new Date(endDate) - Date.now()) / 1000));
}

module.exports = {
  fetchCurrentMarket,
  fetchMarketByTimestamp,
  fetchPriceToBeat,
  getSecondsRemaining,
  currentWindowTs,
  INTERVAL_SECS
};
