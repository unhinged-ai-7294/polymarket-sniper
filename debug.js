#!/usr/bin/env node
/**
 * Debug Script - BTC 5-min Market
 * Goal: Figure out why we're getting 50/50 when UI shows different odds
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
 * Try different API endpoints to find the market
 */
async function debugMarketFetch() {
  console.log('='.repeat(60));
  console.log('DEBUG: Finding BTC 5-min market');
  console.log('='.repeat(60));
  console.log('Current time:', new Date().toISOString());
  
  const slug = getCurrentSlug();
  console.log('\n1. Expected slug:', slug);
  
  // Try Gamma API with slug
  console.log('\n--- Gamma API (by slug) ---');
  try {
    const res = await axios.get(`${GAMMA_HOST}/events`, { params: { slug } });
    console.log('Response:', JSON.stringify(res.data, null, 2));
  } catch (e) {
    console.log('Error:', e.response?.status, e.message);
  }
  
  // Try searching for "bitcoin up or down 5"
  console.log('\n--- Gamma API (search "bitcoin 5 min") ---');
  try {
    const res = await axios.get(`${GAMMA_HOST}/events`, { 
      params: { 
        tag: 'bitcoin',
        limit: 10
      } 
    });
    
    // Filter for 5-min markets
    const fiveMin = res.data?.filter(e => 
      e.title?.toLowerCase().includes('5 min') || 
      e.slug?.includes('5m')
    );
    
    console.log('Found', fiveMin?.length || 0, '5-min markets');
    if (fiveMin?.length > 0) {
      for (const event of fiveMin.slice(0, 3)) {
        console.log('\nEvent:', event.slug);
        console.log('  Title:', event.title);
        console.log('  End:', event.endDate);
        console.log('  Closed:', event.closed);
        
        const market = event.markets?.[0];
        if (market) {
          console.log('  Market ID:', market.id);
          console.log('  Condition ID:', market.conditionId);
          console.log('  outcomePrices (raw):', market.outcomePrices);
          console.log('  clobTokenIds (raw):', market.clobTokenIds);
        }
      }
    }
  } catch (e) {
    console.log('Error:', e.response?.status, e.message);
  }
  
  // Try CLOB API markets endpoint
  console.log('\n--- CLOB API (markets) ---');
  try {
    const res = await axios.get(`${CLOB_HOST}/markets`);
    
    // Find BTC 5-min markets
    const btcMarkets = res.data?.filter(m => 
      m.question?.toLowerCase().includes('bitcoin') && 
      (m.question?.toLowerCase().includes('5 min') || m.question?.toLowerCase().includes('5-min'))
    );
    
    console.log('Found', btcMarkets?.length || 0, 'BTC 5-min markets in CLOB');
    if (btcMarkets?.length > 0) {
      for (const m of btcMarkets.slice(0, 3)) {
        console.log('\nQuestion:', m.question);
        console.log('  Condition ID:', m.condition_id);
        console.log('  Token IDs:', m.tokens?.map(t => t.token_id?.slice(0,20)));
        console.log('  Token Prices:', m.tokens?.map(t => `${t.outcome}: ${t.price}`));
      }
    }
  } catch (e) {
    console.log('Error:', e.response?.status, e.message);
  }
  
  // Try the recurring series endpoint
  console.log('\n--- Gamma API (series: btc-up-or-down-5m) ---');
  try {
    const res = await axios.get(`${GAMMA_HOST}/series/btc-up-or-down-5m`);
    console.log('Series response:', JSON.stringify(res.data, null, 2).slice(0, 1000));
  } catch (e) {
    console.log('Error:', e.response?.status, e.message);
  }
  
  // Try fetching active events by tag
  console.log('\n--- Gamma API (active=true, crypto) ---');
  try {
    const res = await axios.get(`${GAMMA_HOST}/events`, {
      params: {
        active: true,
        tag: 'crypto',
        limit: 20
      }
    });
    
    const btcUpDown = res.data?.filter(e => 
      e.title?.toLowerCase().includes('up or down') &&
      e.title?.toLowerCase().includes('bitcoin')
    );
    
    console.log('Found', btcUpDown?.length || 0, 'active BTC up/down events');
    for (const event of (btcUpDown || []).slice(0, 5)) {
      console.log('\n  Slug:', event.slug);
      console.log('  Title:', event.title);
      console.log('  End:', event.endDate);
      
      const market = event.markets?.[0];
      if (market) {
        console.log('  outcomePrices:', market.outcomePrices);
      }
    }
  } catch (e) {
    console.log('Error:', e.response?.status, e.message);
  }
}

/**
 * Debug WebSocket subscription
 */
async function debugWebSocket(tokenIds) {
  if (!tokenIds || tokenIds.length === 0) {
    console.log('\nNo token IDs to subscribe to');
    return;
  }
  
  console.log('\n='.repeat(60));
  console.log('DEBUG: WebSocket subscription');
  console.log('='.repeat(60));
  console.log('Token IDs:', tokenIds);
  
  const ws = new WebSocket(WSS_HOST);
  
  ws.on('open', () => {
    console.log('WebSocket connected');
    
    // Try different subscription formats
    const msg = {
      type: 'market',
      assets_ids: tokenIds
    };
    
    console.log('Sending:', JSON.stringify(msg));
    ws.send(JSON.stringify(msg));
  });
  
  ws.on('message', (data) => {
    const str = data.toString();
    console.log('WS message:', str.slice(0, 500));
  });
  
  ws.on('error', (e) => console.log('WS error:', e.message));
  ws.on('close', () => console.log('WS closed'));
  
  // Run for 30 seconds
  setTimeout(() => {
    console.log('\nClosing WebSocket after 30s');
    ws.close();
    process.exit(0);
  }, 30000);
}

/**
 * Check what Polymarket UI uses
 */
async function checkUIEndpoint() {
  console.log('\n='.repeat(60));
  console.log('DEBUG: Check what UI might use');
  console.log('='.repeat(60));
  
  // The UI might use a different endpoint - let's try the book endpoint
  console.log('\n--- CLOB book endpoint ---');
  try {
    // First get a valid token ID
    const marketsRes = await axios.get(`${CLOB_HOST}/markets`);
    const btcMarket = marketsRes.data?.find(m => 
      m.question?.toLowerCase().includes('bitcoin') &&
      m.question?.toLowerCase().includes('up or down')
    );
    
    if (btcMarket && btcMarket.tokens?.[0]) {
      const tokenId = btcMarket.tokens[0].token_id;
      console.log('Checking book for token:', tokenId.slice(0, 30) + '...');
      
      const bookRes = await axios.get(`${CLOB_HOST}/book`, {
        params: { token_id: tokenId }
      });
      
      console.log('Book response:', JSON.stringify(bookRes.data, null, 2).slice(0, 1000));
    }
  } catch (e) {
    console.log('Error:', e.response?.status, e.message);
  }
  
  // Also try the price endpoint
  console.log('\n--- CLOB price endpoint ---');
  try {
    const marketsRes = await axios.get(`${CLOB_HOST}/markets`);
    const btcMarket = marketsRes.data?.find(m => 
      m.question?.toLowerCase().includes('bitcoin') &&
      m.question?.toLowerCase().includes('up or down') &&
      !m.closed
    );
    
    if (btcMarket) {
      console.log('Market:', btcMarket.question);
      console.log('Condition ID:', btcMarket.condition_id);
      
      const priceRes = await axios.get(`${CLOB_HOST}/price`, {
        params: { 
          token_id: btcMarket.tokens?.[0]?.token_id,
          side: 'buy'
        }
      });
      
      console.log('Price response:', JSON.stringify(priceRes.data, null, 2));
    }
  } catch (e) {
    console.log('Error:', e.response?.status, e.message);
  }
}

// Run debug
async function main() {
  console.log('Starting debug at', new Date().toISOString());
  console.log('Local time:', new Date().toLocaleString('en-MY', { timeZone: 'Asia/Kuala_Lumpur' }));
  
  await debugMarketFetch();
  await checkUIEndpoint();
  
  console.log('\n\nDebug complete. Check output above for clues.');
}

main().catch(console.error);
