#!/usr/bin/env node
require('dotenv').config();

const config = require('./config');
const { initializeClient } = require('./client');
const { fetchCryptoUpDownMarkets, getSecondsRemaining } = require('./markets');
const { shouldSnipe, executeSnipe, getLivePrice } = require('./sniper');

// Store active markets we're monitoring
const monitoredMarkets = new Map();
const tradeHistory = [];

/**
 * Main monitoring loop
 */
async function monitorMarkets() {
  console.log('\n📊 Scanning markets...');
  
  const markets = await fetchCryptoUpDownMarkets();
  
  for (const market of markets) {
    const secondsRemaining = getSecondsRemaining(market.endDate);
    
    // Skip markets that are too far out
    if (secondsRemaining > 300) continue; // Only monitor last 5 minutes
    
    // Parse symbol from event slug (e.g., "btc-updown-15m-1234567890")
    let symbol = 'BTC';
    if (market.eventSlug.includes('eth')) symbol = 'ETH';
    else if (market.eventSlug.includes('sol')) symbol = 'SOL';
    else if (market.eventSlug.includes('xrp')) symbol = 'XRP';
    
    // Get live price
    const currentPrice = await getLivePrice(symbol);
    if (!currentPrice) continue;
    
    // Parse price to beat from market title
    // e.g., "Bitcoin Up or Down - 15 min" with priceTobeat in description
    const priceTobeat = market.outcomePrices ? parseFloat(market.outcomePrices[0]) : null;
    
    // Log market status
    console.log(`\n📈 ${market.eventTitle}`);
    console.log(`   ⏱️  ${secondsRemaining}s remaining`);
    console.log(`   💰 Current: $${currentPrice}`);
    console.log(`   🎯 Odds: UP ${((market.outcomePrices?.[0] || 0.5) * 100).toFixed(0)}% / DOWN ${((market.outcomePrices?.[1] || 0.5) * 100).toFixed(0)}%`);
    
    // Check if we should snipe
    if (secondsRemaining <= config.SNIPE_SECONDS) {
      const upOdds = parseFloat(market.outcomePrices?.[0]) || 0.5;
      const downOdds = parseFloat(market.outcomePrices?.[1]) || 0.5;
      
      // High odds = high confidence from the market
      const shouldGoUp = upOdds >= config.MIN_CONFIDENCE;
      const shouldGoDown = downOdds >= config.MIN_CONFIDENCE;
      
      if (shouldGoUp || shouldGoDown) {
        const direction = shouldGoUp ? 'UP' : 'DOWN';
        const confidence = shouldGoUp ? upOdds : downOdds;
        
        console.log(`\n🚨 SNIPE OPPORTUNITY!`);
        console.log(`   ${market.eventTitle}`);
        console.log(`   Direction: ${direction} (${(confidence * 100).toFixed(0)}% confident)`);
        console.log(`   Time: ${secondsRemaining}s remaining`);
        
        const result = await executeSnipe(market, direction);
        tradeHistory.push({
          timestamp: new Date().toISOString(),
          ...result
        });
        
        if (result.success) {
          console.log(`✅ TRADE EXECUTED: ${direction} on ${market.eventTitle}`);
        }
      }
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  console.log('🚀 Polymarket Sniper Bot Starting...');
  console.log('═'.repeat(50));
  console.log(`💰 Bet amount: $${config.BET_AMOUNT_USD}`);
  console.log(`🎯 Min confidence: ${config.MIN_CONFIDENCE * 100}%`);
  console.log(`⏱️  Snipe window: ${config.SNIPE_SECONDS}s before close`);
  console.log('═'.repeat(50));
  
  // Validate private key
  if (!config.PRIVATE_KEY) {
    console.error('❌ PRIVATE_KEY not set in .env file');
    process.exit(1);
  }
  
  // Initialize client
  try {
    await initializeClient();
  } catch (error) {
    console.error('❌ Failed to initialize client:', error.message);
    console.error(error);
    process.exit(1);
  }
  
  console.log('\n🔄 Starting market monitor (every 10 seconds)...\n');
  
  // Initial scan
  await monitorMarkets();
  
  // Continuous monitoring
  setInterval(async () => {
    try {
      await monitorMarkets();
    } catch (error) {
      console.error('❌ Monitor error:', error.message);
    }
  }, 10000); // Every 10 seconds
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down...');
  console.log('\n📊 Trade History:');
  tradeHistory.forEach(t => {
    console.log(`   ${t.timestamp}: ${t.direction} ${t.market} - ${t.success ? '✅' : '❌'}`);
  });
  process.exit(0);
});

// Run
main().catch(console.error);
