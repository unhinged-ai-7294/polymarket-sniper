#!/usr/bin/env node
/**
 * BTC 5-min Market Observer v2
 * Uses CLOB midpoint API for accurate real-time prices
 * Captures data every 5 seconds throughout the market cycle
 */

const axios = require('axios');
const fs = require('fs');

const GAMMA_HOST = 'https://gamma-api.polymarket.com';
const CLOB_HOST = 'https://clob.polymarket.com';
const OUTPUT_DIR = './data';

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function getLocalTime() {
  return new Date().toLocaleString('en-MY', { 
    timeZone: 'Asia/Kuala_Lumpur',
    hour12: false 
  });
}

function getMarketSlug() {
  const now = new Date();
  const minutes = now.getUTCMinutes();
  const roundedMinutes = Math.floor(minutes / 5) * 5;
  const currentStart = new Date(now);
  currentStart.setUTCMinutes(roundedMinutes, 0, 0);
  const currentEnd = new Date(currentStart.getTime() + 5 * 60 * 1000);
  return {
    slug: `btc-updown-5m-${Math.floor(currentEnd.getTime() / 1000)}`,
    endTime: currentEnd,
    startTime: currentStart
  };
}

async function getMarketData() {
  const { slug, endTime, startTime } = getMarketSlug();
  const now = new Date();
  const secsRemaining = Math.max(0, Math.floor((endTime - now) / 1000));
  const secsElapsed = Math.floor((now - startTime) / 1000);
  
  try {
    // Get market info from Gamma API
    const res = await axios.get(`${GAMMA_HOST}/events`, { params: { slug } });
    const event = res.data?.[0];
    if (!event) return null;
    
    const market = event.markets?.[0];
    if (!market) return null;
    
    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    const upToken = tokenIds[0];
    const downToken = tokenIds[1];
    
    // Get CLOB midpoints (the TRUE displayed price)
    const [upMid, downMid] = await Promise.all([
      axios.get(`${CLOB_HOST}/midpoint`, { params: { token_id: upToken } }),
      axios.get(`${CLOB_HOST}/midpoint`, { params: { token_id: downToken } })
    ]);
    
    // Get order books for spread info
    const upBook = await axios.get(`${CLOB_HOST}/book?token_id=${upToken}`);
    const upBids = upBook.data.bids || [];
    const upAsks = upBook.data.asks || [];
    const upBestBid = upBids.length > 0 ? upBids[upBids.length - 1] : null;
    const upBestAsk = upAsks.length > 0 ? upAsks[upAsks.length - 1] : null;
    
    const spread = upBestBid && upBestAsk 
      ? parseFloat(upBestAsk.price) - parseFloat(upBestBid.price) 
      : null;
    
    return {
      timestamp: now.toISOString(),
      localTime: getLocalTime(),
      slug,
      title: event.title,
      secsRemaining,
      secsElapsed,
      upMid: parseFloat(upMid.data.mid),
      downMid: parseFloat(downMid.data.mid),
      upPct: parseFloat(upMid.data.mid) * 100,
      downPct: parseFloat(downMid.data.mid) * 100,
      lastTradePrice: parseFloat(upBook.data.last_trade_price),
      spread,
      bestBid: upBestBid ? parseFloat(upBestBid.price) : null,
      bestAsk: upBestAsk ? parseFloat(upBestAsk.price) : null
    };
  } catch (e) {
    return null;
  }
}

async function observeMarketCycle() {
  const captures = [];
  let currentSlug = null;
  let cycleCount = 0;
  
  console.log('='.repeat(70));
  console.log('BTC 5-min Market Observer v2 (CLOB Midpoint)');
  console.log('Started:', getLocalTime());
  console.log('='.repeat(70));
  console.log('');
  
  const poll = async () => {
    const data = await getMarketData();
    if (!data) {
      console.log(`[${getLocalTime()}] No market data`);
      return;
    }
    
    // New market cycle?
    if (currentSlug !== data.slug) {
      if (currentSlug !== null && captures.length > 0) {
        // Save previous cycle data
        const filename = `${OUTPUT_DIR}/cycle-${currentSlug}.json`;
        fs.writeFileSync(filename, JSON.stringify(captures, null, 2));
        console.log(`\n>>> Saved ${captures.length} captures to ${filename}\n`);
        cycleCount++;
        
        // Print summary
        console.log('--- Cycle Summary ---');
        console.log(`First: UP ${captures[0].upPct.toFixed(1)}%`);
        console.log(`Last:  UP ${captures[captures.length - 1].upPct.toFixed(1)}%`);
        console.log(`Change: ${(captures[captures.length - 1].upPct - captures[0].upPct).toFixed(1)}%`);
        console.log('');
      }
      
      // New cycle
      currentSlug = data.slug;
      captures.length = 0;
      console.log(`\n>>> NEW MARKET: ${data.title}`);
      console.log('TIME     | UP%    | DOWN%  | SPREAD | SECS LEFT');
      console.log('-'.repeat(55));
    }
    
    captures.push(data);
    
    // Log
    const spreadStr = data.spread !== null ? data.spread.toFixed(2) : 'N/A';
    console.log(
      `${data.localTime.split(', ')[1]} | ` +
      `${data.upPct.toFixed(1).padStart(5)}% | ` +
      `${data.downPct.toFixed(1).padStart(5)}% | ` +
      `${spreadStr.padStart(5)} | ` +
      `${data.secsRemaining.toString().padStart(3)}s`
    );
  };
  
  // Poll every 5 seconds
  await poll();
  setInterval(poll, 5000);
}

// Handle exit
process.on('SIGINT', () => {
  console.log('\n\nObserver stopped.');
  process.exit(0);
});

observeMarketCycle().catch(console.error);
