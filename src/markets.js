const axios = require('axios');
const config = require('./config');

/**
 * Target series for crypto up/down markets with their timeframes
 */
const TARGET_SERIES = [
  { prefix: 'btc-updown', duration: 5, seriesSlug: 'btc-up-or-down-5m' }
];

/**
 * Calculate timestamps for current and upcoming market windows
 */
function getMarketTimestamps(durationMinutes) {
  const now = new Date();
  const timestamps = [];
  
  // Round down to nearest interval
  const minutes = now.getUTCMinutes();
  const roundedMinutes = Math.floor(minutes / durationMinutes) * durationMinutes;
  
  // Current window
  const currentStart = new Date(now);
  currentStart.setUTCMinutes(roundedMinutes, 0, 0);
  const currentEnd = new Date(currentStart.getTime() + durationMinutes * 60 * 1000);
  
  // Next window
  const nextEnd = new Date(currentEnd.getTime() + durationMinutes * 60 * 1000);
  
  // Return timestamps for current and next windows
  timestamps.push(Math.floor(currentEnd.getTime() / 1000));
  timestamps.push(Math.floor(nextEnd.getTime() / 1000));
  
  return timestamps;
}

/**
 * Build market slug from prefix and timestamp
 */
function buildSlug(prefix, duration, timestamp) {
  return `${prefix}-${duration}m-${timestamp}`;
}

/**
 * Fetch active crypto up/down markets by constructing expected slugs
 */
async function fetchCryptoUpDownMarkets() {
  console.log('📊 Fetching crypto up/down markets...');
  
  const markets = [];
  const slugsToQuery = [];
  
  // Build list of expected slugs for current and next windows
  for (const series of TARGET_SERIES) {
    const timestamps = getMarketTimestamps(series.duration);
    for (const ts of timestamps) {
      slugsToQuery.push({
        slug: buildSlug(series.prefix, series.duration, ts),
        series: series
      });
    }
  }
  
  // Query each potential market
  for (const { slug, series } of slugsToQuery) {
    try {
      const response = await axios.get(`${config.GAMMA_HOST}/events`, {
        params: { slug }
      });
      
      const events = response.data;
      if (!events || events.length === 0) continue;
      
      const event = events[0];
      
      // Skip closed markets
      if (event.closed) continue;
      
      const market = event.markets?.[0];
      if (!market) continue;
      
      // Parse outcomes and prices
      let outcomes = ['Up', 'Down'];
      let outcomePrices = [0.5, 0.5];
      let tokens = [];
      
      try {
        outcomes = JSON.parse(market.outcomes || '["Up", "Down"]');
        outcomePrices = JSON.parse(market.outcomePrices || '["0.5", "0.5"]').map(p => parseFloat(p));
        tokens = JSON.parse(market.clobTokenIds || '[]');
      } catch (e) {}
      
      markets.push({
        eventId: event.id,
        eventSlug: event.slug,
        eventTitle: event.title,
        marketId: market.id,
        conditionId: market.conditionId,
        question: market.question,
        outcomes,
        outcomePrices,
        endDate: event.endDate,
        startTime: event.startTime,
        tokens,
        acceptingOrders: market.acceptingOrders,
        lastTradePrice: market.lastTradePrice,
        bestBid: market.bestBid,
        bestAsk: market.bestAsk,
        seriesSlug: series.seriesSlug,
        symbol: series.prefix.split('-')[0].toUpperCase()
      });
      
    } catch (error) {
      // Silently skip markets that don't exist
      if (error.response?.status !== 404) {
        console.error(`❌ Error fetching ${slug}:`, error.message);
      }
    }
  }
  
  // Sort by end date (soonest first)
  markets.sort((a, b) => new Date(a.endDate) - new Date(b.endDate));
  
  console.log(`✅ Found ${markets.length} target markets`);
  return markets;
}

/**
 * Get market details including current prices
 */
async function getMarketDetails(conditionId) {
  try {
    const response = await axios.get(`${config.GAMMA_HOST}/markets/${conditionId}`);
    return response.data;
  } catch (error) {
    console.error(`❌ Error fetching market ${conditionId}:`, error.message);
    return null;
  }
}

/**
 * Parse time remaining from market endDate
 * Returns seconds until market closes
 */
function getSecondsRemaining(endDate) {
  if (!endDate) return Infinity;
  const end = new Date(endDate);
  const now = new Date();
  return Math.max(0, Math.floor((end - now) / 1000));
}

/**
 * Get confidence level based on market prices
 * Higher confidence = price closer to 0 or 1
 */
function getConfidence(outcomePrices) {
  if (!outcomePrices || outcomePrices.length < 2) return 0.5;
  const upPrice = parseFloat(outcomePrices[0]);
  const downPrice = parseFloat(outcomePrices[1]);
  return Math.max(upPrice, downPrice);
}

/**
 * Determine predicted direction based on prices
 */
function getPredictedDirection(outcomePrices) {
  if (!outcomePrices || outcomePrices.length < 2) return null;
  const upPrice = parseFloat(outcomePrices[0]);
  const downPrice = parseFloat(outcomePrices[1]);
  return upPrice > downPrice ? 'Up' : 'Down';
}

module.exports = {
  fetchCryptoUpDownMarkets,
  getMarketDetails,
  getSecondsRemaining,
  getConfidence,
  getPredictedDirection,
  TARGET_SERIES
};
