#!/usr/bin/env node
/**
 * BTC 5-minute Market Observer
 * 
 * Collects data on market behavior without trading.
 * Goal: Find patterns like "at 3min mark, if odds > X%, does it resolve that way?"
 */

require('dotenv').config();

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('./config');

// Data storage
const DATA_FILE = path.join(__dirname, '..', 'data', 'observations.json');
const SUMMARY_FILE = path.join(__dirname, '..', 'data', 'analysis.md');

// Ensure data directory exists
const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Load existing data or start fresh
let observations = [];
if (fs.existsSync(DATA_FILE)) {
  try {
    observations = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.log(`📂 Loaded ${observations.length} existing observations`);
  } catch (e) {
    observations = [];
  }
}

// Current market tracking
let currentMarket = null;
let marketSnapshots = []; // Snapshots at different time points
let ws = null;

// Time checkpoints to record (seconds remaining)
const CHECKPOINTS = [300, 240, 180, 120, 60, 30, 15, 5];

/**
 * Save observations to file
 */
function saveData() {
  fs.writeFileSync(DATA_FILE, JSON.stringify(observations, null, 2));
}

/**
 * Fetch current BTC 5-min market
 */
async function fetchCurrentMarket() {
  try {
    const now = new Date();
    const minutes = now.getUTCMinutes();
    const roundedMinutes = Math.floor(minutes / 5) * 5;
    
    const currentStart = new Date(now);
    currentStart.setUTCMinutes(roundedMinutes, 0, 0);
    const currentEnd = new Date(currentStart.getTime() + 5 * 60 * 1000);
    const timestamp = Math.floor(currentEnd.getTime() / 1000);
    
    const slug = `btc-updown-5m-${timestamp}`;
    
    const response = await axios.get(`${config.GAMMA_HOST}/events`, {
      params: { slug }
    });
    
    const events = response.data;
    if (!events || events.length === 0) return null;
    
    const event = events[0];
    if (event.closed) return null;
    
    const market = event.markets?.[0];
    if (!market) return null;
    
    let outcomePrices = [0.5, 0.5];
    let tokens = [];
    
    try {
      outcomePrices = JSON.parse(market.outcomePrices || '["0.5", "0.5"]').map(p => parseFloat(p));
      tokens = JSON.parse(market.clobTokenIds || '[]');
    } catch (e) {}
    
    return {
      slug,
      eventId: event.id,
      conditionId: market.conditionId,
      title: event.title,
      endDate: event.endDate,
      startTime: currentStart.toISOString(),
      tokens,
      upOdds: outcomePrices[0],
      downOdds: outcomePrices[1]
    };
    
  } catch (error) {
    if (error.response?.status !== 404) {
      console.error('❌ Fetch error:', error.message);
    }
    return null;
  }
}

/**
 * Get seconds remaining until market closes
 */
function getSecondsRemaining(endDate) {
  const end = new Date(endDate);
  const now = new Date();
  return Math.max(0, Math.floor((end - now) / 1000));
}

/**
 * Record a snapshot at current time
 */
function recordSnapshot(upOdds, downOdds) {
  if (!currentMarket) return;
  
  const secsRemaining = getSecondsRemaining(currentMarket.endDate);
  const leader = upOdds > downOdds ? 'UP' : 'DOWN';
  const leaderOdds = Math.max(upOdds, downOdds);
  
  const snapshot = {
    timestamp: new Date().toISOString(),
    secsRemaining,
    upOdds: parseFloat(upOdds.toFixed(4)),
    downOdds: parseFloat(downOdds.toFixed(4)),
    leader,
    leaderOdds: parseFloat(leaderOdds.toFixed(4)),
    spread: parseFloat(Math.abs(upOdds - downOdds).toFixed(4))
  };
  
  marketSnapshots.push(snapshot);
  
  // Log significant checkpoints
  const checkpoint = CHECKPOINTS.find(c => Math.abs(secsRemaining - c) < 3);
  if (checkpoint) {
    console.log(`   📸 ${checkpoint}s: ${leader} ${(leaderOdds * 100).toFixed(1)}% (spread: ${(snapshot.spread * 100).toFixed(1)}%)`);
  }
}

/**
 * Finalize market observation and record outcome
 */
async function finalizeMarket() {
  if (!currentMarket || marketSnapshots.length === 0) return;
  
  console.log(`\n🏁 Market closed: ${currentMarket.slug}`);
  
  // Wait a bit for settlement
  await new Promise(r => setTimeout(r, 10000));
  
  // Try to fetch outcome
  let outcome = null;
  try {
    const response = await axios.get(`${config.GAMMA_HOST}/events`, {
      params: { slug: currentMarket.slug }
    });
    
    const event = response.data?.[0];
    const market = event?.markets?.[0];
    
    if (market) {
      // Check which outcome won based on final prices
      const finalPrices = JSON.parse(market.outcomePrices || '["0.5", "0.5"]').map(p => parseFloat(p));
      if (finalPrices[0] > 0.9) outcome = 'UP';
      else if (finalPrices[1] > 0.9) outcome = 'DOWN';
    }
  } catch (e) {
    console.log('   ⚠️ Could not fetch outcome');
  }
  
  // Build observation record
  const observation = {
    slug: currentMarket.slug,
    startTime: currentMarket.startTime,
    endTime: currentMarket.endDate,
    outcome,
    snapshots: marketSnapshots,
    // Key analysis points
    at3min: marketSnapshots.find(s => s.secsRemaining >= 175 && s.secsRemaining <= 185),
    at2min: marketSnapshots.find(s => s.secsRemaining >= 115 && s.secsRemaining <= 125),
    at1min: marketSnapshots.find(s => s.secsRemaining >= 55 && s.secsRemaining <= 65),
    at30s: marketSnapshots.find(s => s.secsRemaining >= 25 && s.secsRemaining <= 35),
    finalSnapshot: marketSnapshots[marketSnapshots.length - 1]
  };
  
  // Analyze prediction accuracy at each checkpoint
  if (outcome) {
    console.log(`   ✅ Outcome: ${outcome}`);
    
    const checkAnalysis = (label, snapshot) => {
      if (!snapshot) return;
      const predicted = snapshot.leader;
      const correct = predicted === outcome;
      console.log(`   ${label}: ${predicted} ${(snapshot.leaderOdds * 100).toFixed(0)}% → ${correct ? '✅' : '❌'}`);
    };
    
    checkAnalysis('3min', observation.at3min);
    checkAnalysis('2min', observation.at2min);
    checkAnalysis('1min', observation.at1min);
    checkAnalysis('30s', observation.at30s);
  }
  
  observations.push(observation);
  saveData();
  
  // Update analysis
  updateAnalysis();
  
  // Reset for next market
  currentMarket = null;
  marketSnapshots = [];
}

/**
 * Update analysis summary
 */
function updateAnalysis() {
  const completed = observations.filter(o => o.outcome);
  
  if (completed.length < 3) {
    console.log(`\n📊 Need more data (${completed.length} completed observations)`);
    return;
  }
  
  // Analyze prediction accuracy at each checkpoint
  const analyzeCheckpoint = (name, getter) => {
    const valid = completed.filter(o => getter(o) && o.outcome);
    if (valid.length === 0) return null;
    
    let correct = 0;
    let highConfCorrect = 0;
    let highConfTotal = 0;
    
    for (const obs of valid) {
      const snapshot = getter(obs);
      if (snapshot.leader === obs.outcome) correct++;
      
      // High confidence = > 60%
      if (snapshot.leaderOdds >= 0.60) {
        highConfTotal++;
        if (snapshot.leader === obs.outcome) highConfCorrect++;
      }
    }
    
    return {
      total: valid.length,
      correct,
      accuracy: (correct / valid.length * 100).toFixed(1),
      highConfTotal,
      highConfCorrect,
      highConfAccuracy: highConfTotal > 0 ? (highConfCorrect / highConfTotal * 100).toFixed(1) : 'N/A'
    };
  };
  
  const analysis = {
    totalObservations: observations.length,
    completedWithOutcome: completed.length,
    checkpoints: {
      '3min': analyzeCheckpoint('3min', o => o.at3min),
      '2min': analyzeCheckpoint('2min', o => o.at2min),
      '1min': analyzeCheckpoint('1min', o => o.at1min),
      '30s': analyzeCheckpoint('30s', o => o.at30s)
    }
  };
  
  // Write markdown summary
  let md = `# BTC 5-min Market Analysis\n\n`;
  md += `**Last updated:** ${new Date().toISOString()}\n`;
  md += `**Total observations:** ${analysis.totalObservations}\n`;
  md += `**Completed with outcome:** ${analysis.completedWithOutcome}\n\n`;
  
  md += `## Prediction Accuracy by Time\n\n`;
  md += `| Checkpoint | Sample | Accuracy | High Conf (≥60%) | HC Accuracy |\n`;
  md += `|------------|--------|----------|------------------|-------------|\n`;
  
  for (const [name, data] of Object.entries(analysis.checkpoints)) {
    if (data) {
      md += `| ${name} | ${data.total} | ${data.accuracy}% | ${data.highConfTotal} | ${data.highConfAccuracy}% |\n`;
    }
  }
  
  md += `\n## Key Findings\n\n`;
  
  // Find best checkpoint
  const checkpoints = Object.entries(analysis.checkpoints).filter(([_, d]) => d && d.total >= 3);
  if (checkpoints.length > 0) {
    const best = checkpoints.sort((a, b) => parseFloat(b[1].accuracy) - parseFloat(a[1].accuracy))[0];
    md += `- **Best checkpoint:** ${best[0]} with ${best[1].accuracy}% accuracy\n`;
    
    const bestHC = checkpoints
      .filter(([_, d]) => d.highConfTotal >= 2)
      .sort((a, b) => parseFloat(b[1].highConfAccuracy) - parseFloat(a[1].highConfAccuracy))[0];
    
    if (bestHC) {
      md += `- **Best high-confidence checkpoint:** ${bestHC[0]} with ${bestHC[1].highConfAccuracy}% accuracy (n=${bestHC[1].highConfTotal})\n`;
    }
  }
  
  md += `\n## Raw Data\n\n`;
  md += `See \`observations.json\` for full data.\n`;
  
  fs.writeFileSync(SUMMARY_FILE, md);
  console.log(`\n📊 Analysis updated: ${SUMMARY_FILE}`);
}

/**
 * Connect to WebSocket for price updates
 */
function connectWebSocket() {
  console.log('🔌 Connecting to WebSocket...');
  
  ws = new WebSocket(config.WSS_HOST);
  
  ws.on('open', () => {
    console.log('✅ WebSocket connected');
    subscribeToCurrentMarket();
  });
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      
      if (msg.event_type === 'price_change' || msg.type === 'price_change') {
        if (!currentMarket) return;
        
        const tokenId = msg.asset_id;
        const newPrice = parseFloat(msg.price);
        
        // Determine if this is UP or DOWN token
        const isUp = currentMarket.tokens[0] === tokenId;
        
        if (isUp) {
          currentMarket.upOdds = newPrice;
          currentMarket.downOdds = 1 - newPrice;
        } else if (currentMarket.tokens[1] === tokenId) {
          currentMarket.downOdds = newPrice;
          currentMarket.upOdds = 1 - newPrice;
        }
        
        recordSnapshot(currentMarket.upOdds, currentMarket.downOdds);
      }
    } catch (e) {}
  });
  
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error.message);
  });
  
  ws.on('close', () => {
    console.log('🔌 WebSocket closed, reconnecting in 3s...');
    setTimeout(connectWebSocket, 3000);
  });
}

/**
 * Subscribe to current market's tokens
 */
function subscribeToCurrentMarket() {
  if (!ws || ws.readyState !== WebSocket.OPEN || !currentMarket) return;
  
  const msg = {
    type: 'market',
    assets_ids: currentMarket.tokens
  };
  
  ws.send(JSON.stringify(msg));
  console.log(`📡 Subscribed to market tokens`);
}

/**
 * Main monitoring loop
 */
async function monitor() {
  // Check if current market ended
  if (currentMarket) {
    const secsRemaining = getSecondsRemaining(currentMarket.endDate);
    
    if (secsRemaining <= 0) {
      await finalizeMarket();
    }
  }
  
  // Find new market if needed
  if (!currentMarket) {
    const market = await fetchCurrentMarket();
    
    if (market) {
      const secsRemaining = getSecondsRemaining(market.endDate);
      
      // Only track if we have at least 30 seconds
      if (secsRemaining > 30) {
        currentMarket = market;
        marketSnapshots = [];
        
        console.log(`\n🆕 New market: ${market.slug}`);
        console.log(`   ⏱️  ${secsRemaining}s remaining`);
        console.log(`   📈 UP: ${(market.upOdds * 100).toFixed(1)}% | DOWN: ${(market.downOdds * 100).toFixed(1)}%`);
        
        // Initial snapshot
        recordSnapshot(market.upOdds, market.downOdds);
        
        // Subscribe via WebSocket
        subscribeToCurrentMarket();
      }
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  console.log('👀 BTC 5-min Market Observer Starting...');
  console.log('═'.repeat(50));
  console.log('📊 Mode: OBSERVATION ONLY (no trading)');
  console.log('🎯 Goal: Find patterns in odds vs outcomes');
  console.log(`📂 Data: ${DATA_FILE}`);
  console.log('═'.repeat(50));
  
  // Connect WebSocket
  connectWebSocket();
  
  // Initial scan
  await monitor();
  
  // Monitor every 2 seconds
  setInterval(monitor, 2000);
  
  // Also poll market data every 10 seconds (backup)
  setInterval(async () => {
    if (currentMarket) {
      const fresh = await fetchCurrentMarket();
      if (fresh) {
        currentMarket.upOdds = fresh.upOdds;
        currentMarket.downOdds = fresh.downOdds;
        recordSnapshot(fresh.upOdds, fresh.downOdds);
      }
    }
  }, 10000);
  
  console.log('\n👀 Observing... (Ctrl+C to stop and see analysis)\n');
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down observer...');
  
  if (ws) ws.close();
  saveData();
  updateAnalysis();
  
  console.log(`\n📊 Final Stats:`);
  console.log(`   Total observations: ${observations.length}`);
  console.log(`   With outcomes: ${observations.filter(o => o.outcome).length}`);
  console.log(`\n📂 Data saved to: ${DATA_FILE}`);
  console.log(`📄 Analysis: ${SUMMARY_FILE}`);
  
  process.exit(0);
});

main().catch(console.error);
