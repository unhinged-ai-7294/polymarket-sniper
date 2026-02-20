require('dotenv').config();

module.exports = {
  // Polymarket endpoints
  CLOB_HOST: 'https://clob.polymarket.com',
  GAMMA_HOST: 'https://gamma-api.polymarket.com',
  WSS_MARKET: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  WSS_RTDS: 'wss://ws-live-data.polymarket.com',

  // Chain config (Polygon)
  CHAIN_ID: 137,

  // Wallet
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  PROXY_WALLET: process.env.PROXY_WALLET,

  // Trading parameters
  BET_AMOUNT_USD: parseFloat(process.env.BET_AMOUNT_USD) || 3,
  SNIPE_SECONDS: parseInt(process.env.SNIPE_SECONDS) || 30,
  MIN_ODDS: parseFloat(process.env.MIN_ODDS) || 0.85,
  STOP_LOSS_CENTS: parseFloat(process.env.STOP_LOSS_CENTS) || 0.30,
  LIMIT_PRICE: parseFloat(process.env.LIMIT_PRICE) || 0.70,

  // Dashboard
  DASHBOARD_PORT: parseInt(process.env.DASHBOARD_PORT) || 3000,

  // Builder API (for gasless relayer)
  BUILDER_API_KEY: process.env.BUILDER_API_KEY,
  BUILDER_SECRET: process.env.BUILDER_SECRET,
  BUILDER_PASSPHRASE: process.env.BUILDER_PASSPHRASE,

  // Telegram (optional)
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  TELEGRAM_TOPIC_ID: process.env.TELEGRAM_TOPIC_ID,

  // Arb strategy
  BINANCE_WSS: 'wss://stream.binance.us:9443/ws/btcusdt@bookTicker',
  DIVERGENCE_THRESHOLD: parseFloat(process.env.DIVERGENCE_THRESHOLD) || 0.08,
  MODEL_K_BASE: parseFloat(process.env.MODEL_K_BASE) || 4.76,
  ARB_BET_AMOUNT_USD: parseFloat(process.env.ARB_BET_AMOUNT_USD) || 1,
  ARB_STOP_LOSS_CENTS: parseFloat(process.env.ARB_STOP_LOSS_CENTS) || 0.10,
  ARB_SLIPPAGE: parseFloat(process.env.ARB_SLIPPAGE) || 0.03,
  ARB_PROFIT_CAPTURE: parseFloat(process.env.ARB_PROFIT_CAPTURE) || 0.60,
  ARB_COOLDOWN_MS: parseInt(process.env.ARB_COOLDOWN_MS) || 3000,
  ARB_MIN_SECS_LEFT: parseInt(process.env.ARB_MIN_SECS_LEFT) || 15,
  MAX_CONCURRENT_POSITIONS: parseInt(process.env.MAX_CONCURRENT_POSITIONS) || 3,
  MAX_TRADES_PER_CYCLE: parseInt(process.env.MAX_TRADES_PER_CYCLE) || 5
};
