// ─── WebSocket Connection ──────────────────────────────────────────
let ws = null;
let reconnectTimer = null;

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    document.getElementById('live-indicator').textContent = 'LIVE';
    document.getElementById('live-indicator').classList.remove('disconnected');
  };

  ws.onclose = () => {
    document.getElementById('live-indicator').textContent = 'OFFLINE';
    document.getElementById('live-indicator').classList.add('disconnected');
    reconnectTimer = setTimeout(connectWs, 3000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'state') updateState(msg);
      else if (msg.type === 'trade') addTrade(msg.trade);
      else if (msg.type === 'log') addLogLine(msg.line);
    } catch (e) {}
  };
}

// ─── State Update ──────────────────────────────────────────────────
function updateState(s) {
  // Market info
  const titleEl = document.getElementById('market-title');
  titleEl.textContent = s.market ? s.market.title : '--';

  // Time left
  const secsLeft = s.secsLeft != null ? s.secsLeft : 0;
  const totalSecs = 300; // 5 min markets
  const pct = Math.min(100, Math.max(0, (secsLeft / totalSecs) * 100));
  const timeBar = document.getElementById('time-bar');
  timeBar.style.setProperty('--pct', pct + '%');
  timeBar.classList.remove('warning', 'danger');
  if (secsLeft <= 30) timeBar.classList.add('danger');
  else if (secsLeft <= 60) timeBar.classList.add('warning');
  document.getElementById('time-left').textContent = secsLeft != null ? secsLeft + 's' : '--';

  // BTC price
  const btcEl = document.getElementById('btc-price');
  btcEl.textContent = s.btcCurrentPrice ? '$' + formatNum(s.btcCurrentPrice, 2) : '--';

  // Momentum
  const momEl = document.getElementById('momentum');
  if (s.momentum != null) {
    const sign = s.momentum >= 0 ? '+' : '';
    const dir = s.momentum >= 0 ? 'UP' : 'DOWN';
    momEl.textContent = sign + s.momentum.toFixed(4) + '% (' + dir + ')';
    momEl.className = 'stat-value ' + (s.momentum >= 0 ? 'color-up' : 'color-down');
  } else {
    momEl.textContent = 'waiting...';
    momEl.className = 'stat-value';
  }

  // Odds
  const upPct = s.upOdds != null ? (s.upOdds * 100).toFixed(1) : '--';
  const downPct = s.downOdds != null ? (s.downOdds * 100).toFixed(1) : '--';
  document.getElementById('odds-up').textContent = upPct + '%';
  document.getElementById('odds-down').textContent = downPct + '%';

  if (s.upOdds != null) {
    document.getElementById('odds-bar-up').style.width = (s.upOdds * 100) + '%';
  }
  if (s.downOdds != null) {
    document.getElementById('odds-bar-down').style.width = (s.downOdds * 100) + '%';
  }

  // Signal
  const sigEl = document.getElementById('signal-display');
  sigEl.textContent = s.signal || 'WAIT';
  sigEl.classList.remove('buy', 'placing', 'done');
  if (s.signal && s.signal.includes('BUY')) sigEl.classList.add('buy');
  else if (s.signal && s.signal.includes('PLACING')) sigEl.classList.add('placing');
  else if (s.signal && s.signal.includes('DONE')) sigEl.classList.add('done');

  // Trade stats
  if (s.tradeStats) {
    document.getElementById('session-pnl').textContent =
      s.tradeStats.total + ' trades / ' + s.tradeStats.wins + ' wins';
  }
}

// ─── Trade Table ───────────────────────────────────────────────────
function addTrade(trade) {
  if (!trade) return;
  const tbody = document.getElementById('trades-body');

  // Remove "no trades" placeholder
  const empty = tbody.querySelector('.empty-row');
  if (empty) empty.parentElement.remove();

  const tr = document.createElement('tr');
  const time = new Date(trade.timestamp).toLocaleTimeString();
  const slug = trade.market ? trade.market.substring(0, 24) + '...' : '--';
  const odds = trade.odds != null ? (trade.odds * 100).toFixed(1) + '%' : '--';
  const result = trade.success ? 'FILLED' : 'FAIL';
  const resultClass = trade.success ? 'trade-win' : 'trade-fail';

  tr.innerHTML = `
    <td>${time}</td>
    <td>${slug}</td>
    <td class="${trade.direction === 'UP' ? 'color-up' : 'color-down'}">${trade.direction}</td>
    <td>${odds}</td>
    <td class="${resultClass}">${result}</td>
  `;
  tr.classList.add(trade.success ? 'flash-green' : 'flash-red');

  // Insert at top
  tbody.insertBefore(tr, tbody.firstChild);

  // Keep last 20
  while (tbody.children.length > 20) {
    tbody.removeChild(tbody.lastChild);
  }
}

// ─── Log ───────────────────────────────────────────────────────────
function addLogLine(line) {
  const scroll = document.getElementById('log-scroll');
  const div = document.createElement('div');
  div.className = 'log-line';
  if (line.includes('TRADE') || line.includes('BUY') || line.includes('SUCCESS')) {
    div.classList.add('trade-line');
  } else if (line.includes('ERROR') || line.includes('FAILED') || line.includes('error')) {
    div.classList.add('error-line');
  }
  div.textContent = line;
  scroll.appendChild(div);

  // Keep last 100 lines
  while (scroll.children.length > 100) {
    scroll.removeChild(scroll.firstChild);
  }

  // Auto-scroll
  scroll.scrollTop = scroll.scrollHeight;
}

// ─── Portfolio Polling ─────────────────────────────────────────────
async function fetchBalance() {
  try {
    const res = await fetch('/api/balance');
    const data = await res.json();
    const bal = data?.balance != null ? parseFloat(data.balance) : null;
    document.getElementById('usdc-balance').textContent = bal != null ? '$' + formatNum(bal, 2) : '--';
    return bal;
  } catch (e) {
    return null;
  }
}

async function fetchPositions() {
  try {
    const res = await fetch('/api/positions');
    const data = await res.json();
    let totalPos = 0;
    if (Array.isArray(data)) {
      for (const p of data) {
        const val = parseFloat(p.currentValue || p.value || 0);
        if (!isNaN(val)) totalPos += val;
      }
    }
    document.getElementById('positions-value').textContent = '$' + formatNum(totalPos, 2);
    return totalPos;
  } catch (e) {
    return 0;
  }
}

async function updatePortfolio() {
  const [bal, pos] = await Promise.all([fetchBalance(), fetchPositions()]);
  const total = (bal || 0) + (pos || 0);
  document.getElementById('total-value').textContent = '$' + formatNum(total, 2);
}

// ─── Initial Load ──────────────────────────────────────────────────
async function loadInitialData() {
  // Load existing logs & trades via REST
  try {
    const stateRes = await fetch('/api/state');
    const state = await stateRes.json();
    if (state.logs) {
      for (const line of state.logs) addLogLine(line);
    }
    updateState(state);
  } catch (e) {}

  try {
    const tradesRes = await fetch('/api/trades');
    const trades = await tradesRes.json();
    if (Array.isArray(trades)) {
      // Show newest first
      for (const t of trades.slice().reverse()) addTrade(t);
    }
  } catch (e) {}

  // Load chart
  loadChart();

  // Portfolio
  updatePortfolio();
}

// ─── Helpers ───────────────────────────────────────────────────────
function formatNum(n, decimals) {
  return Number(n).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// ─── Init ──────────────────────────────────────────────────────────
connectWs();
loadInitialData();

// Refresh portfolio every 30s
setInterval(updatePortfolio, 30000);
