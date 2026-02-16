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
  BET_AMOUNT_USD: parseFloat(process.env.BET_AMOUNT_USD) || 1,
  SNIPE_SECONDS: parseInt(process.env.SNIPE_SECONDS) || 30,
  MIN_ODDS: parseFloat(process.env.MIN_ODDS) || 0.85,
  STOP_LOSS_CENTS: parseFloat(process.env.STOP_LOSS_CENTS) || 0.30,

  // Dashboard
  DASHBOARD_PORT: parseInt(process.env.DASHBOARD_PORT) || 3000,

  // Builder API (for gasless relayer)
  BUILDER_API_KEY: process.env.BUILDER_API_KEY,
  BUILDER_SECRET: process.env.BUILDER_SECRET,
  BUILDER_PASSPHRASE: process.env.BUILDER_PASSPHRASE,

  // Telegram (optional)
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  TELEGRAM_TOPIC_ID: process.env.TELEGRAM_TOPIC_ID
};
