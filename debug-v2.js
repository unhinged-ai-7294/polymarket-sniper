#!/usr/bin/env node
/**
 * Debug v2 - BTC 5-min Market
 * Using CORRECT price fields: bestBid, bestAsk, lastTradePrice
 */

const axios = require('axios');
const WebSocket = require('ws');

const GAMMA_HOST = 'https://gamma-api.polymarket.com';
const CLOB_HOST = 'https://clob.polymarket.com';
const WSS_HOST = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

/**
 * Build expected slug for current 5-min window
 */
function getCurrentSlug() {
  const now = new Date();
  const minutes = now.getUTCMinutes();
  const roundedMinutes = Math.floor(minutes / 5) * 5;
  
  const currentStart = new Date(now);
  currentStart.setUTCMinutes(roundedMinutes, 0, 0);
  const currentEnd = new Date(currentStart.getTime() + 5 * 60 * 1000);
  const timestamp = Math.floor(currentEnd.getTime() / 1000);
  
  return `btc-updown-5m-${timestamp}`;
}

/**
 * Get seconds until market ends
 */
function getSecondsRemaining(endDate) {
  const end = new Date(endDate);
  const now = new Date();
  return Math.max(0, Math.floor((end - now) / 1000));
}

/**
 * Fetch and display current market with CORRECT prices
 */
async function fetchMarket() {
  const slug = getCurrentSlug();
  console.log(`\n📊 Fetching: ${slug}`);
  
  try {
    const res = await axios.get(`${GAMMA_HOST}/events`, { params: { slug } });
    const event = res.data?.[0];
    
    if (!event) {
      console.log('❌ Market not found');
      return null;
    }
    
    const market = event.markets?.[0];
    if (!market) {
      console.log('❌ No market data');
      return null;
    }
    
    const secsRemaining = getSecondsRemaining(event.endDate);
    const mins = Math.floor(secsRemaining / 60);
    const secs = secsRemaining % 60;
    
    // Parse token IDs
    let tokenIds = [];
    try {
      tokenIds = JSON.parse(market.clobTokenIds || '[]');
    } catch (e) {}
    
    console.log('─'.repeat(50));
    console.log(`📈 ${event.title}`);
    console.log(`⏱️  Time remaining: ${mins}m ${secs}s`);
    console.log('─'.repeat(50));
    console.log('PRICES (these are the REAL ones):');
    console.log(`  lastTradePrice: ${market.lastTradePrice}`);
    console.log(`  bestBid: ${market.bestBid}`);
    console.log(`  bestAsk: ${market.bestAsk}`);
    console.log(`  spread: ${market.spread}`);
    console.log('─'.repeat(50));
    console.log('Stale field (ignore):');
    console.log(`  outcomePrices: ${market.outcomePrices}`);
    console.log('─'.repeat(50));
    console.log(`Token IDs: ${tokenIds.length > 0 ? 'Found' : 'Missing'}`);
    if (tokenIds.length > 0) {
      console.log(`  UP token: ${tokenIds[0]?.slice(0, 30)}...`);
      console.log(`  DOWN token: ${tokenIds[1]?.slice(0, 30)}...`);
    }
    
    // Interpret the price
    const upPrice = market.lastTradePrice || 0.5;
    const downPrice = 1 - upPrice;
    console.log('─'.repeat(50));
    console.log('INTERPRETATION:');
    console.log(`  UP:   ${(upPrice * 100).toFixed(1)}%`);
    console.log(`  DOWN: ${(downPrice * 100).toFixed(1)}%`);
    console.log(`  Leader: ${upPrice > 0.5 ? 'UP' : upPrice < 0.5 ? 'DOWN' : 'EVEN'}`);
    
    return {
      slug,
      title: event.title,
      endDate: event.endDate,
      secsRemaining,
      lastTradePrice: market.lastTradePrice,
      bestBid: market.bestBid,
      bestAsk: market.bestAsk,
      tokenIds,
      conditionId: market.conditionId
    };
    
  } catch (e) {
    console.log('❌ Error:', e.message);
    return null;
  }
}

/**
 * Subscribe to WebSocket for real-time price updates
 */
function subscribeWebSocket(tokenIds) {
  console.log('\n🔌 Connecting to WebSocket...');
  
  const ws = new WebSocket(WSS_HOST);
  
  ws.on('open', () => {
    console.log('✅ WebSocket connected');
    
    const msg = {
      type: 'market',
      assets_ids: tokenIds
    };
    
    console.log('📡 Subscribing to tokens...');
    ws.send(JSON.stringify(msg));
  });
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      // Log all messages to understand the format
      if (msg.event_type === 'price_change') {
        const price = parseFloat(msg.price);
        const tokenId = msg.asset_id;
        const isUp = tokenIds[0] === tokenId;
        
        console.log(`💹 Price update: ${isUp ? 'UP' : 'DOWN'} = ${(price * 100).toFixed(1)}%`);
      } else if (msg.event_type === 'book') {
        console.log(`📖 Book update for ${msg.asset_id?.slice(0, 20)}...`);
      } else {
        // Log unknown message types
        console.log('📨 WS:', JSON.stringify(msg).slice(0, 200));
      }
    } catch (e) {
      console.log('📨 WS (raw):', data.toString().slice(0, 100));
    }
  });
  
  ws.on('error', (e) => console.log('❌ WS error:', e.message));
  ws.on('close', () => console.log('🔌 WS closed'));
  
  return ws;
}

/**
 * Main - poll market every 5 seconds and show WebSocket updates
 */
async function main() {
  console.log('═'.repeat(50));
  console.log('BTC 5-min Market Debug v2');
  console.log('═'.repeat(50));
  console.log(`Started: ${new Date().toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' })}`);
  
  // Initial fetch
  let market = await fetchMarket();
  
  if (!market) {
    console.log('\nNo market found. Waiting for next 5-min window...');
    // Wait and retry
    await new Promise(r => setTimeout(r, 10000));
    market = await fetchMarket();
  }
  
  if (!market) {
    console.log('\nStill no market. Exiting.');
    process.exit(1);
  }
  
  // Connect WebSocket
  let ws = null;
  if (market.tokenIds?.length > 0) {
    ws = subscribeWebSocket(market.tokenIds);
  }
  
  // Poll every 5 seconds
  const interval = setInterval(async () => {
    const newMarket = await fetchMarket();
    
    if (newMarket && newMarket.slug !== market?.slug) {
      console.log('\n🔄 New market window detected!');
      market = newMarket;
      
      // Reconnect WebSocket for new tokens
      if (ws) ws.close();
      if (market.tokenIds?.length > 0) {
        ws = subscribeWebSocket(market.tokenIds);
      }
    }
    
    if (newMarket?.secsRemaining <= 0) {
      console.log('\n⏰ Market closed!');
    }
    
  }, 5000);
  
  // Run for 2 minutes then exit
  setTimeout(() => {
    console.log('\n\n📊 Debug session complete (2 min)');
    clearInterval(interval);
    if (ws) ws.close();
    process.exit(0);
  }, 120000);
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  process.exit(0);
});

main().catch(console.error);
