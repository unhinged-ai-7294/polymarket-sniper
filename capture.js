#!/usr/bin/env node
/**
 * Capture BTC 5-min market data until close
 * Output: timestamp, UP%, DOWN%
 */

const axios = require('axios');
const WebSocket = require('ws');
const fs = require('fs');

const GAMMA_HOST = 'https://gamma-api.polymarket.com';
const WSS_HOST = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const OUTPUT_FILE = './data/capture.json';

// Data storage
const captures = [];
let tokenMap = {};
let currentMarket = null;

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

async function fetchMarket() {
  const slug = getCurrentSlug();
  try {
    const res = await axios.get(`${GAMMA_HOST}/events`, { params: { slug } });
    const event = res.data?.[0];
    if (!event) return null;
    
    const market = event.markets?.[0];
    if (!market) return null;
    
    let tokenIds = [];
    try { tokenIds = JSON.parse(market.clobTokenIds || '[]'); } catch (e) {}
    
    if (tokenIds.length >= 2) {
      tokenMap[tokenIds[0]] = 'UP';
      tokenMap[tokenIds[1]] = 'DOWN';
    }
    
    const endDate = new Date(event.endDate);
    const secsRemaining = Math.max(0, Math.floor((endDate - new Date()) / 1000));
    
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

function saveData() {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(captures, null, 2));
}

function recordCapture(source, upPct, downPct) {
  const timestamp = new Date().toISOString();
  const localTime = new Date().toLocaleTimeString('en-US', { 
    hour12: false, 
    timeZone: 'Asia/Kuala_Lumpur' 
  });
  
  const entry = {
    timestamp,
    localTime,
    source,
    upPct: parseFloat(upPct.toFixed(1)),
    downPct: parseFloat(downPct.toFixed(1)),
    secsRemaining: currentMarket?.secsRemaining || 0
  };
  
  captures.push(entry);
  console.log(`[${localTime}] ${source.padEnd(4)} | UP: ${upPct.toFixed(1)}% | DOWN: ${downPct.toFixed(1)}%`);
}

function connectWebSocket(tokenIds) {
  const ws = new WebSocket(WSS_HOST);
  
  ws.on('open', () => {
    console.log('WebSocket connected');
    ws.send(JSON.stringify({ type: 'market', assets_ids: tokenIds }));
  });
  
  ws.on('message', (data) => {
    try {
      const str = data.toString();
      const msgs = str.startsWith('[') ? JSON.parse(str) : [JSON.parse(str)];
      
      for (const msg of msgs) {
        if (msg.price && msg.asset_id) {
          const price = parseFloat(msg.price);
          const side = tokenMap[msg.asset_id];
          
          if (!isNaN(price) && side) {
            if (side === 'UP') {
              recordCapture('WS', price * 100, (1 - price) * 100);
            } else {
              recordCapture('WS', (1 - price) * 100, price * 100);
            }
          }
        }
      }
    } catch (e) {}
  });
  
  ws.on('error', (e) => console.log('WS error:', e.message));
  ws.on('close', () => console.log('WS closed'));
  
  return ws;
}

async function main() {
  console.log('='.repeat(60));
  console.log('BTC 5-min Market Capture');
  console.log('Started:', new Date().toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' }));
  console.log('='.repeat(60));
  
  currentMarket = await fetchMarket();
  if (!currentMarket) {
    console.log('No market found');
    process.exit(1);
  }
  
  console.log(`\nMarket: ${currentMarket.title}`);
  console.log(`Ends: ${currentMarket.endDate}`);
  console.log(`Time remaining: ${currentMarket.secsRemaining}s`);
  console.log('\nCapturing data...\n');
  
  // Initial API capture
  const upPct = (currentMarket.lastTradePrice || 0.5) * 100;
  recordCapture('API', upPct, 100 - upPct);
  
  // Connect WebSocket
  const ws = connectWebSocket(currentMarket.tokenIds);
  
  // Poll API every 5 seconds
  const pollInterval = setInterval(async () => {
    currentMarket = await fetchMarket();
    if (currentMarket) {
      const upPct = (currentMarket.lastTradePrice || 0.5) * 100;
      recordCapture('API', upPct, 100 - upPct);
      
      // Check if market closed
      if (currentMarket.secsRemaining <= 0) {
        console.log('\n='.repeat(60));
        console.log('MARKET CLOSED');
        console.log('='.repeat(60));
        console.log(`\nTotal captures: ${captures.length}`);
        saveData();
        console.log(`Data saved to: ${OUTPUT_FILE}`);
        
        // Print summary
        console.log('\n--- SUMMARY ---');
        console.log('Timestamp | Source | UP% | DOWN%');
        for (const c of captures) {
          console.log(`${c.localTime} | ${c.source} | ${c.upPct}% | ${c.downPct}%`);
        }
        
        clearInterval(pollInterval);
        ws.close();
        process.exit(0);
      }
    }
  }, 5000);
  
  // Timeout after 10 minutes (in case something goes wrong)
  setTimeout(() => {
    console.log('\nTimeout reached');
    saveData();
    process.exit(0);
  }, 600000);
}

process.on('SIGINT', () => {
  console.log('\nInterrupted');
  saveData();
  process.exit(0);
});

main().catch(console.error);
