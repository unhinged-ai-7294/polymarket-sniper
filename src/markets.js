const axios = require('axios');
const config = require('./config');

/**
 * Fetch active crypto up/down markets from Gamma API
 */
async function fetchCryptoUpDownMarkets() {
  console.log('📊 Fetching crypto up/down markets...');
  
  try {
    // Fetch events with crypto tag
    const response = await axios.get(`${config.GAMMA_HOST}/events`, {
      params: {
        active: true,
        closed: false,
        tag: 'crypto',
        limit: 100
      }
    });
    
    const events = response.data || [];
    const upDownMarkets = [];
    
    for (const event of events) {
      const slug = event.slug || '';
      
      // Filter for BTC/ETH 5-min and 15-min up/down markets
      const isTargetMarket = config.MARKET_FILTERS.some(filter => 
        slug.toLowerCase().includes(filter)
      );
      
      if (isTargetMarket && event.markets) {
        for (const market of event.markets) {
          upDownMarkets.push({
            eventId: event.id,
            eventSlug: slug,
            eventTitle: event.title,
            marketId: market.id,
            conditionId: market.conditionId,
            question: market.question,
            outcomes: market.outcomes,
            outcomePrices: market.outcomePrices,
            endDate: event.endDate,
            tokens: market.clobTokenIds
          });
        }
      }
    }
    
    console.log(`✅ Found ${upDownMarkets.length} target markets`);
    return upDownMarkets;
    
  } catch (error) {
    console.error('❌ Error fetching markets:', error.message);
    return [];
  }
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
 * Parse time remaining from market title/endDate
 * Returns seconds until market closes
 */
function getSecondsRemaining(endDate) {
  if (!endDate) return Infinity;
  const end = new Date(endDate);
  const now = new Date();
  return Math.max(0, Math.floor((end - now) / 1000));
}

module.exports = {
  fetchCryptoUpDownMarkets,
  getMarketDetails,
  getSecondsRemaining
};
