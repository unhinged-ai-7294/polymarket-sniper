#!/usr/bin/env node
require('dotenv').config();

const WebSocket = require('ws');
const config = require('./config');
const { initializeClient, getClient } = require('./client');
const { fetchCryptoUpDownMarkets, getSecondsRemaining } = require('./markets');
const { executeSnipe, getLivePrice } = require('./sniper');

// State
let ws = null;
let monitoredMarkets = new Map(); // tokenId -> market data
let openPositions = new Set();    // conditionIds we've already bet on
const tradeHistory = [];

/**
 * Subscribe to token price updates via WebSocket
 */
function subscribeToTokens(tokenIds) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.log('⚠️ WebSocket not ready, skipping subscription');
    return;
  }
  
  if (tokenIds.length === 0) return;
  
  const msg = {
    type: 'market',
    assets_ids: tokenIds
  };
  
  ws.send(JSON.stringify(msg));
  console.log(`📡 Subscribed to ${tokenIds.length} tokens`);
}

/**
 * Handle incoming WebSocket messages
 */
function handleMessage(data) {
  try {
    const msg = JSON.parse(data);
    
    // Price change events
    if (msg.event_type === 'price_change' || msg.type === 'price_change') {
      const tokenId = msg.asset_id;
      const newPrice = parseFloat(msg.price);
      
      // Find which market this token belongs to
      for (const [id, market] of monitoredMarkets) {
        if (market.tokens?.includes(tokenId)) {
          const isUp = market.tokens[0] === tokenId;
          const direction = isUp ? 'UP' : 'DOWN';
          
          console.log(`💹 ${market.symbol} ${direction}: ${(newPrice * 100).toFixed(1)}%`);
          
          // Update stored odds
          if (isUp) {
            market.outcomePrices = [newPrice, 1 - newPrice];
          } else {
            market.outcomePrices = [1 - newPrice, newPrice];
          }
          
          // Check for snipe opportunity
          checkSnipeOpportunity(market);
          break;
        }
      }
    }
    
    // Book updates (order book changes)
    if (msg.event_type === 'book') {
      // Can process order book depth here if needed
    }
    
  } catch (e) {
    // Ignore parse errors
  }
}

/**
 * Check if we should snipe this market
 */
async function checkSnipeOpportunity(market) {
  const secondsRemaining = getSecondsRemaining(market.endDate);
  
  // Only snipe in final window
  if (secondsRemaining > config.SNIPE_SECONDS || secondsRemaining < 3) {
    return;
  }
  
  // Skip if already positioned
  if (openPositions.has(market.conditionId)) {
    return;
  }
  
  const upOdds = parseFloat(market.outcomePrices?.[0]) || 0.5;
  const downOdds = parseFloat(market.outcomePrices?.[1]) || 0.5;
  
  // Check confidence thresholds
  const shouldGoUp = upOdds >= config.MIN_CONFIDENCE && upOdds <= config.MAX_CONFIDENCE;
  const shouldGoDown = downOdds >= config.MIN_CONFIDENCE && downOdds <= config.MAX_CONFIDENCE;
  
  if (!shouldGoUp && !shouldGoDown) {
    return;
  }
  
  const direction = shouldGoUp ? 'UP' : 'DOWN';
  const confidence = shouldGoUp ? upOdds : downOdds;
  
  console.log(`\n🚨 SNIPE SIGNAL!`);
  console.log(`   ${market.symbol} - ${market.eventTitle}`);
  console.log(`   Direction: ${direction} (${(confidence * 100).toFixed(0)}%)`);
  console.log(`   Time left: ${secondsRemaining}s`);
  
  // Execute the snipe
  openPositions.add(market.conditionId);
  
  const result = await executeSnipe(market, direction);
  tradeHistory.push({
    timestamp: new Date().toISOString(),
    ...result
  });
  
  if (result.success) {
    console.log(`✅ TRADE EXECUTED: ${direction} on ${market.symbol}`);
  } else {
    // Allow retry on failure
    openPositions.delete(market.conditionId);
  }
}

/**
 * Connect to Polymarket WebSocket
 */
function connectWebSocket() {
  console.log('🔌 Connecting to WebSocket...');
  
  ws = new WebSocket(config.WSS_HOST);
  
  ws.on('open', () => {
    console.log('✅ WebSocket connected');
    
    // Subscribe to currently monitored tokens
    const allTokens = [];
    for (const market of monitoredMarkets.values()) {
      if (market.tokens) {
        allTokens.push(...market.tokens);
      }
    }
    
    if (allTokens.length > 0) {
      subscribeToTokens(allTokens);
    }
  });
  
  ws.on('message', handleMessage);
  
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error.message);
  });
  
  ws.on('close', () => {
    console.log('🔌 WebSocket closed, reconnecting in 3s...');
    setTimeout(connectWebSocket, 3000);
  });
  
  ws.on('ping', () => ws.pong());
}

/**
 * Refresh market list periodically (discover new markets)
 */
async function refreshMarkets() {
  try {
    const markets = await fetchCryptoUpDownMarkets();
    const newTokens = [];
    
    console.log(`\n📊 Found ${markets.length} crypto Up/Down markets`);
    
    for (const market of markets) {
      const secs = getSecondsRemaining(market.endDate);
      
      // Only track markets within 15 minutes
      if (secs > 0 && secs < 900) {
        const key = market.conditionId;
        
        if (!monitoredMarkets.has(key)) {
          console.log(`   ➕ ${market.symbol} | ${Math.floor(secs/60)}m ${secs%60}s remaining`);
          monitoredMarkets.set(key, market);
          
          if (market.tokens) {
            newTokens.push(...market.tokens);
          }
        }
      }
    }
    
    // Clean up expired markets
    for (const [key, market] of monitoredMarkets) {
      const secs = getSecondsRemaining(market.endDate);
      if (secs <= 0) {
        console.log(`   ➖ ${market.symbol} expired`);
        monitoredMarkets.delete(key);
        openPositions.delete(market.conditionId);
      }
    }
    
    // Subscribe to new tokens
    if (newTokens.length > 0) {
      subscribeToTokens(newTokens);
    }
    
    console.log(`   📡 Monitoring ${monitoredMarkets.size} active markets`);
    
  } catch (error) {
    console.error('❌ Market refresh error:', error.message);
  }
}

/**
 * Periodic timer check for snipe windows (backup to WebSocket)
 */
async function timerCheck() {
  for (const market of monitoredMarkets.values()) {
    await checkSnipeOpportunity(market);
  }
}

/**
 * Main entry point
 */
async function main() {
  console.log('🚀 Polymarket Sniper Bot Starting...');
  console.log('═'.repeat(50));
  console.log(`💰 Bet amount: $${config.BET_AMOUNT_USD}`);
  console.log(`🎯 Confidence range: ${config.MIN_CONFIDENCE * 100}% - ${config.MAX_CONFIDENCE * 100}%`);
  console.log(`⏱️  Snipe window: ${config.SNIPE_SECONDS}s before close`);
  console.log(`🔌 WebSocket: ${config.WSS_HOST}`);
  console.log('═'.repeat(50));
  
  // Validate config
  if (!config.PRIVATE_KEY) {
    console.error('❌ PRIVATE_KEY not set in .env file');
    process.exit(1);
  }
  
  // Initialize CLOB client
  try {
    await initializeClient();
    console.log('✅ CLOB client initialized');
  } catch (error) {
    console.error('❌ Failed to initialize client:', error.message);
    process.exit(1);
  }
  
  // Connect WebSocket
  connectWebSocket();
  
  // Initial market scan
  await refreshMarkets();
  
  // Refresh markets every 30 seconds (discover new ones)
  setInterval(refreshMarkets, 30000);
  
  // Backup timer check every 1 second (in case WebSocket misses something)
  setInterval(timerCheck, 1000);
  
  console.log('\n🎯 Bot running - listening for snipe opportunities...\n');
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  
  if (ws) ws.close();
  
  console.log('\n📊 Trade History:');
  if (tradeHistory.length === 0) {
    console.log('   No trades executed');
  } else {
    tradeHistory.forEach(t => {
      console.log(`   ${t.timestamp}: ${t.direction} ${t.market} - ${t.success ? '✅' : '❌'}`);
    });
  }
  
  process.exit(0);
});

main().catch(console.error);
