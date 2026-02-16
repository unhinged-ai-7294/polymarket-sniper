#!/usr/bin/env node
// Debug wallet setup - find proxy wallet and check balance
require('dotenv').config();
const { ClobClient } = require('@polymarket/clob-client');
const { ethers } = require('ethers');
const axios = require('axios');

async function main() {
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY);
  console.log('EOA signer address:', wallet.address);

  // Try both signature types
  for (const sigType of [0, 1, 2]) {
    const label = ['EOA', 'POLY_PROXY', 'POLY_GNOSIS_SAFE'][sigType];
    console.log(`\n=== Trying signature type ${sigType} (${label}) ===`);

    try {
      const tempClient = new ClobClient('https://clob.polymarket.com', 137, wallet);
      const creds = await tempClient.deriveApiKey();
      console.log('API key:', creds.apiKey?.slice(0, 20) + '...');

      const client = new ClobClient(
        'https://clob.polymarket.com', 137, wallet, creds, sigType
      );

      const bal = await client.getBalanceAllowance({ asset_type: 'COLLATERAL' });
      console.log('Balance:', bal.balance);
      console.log('Allowances:', JSON.stringify(bal.allowances));
    } catch (e) {
      console.log('Error:', e.response?.data || e.message);
    }
  }

  // Check on-chain USDC balance of EOA directly
  console.log('\n=== On-chain check ===');
  const provider = new ethers.providers.JsonRpcProvider('https://polygon-rpc.com');
  const usdcAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC on Polygon
  const usdc = new ethers.Contract(usdcAddress, [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)'
  ], provider);

  const eoaBal = await usdc.balanceOf(wallet.address);
  console.log('EOA USDC balance:', ethers.utils.formatUnits(eoaBal, 6));

  // Also check USDCe (native USDC on Polygon)
  const usdceAddress = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
  const usdce = new ethers.Contract(usdceAddress, [
    'function balanceOf(address) view returns (uint256)'
  ], provider);
  const usdceBal = await usdce.balanceOf(wallet.address);
  console.log('EOA USDC.e balance:', ethers.utils.formatUnits(usdceBal, 6));

  // MATIC balance
  const maticBal = await provider.getBalance(wallet.address);
  console.log('EOA MATIC balance:', ethers.utils.formatEther(maticBal));

  // Try to find proxy wallet via polygonscan
  console.log('\n=== Looking for proxy wallet ===');
  // Polymarket proxy factory on Polygon
  // Try deriving proxy address via the factory contract
  const proxyFactory = '0xaB45c5A2B4f997f41cC14B840bfBB01C1f526C1C'; // known Polymarket proxy factory
  const factory = new ethers.Contract(proxyFactory, [
    'function getProxy(address) view returns (address)',
    'function proxies(address) view returns (address)'
  ], provider);

  try {
    const proxy = await factory.getProxy(wallet.address);
    console.log('Proxy wallet (getProxy):', proxy);
    if (proxy !== ethers.constants.AddressZero) {
      const proxyBal = await usdc.balanceOf(proxy);
      console.log('Proxy USDC balance:', ethers.utils.formatUnits(proxyBal, 6));
      const proxyBalE = await usdce.balanceOf(proxy);
      console.log('Proxy USDC.e balance:', ethers.utils.formatUnits(proxyBalE, 6));
    }
  } catch (e) {
    console.log('getProxy failed:', e.reason || e.message);
    try {
      const proxy = await factory.proxies(wallet.address);
      console.log('Proxy wallet (proxies mapping):', proxy);
    } catch (e2) {
      console.log('proxies failed:', e2.reason || e2.message);
    }
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
