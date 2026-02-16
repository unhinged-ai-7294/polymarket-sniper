#!/usr/bin/env node
// Test: Build order manually with correct amounts, sign, and POST
require('dotenv').config();
const { ethers } = require('ethers');
const { ExchangeOrderBuilder, Side: UtilsSide } = require('@polymarket/order-utils');
const { initializeClient, getClient } = require('./src/client');
const { fetchCurrentMarket } = require('./src/markets');
const axios = require('axios');

const PROXY_WALLET = process.env.PROXY_WALLET;
const EXCHANGE_ADDRESS = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

async function main() {
  console.log('=== MANUAL ORDER TEST ===\n');

  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
  console.log('Signer (EOA):', wallet.address);
  console.log('Maker (proxy):', PROXY_WALLET);

  // Init client just for auth headers
  await initializeClient();
  const client = getClient();

  // Check balance
  const bal = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
  console.log('CLOB Balance:', bal.balance);

  // Get market
  const market = await fetchCurrentMarket();
  if (!market) { console.log('No market'); process.exit(1); }
  console.log('\nMarket:', market.title);
  console.log('UP token:', market.tokens[0].slice(0, 20) + '...');

  const tokenId = market.tokens[0]; // Buy UP

  // Get orderbook to find best ask
  const book = await client.getOrderBook(tokenId);
  const bestAsk = book.asks?.[book.asks.length - 1]; // lowest ask
  console.log('Best ask:', JSON.stringify(bestAsk));

  // --- Build order manually (matching UI format exactly) ---
  const price = 0.99;
  const dollarAmount = 1; // $1

  // makerAmount = round to whole cents (2 USDC decimals = divisible by 10000 in atomic)
  const makerAmount = String(Math.round(dollarAmount * 100) * 10000); // $1.00 = "1000000"
  // takerAmount = dollarAmount/price, round to 4 decimals (divisible by 100 in atomic)
  const rawTaker = dollarAmount / price;
  const takerAmount = String(Math.round(rawTaker * 10000) * 100); // 1.0101 = "1010100"

  console.log(`\nComputed amounts: maker=${makerAmount} taker=${takerAmount}`);
  console.log(`  = $${parseInt(makerAmount)/1e6} USDC for ${parseInt(takerAmount)/1e6} tokens`);
  console.log(`  = effective price ${parseInt(makerAmount)/parseInt(takerAmount)}`);

  // Build and sign order using ExchangeOrderBuilder (must use CTF Exchange for EIP712 domain)
  const orderBuilder = new ExchangeOrderBuilder(EXCHANGE_ADDRESS, 137, wallet);

  const order = await orderBuilder.buildSignedOrder({
    maker: PROXY_WALLET,
    taker: '0x0000000000000000000000000000000000000000',
    tokenId,
    makerAmount,
    takerAmount,
    side: UtilsSide.BUY,
    feeRateBps: '1000',
    nonce: '0',
    signer: wallet.address,
    expiration: '0',
    signatureType: 1 // POLY_PROXY
  });
  const signature = order.signature;

  console.log('\nSigned order:');
  console.log('  maker:', order.maker);
  console.log('  signer:', order.signer);
  console.log('  makerAmount:', order.makerAmount);
  console.log('  takerAmount:', order.takerAmount);
  console.log('  signatureType:', order.signatureType);
  console.log('  feeRateBps:', order.feeRateBps);

  // POST manually (matching UI payload format)
  const payload = {
    order: {
      salt: parseInt(order.salt),
      maker: order.maker,
      signer: order.signer,
      taker: order.taker,
      tokenId: order.tokenId,
      makerAmount: order.makerAmount,
      takerAmount: order.takerAmount,
      side: 'BUY',
      expiration: order.expiration,
      nonce: order.nonce,
      feeRateBps: order.feeRateBps,
      signatureType: order.signatureType,
      signature
    },
    owner: client.creds?.key || '',
    orderType: 'FOK'
  };

  console.log('\nPayload:', JSON.stringify(payload, null, 2));

  // Use client's auth headers
  try {
    const { createL2Headers } = require('@polymarket/clob-client/dist/headers');
    const headerArgs = {
      method: 'POST',
      requestPath: '/order',
      body: JSON.stringify(payload)
    };
    const headers = await createL2Headers(wallet, client.creds, headerArgs);

    const resp = await axios.post('https://clob.polymarket.com/order', payload, { headers });
    console.log('\nResponse:', JSON.stringify(resp.data, null, 2));
    console.log('\n*** SUCCESS ***');
  } catch (err) {
    console.log('\nError:', err.response?.status, JSON.stringify(err.response?.data));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
