const { ClobClient } = require('@polymarket/clob-client');
const { ethers } = require('ethers');
const config = require('./config');

let clobClient = null;
let wallet = null;

async function initializeClient() {
  if (clobClient) return clobClient;
  
  console.log('🔐 Initializing Polymarket client...');
  
  // Create wallet from private key
  wallet = new ethers.Wallet(config.PRIVATE_KEY);
  console.log(`📍 Wallet address: ${wallet.address}`);
  
  // Initialize CLOB client without auth first to derive credentials
  const tempClient = new ClobClient(config.CLOB_HOST, config.CHAIN_ID, wallet);
  
  // Derive API credentials
  console.log('🔑 Deriving API credentials...');
  const apiCreds = await tempClient.deriveApiKey();
  console.log('✅ API credentials derived');
  
  // Reinitialize with full auth
  // Signature type 1 = POLY_PROXY (Google/email login)
  const funder = config.PROXY_WALLET || wallet.address;
  console.log(`Proxy wallet: ${funder}`);
  clobClient = new ClobClient(
    config.CLOB_HOST,
    config.CHAIN_ID,
    wallet,
    apiCreds,
    1, // POLY_PROXY signature type
    funder
  );
  
  console.log('✅ Client initialized successfully');
  return clobClient;
}

function getWallet() {
  return wallet;
}

function getClient() {
  return clobClient;
}

module.exports = {
  initializeClient,
  getWallet,
  getClient
};
