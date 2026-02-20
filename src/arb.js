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
const { placeOrder, placeSellOrder } = require('./sniper');
const { fetchCurrentMarket, fetchPriceToBeat, getSecondsRemaining } = require('./markets');

// ─── State ───────────────────────────────────────────────────────────
let currentMarket = null;
let btcOpenPrice = null;

// Binance price state
let binanceBtcMid = null;
let binanceBtcBid = null;
let binanceBtcAsk = null;

// Polymarket order book state
let upBestBid = null;
let upBestAsk = null;
let downBestBid = null;
let downBestAsk = null;

// Derived mid prices (for display compatibility)
let upOdds = null;
let downOdds = null;

// Trade state
let isExecutingTrade = false;
let isExecutingExit = false;
let lastTradeTime = 0;
let tradesThisCycle = 0;
let sessionPnL = 0;

// Active positions (multiple allowed per cycle)
let activePositions = []; // { id, direction, entryPrice, tokenAmount, tokenId, targetPrice, stopPrice, entryTime, binanceAtEntry, divergenceAtEntry }

let wsBinance = null;
let wsMarket = null;
let dashboardInterval = null;
let exitCheckInterval = null;
let cycleTimeout = null;

const tradeHistory = [];
const tradeLogs = [];

const LOG_FILE = path.join(__dirname, '..', 'arb_trades.log');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  tradeLogs.push(line);
  if (tradeLogs.length > 80) tradeLogs.shift();
  fs.appendFileSync(LOG_FILE, line + '\n');
  broadcastEvent({ type: 'log', line });
}

// ─── Binance WebSocket ───────────────────────────────────────────────
function connectBinanceWs() {
  if (wsBinance) {
    wsBinance.removeAllListeners();
    wsBinance.close();
  }

  wsBinance = new WebSocket(config.BINANCE_WSS);

  wsBinance.on('open', () => {
    log('Binance WS connected (btcusdt@bookTicker)');
  });

  wsBinance.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      // bookTicker fields: b = best bid, a = best ask
      const bid = parseFloat(msg.b);
      const ask = parseFloat(msg.a);
      if (isNaN(bid) || isNaN(ask)) return;

      binanceBtcBid = bid;
      binanceBtcAsk = ask;
      binanceBtcMid = (bid + ask) / 2;

      evaluateArbitrage();
    } catch (e) {}
  });

  wsBinance.on('error', (err) => log('Binance WS error: ' + err.message));
  wsBinance.on('close', () => {
    log('Binance WS disconnected, reconnecting in 2s...');
    setTimeout(connectBinanceWs, 2000);
  });
  wsBinance.on('ping', () => wsBinance.pong());
}

// ─── Polymarket CLOB WebSocket ───────────────────────────────────────
function connectMarketWs(tokens) {
  if (wsMarket) {
    wsMarket.removeAllListeners();
    wsMarket.close();
  }

  if (!tokens || tokens.length < 2) return;

  wsMarket = new WebSocket(config.WSS_MARKET);

  wsMarket.on('open', () => {
    log('Polymarket CLOB WS connected');
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

          if (pc.asset_id === currentMarket.tokens[0]) {
            upBestBid = bid;
            upBestAsk = ask;
            upOdds = (bid + ask) / 2;
            downOdds = 1 - upOdds;
          } else if (pc.asset_id === currentMarket.tokens[1]) {
            downBestBid = bid;
            downBestAsk = ask;
            downOdds = (bid + ask) / 2;
            upOdds = 1 - downOdds;
          }
        }
        evaluateArbitrage();
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

// ─── Sigmoid Implied Probability Model ──────────────────────────────
function calculateImpliedProbability(binancePrice, openPrice, secsLeft) {
  if (!binancePrice || !openPrice || openPrice === 0) return { up: 0.5, down: 0.5 };

  const pctChange = (binancePrice - openPrice) / openPrice * 100;
  const k = config.MODEL_K_BASE * Math.sqrt(300 / Math.max(secsLeft, 10));
  const probUp = 1 / (1 + Math.exp(-k * pctChange));

  return { up: probUp, down: 1 - probUp };
}

// ─── Arbitrage Evaluation (fast, synchronous) ───────────────────────
function evaluateArbitrage() {
  // Guard: need all data
  if (!currentMarket || !btcOpenPrice || !binanceBtcMid) return;
  if (upBestAsk === null && downBestAsk === null) return;
  if (isExecutingTrade) return;

  // Guard: position/trade limits
  if (activePositions.length >= config.MAX_CONCURRENT_POSITIONS) return;
  if (tradesThisCycle >= config.MAX_TRADES_PER_CYCLE) return;

  // Guard: cooldown
  if (Date.now() - lastTradeTime < config.ARB_COOLDOWN_MS) return;

  // Guard: time bounds
  const secsLeft = getSecondsRemaining(currentMarket.endDate);
  if (secsLeft < config.ARB_MIN_SECS_LEFT || secsLeft > 280) return;

  // Calculate implied probability from Binance price
  const implied = calculateImpliedProbability(binanceBtcMid, btcOpenPrice, secsLeft);

  // Check UP divergence: implied UP prob vs Polymarket UP ask price
  if (upBestAsk !== null) {
    const upDivergence = implied.up - upBestAsk;
    if (upDivergence > config.DIVERGENCE_THRESHOLD) {
      // Don't open a second position in the same direction this cycle
      if (!activePositions.some(p => p.direction === 'UP')) {
        executeArbTrade('UP', upBestAsk, implied.up, upDivergence, secsLeft);
        return;
      }
    }
  }

  // Check DOWN divergence: implied DOWN prob vs Polymarket DOWN ask price
  if (downBestAsk !== null) {
    const downDivergence = implied.down - downBestAsk;
    if (downDivergence > config.DIVERGENCE_THRESHOLD) {
      if (!activePositions.some(p => p.direction === 'DOWN')) {
        executeArbTrade('DOWN', downBestAsk, implied.down, downDivergence, secsLeft);
        return;
      }
    }
  }
}

// ─── Execute Arb Trade ──────────────────────────────────────────────
async function executeArbTrade(direction, askPrice, impliedProb, divergence, secsLeft) {
  isExecutingTrade = true;
  lastTradeTime = Date.now();

  const buyPrice = Math.min(askPrice + config.ARB_SLIPPAGE, 0.99);
  const targetPrice = Math.min(buyPrice + divergence * config.ARB_PROFIT_CAPTURE, 0.99);
  const stopPrice = Math.max(buyPrice - config.ARB_STOP_LOSS_CENTS, 0.01);

  log(`>>> ARB SIGNAL: ${direction} | divergence ${(divergence * 100).toFixed(1)}% | implied ${(impliedProb * 100).toFixed(1)}% vs ask ${(askPrice * 100).toFixed(1)}% | T-${secsLeft}`);
  log(`    Buy @ ${(buyPrice * 100).toFixed(1)}c | target ${(targetPrice * 100).toFixed(1)}c | SL ${(stopPrice * 100).toFixed(1)}c`);

  const tokenId = direction === 'UP' ? currentMarket.tokens[0] : currentMarket.tokens[1];

  try {
    const result = await placeOrder(tokenId, config.ARB_BET_AMOUNT_USD, buyPrice);

    if (result.logs) {
      for (const line of result.logs) {
        log(`    [order] ${line}`);
      }
    }

    if (!result.error) {
      tradesThisCycle++;
      const tokensReceived = config.ARB_BET_AMOUNT_USD / buyPrice;

      const pos = {
        id: Date.now(),
        direction,
        entryPrice: buyPrice,
        tokenAmount: tokensReceived,
        tokenId: direction === 'UP' ? currentMarket.tokens[0] : currentMarket.tokens[1],
        targetPrice,
        stopPrice,
        entryTime: new Date().toISOString(),
        binanceAtEntry: binanceBtcMid,
        divergenceAtEntry: divergence,
        secsLeftAtEntry: secsLeft
      };
      activePositions.push(pos);

      log(`>>> ARB FILLED: ${direction} ${tokensReceived.toFixed(2)} tokens @ ${(buyPrice * 100).toFixed(1)}c | target ${(targetPrice * 100).toFixed(1)}c | SL ${(stopPrice * 100).toFixed(1)}c`);

      tradeHistory.push({
        timestamp: new Date().toISOString(),
        market: currentMarket.slug,
        direction,
        entryPrice: buyPrice,
        impliedProb,
        askPrice,
        divergence,
        btcOpen: btcOpenPrice,
        binanceAtEntry: binanceBtcMid,
        secsLeft,
        success: true,
        type: 'ARB_ENTRY',
        source: 'ARB'
      });
      broadcastEvent({ type: 'trade', trade: tradeHistory[tradeHistory.length - 1] });
    } else {
      log(`    ARB order not filled: ${result.error || 'no fill'} -- opportunity gone`);
    }
  } catch (error) {
    log(`    ARB trade error: ${error.message}`);
  }

  isExecutingTrade = false;
}

// ─── Exit Management ────────────────────────────────────────────────
async function checkExits() {
  if (activePositions.length === 0 || isExecutingExit || !currentMarket) return;

  const secsLeft = getSecondsRemaining(currentMarket.endDate);

  for (let i = activePositions.length - 1; i >= 0; i--) {
    const pos = activePositions[i];
    const currentPrice = pos.direction === 'UP'
      ? (upBestBid !== null ? upBestBid : upOdds)
      : (downBestBid !== null ? downBestBid : downOdds);

    if (currentPrice === null) continue;

    const pnlPerToken = currentPrice - pos.entryPrice;
    const inProfit = pnlPerToken > 0;
    let exitReason = null;

    // 1. Profit target
    if (currentPrice >= pos.targetPrice) {
      exitReason = `PROFIT TARGET (${(currentPrice * 100).toFixed(1)}c >= ${(pos.targetPrice * 100).toFixed(1)}c)`;
    }

    // 2. Stop loss
    if (!exitReason && currentPrice <= pos.stopPrice) {
      exitReason = `STOP LOSS (${(currentPrice * 100).toFixed(1)}c <= ${(pos.stopPrice * 100).toFixed(1)}c)`;
    }

    // 3. BTC revert — Binance price crossed to the wrong side of open
    if (!exitReason && btcOpenPrice && binanceBtcMid) {
      if (pos.direction === 'UP' && binanceBtcMid < btcOpenPrice) {
        exitReason = `BTC REVERT (${pos.direction} bet, BTC $${binanceBtcMid.toFixed(0)} < open $${btcOpenPrice.toFixed(0)})`;
      } else if (pos.direction === 'DOWN' && binanceBtcMid > btcOpenPrice) {
        exitReason = `BTC REVERT (${pos.direction} bet, BTC $${binanceBtcMid.toFixed(0)} > open $${btcOpenPrice.toFixed(0)})`;
      }
    }

    // 4. Time exit — <8s left and in profit, sell
    if (!exitReason && secsLeft < 8 && inProfit) {
      exitReason = `TIME EXIT (${secsLeft}s left, in profit)`;
    }

    // 5. Convergence — divergence collapsed to <2% and in profit
    if (!exitReason && inProfit && btcOpenPrice && binanceBtcMid) {
      const implied = calculateImpliedProbability(binanceBtcMid, btcOpenPrice, secsLeft);
      const currentAsk = pos.direction === 'UP' ? (upBestAsk || upOdds) : (downBestAsk || downOdds);
      if (currentAsk !== null) {
        const currentDivergence = (pos.direction === 'UP' ? implied.up : implied.down) - currentAsk;
        if (currentDivergence < 0.02) {
          exitReason = `CONVERGENCE (divergence ${(currentDivergence * 100).toFixed(1)}% < 2%)`;
        }
      }
    }

    if (exitReason) {
      await executeExit(pos, i, currentPrice, exitReason);
      // Only exit one position per tick to avoid concurrency issues
      break;
    }
  }
}

async function executeExit(pos, index, currentPrice, reason) {
  isExecutingExit = true;

  const sellPrice = Math.max(0.01, currentPrice - config.ARB_SLIPPAGE);
  const pnl = (currentPrice - pos.entryPrice) * pos.tokenAmount;

  log(`>>> EXIT ${pos.direction}: ${reason}`);
  log(`    Selling ${pos.tokenAmount.toFixed(2)} tokens @ ${(sellPrice * 100).toFixed(1)}c (entry ${(pos.entryPrice * 100).toFixed(1)}c) | P&L ~$${pnl.toFixed(2)}`);

  try {
    const result = await placeSellOrder(pos.tokenId, pos.tokenAmount, sellPrice);

    if (result.logs) {
      for (const line of result.logs) {
        log(`    [sell] ${line}`);
      }
    }

    if (!result.error) {
      sessionPnL += pnl;
      activePositions.splice(index, 1);

      log(`>>> EXIT FILLED: ${pos.direction} | P&L $${pnl.toFixed(2)} | session $${sessionPnL.toFixed(2)}`);

      tradeHistory.push({
        timestamp: new Date().toISOString(),
        market: currentMarket.slug,
        direction: pos.direction,
        sellPrice,
        entryPrice: pos.entryPrice,
        pnl,
        reason,
        success: true,
        type: 'ARB_EXIT',
        source: 'ARB'
      });
      broadcastEvent({ type: 'trade', trade: tradeHistory[tradeHistory.length - 1] });
    } else {
      log(`    Exit failed: ${result.error} — will retry`);
    }
  } catch (error) {
    log(`    Exit error: ${error.message}`);
  }

  isExecutingExit = false;
}

// ─── Dashboard ──────────────────────────────────────────────────────
let priceToBeatRetrying = false;

function printDashboard() {
  if (!currentMarket) return;

  // Background retry for price to beat
  if (!btcOpenPrice && currentMarket && !priceToBeatRetrying) {
    priceToBeatRetrying = true;
    fetchPriceToBeat(currentMarket.slug).then(price => {
      if (price) {
        btcOpenPrice = price;
        log(`Price to beat fetched (background): $${price.toFixed(2)}`);
      }
      priceToBeatRetrying = false;
    }).catch(() => { priceToBeatRetrying = false; });
  }

  const secsLeft = getSecondsRemaining(currentMarket.endDate);
  const pctChange = (binanceBtcMid && btcOpenPrice)
    ? ((binanceBtcMid - btcOpenPrice) / btcOpenPrice * 100)
    : null;

  // Implied probabilities
  const implied = (binanceBtcMid && btcOpenPrice)
    ? calculateImpliedProbability(binanceBtcMid, btcOpenPrice, secsLeft)
    : null;

  // Divergences
  let upDiv = null, downDiv = null;
  if (implied) {
    if (upBestAsk !== null) upDiv = implied.up - upBestAsk;
    if (downBestAsk !== null) downDiv = implied.down - downBestAsk;
  }

  // Signal indicator
  let signalStr = 'SCANNING';
  if (isExecutingTrade) signalStr = 'EXECUTING TRADE...';
  else if (isExecutingExit) signalStr = 'EXECUTING EXIT...';
  else if (secsLeft < config.ARB_MIN_SECS_LEFT) signalStr = 'TOO CLOSE TO EXPIRY';
  else if (secsLeft > 280) signalStr = 'WAITING FOR WINDOW';
  else if (tradesThisCycle >= config.MAX_TRADES_PER_CYCLE) signalStr = 'MAX TRADES REACHED';
  else if (activePositions.length >= config.MAX_CONCURRENT_POSITIONS) signalStr = 'MAX POSITIONS';
  else if (upDiv !== null && upDiv > config.DIVERGENCE_THRESHOLD) signalStr = `>>> BUY UP (div +${(upDiv * 100).toFixed(1)}%) <<<`;
  else if (downDiv !== null && downDiv > config.DIVERGENCE_THRESHOLD) signalStr = `>>> BUY DOWN (div +${(downDiv * 100).toFixed(1)}%) <<<`;

  const up = upOdds !== null ? (upOdds * 100).toFixed(1) : '??';
  const down = downOdds !== null ? (downOdds * 100).toFixed(1) : '??';
  const upBid = upBestBid !== null ? (upBestBid * 100).toFixed(1) : '??';
  const upAsk = upBestAsk !== null ? (upBestAsk * 100).toFixed(1) : '??';
  const downBid = downBestBid !== null ? (downBestBid * 100).toFixed(1) : '??';
  const downAsk = downBestAsk !== null ? (downBestAsk * 100).toFixed(1) : '??';

  console.clear();
  console.log('========= BINANCE-POLYMARKET ARB BOT =========');
  console.log(`Market:      ${currentMarket.title}`);
  console.log(`Time left:   ${secsLeft}s`);
  console.log('-----------------------------------------------');
  console.log(`Binance BTC: ${binanceBtcMid ? '$' + binanceBtcMid.toFixed(2) : 'connecting...'}`);
  console.log(`Open price:  ${btcOpenPrice ? '$' + btcOpenPrice.toFixed(2) : 'waiting...'}`);
  console.log(`% Change:    ${pctChange !== null ? (pctChange >= 0 ? '+' : '') + pctChange.toFixed(4) + '%' : 'waiting...'}`);
  console.log('-----------------------------------------------');
  console.log(`Implied:     UP ${implied ? (implied.up * 100).toFixed(1) + '%' : '??'}  |  DOWN ${implied ? (implied.down * 100).toFixed(1) + '%' : '??'}`);
  console.log(`Market:      UP ${upBid}/${upAsk}  |  DOWN ${downBid}/${downAsk}`);
  console.log(`Divergence:  UP ${upDiv !== null ? (upDiv >= 0 ? '+' : '') + (upDiv * 100).toFixed(1) + '%' : '??'}  |  DOWN ${downDiv !== null ? (downDiv >= 0 ? '+' : '') + (downDiv * 100).toFixed(1) + '%' : '??'}  (threshold ${(config.DIVERGENCE_THRESHOLD * 100).toFixed(0)}%)`);
  console.log('-----------------------------------------------');
  console.log(`Signal:      ${signalStr}`);

  // Active positions
  if (activePositions.length > 0) {
    console.log('-----------------------------------------------');
    console.log('Positions:');
    for (const pos of activePositions) {
      const curPrice = pos.direction === 'UP'
        ? (upBestBid !== null ? upBestBid : upOdds)
        : (downBestBid !== null ? downBestBid : downOdds);
      const pnl = curPrice !== null ? ((curPrice - pos.entryPrice) * pos.tokenAmount) : null;
      console.log(`  ${pos.direction} ${pos.tokenAmount.toFixed(1)} tok @ ${(pos.entryPrice * 100).toFixed(0)}c | now ${curPrice !== null ? (curPrice * 100).toFixed(0) + 'c' : '??'} | tgt ${(pos.targetPrice * 100).toFixed(0)}c | SL ${(pos.stopPrice * 100).toFixed(0)}c${pnl !== null ? ' | $' + pnl.toFixed(2) : ''}`);
    }
  }

  console.log('-----------------------------------------------');
  console.log(`Session:     P&L $${sessionPnL.toFixed(2)} | Trades ${tradesThisCycle}/${config.MAX_TRADES_PER_CYCLE} | Positions ${activePositions.length}/${config.MAX_CONCURRENT_POSITIONS}`);
  console.log(`Settings:    $${config.ARB_BET_AMOUNT_USD}/trade | div ${(config.DIVERGENCE_THRESHOLD * 100).toFixed(0)}% | SL ${(config.ARB_STOP_LOSS_CENTS * 100).toFixed(0)}c | profit ${(config.ARB_PROFIT_CAPTURE * 100).toFixed(0)}%`);
  console.log('===============================================');

  if (tradeLogs.length > 0) {
    console.log('');
    console.log('--- Trade Log ---');
    const recent = tradeLogs.slice(-15);
    for (const line of recent) {
      console.log(line);
    }
  }

  broadcastState();
}

// ─── Market Cycle ───────────────────────────────────────────────────
async function startNewCycle() {
  if (dashboardInterval) clearInterval(dashboardInterval);
  if (exitCheckInterval) clearInterval(exitCheckInterval);
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

  // Reset cycle state
  currentMarket = market;
  upOdds = market.outcomePrices[0];
  downOdds = market.outcomePrices[1];
  upBestBid = null;
  upBestAsk = null;
  downBestBid = null;
  downBestAsk = null;
  isExecutingTrade = false;
  isExecutingExit = false;
  activePositions = [];
  tradesThisCycle = 0;
  lastTradeTime = 0;

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
    log('WARNING: Could not fetch price to beat, will retry in background');
  }

  // Subscribe to this market's CLOB odds
  connectMarketWs(market.tokens);

  // Dashboard every 1s
  dashboardInterval = setInterval(printDashboard, 1000);

  // Exit checks every 500ms
  exitCheckInterval = setInterval(checkExits, 500);

  // Schedule next cycle
  const nextCycleMs = (secsLeft + 5) * 1000;
  cycleTimeout = setTimeout(startNewCycle, nextCycleMs);
}

// ─── Web Dashboard Server ───────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

app.use(express.static(path.join(__dirname, '..', 'frontend')));

let balanceCache = { data: null, ts: 0 };
let positionsCache = { data: null, ts: 0 };

app.get('/api/state', (req, res) => {
  const secsLeft = currentMarket ? getSecondsRemaining(currentMarket.endDate) : null;
  const pctChange = (binanceBtcMid && btcOpenPrice)
    ? ((binanceBtcMid - btcOpenPrice) / btcOpenPrice * 100)
    : null;
  const implied = (binanceBtcMid && btcOpenPrice && secsLeft)
    ? calculateImpliedProbability(binanceBtcMid, btcOpenPrice, secsLeft)
    : null;

  let upDiv = null, downDiv = null;
  if (implied) {
    if (upBestAsk !== null) upDiv = implied.up - upBestAsk;
    if (downBestAsk !== null) downDiv = implied.down - downBestAsk;
  }

  res.json({
    strategy: 'arb',
    market: currentMarket ? {
      title: currentMarket.title,
      slug: currentMarket.slug,
      endDate: currentMarket.endDate,
    } : null,
    secsLeft,
    btcOpenPrice,
    binancePrice: binanceBtcMid,
    pctChange,
    implied,
    upOdds,
    downOdds,
    orderBook: { upBestBid, upBestAsk, downBestBid, downBestAsk },
    divergence: { up: upDiv, down: downDiv },
    activePositions: activePositions.map(p => ({
      ...p,
      currentPrice: p.direction === 'UP'
        ? (upBestBid || upOdds)
        : (downBestBid || downOdds),
    })),
    sessionPnL,
    tradesThisCycle,
    isExecutingTrade,
    isExecutingExit,
    tradeStats: {
      total: tradeHistory.length,
      entries: tradeHistory.filter(t => t.type === 'ARB_ENTRY').length,
      exits: tradeHistory.filter(t => t.type === 'ARB_EXIT').length,
      betAmount: config.ARB_BET_AMOUNT_USD,
    },
    config: {
      divergenceThreshold: config.DIVERGENCE_THRESHOLD,
      stopLoss: config.ARB_STOP_LOSS_CENTS,
      profitCapture: config.ARB_PROFIT_CAPTURE,
      maxPositions: config.MAX_CONCURRENT_POSITIONS,
      maxTrades: config.MAX_TRADES_PER_CYCLE,
    },
    logs: tradeLogs,
  });
});

app.get('/api/trades', (req, res) => {
  res.json(tradeHistory);
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

// WebSocket broadcast
function broadcastState() {
  if (wss.clients.size === 0) return;
  const secsLeft = currentMarket ? getSecondsRemaining(currentMarket.endDate) : null;
  const pctChange = (binanceBtcMid && btcOpenPrice)
    ? ((binanceBtcMid - btcOpenPrice) / btcOpenPrice * 100)
    : null;
  const implied = (binanceBtcMid && btcOpenPrice && secsLeft)
    ? calculateImpliedProbability(binanceBtcMid, btcOpenPrice, secsLeft)
    : null;

  const payload = JSON.stringify({
    type: 'state',
    strategy: 'arb',
    market: currentMarket ? {
      title: currentMarket.title,
      slug: currentMarket.slug,
      endDate: currentMarket.endDate,
    } : null,
    secsLeft,
    binancePrice: binanceBtcMid,
    btcOpenPrice,
    pctChange,
    implied,
    upOdds,
    downOdds,
    orderBook: { upBestBid, upBestAsk, downBestBid, downBestAsk },
    activePositions: activePositions.length,
    sessionPnL,
    tradesThisCycle,
    isExecutingTrade,
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

// ─── Main ───────────────────────────────────────────────────────────
async function main() {
  console.log('Binance-Polymarket Arbitrage Bot');
  console.log('=================================');
  console.log(`Bet amount:    $${config.ARB_BET_AMOUNT_USD}`);
  console.log(`Divergence:    ${(config.DIVERGENCE_THRESHOLD * 100).toFixed(0)}% threshold`);
  console.log(`Stop loss:     ${(config.ARB_STOP_LOSS_CENTS * 100).toFixed(0)}c`);
  console.log(`Profit capture:${(config.ARB_PROFIT_CAPTURE * 100).toFixed(0)}% of divergence`);
  console.log(`Max positions: ${config.MAX_CONCURRENT_POSITIONS}`);
  console.log(`Max trades:    ${config.MAX_TRADES_PER_CYCLE}/cycle`);
  console.log(`Cooldown:      ${config.ARB_COOLDOWN_MS}ms`);
  console.log(`Log file:      ${LOG_FILE}`);
  console.log('=================================\n');

  if (!config.PRIVATE_KEY) {
    console.error('PRIVATE_KEY not set in .env file');
    process.exit(1);
  }

  // Initialize CLOB client
  try {
    await initializeClient();
    log('CLOB client ready');
  } catch (error) {
    console.error('Failed to initialize client:', error.message);
    process.exit(1);
  }

  // Start web dashboard
  const port = parseInt(process.env.ARB_DASHBOARD_PORT) || config.DASHBOARD_PORT + 1;
  server.listen(port, () => {
    log(`Dashboard running at http://localhost:${port}`);
  });

  // Connect Binance WS (persists across cycles)
  connectBinanceWs();

  // Start first cycle
  await startNewCycle();
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down arb bot...');
  if (wsBinance) wsBinance.close();
  if (wsMarket) wsMarket.close();
  if (dashboardInterval) clearInterval(dashboardInterval);
  if (exitCheckInterval) clearInterval(exitCheckInterval);
  if (cycleTimeout) clearTimeout(cycleTimeout);

  console.log(`\nSession P&L: $${sessionPnL.toFixed(2)}`);
  console.log(`Trades: ${tradeHistory.length}`);

  if (tradeHistory.length > 0) {
    console.log('\nTrade History:');
    for (const t of tradeHistory) {
      const typeStr = t.type === 'ARB_ENTRY' ? 'BUY' : 'SELL';
      console.log(`  ${t.timestamp} | ${typeStr} ${t.direction} | ${t.market}`);
    }
  }

  console.log(`\nFull logs: ${LOG_FILE}`);
  process.exit(0);
});

main().catch(console.error);
