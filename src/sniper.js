const WebSocket = require('ws');
const axios = require('axios');
const config = require('./config');
const { getClient } = require('./client');

// Track active subscriptions and positions
const activeMarkets = new Map();
const openPositions = new Set();

/**
 * Connect to Polymarket WebSocket for real-time price updates
 */
function connectWebSocket(tokenIds, onPriceUpdate) {
  console.log('🔌 Connecting to WebSocket...');
  
  const ws = new WebSocket(config.WSS_HOST);
  
  ws.on('open', () => {
    console.log('✅ WebSocket connected');
    
    // Subscribe to market channel for price updates
    const subscribeMsg = {
      type: 'MARKET',
      assets_ids: tokenIds
    };
    
    ws.send(JSON.stringify(subscribeMsg));
    console.log(`📡 Subscribed to ${tokenIds.length} tokens`);
  });
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'price_change' || msg.event_type === 'price_change') {
        onPriceUpdate(msg);
      }
    } catch (e) {
      // Ignore parse errors
    }
  });
  
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error.message);
  });
  
  ws.on('close', () => {
    console.log('🔌 WebSocket closed, reconnecting in 5s...');
    setTimeout(() => connectWebSocket(tokenIds, onPriceUpdate), 5000);
  });
  
  return ws;
}

/**
 * Evaluate if we should snipe this market
 */
function shouldSnipe(market, currentPrice, priceTobeat, secondsRemaining) {
  // Only snipe in final N seconds
  if (secondsRemaining > config.SNIPE_SECONDS) {
    return { snipe: false, reason: `Too early (${secondsRemaining}s remaining)` };
  }
  
  // Skip if we already have a position
  if (openPositions.has(market.conditionId)) {
    return { snipe: false, reason: 'Already have position' };
  }
  
  // Calculate confidence based on price difference
  const priceDiff = currentPrice - priceTobeat;
  const upConfidence = priceDiff > 0 ? 0.5 + Math.min(0.49, Math.abs(priceDiff) / priceTobeat * 10) : 0.5 - Math.min(0.49, Math.abs(priceDiff) / priceTobeat * 10);
  
  // Determine direction and confidence
  const goUp = upConfidence >= 0.5;
  const confidence = goUp ? upConfidence : (1 - upConfidence);
  
  if (confidence < config.MIN_CONFIDENCE) {
    return { snipe: false, reason: `Low confidence (${(confidence * 100).toFixed(1)}%)` };
  }
  
  return {
    snipe: true,
    direction: goUp ? 'UP' : 'DOWN',
    confidence,
    reason: `Sniping ${goUp ? 'UP' : 'DOWN'} with ${(confidence * 100).toFixed(1)}% confidence`
  };
}

/**
 * Place a market buy order
 */
async function placeOrder(tokenId, side, amount) {
  const client = getClient();
  if (!client) {
    console.error('❌ Client not initialized');
    return null;
  }
  
  try {
    console.log(`🎯 Placing ${side} order for $${amount} on token ${tokenId.slice(0,10)}...`);
    
    // Use createMarketBuyOrder for market orders
    const order = await client.createMarketBuyOrder({
      tokenID: tokenId,
      amount: parseFloat(amount) // USDC amount
    });
    
    console.log('✅ Order created, posting...');
    
    // Post the order to execute it
    const result = await client.postOrder(order);
    console.log('✅ Order executed:', result);
    
    return result;
    
  } catch (error) {
    console.error('❌ Order failed:', error.message);
    console.error('   Full error:', error);
    return null;
  }
}

/**
 * Execute snipe trade
 */
async function executeSnipe(market, direction) {
  const tokenId = direction === 'UP' ? market.tokens[0] : market.tokens[1];
  
  console.log(`\n🎯 SNIPING: ${market.eventTitle}`);
  console.log(`   Direction: ${direction}`);
  console.log(`   Amount: $${config.BET_AMOUNT_USD}`);
  console.log(`   Token ID: ${tokenId}`);
  
  const result = await placeOrder(tokenId, 'BUY', config.BET_AMOUNT_USD);
  
  if (result) {
    openPositions.add(market.conditionId);
    return {
      success: true,
      market: market.eventTitle,
      direction,
      amount: config.BET_AMOUNT_USD,
      order: result
    };
  }
  
  return { success: false, market: market.eventTitle, direction };
}

/**
 * Get live crypto price from Chainlink
 */
async function getLivePrice(symbol) {
  try {
    // Use CoinGecko as backup price source
    const ids = {
      'BTC': 'bitcoin',
      'ETH': 'ethereum',
      'SOL': 'solana',
      'XRP': 'ripple'
    };
    
    const id = ids[symbol.toUpperCase()];
    if (!id) return null;
    
    const response = await axios.get(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`);
    return response.data[id]?.usd;
    
  } catch (error) {
    console.error(`❌ Error fetching ${symbol} price:`, error.message);
    return null;
  }
}

module.exports = {
  connectWebSocket,
  shouldSnipe,
  executeSnipe,
  getLivePrice,
  activeMarkets,
  openPositions
};
