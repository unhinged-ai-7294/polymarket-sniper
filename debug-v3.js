#!/usr/bin/env node
/**
 * Debug v3 - BTC 5-min Market
 * Fixed WebSocket message parsing
 */

const axios = require('axios');
const WebSocket = require('ws');

const GAMMA_HOST = 'https://gamma-api.polymarket.com';
const WSS_HOST = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';

// Store token ID mapping
let tokenMap = {}; // tokenId -> 'UP' or 'DOWN'

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
 * Fetch current market
 */
async function fetchMarket() {
  const slug = getCurrentSlug();
  
  try {
    const res = await axios.get(`${GAMMA_HOST}/events`, { params: { slug } });
    const event = res.data?.[0];
    if (!event) return null;
    
    const market = event.markets?.[0];
    if (!market) return null;
    
    // Parse token IDs
    let tokenIds = [];
    try {
      tokenIds = JSON.parse(market.clobTokenIds || '[]');
    } catch (e) {}
    
    // Build token map
    if (tokenIds.length >= 2) {
      tokenMap[tokenIds[0]] = 'UP';
      tokenMap[tokenIds[1]] = 'DOWN';
    }
    
    const endDate = new Date(event.endDate);
    const now = new Date();
    const secsRemaining = Math.max(0, Math.floor((endDate - now) / 1000));
    
    return {
      slug,
      title: event.title,
      endDate: event.endDate,
      secsRemaining,
      lastTradePrice: market.lastTradePrice,
      bestBid: market.bestBid,
      bestAsk: market.bestAsk,
      tokenIds
    };
  } catch (e) {
    return null;
  }
}

/**
 * Log market status
 */
function logMarket(m) {
  const mins = Math.floor(m.secsRemaining / 60);
  const secs = m.secsRemaining % 60;
  
  const upPrice = m.lastTradePrice || 0.5;
  const downPrice = 1 - upPrice;
  
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`📈 ${m.title}`);
  console.log(`⏱️  ${mins}m ${secs}s remaining`);
  console.log(`💰 UP: ${(upPrice * 100).toFixed(1)}% | DOWN: ${(downPrice * 100).toFixed(1)}%`);
  console.log(`📊 Bid: ${m.bestBid} | Ask: ${m.bestAsk} | Last: ${m.lastTradePrice}`);
}

/**
 * Connect WebSocket and handle messages
 */
function connectWebSocket(tokenIds) {
  console.log('\n🔌 Connecting to WebSocket...');
  
  const ws = new WebSocket(WSS_HOST);
  
  ws.on('open', () => {
    console.log('✅ WebSocket connected');
    
    // Subscribe to market channel
    const msg = {
      type: 'market',
      assets_ids: tokenIds
    };
    ws.send(JSON.stringify(msg));
    console.log(`📡 Subscribed to ${tokenIds.length} tokens`);
  });
  
  ws.on('message', (data) => {
    try {
      const str = data.toString();
      
      // Handle array of messages
      if (str.startsWith('[')) {
        const msgs = JSON.parse(str);
        for (const msg of msgs) {
          handleSingleMessage(msg);
        }
      } else {
        const msg = JSON.parse(str);
        handleSingleMessage(msg);
      }
    } catch (e) {
      // Ignore parse errors
    }
  });
  
  ws.on('error', (e) => console.log('❌ WS error:', e.message));
  ws.on('close', () => console.log('🔌 WS closed'));
  
  return ws;
}

/**
 * Handle a single WebSocket message
 */
function handleSingleMessage(msg) {
  // Check if it has price data
  if (msg.price && msg.asset_id) {
    const price = parseFloat(msg.price);
    const side = tokenMap[msg.asset_id] || 'UNKNOWN';
    
    // Only log meaningful price changes
    if (!isNaN(price)) {
      const timestamp = new Date().toLocaleTimeString('en-US', { 
        hour12: false, 
        timeZone: 'Asia/Kuala_Lumpur' 
      });
      
      console.log(`💹 [${timestamp}] ${side}: ${(price * 100).toFixed(1)}%`);
    }
  }
  
  // Log book updates (less verbose)
  if (msg.event_type === 'book') {
    // Skip - too verbose
  }
}

/**
 * Main
 */
async function main() {
  console.log('═'.repeat(50));
  console.log('BTC 5-min Market Debug v3');
  console.log('═'.repeat(50));
  console.log(`Started: ${new Date().toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' })}`);
  
  // Fetch initial market
  let market = await fetchMarket();
  
  if (!market) {
    console.log('\n❌ No market found');
    process.exit(1);
  }
  
  logMarket(market);
  
  // Connect WebSocket
  let ws = null;
  if (market.tokenIds?.length > 0) {
    ws = connectWebSocket(market.tokenIds);
  }
  
  // Poll API every 10 seconds to show updated prices
  setInterval(async () => {
    const m = await fetchMarket();
    if (m) {
      // Check for new market
      if (m.slug !== market?.slug) {
        console.log('\n\n🔄 NEW MARKET WINDOW!');
        market = m;
        logMarket(market);
        
        // Update token map
        if (m.tokenIds?.length >= 2) {
          tokenMap = {};
          tokenMap[m.tokenIds[0]] = 'UP';
          tokenMap[m.tokenIds[1]] = 'DOWN';
        }
        
        // Reconnect WebSocket
        if (ws) ws.close();
        ws = connectWebSocket(m.tokenIds);
      } else {
        market = m;
        logMarket(market);
      }
    }
  }, 10000);
  
  // Run for 2 minutes
  setTimeout(() => {
    console.log('\n\n✅ Debug complete');
    if (ws) ws.close();
    process.exit(0);
  }, 120000);
}

process.on('SIGINT', () => {
  console.log('\n👋 Bye');
  process.exit(0);
});

main().catch(console.error);
