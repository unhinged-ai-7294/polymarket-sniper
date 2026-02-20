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
const { executeStopLoss, placeGTCOrder, cancelOrder, getOrderStatus } = require('./sniper');
const { fetchCurrentMarket, fetchPriceToBeat, getSecondsRemaining } = require('./markets');

// ─── State ───────────────────────────────────────────────────────────
let currentMarket = null;
let btcOpenPrice = null;
let btcCurrentPrice = null;
let upOdds = null;
let downOdds = null;
let hasBet = false;
let lastBetResult = null;
let isExecutingStopLoss = false;
let stopLossFired = false;

// Position tracking for stop loss
let position = null; // { direction, entryPrice, tokenAmount, tokenId }

// GTC order tracking
let upOrderID = null;
let downOrderID = null;
let fillPollInterval = null;
let ordersPlaced = false;
let ordersCancelling = false;

let wsRtds = null;
let wsMarket = null;
let dashboardInterval = null;
let stopLossInterval = null;
let cycleTimeout = null;

const tradeHistory = [];
const tradeLogs = [];

// ─── Cycle data recording ────────────────────────────────────────────
let cycleData = null;
let lastSnapshotTime = 0;

const LOG_FILE = path.join(__dirname, '..', 'trades.log');
const HISTORY_FILE = path.join(__dirname, '..', 'data', 'market_history.json');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  tradeLogs.push(line);
  if (tradeLogs.length > 50) tradeLogs.shift();
  fs.appendFileSync(LOG_FILE, line + '\n');
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
    betPlaced: null,
    strategy: 'passive'
  };
  lastSnapshotTime = 0;
}

function recordSnapshot() {
  if (!cycleData || !currentMarket) return;
  const now = Date.now();
  if (now - lastSnapshotTime < 5000) return;
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

  if (cycleData.priceToBeat != null && cycleData.finalBtcPrice != null) {
    cycleData.actualOutcome = cycleData.finalBtcPrice >= cycleData.priceToBeat ? 'UP' : 'DOWN';
  } else {
    cycleData.actualOutcome = null;
  }

  saveCycleData(cycleData);
  log(`Cycle recorded: ${cycleData.slug} -> ${cycleData.actualOutcome} (${cycleData.snapshots.length} snapshots)`);
  cycleData = null;
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

// ─── GTC order placement ─────────────────────────────────────────────
async function placeGTCOrders() {
  if (!currentMarket || ordersPlaced) return;
  ordersPlaced = true;

  const upTokenId = currentMarket.tokens[0];
  const downTokenId = currentMarket.tokens[1];
  const limitPrice = config.LIMIT_PRICE;

  log(`Placing GTC BUY on UP @ ${(limitPrice * 100).toFixed(0)}c...`);
  const upResult = await placeGTCOrder(upTokenId, config.BET_AMOUNT_USD, limitPrice);
  for (const line of upResult.logs) log(`  [gtc-up] ${line}`);

  if (upResult.error) {
    log(`ERROR placing UP order: ${upResult.error}`);
  } else {
    upOrderID = upResult.orderID;
    log(`Placed GTC BUY on UP @ ${(limitPrice * 100).toFixed(0)}c — order ${upOrderID}`);
  }

  log(`Placing GTC BUY on DOWN @ ${(limitPrice * 100).toFixed(0)}c...`);
  const downResult = await placeGTCOrder(downTokenId, config.BET_AMOUNT_USD, limitPrice);
  for (const line of downResult.logs) log(`  [gtc-down] ${line}`);

  if (downResult.error) {
    log(`ERROR placing DOWN order: ${downResult.error}`);
  } else {
    downOrderID = downResult.orderID;
    log(`Placed GTC BUY on DOWN @ ${(limitPrice * 100).toFixed(0)}c — order ${downOrderID}`);
  }

  if (!upOrderID && !downOrderID) {
    log('Both GTC orders failed — waiting for next cycle');
    ordersPlaced = false;
    return;
  }

  // Start polling for fills
  fillPollInterval = setInterval(pollForFill, 2000);
}

// ─── Fill detection via polling ──────────────────────────────────────
async function pollForFill() {
  if (hasBet || ordersCancelling) return;

  // Check UP order
  if (upOrderID) {
    const status = await getOrderStatus(upOrderID);
    if (status && isFilled(status)) {
      log(`>>> UP ORDER FILLED! Order ${upOrderID}`);
      await handleFill('UP', status);
      return;
    }
  }

  // Check DOWN order
  if (downOrderID) {
    const status = await getOrderStatus(downOrderID);
    if (status && isFilled(status)) {
      log(`>>> DOWN ORDER FILLED! Order ${downOrderID}`);
      await handleFill('DOWN', status);
      return;
    }
  }

  // Check if market is about to close — cancel both orders
  if (currentMarket) {
    const secsLeft = getSecondsRemaining(currentMarket.endDate);
    if (secsLeft <= 5) {
      log('Market closing — cancelling unfilled GTC orders');
      await cancelRemainingOrders();
    }
  }
}

function isFilled(status) {
  // Check various indicators of a filled order
  if (status.status === 'MATCHED' || status.status === 'FILLED') return true;
  // size_matched > 0 means at least partial fill
  const matched = parseFloat(status.size_matched || '0');
  const total = parseFloat(status.original_size || status.size || '0');
  if (matched > 0 && matched >= total * 0.9) return true; // 90%+ filled counts
  return false;
}

async function handleFill(direction, orderStatus) {
  if (hasBet) return; // Guard against double-fill race
  hasBet = true;

  // Stop polling
  if (fillPollInterval) {
    clearInterval(fillPollInterval);
    fillPollInterval = null;
  }

  // Cancel the other side's order
  const otherDirection = direction === 'UP' ? 'DOWN' : 'UP';
  const otherOrderID = direction === 'UP' ? downOrderID : upOrderID;
  if (otherOrderID) {
    log(`Cancelling ${otherDirection} order ${otherOrderID}...`);
    const cancelResult = await cancelOrder(otherOrderID);
    for (const line of cancelResult.logs) log(`  [cancel] ${line}`);
  }

  // Record position
  const limitPrice = config.LIMIT_PRICE;
  const tokensReceived = config.BET_AMOUNT_USD / limitPrice;
  const tokenId = direction === 'UP' ? currentMarket.tokens[0] : currentMarket.tokens[1];

  position = {
    direction,
    entryPrice: limitPrice,
    tokenAmount: tokensReceived,
    tokenId,
    source: `PASSIVE @ ${(limitPrice * 100).toFixed(0)}c`,
    entryTime: new Date().toISOString(),
    oddsAtEntry: direction === 'UP' ? upOdds : downOdds,
    btcAtEntry: btcCurrentPrice,
    btcOpen: btcOpenPrice,
    secsLeftAtEntry: currentMarket ? getSecondsRemaining(currentMarket.endDate) : null
  };
  stopLossFired = false;

  log(`Position: ${direction} ${tokensReceived.toFixed(4)} tokens @ ${(limitPrice * 100).toFixed(0)}c (stop loss at ${((limitPrice - config.STOP_LOSS_CENTS) * 100).toFixed(0)}c)`);

  lastBetResult = { direction, success: true };

  tradeHistory.push({
    timestamp: new Date().toISOString(),
    market: currentMarket.slug,
    direction,
    odds: direction === 'UP' ? upOdds : downOdds,
    buyPrice: limitPrice,
    btcOpen: btcOpenPrice,
    btcAtBet: btcCurrentPrice,
    success: true,
    error: null,
    source: 'PASSIVE'
  });
  broadcastEvent({ type: 'trade', trade: tradeHistory[tradeHistory.length - 1] });

  if (cycleData) {
    cycleData.betPlaced = {
      direction,
      oddsAtBet: direction === 'UP' ? upOdds : downOdds,
      buyPrice: limitPrice,
      timestamp: new Date().toISOString(),
      success: true,
      source: 'PASSIVE'
    };
  }
}

async function cancelRemainingOrders() {
  if (ordersCancelling) return;
  ordersCancelling = true;

  if (fillPollInterval) {
    clearInterval(fillPollInterval);
    fillPollInterval = null;
  }

  if (upOrderID && !hasBet) {
    log(`Cancelling UP order ${upOrderID}...`);
    const r = await cancelOrder(upOrderID);
    for (const line of r.logs) log(`  [cancel] ${line}`);
  }
  if (downOrderID && !hasBet) {
    log(`Cancelling DOWN order ${downOrderID}...`);
    const r = await cancelOrder(downOrderID);
    for (const line of r.logs) log(`  [cancel] ${line}`);
  }

  ordersCancelling = false;
}

// ─── Stop loss check (identical to index.js) ────────────────────────
async function checkStopLoss() {
  if (!position || !currentMarket || stopLossFired || isExecutingStopLoss) return;
  if (upOdds === null || downOdds === null) return;

  const currentPrice = position.direction === 'UP' ? upOdds : downOdds;
  const oddsDrop = position.entryPrice - currentPrice;

  // Check 1: Odds dropped 30c+ from entry
  const oddsTriggered = oddsDrop >= config.STOP_LOSS_CENTS;

  // Check 2: BTC price crossed to the wrong side of price-to-beat
  let priceTriggered = false;
  if (btcOpenPrice && btcCurrentPrice) {
    if (position.direction === 'UP' && btcCurrentPrice < btcOpenPrice) {
      priceTriggered = true;
    } else if (position.direction === 'DOWN' && btcCurrentPrice > btcOpenPrice) {
      priceTriggered = true;
    }
  }

  if (oddsTriggered || priceTriggered) {
    isExecutingStopLoss = true;
    stopLossFired = true;

    const reason = oddsTriggered
      ? `odds dropped ${(oddsDrop * 100).toFixed(0)}c (${(position.entryPrice * 100).toFixed(1)}c -> ${(currentPrice * 100).toFixed(1)}c)`
      : `BTC crossed to wrong side (bet ${position.direction}, BTC now $${btcCurrentPrice.toFixed(2)} vs open $${btcOpenPrice.toFixed(2)})`;
    log(`>>> STOP LOSS TRIGGERED: ${reason}`);

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

          log('');
          log('════════════════ LOSS REPORT ════════════════');
          log(`Market:       ${currentMarket.title}`);
          log(`Trigger:      ${position.source}`);
          log(`Entry time:   ${position.entryTime}`);
          log(`Direction:    ${position.direction}`);
          log(`Entry price:  ${(position.entryPrice * 100).toFixed(1)}c (odds were ${(position.oddsAtEntry * 100).toFixed(1)}%)`);
          log(`BTC at entry: $${position.btcAtEntry ? position.btcAtEntry.toFixed(2) : '??'} (open: $${position.btcOpen ? position.btcOpen.toFixed(2) : '??'})`);
          log(`Secs left:    ${position.secsLeftAtEntry}s at entry`);
          log(`─────────────────────────────────────────────`);
          log(`Reason:       STOP LOSS — ${reason}`);
          log(`Sold at:      ${(sellPrice * 100).toFixed(1)}c`);
          log(`Loss:         ~$${loss.toFixed(2)}`);
          log(`BTC now:      $${btcCurrentPrice ? btcCurrentPrice.toFixed(2) : '??'}`);
          log('═════════════════════════════════════════════');
          log('Shutting down after first loss.');
          process.exit(1);
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

// ─── Signal computation ──────────────────────────────────────────────
function computeSignal() {
  if (!currentMarket) return { signal: 'NO MARKET', leader: null, leaderOdds: null };

  const leader = upOdds !== null && downOdds !== null ? (upOdds >= downOdds ? 'UP' : 'DOWN') : null;
  const leaderOdds = upOdds !== null && downOdds !== null ? Math.max(upOdds, downOdds) : null;

  let signal = 'WAIT';
  if (isExecutingStopLoss) {
    signal = 'STOP LOSS SELLING...';
  } else if (stopLossFired) {
    signal = 'STOP LOSS TRIGGERED';
  } else if (hasBet && position) {
    const posPrice = position.direction === 'UP' ? upOdds : downOdds;
    const posStr = posPrice !== null
      ? ` @ ${(posPrice * 100).toFixed(1)}% (entry ${(position.entryPrice * 100).toFixed(1)}%)`
      : '';
    signal = `BET ${position.direction}${posStr}`;
  } else if (ordersPlaced && (upOrderID || downOrderID)) {
    signal = `GTC ORDERS RESTING @ ${(config.LIMIT_PRICE * 100).toFixed(0)}c (UP: ${upOrderID ? 'active' : 'failed'}, DOWN: ${downOrderID ? 'active' : 'failed'})`;
  } else {
    signal = 'PLACING ORDERS...';
  }

  return { signal, leader, leaderOdds };
}

// ─── Dashboard ───────────────────────────────────────────────────────
let priceToBeatRetrying = false;

function printDashboard() {
  if (!currentMarket) return;

  recordSnapshot();

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
  console.log('======= POLYMARKET PASSIVE LIMIT SNIPER =======');
  console.log(`Strategy:   GTC limit orders @ ${(config.LIMIT_PRICE * 100).toFixed(0)}c both sides`);
  console.log(`Market:     ${currentMarket.title}`);
  console.log(`Time left:  ${secsLeft}s`);
  console.log('------------------------------------------------');
  console.log(`Price to beat: ${btcOpenPrice ? '$' + btcOpenPrice.toFixed(2) : 'waiting...'}`);
  console.log(`BTC now:       ${btcCurrentPrice ? '$' + btcCurrentPrice.toFixed(2) : 'waiting...'}`);
  console.log(`Momentum:      ${momentumStr} (${momentumDir})`);
  console.log('------------------------------------------------');
  console.log(`UP odds:    ${up}%`);
  console.log(`DOWN odds:  ${down}%`);
  console.log('------------------------------------------------');
  console.log(`Signal:     ${signal}`);
  if (position) {
    const posPrice = position.direction === 'UP' ? upOdds : downOdds;
    const stopAt = position.entryPrice - config.STOP_LOSS_CENTS;
    const pnl = posPrice !== null ? ((posPrice - position.entryPrice) * position.tokenAmount) : null;
    console.log(`Position:   ${position.direction} ${position.tokenAmount.toFixed(2)} tokens @ ${(position.entryPrice*100).toFixed(0)}c | now ${posPrice !== null ? (posPrice*100).toFixed(0)+'c' : '??'} | SL @ ${(stopAt*100).toFixed(0)}c${pnl !== null ? ' | P&L $' + pnl.toFixed(2) : ''}`);
  }
  console.log(`Orders:     UP=${upOrderID || 'none'} | DOWN=${downOrderID || 'none'}`);
  console.log(`Trades:     ${total} total | ${wins} wins | $${config.BET_AMOUNT_USD}/trade`);
  const snapCount = cycleData ? cycleData.snapshots.length : 0;
  console.log(`Recording:  ${snapCount} snapshots`);
  console.log('================================================');

  if (tradeLogs.length > 0) {
    console.log('');
    console.log('--- Trade Log ---');
    for (const line of tradeLogs) {
      console.log(line);
    }
  }

  broadcastState();
}

// ─── Market cycle ────────────────────────────────────────────────────
async function startNewCycle() {
  finalizeCycleData();

  if (dashboardInterval) clearInterval(dashboardInterval);
  if (stopLossInterval) clearInterval(stopLossInterval);
  if (fillPollInterval) clearInterval(fillPollInterval);
  if (cycleTimeout) clearTimeout(cycleTimeout);

  // Cancel any leftover orders from previous cycle
  await cancelRemainingOrders();

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
  isExecutingStopLoss = false;
  stopLossFired = false;
  position = null;
  upOrderID = null;
  downOrderID = null;
  ordersPlaced = false;
  ordersCancelling = false;

  // Fetch the price to beat
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

  // Stop loss check every 1s
  stopLossInterval = setInterval(checkStopLoss, 1000);

  // Place GTC orders on both sides immediately
  await placeGTCOrders();

  // Schedule next cycle
  const nextCycleMs = (secsLeft + 5) * 1000;
  cycleTimeout = setTimeout(startNewCycle, nextCycleMs);
}

// ─── Web Dashboard Server ─────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, '..', 'frontend')));

let balanceCache = { data: null, ts: 0 };
let positionsCache = { data: null, ts: 0 };

app.get('/api/state', (req, res) => {
  const secsLeft = currentMarket ? getSecondsRemaining(currentMarket.endDate) : null;
  const momentum = (btcOpenPrice && btcCurrentPrice)
    ? ((btcCurrentPrice - btcOpenPrice) / btcOpenPrice * 100)
    : null;
  const { signal, leader, leaderOdds } = computeSignal();

  res.json({
    strategy: 'passive',
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
    lastBetResult: lastBetResult ? {
      direction: lastBetResult.direction,
      success: lastBetResult.success,
    } : null,
    orders: {
      upOrderID,
      downOrderID,
      limitPrice: config.LIMIT_PRICE,
    },
    tradeStats: {
      total: tradeHistory.length,
      wins: tradeHistory.filter(t => t.success).length,
      betAmount: config.BET_AMOUNT_USD,
    },
    logs: tradeLogs,
  });
});

app.get('/api/trades', (req, res) => {
  res.json(tradeHistory);
});

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

function broadcastState() {
  if (wss.clients.size === 0) return;
  const secsLeft = currentMarket ? getSecondsRemaining(currentMarket.endDate) : null;
  const momentum = (btcOpenPrice && btcCurrentPrice)
    ? ((btcCurrentPrice - btcOpenPrice) / btcOpenPrice * 100)
    : null;
  const { signal, leader, leaderOdds } = computeSignal();

  const payload = JSON.stringify({
    type: 'state',
    strategy: 'passive',
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
    orders: {
      upOrderID,
      downOrderID,
      limitPrice: config.LIMIT_PRICE,
    },
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
  console.log('Polymarket Passive Limit Sniper');
  console.log('================================');
  console.log(`Strategy:     GTC limit orders @ ${(config.LIMIT_PRICE * 100).toFixed(0)}c both sides`);
  console.log(`Bet amount:   $${config.BET_AMOUNT_USD} per side ($${config.BET_AMOUNT_USD * 2} locked)`);
  console.log(`Stop loss:    ${(config.STOP_LOSS_CENTS * 100).toFixed(0)}c drop`);
  console.log(`Log file:     ${LOG_FILE}`);
  console.log('================================\n');

  if (!config.PRIVATE_KEY) {
    console.error('PRIVATE_KEY not set in .env file');
    process.exit(1);
  }

  try {
    await initializeClient();
    log('CLOB client ready');
  } catch (error) {
    console.error('Failed to initialize client:', error.message);
    process.exit(1);
  }

  server.listen(config.DASHBOARD_PORT, () => {
    log(`Dashboard running at http://localhost:${config.DASHBOARD_PORT}`);
  });

  connectChainlinkWs();

  await startNewCycle();
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  finalizeCycleData();

  // Cancel any resting orders before exit
  const cleanup = async () => {
    await cancelRemainingOrders();
    if (wsRtds) wsRtds.close();
    if (wsMarket) wsMarket.close();
    if (dashboardInterval) clearInterval(dashboardInterval);
    if (stopLossInterval) clearInterval(stopLossInterval);
    if (fillPollInterval) clearInterval(fillPollInterval);
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
  };

  cleanup().catch(() => process.exit(1));
});

main().catch(console.error);
