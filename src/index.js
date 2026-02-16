#!/usr/bin/env node
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const http = require('http');
const WebSocket = require('ws');
const express = require('express');
const axios = require('axios');
const config = require('./config');
const { initializeClient, getClient } = require('./client');
const { executeSnipe, executeStopLoss } = require('./sniper');
const { fetchCurrentMarket, fetchPriceToBeat, getSecondsRemaining } = require('./markets');

// ─── State ───────────────────────────────────────────────────────────
let currentMarket = null;
let btcOpenPrice = null;
let btcCurrentPrice = null;
let upOdds = null;
let downOdds = null;
let hasBet = false;
let lastBetResult = null;
let isExecutingTrade = false;
let isExecutingStopLoss = false;
let stopLossFired = false;

// Position tracking for stop loss
let position = null; // { direction, entryPrice, tokenAmount, tokenId }

let wsRtds = null;
let wsMarket = null;
let dashboardInterval = null;
let snipeCheckInterval = null;
let stopLossInterval = null;
let cycleTimeout = null;

const tradeHistory = [];
const tradeLogs = [];  // Buffer of recent trade log lines shown in dashboard

// ─── Cycle data recording ────────────────────────────────────────────
let cycleData = null;
let lastSnapshotTime = 0;

const LOG_FILE = path.join(__dirname, '..', 'trades.log');
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'market_history.json');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  tradeLogs.push(line);
  // Keep last 50 lines for web dashboard
  if (tradeLogs.length > 50) tradeLogs.shift();
  // Also write to file
  fs.appendFileSync(LOG_FILE, line + '\n');
  // Broadcast to web dashboard
  broadcastEvent({ type: 'log', line });
}

// ─── Cycle data recording ─────────────────────────────────────────────
function initCycleData(market) {
  cycleData = {
    slug: market.slug,
    title: market.title,
    startTime: market.startTime || null,
    endTime: market.endDate,
    priceToBeat: btcOpenPrice,
    snapshots: [],
    betPlaced: null
  };
  lastSnapshotTime = 0;
}

function recordSnapshot() {
  if (!cycleData || !currentMarket) return;
  const now = Date.now();
  if (now - lastSnapshotTime < 5000) return; // Only every 5s
  lastSnapshotTime = now;

  const secsLeft = getSecondsRemaining(currentMarket.endDate);
  const momentum = (btcOpenPrice && btcCurrentPrice)
    ? ((btcCurrentPrice - btcOpenPrice) / btcOpenPrice * 100)
    : null;

  cycleData.snapshots.push({
    ts: new Date().toISOString(),
    secsLeft,
    priceToBeat: btcOpenPrice,
    btcPrice: btcCurrentPrice,
    momentum: momentum !== null ? parseFloat(momentum.toFixed(4)) : null,
    upOdds: upOdds !== null ? parseFloat(upOdds.toFixed(4)) : null,
    downOdds: downOdds !== null ? parseFloat(downOdds.toFixed(4)) : null
  });
}

function finalizeCycleData() {
  if (!cycleData || cycleData.snapshots.length === 0) {
    cycleData = null;
    return;
  }

  const finalSnap = cycleData.snapshots[cycleData.snapshots.length - 1];
  cycleData.finalBtcPrice = finalSnap.btcPrice;
  cycleData.finalMomentum = finalSnap.momentum;
  cycleData.finalOdds = { up: finalSnap.upOdds, down: finalSnap.downOdds };

  // Determine actual outcome
  if (cycleData.priceToBeat != null && cycleData.finalBtcPrice != null) {
    cycleData.actualOutcome = cycleData.finalBtcPrice >= cycleData.priceToBeat ? 'UP' : 'DOWN';
  } else {
    cycleData.actualOutcome = null;
  }

  // Extract milestone odds (T-60, T-30, T-10)
  cycleData.oddsAtT60 = findOddsAtSecsLeft(cycleData.snapshots, 60);
  cycleData.oddsAtT30 = findOddsAtSecsLeft(cycleData.snapshots, 30);
  cycleData.oddsAtT10 = findOddsAtSecsLeft(cycleData.snapshots, 10);

  // Determine if odds correctly predicted the outcome
  if (cycleData.actualOutcome && cycleData.finalOdds.up != null) {
    const oddsFavored = cycleData.finalOdds.up > 0.5 ? 'UP' : 'DOWN';
    cycleData.oddsCorrect = oddsFavored === cycleData.actualOutcome;
  } else {
    cycleData.oddsCorrect = null;
  }

  saveCycleData(cycleData);
  log(`Cycle recorded: ${cycleData.slug} → ${cycleData.actualOutcome} (${cycleData.snapshots.length} snapshots)`);
  cycleData = null;
}

function findOddsAtSecsLeft(snapshots, targetSecs) {
  let closest = null;
  let closestDiff = Infinity;
  for (const s of snapshots) {
    const diff = Math.abs(s.secsLeft - targetSecs);
    if (diff < closestDiff) {
      closestDiff = diff;
      closest = s;
    }
  }
  if (!closest || closestDiff > 10) return null; // No snapshot within 10s of target
  return { up: closest.upOdds, down: closest.downOdds };
}

function saveCycleData(record) {
  try {
    let history = [];
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
      if (raw.trim()) history = JSON.parse(raw);
    }
    history.push(record);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2) + '\n');
  } catch (err) {
    log('ERROR saving cycle data: ' + err.message);
  }
}

// ─── Chainlink BTC price via Polymarket RTDS ─────────────────────────
function connectChainlinkWs() {
  if (wsRtds) {
    wsRtds.removeAllListeners();
    wsRtds.close();
  }

  wsRtds = new WebSocket(config.WSS_RTDS);

  wsRtds.on('open', () => {
    log('Chainlink RTDS connected');
    wsRtds.send(JSON.stringify({
      action: 'subscribe',
      subscriptions: [{
        topic: 'crypto_prices_chainlink',
        type: '*',
        filters: JSON.stringify({ symbol: 'btc/usd' })
      }]
    }));
  });

  wsRtds.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.topic === 'crypto_prices_chainlink' && msg.payload) {
        const price = parseFloat(msg.payload.value);
        if (!isNaN(price) && price > 0) {
          btcCurrentPrice = price;
        }
      }
    } catch (e) {}
  });

  wsRtds.on('error', (err) => log('RTDS error: ' + err.message));
  wsRtds.on('close', () => setTimeout(connectChainlinkWs, 3000));
}

// ─── Polymarket odds via CLOB websocket ──────────────────────────────
function connectMarketWs(tokens) {
  if (wsMarket) {
    wsMarket.removeAllListeners();
    wsMarket.close();
  }

  if (!tokens || tokens.length < 2) return;

  wsMarket = new WebSocket(config.WSS_MARKET);

  wsMarket.on('open', () => {
    log('Polymarket odds WS connected');
    wsMarket.send(JSON.stringify({ type: 'market', assets_ids: tokens }));
  });

  wsMarket.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);

      if (msg.event_type === 'price_change' && msg.price_changes) {
        for (const pc of msg.price_changes) {
          const bid = parseFloat(pc.best_bid);
          const ask = parseFloat(pc.best_ask);
          if (isNaN(bid) || isNaN(ask)) continue;
          const mid = (bid + ask) / 2;

          if (pc.asset_id === currentMarket.tokens[0]) {
            upOdds = mid;
            downOdds = 1 - mid;
          } else if (pc.asset_id === currentMarket.tokens[1]) {
            downOdds = mid;
            upOdds = 1 - mid;
          }
        }
      }

      if (msg.event_type === 'last_trade_price') {
        const price = parseFloat(msg.price);
        if (!isNaN(price) && msg.asset_id) {
          if (msg.asset_id === currentMarket.tokens[0]) {
            upOdds = price;
            downOdds = 1 - price;
          } else if (msg.asset_id === currentMarket.tokens[1]) {
            downOdds = price;
            upOdds = 1 - price;
          }
        }
      }
    } catch (e) {}
  });

  wsMarket.on('error', (err) => log('Market WS error: ' + err.message));
  wsMarket.on('close', () => {
    log('Market WS disconnected, reconnecting in 1s...');
    setTimeout(() => {
      if (currentMarket && getSecondsRemaining(currentMarket.endDate) > 5) {
        connectMarketWs(currentMarket.tokens);
      }
    }, 1000);
  });
  wsMarket.on('ping', () => wsMarket.pong());
}

// ─── Snipe check (tiered checkpoints) ─────────────────────────────────
// T-60 → 90%+, T-50 → 80%+, T-40 → 75%+, T-20 → 85%+
const CHECKPOINTS = [
  // { at: 50, minOdds: 0.9 },
  { at: 30, minOdds: 0.85 },
  { at: 20, minOdds: 0.87 },
  { at: 10, minOdds: 0.85 },
];
let nextCheckpointIdx = 0;

async function checkSnipe() {
  if (!currentMarket || hasBet || isExecutingTrade) return;
  if (upOdds === null || downOdds === null) return;
  if (nextCheckpointIdx >= CHECKPOINTS.length) return;

  const secsLeft = getSecondsRemaining(currentMarket.endDate);
  const cp = CHECKPOINTS[nextCheckpointIdx];

  // Wait until we reach the current checkpoint
  if (secsLeft > cp.at || secsLeft < 3) return;

  // Consume this checkpoint
  nextCheckpointIdx++;

  // Determine leader
  const leader = upOdds >= downOdds ? 'UP' : 'DOWN';
  const leaderOdds = Math.max(upOdds, downOdds);

  if (leaderOdds < cp.minOdds) {
    const next = nextCheckpointIdx < CHECKPOINTS.length
      ? `next T-${CHECKPOINTS[nextCheckpointIdx].at} (${(CHECKPOINTS[nextCheckpointIdx].minOdds*100)}%+)`
      : 'no more checkpoints';
    log(`T-${cp.at}: SKIP — ${leader} at ${(leaderOdds*100).toFixed(1)}% (need ${(cp.minOdds*100)}%+) → ${next}`);
    return;
  }

  // We have an edge — buy the leader
  isExecutingTrade = true;
  hasBet = true;

  log(`>>> BUY ${leader} — ${(leaderOdds*100).toFixed(1)}% odds (T-${cp.at}, threshold ${(cp.minOdds*100)}%+)`);
  log(`    Amount: $${config.BET_AMOUNT_USD}`);

  // Retry loop with escalating slippage
  const SLIPPAGE_STEPS = [0.03, 0.06, 0.10, 0.14, 0.14];
  const RETRY_DELAY = 1500;
  const retryCutoff = Math.max(cp.at - 17, 3); // stop retrying ~17s after checkpoint, but never below 3s

  let filled = false;
  for (let attempt = 0; attempt < SLIPPAGE_STEPS.length; attempt++) {
    const timeLeft = getSecondsRemaining(currentMarket.endDate);
    if (timeLeft < retryCutoff) {
      log(`    Past cutoff (${timeLeft}s left, cutoff ${retryCutoff}s), stopping retries`);
      break;
    }

    const liveOdds = leader === 'UP' ? upOdds : downOdds;
    const buyPrice = Math.min(liveOdds + SLIPPAGE_STEPS[attempt], 0.99);

    log(`    Attempt ${attempt + 1}/${SLIPPAGE_STEPS.length}: ${leader} @ ${(buyPrice*100).toFixed(1)}% (${(liveOdds*100).toFixed(1)}% + ${(SLIPPAGE_STEPS[attempt]*100).toFixed(0)}% slip) | ${timeLeft}s left`);

    try {
      const result = await executeSnipe(currentMarket, leader, buyPrice);

      if (result.logs) {
        for (const line of result.logs) {
          log(`    [sniper] ${line}`);
        }
      }

      if (result.success) {
        filled = true;
        lastBetResult = { direction: leader, odds: liveOdds, ...result };

        // Track position for stop loss
        const tokensReceived = config.BET_AMOUNT_USD / buyPrice;
        position = {
          direction: leader,
          entryPrice: buyPrice,
          tokenAmount: tokensReceived,
          tokenId: leader === 'UP' ? currentMarket.tokens[0] : currentMarket.tokens[1]
        };
        stopLossFired = false;
        log(`    Position: ${tokensReceived.toFixed(4)} tokens @ ${buyPrice} (stop loss at ${(buyPrice - config.STOP_LOSS_CENTS).toFixed(2)})`);

        tradeHistory.push({
          timestamp: new Date().toISOString(),
          market: currentMarket.slug,
          direction: leader,
          odds: liveOdds,
          buyPrice,
          btcOpen: btcOpenPrice,
          btcAtBet: btcCurrentPrice,
          success: true,
          error: null
        });
        log(`>>> TRADE SUCCESS: ${leader} on ${currentMarket.slug} (attempt ${attempt + 1})`);
        broadcastEvent({ type: 'trade', trade: tradeHistory[tradeHistory.length - 1] });
        if (cycleData) {
          cycleData.betPlaced = {
            direction: leader,
            oddsAtBet: liveOdds,
            buyPrice,
            timestamp: new Date().toISOString(),
            success: true
          };
        }
        break;
      } else {
        log(`    Attempt ${attempt + 1} failed: ${result.error || 'unknown'}`);
      }
    } catch (error) {
      log(`    Attempt ${attempt + 1} error: ${error.message}`);
    }

    if (attempt < SLIPPAGE_STEPS.length - 1) {
      await new Promise(r => setTimeout(r, RETRY_DELAY));
    }
  }

  if (!filled) {
    log(`>>> ALL ATTEMPTS FAILED for ${leader}`);
    hasBet = false;
    lastBetResult = { direction: leader, odds: leaderOdds, success: false, error: 'all attempts failed' };
    tradeHistory.push({
      timestamp: new Date().toISOString(),
      market: currentMarket.slug,
      direction: leader,
      odds: leaderOdds,
      btcOpen: btcOpenPrice,
      btcAtBet: btcCurrentPrice,
      success: false,
      error: 'all attempts exhausted'
    });
    broadcastEvent({ type: 'trade', trade: tradeHistory[tradeHistory.length - 1] });
    if (nextCheckpointIdx < CHECKPOINTS.length) {
      log(`    Will retry at T-${CHECKPOINTS[nextCheckpointIdx].at} (${(CHECKPOINTS[nextCheckpointIdx].minOdds*100)}%+)`);
    }
  }

  isExecutingTrade = false;
}

// ─── Stop loss check ──────────────────────────────────────────────────
async function checkStopLoss() {
  if (!position || !currentMarket || stopLossFired || isExecutingStopLoss) return;
  if (upOdds === null || downOdds === null) return;

  // Current price of the token we hold
  const currentPrice = position.direction === 'UP' ? upOdds : downOdds;
  const drop = position.entryPrice - currentPrice;

  if (drop >= config.STOP_LOSS_CENTS) {
    isExecutingStopLoss = true;
    stopLossFired = true;

    log(`>>> STOP LOSS TRIGGERED: ${position.direction} dropped from ${position.entryPrice.toFixed(2)} to ${currentPrice.toFixed(2)} (${(drop * 100).toFixed(0)}c drop, threshold ${(config.STOP_LOSS_CENTS * 100).toFixed(0)}c)`);

    // Retry with increasing slippage to guarantee fill
    const SL_SLIPPAGE_STEPS = [0.02, 0.05, 0.10, 0.15];
    let sold = false;

    for (let attempt = 0; attempt < SL_SLIPPAGE_STEPS.length; attempt++) {
      const sellPrice = Math.max(0.01, currentPrice - SL_SLIPPAGE_STEPS[attempt]);
      log(`    Stop loss attempt ${attempt + 1}/${SL_SLIPPAGE_STEPS.length}: selling @ ${sellPrice.toFixed(2)} (${(SL_SLIPPAGE_STEPS[attempt] * 100).toFixed(0)}c slippage)`);

      try {
        const result = await executeStopLoss(currentMarket, position.direction, position.tokenAmount, sellPrice);

        if (result.logs) {
          for (const line of result.logs) {
            log(`    [stop-loss] ${line}`);
          }
        }

        if (result.success) {
          const loss = (position.entryPrice - sellPrice) * position.tokenAmount;
          log(`>>> STOP LOSS SOLD: ${position.tokenAmount.toFixed(4)} tokens @ ${sellPrice.toFixed(2)} (loss ~$${loss.toFixed(2)})`);
          tradeHistory.push({
            timestamp: new Date().toISOString(),
            market: currentMarket.slug,
            direction: position.direction,
            odds: currentPrice,
            buyPrice: sellPrice,
            btcOpen: btcOpenPrice,
            btcAtBet: btcCurrentPrice,
            success: true,
            error: null,
            type: 'STOP_LOSS_SELL'
          });
          broadcastEvent({ type: 'trade', trade: tradeHistory[tradeHistory.length - 1] });
          sold = true;
          break;
        } else {
          log(`    Stop loss attempt ${attempt + 1} failed: ${result.error}`);
        }
      } catch (err) {
        log(`    Stop loss attempt ${attempt + 1} error: ${err.message}`);
      }

      if (attempt < SL_SLIPPAGE_STEPS.length - 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }

    if (!sold) {
      log(`>>> STOP LOSS ALL ATTEMPTS FAILED - will retry on next tick`);
      stopLossFired = false;
    }

    isExecutingStopLoss = false;
  }
}

// ─── Signal computation (reusable) ────────────────────────────────────
function computeSignal() {
  if (!currentMarket) return { signal: 'NO MARKET', leader: null, leaderOdds: null };

  const secsLeft = getSecondsRemaining(currentMarket.endDate);
  const leader = upOdds !== null && downOdds !== null ? (upOdds >= downOdds ? 'UP' : 'DOWN') : null;
  const leaderOdds = upOdds !== null && downOdds !== null ? Math.max(upOdds, downOdds) : null;
  const currentCp = nextCheckpointIdx < CHECKPOINTS.length ? CHECKPOINTS[nextCheckpointIdx] : null;

  let signal = 'WAIT';
  if (isExecutingStopLoss) {
    signal = 'STOP LOSS SELLING...';
  } else if (stopLossFired) {
    signal = 'STOP LOSS TRIGGERED';
  } else if (isExecutingTrade) {
    signal = 'PLACING TRADE...';
  } else if (hasBet && position) {
    const posPrice = position.direction === 'UP' ? upOdds : downOdds;
    const posStr = posPrice !== null
      ? ` @ ${(posPrice * 100).toFixed(1)}% (entry ${(position.entryPrice * 100).toFixed(1)}%)`
      : '';
    signal = lastBetResult
      ? `BET ${lastBetResult.direction}${posStr}`
      : 'BETTING...';
  } else if (hasBet) {
    signal = lastBetResult
      ? `BET ${lastBetResult.direction} (${lastBetResult.success ? 'OK' : 'FAILED'})`
      : 'BETTING...';
  } else if (nextCheckpointIdx >= CHECKPOINTS.length) {
    signal = 'DONE (all checkpoints passed)';
  } else if (currentCp && secsLeft <= currentCp.at && leaderOdds !== null) {
    signal = leaderOdds >= currentCp.minOdds
      ? `>>> BUY ${leader} ${(leaderOdds*100).toFixed(1)}% <<<`
      : `SKIP (${leader} ${(leaderOdds*100).toFixed(1)}% < ${(currentCp.minOdds*100)}%)`;
  } else if (secsLeft <= 3) {
    signal = 'MARKET CLOSING';
  } else if (currentCp) {
    signal = `WAIT -> T-${currentCp.at} (need ${(currentCp.minOdds*100)}%+)`;
  }

  return { signal, leader, leaderOdds };
}

// ─── Dashboard ───────────────────────────────────────────────────────
let priceToBeatRetrying = false;

function printDashboard() {
  if (!currentMarket) return;

  // Record snapshot alongside dashboard updates
  recordSnapshot();

  // Background retry for price to beat if it failed during startup
  if (!btcOpenPrice && currentMarket && !priceToBeatRetrying) {
    priceToBeatRetrying = true;
    fetchPriceToBeat(currentMarket.slug).then(price => {
      if (price) {
        btcOpenPrice = price;
        if (cycleData) cycleData.priceToBeat = price;
        log(`Price to beat fetched (background): $${price.toFixed(2)}`);
      }
      priceToBeatRetrying = false;
    }).catch(() => { priceToBeatRetrying = false; });
  }

  const secsLeft = getSecondsRemaining(currentMarket.endDate);
  const momentum = (btcOpenPrice && btcCurrentPrice)
    ? ((btcCurrentPrice - btcOpenPrice) / btcOpenPrice * 100)
    : null;
  const momentumDir = momentum !== null ? (momentum >= 0 ? 'UP' : 'DOWN') : '??';
  const momentumStr = momentum !== null
    ? `${momentum >= 0 ? '+' : ''}${momentum.toFixed(4)}%`
    : 'waiting...';

  const up = upOdds !== null ? (upOdds * 100).toFixed(1) : '??';
  const down = downOdds !== null ? (downOdds * 100).toFixed(1) : '??';

  const { signal } = computeSignal();

  const wins = tradeHistory.filter(t => t.success).length;
  const total = tradeHistory.length;

  console.clear();
  console.log('========= POLYMARKET BTC 5M SNIPER =========');
  console.log(`Market:     ${currentMarket.title}`);
  console.log(`Time left:  ${secsLeft}s ${secsLeft <= 60 ? '(TRADE WINDOW)' : ''}`);
  console.log('---------------------------------------------');
  console.log(`Price to beat: ${btcOpenPrice ? '$' + btcOpenPrice.toFixed(2) : 'waiting...'}`);
  console.log(`BTC now:       ${btcCurrentPrice ? '$' + btcCurrentPrice.toFixed(2) : 'waiting...'}`);
  console.log(`Momentum:      ${momentumStr} (${momentumDir})`);
  console.log('---------------------------------------------');
  console.log(`UP odds:    ${up}%`);
  console.log(`DOWN odds:  ${down}%`);
  console.log('---------------------------------------------');
  console.log(`Signal:     ${signal}`);
  if (position) {
    const posPrice = position.direction === 'UP' ? upOdds : downOdds;
    const stopAt = position.entryPrice - config.STOP_LOSS_CENTS;
    const pnl = posPrice !== null ? ((posPrice - position.entryPrice) * position.tokenAmount) : null;
    console.log(`Position:   ${position.direction} ${position.tokenAmount.toFixed(2)} tokens @ ${(position.entryPrice*100).toFixed(0)}c | now ${posPrice !== null ? (posPrice*100).toFixed(0)+'c' : '??'} | SL @ ${(stopAt*100).toFixed(0)}c${pnl !== null ? ' | P&L $' + pnl.toFixed(2) : ''}`);
  }
  console.log(`Trades:     ${total} total | ${wins} wins | $${config.BET_AMOUNT_USD}/trade`);
  const snapCount = cycleData ? cycleData.snapshots.length : 0;
  console.log(`Recording:  ${snapCount} snapshots`);
  console.log('=============================================');

  // Show trade log buffer
  if (tradeLogs.length > 0) {
    console.log('');
    console.log('--- Trade Log ---');
    for (const line of tradeLogs) {
      console.log(line);
    }
  }

  // Broadcast to web dashboard
  broadcastState();
}

// ─── Market cycle ────────────────────────────────────────────────────
async function startNewCycle() {
  // Finalize and save data from the previous cycle before resetting
  finalizeCycleData();

  if (dashboardInterval) clearInterval(dashboardInterval);
  if (snipeCheckInterval) clearInterval(snipeCheckInterval);
  if (stopLossInterval) clearInterval(stopLossInterval);
  if (cycleTimeout) clearTimeout(cycleTimeout);

  console.clear();
  log('Fetching current BTC 5m market...');

  const market = await fetchCurrentMarket();
  if (!market) {
    log('No active market found, retrying in 10s...');
    cycleTimeout = setTimeout(startNewCycle, 10000);
    return;
  }

  const secsLeft = getSecondsRemaining(market.endDate);
  if (secsLeft <= 5) {
    log(`Market closing in ${secsLeft}s, waiting for next window...`);
    cycleTimeout = setTimeout(startNewCycle, (secsLeft + 2) * 1000);
    return;
  }

  // Reset state
  currentMarket = market;
  upOdds = market.outcomePrices[0];
  downOdds = market.outcomePrices[1];
  hasBet = false;
  lastBetResult = null;
  isExecutingTrade = false;
  isExecutingStopLoss = false;
  stopLossFired = false;
  position = null;
  nextCheckpointIdx = 0;

  // Fetch the price to beat from Polymarket (retry up to 3 times)
  btcOpenPrice = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    btcOpenPrice = await fetchPriceToBeat(market.slug);
    if (btcOpenPrice) break;
    if (attempt < 3) {
      log(`Price to beat fetch failed (attempt ${attempt}/3), retrying in 2s...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  log(`Active: ${market.title} (${secsLeft}s left)`);
  if (btcOpenPrice) {
    log(`Price to beat: $${btcOpenPrice.toFixed(2)}`);
  } else {
    log(`WARNING: Could not fetch price to beat after 3 attempts, will retry in background`);
  }

  // Subscribe to this market's odds
  connectMarketWs(market.tokens);

  // Initialize cycle data recording
  initCycleData(market);

  // Dashboard every 2s
  dashboardInterval = setInterval(printDashboard, 2000);

  // Snipe check every 1s
  snipeCheckInterval = setInterval(checkSnipe, 1000);

  // Stop loss check every 1s
  stopLossInterval = setInterval(checkStopLoss, 1000);

  // Schedule next cycle
  const nextCycleMs = (secsLeft + 5) * 1000;
  cycleTimeout = setTimeout(startNewCycle, nextCycleMs);
}

// ─── Web Dashboard Server ─────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

// Serve frontend static files
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Cached balance/positions
let balanceCache = { data: null, ts: 0 };
let positionsCache = { data: null, ts: 0 };

// GET /api/state - live state
app.get('/api/state', (req, res) => {
  const secsLeft = currentMarket ? getSecondsRemaining(currentMarket.endDate) : null;
  const momentum = (btcOpenPrice && btcCurrentPrice)
    ? ((btcCurrentPrice - btcOpenPrice) / btcOpenPrice * 100)
    : null;
  const { signal, leader, leaderOdds } = computeSignal();

  res.json({
    market: currentMarket ? {
      title: currentMarket.title,
      slug: currentMarket.slug,
      endDate: currentMarket.endDate,
    } : null,
    secsLeft,
    btcOpenPrice,
    btcCurrentPrice,
    upOdds,
    downOdds,
    momentum,
    signal,
    leader,
    leaderOdds,
    hasBet,
    isExecutingTrade,
    lastBetResult: lastBetResult ? {
      direction: lastBetResult.direction,
      success: lastBetResult.success,
    } : null,
    tradeStats: {
      total: tradeHistory.length,
      wins: tradeHistory.filter(t => t.success).length,
      betAmount: config.BET_AMOUNT_USD,
    },
    logs: tradeLogs,
  });
});

// GET /api/trades - trade history
app.get('/api/trades', (req, res) => {
  res.json(tradeHistory);
});

// GET /api/history - market history from file
app.get('/api/history', (req, res) => {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const raw = fs.readFileSync(HISTORY_FILE, 'utf-8');
      res.json(raw.trim() ? JSON.parse(raw) : []);
    } else {
      res.json([]);
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/balance - USDC balance (30s cache)
app.get('/api/balance', async (req, res) => {
  const now = Date.now();
  if (balanceCache.data && now - balanceCache.ts < 30000) {
    return res.json(balanceCache.data);
  }
  try {
    const client = getClient();
    if (!client) return res.json({ balance: null });
    const result = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
    balanceCache = { data: result, ts: now };
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/positions - open positions (60s cache)
app.get('/api/positions', async (req, res) => {
  const now = Date.now();
  if (positionsCache.data && now - positionsCache.ts < 60000) {
    return res.json(positionsCache.data);
  }
  try {
    const proxyWallet = config.PROXY_WALLET;
    if (!proxyWallet) return res.json([]);
    const { data } = await axios.get('https://data-api.polymarket.com/positions', {
      params: { user: proxyWallet },
      timeout: 10000,
    });
    positionsCache = { data: data || [], ts: now };
    res.json(data || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// WebSocket broadcast helpers
function broadcastState() {
  if (wss.clients.size === 0) return;
  const secsLeft = currentMarket ? getSecondsRemaining(currentMarket.endDate) : null;
  const momentum = (btcOpenPrice && btcCurrentPrice)
    ? ((btcCurrentPrice - btcOpenPrice) / btcOpenPrice * 100)
    : null;
  const { signal, leader, leaderOdds } = computeSignal();

  const payload = JSON.stringify({
    type: 'state',
    market: currentMarket ? {
      title: currentMarket.title,
      slug: currentMarket.slug,
      endDate: currentMarket.endDate,
    } : null,
    secsLeft,
    btcOpenPrice,
    btcCurrentPrice,
    upOdds,
    downOdds,
    momentum,
    signal,
    leader,
    leaderOdds,
    hasBet,
    isExecutingTrade,
    tradeStats: {
      total: tradeHistory.length,
      wins: tradeHistory.filter(t => t.success).length,
      betAmount: config.BET_AMOUNT_USD,
    },
  });

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function broadcastEvent(event) {
  if (wss.clients.size === 0) return;
  const payload = JSON.stringify(event);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log('Polymarket BTC 5M Sniper');
  console.log('========================');
  console.log(`Bet amount:   $${config.BET_AMOUNT_USD}`);
  console.log(`Snipe window: last ${config.SNIPE_SECONDS}s`);
  console.log(`Min odds:     ${config.MIN_ODDS * 100}%`);
  console.log(`Stop loss:    ${(config.STOP_LOSS_CENTS * 100).toFixed(0)}c drop`);
  console.log(`Log file:     ${LOG_FILE}`);
  console.log('========================\n');

  if (!config.PRIVATE_KEY) {
    console.error('PRIVATE_KEY not set in .env file');
    process.exit(1);
  }

  // Initialize CLOB client for trading
  try {
    await initializeClient();
    log('CLOB client ready');
  } catch (error) {
    console.error('Failed to initialize client:', error.message);
    process.exit(1);
  }

  // Start web dashboard server
  server.listen(config.DASHBOARD_PORT, () => {
    log(`Dashboard running at http://localhost:${config.DASHBOARD_PORT}`);
  });

  // Chainlink price feed (persists across cycles)
  connectChainlinkWs();

  // Start first cycle
  await startNewCycle();
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  finalizeCycleData();
  if (wsRtds) wsRtds.close();
  if (wsMarket) wsMarket.close();
  if (dashboardInterval) clearInterval(dashboardInterval);
  if (snipeCheckInterval) clearInterval(snipeCheckInterval);
  if (stopLossInterval) clearInterval(stopLossInterval);
  if (cycleTimeout) clearTimeout(cycleTimeout);

  console.log('\nTrade History:');
  if (tradeHistory.length === 0) {
    console.log('  No trades');
  } else {
    tradeHistory.forEach(t => {
      console.log(`  ${t.timestamp} | ${t.market} | ${t.direction} @ ${(t.odds * 100).toFixed(0)}% | ${t.success ? 'WIN' : 'FAIL'}`);
    });
  }
  console.log(`\nFull logs: ${LOG_FILE}`);
  process.exit(0);
});

main().catch(console.error);
