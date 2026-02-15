require('dotenv').config();

module.exports = {
  // Polymarket endpoints
  CLOB_HOST: 'https://clob.polymarket.com',
  GAMMA_HOST: 'https://gamma-api.polymarket.com',
  WSS_HOST: 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  
  // Chain config (Polygon)
  CHAIN_ID: 137,
  
  // Wallet
  PRIVATE_KEY: process.env.PRIVATE_KEY,
  
  // Trading parameters
  BET_AMOUNT_USD: parseFloat(process.env.BET_AMOUNT_USD) || 2,
  MIN_CONFIDENCE: parseFloat(process.env.MIN_CONFIDENCE) || 0.60,
  MAX_CONFIDENCE: parseFloat(process.env.MAX_CONFIDENCE) || 0.85,
  SNIPE_SECONDS: parseInt(process.env.SNIPE_SECONDS) || 30,
  
  // Market filters - BTC and ETH 5-min and 15-min markets
  MARKET_FILTERS: [
    'btc-updown-5m',
    'btc-updown-15m',
    'eth-updown-5m', 
    'eth-updown-15m'
  ],
  
  // Telegram (optional)
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  TELEGRAM_TOPIC_ID: process.env.TELEGRAM_TOPIC_ID
};
