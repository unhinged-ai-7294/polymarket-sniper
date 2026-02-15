#!/usr/bin/env node
/**
 * Capture BTC 5-min market data - FIXED VERSION
 * Uses proper WebSocket parsing with best_bid/best_ask
 */

const axios = require('axios');
const WebSocket = require('ws');
const fs = require('fs');

const GAMMA_HOST = 'https://gamma-api.polymarket.com';
const CLOB_HOST = 'https://clob.polymarket.com';
const WSS_HOST = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const OUTPUT_FILE = './data/capture.json';

// Data storage
const captures = [];
let tokenMap = {};
let currentMarket = null;
let upTokenId = null;

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
      upTokenId = tokenIds[0];
    }
    
    const endDate = new Date(event.endDate);
    const secsRemaining = Math.max(0, Math.floor((endDate - new Date()) / 1000));
    
    // Get REAL price from CLOB midpoint
    let midpoint = 0.5;
    try {
      const midRes = await axios.get(`${CLOB_HOST}/midpoint`, { params: { token_id: tokenIds[0] } });
      midpoint = parseFloat(midRes.data.mid);
    } catch (e) {}
    
    return {
      slug,
      title: event.title,
      endDate: event.endDate,
      secsRemaining,
      midpoint,
      tokenIds
    };
  } catch (e) {
    return null;
  }
}

function saveData() {
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(captures, null, 2));
}

function getLocalTime() {
  return new Date().toLocaleTimeString('en-US', { 
    hour12: false, 
    timeZone: 'Asia/Kuala_Lumpur' 
  });
}

function recordCapture(source, upPct, downPct, extra = '') {
  const timestamp = new Date().toISOString();
  const localTime = getLocalTime();
  
  const entry = {
    timestamp,
    localTime,
    source,
    upPct: parseFloat(upPct.toFixed(1)),
    downPct: parseFloat(downPct.toFixed(1)),
    secsRemaining: currentMarket?.secsRemaining || 0
  };
  
  captures.push(entry);
  const extraStr = extra ? ` ${extra}` : '';
  console.log(`[${localTime}] ${source.padEnd(4)} | UP: ${upPct.toFixed(1).padStart(5)}% | DOWN: ${downPct.toFixed(1).padStart(5)}%${extraStr}`);
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
      let msg;
      
      // Handle array or object
      if (str.startsWith('[')) {
        msg = JSON.parse(str)[0];
      } else {
        msg = JSON.parse(str);
      }
      
      // DEBUG: Log raw message structure
      // console.log('RAW:', JSON.stringify(msg).substring(0, 200));
      
      // Handle price_changes (real-time updates)
      if (msg.price_changes && Array.isArray(msg.price_changes)) {
        for (const change of msg.price_changes) {
          if (change.asset_id === upTokenId && change.best_bid && change.best_ask) {
            const bestBid = parseFloat(change.best_bid);
            const bestAsk = parseFloat(change.best_ask);
            const spread = bestAsk - bestBid;
            
            let upPct;
            if (spread <= 0.10) {
              // Midpoint
              upPct = ((bestBid + bestAsk) / 2) * 100;
            } else {
              // Use trade price if spread too wide
              upPct = parseFloat(change.price) * 100;
            }
            
            recordCapture('WS', upPct, 100 - upPct, `(bid:${bestBid} ask:${bestAsk})`);
          }
        }
      }
      
      // Handle initial order book snapshot
      if (msg.bids && msg.asks && msg.asset_id === upTokenId) {
        const bids = msg.bids;
        const asks = msg.asks;
        if (bids.length > 0 && asks.length > 0) {
          // Best bid = highest (last in sorted array)
          // Best ask = lowest (last in sorted asks which are descending)
          const bestBid = parseFloat(bids[bids.length - 1].price);
          const bestAsk = parseFloat(asks[asks.length - 1].price);
          const upPct = ((bestBid + bestAsk) / 2) * 100;
          recordCapture('WS', upPct, 100 - upPct, `(initial book)`);
        }
      }
      
    } catch (e) {
      // Ignore parse errors
    }
  });
  
  ws.on('error', (e) => console.log('WS error:', e.message));
  ws.on('close', () => console.log('WS closed'));
  
  return ws;
}

async function main() {
  console.log('='.repeat(70));
  console.log('BTC 5-min Market Capture v2 (WebSocket + CLOB Midpoint)');
  console.log('Started:', new Date().toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' }));
  console.log('='.repeat(70));
  
  currentMarket = await fetchMarket();
  if (!currentMarket) {
    console.log('No market found');
    process.exit(1);
  }
  
  console.log(`\nMarket: ${currentMarket.title}`);
  console.log(`Ends: ${currentMarket.endDate}`);
  console.log(`Time remaining: ${currentMarket.secsRemaining}s`);
  console.log('\nCapturing data...\n');
  
  // Initial CLOB midpoint capture
  const upPct = currentMarket.midpoint * 100;
  recordCapture('CLOB', upPct, 100 - upPct, '(initial)');
  
  // Connect WebSocket
  const ws = connectWebSocket(currentMarket.tokenIds);
  
  // Poll CLOB midpoint every 5 seconds as backup
  const pollInterval = setInterval(async () => {
    currentMarket = await fetchMarket();
    if (currentMarket) {
      const upPct = currentMarket.midpoint * 100;
      recordCapture('CLOB', upPct, 100 - upPct);
      
      // Check if market closed
      if (currentMarket.secsRemaining <= 0) {
        console.log('\n' + '='.repeat(70));
        console.log('MARKET CLOSED');
        console.log('='.repeat(70));
        console.log(`\nTotal captures: ${captures.length}`);
        saveData();
        console.log(`Data saved to: ${OUTPUT_FILE}`);
        
        clearInterval(pollInterval);
        ws.close();
        process.exit(0);
      }
    }
  }, 5000);
  
  // Timeout after 10 minutes
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
