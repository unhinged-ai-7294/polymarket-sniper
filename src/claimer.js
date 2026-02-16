#!/usr/bin/env node
/**
 * Gasless auto-claimer using Polymarket's relayer-v2 API.
 * No gas fees, no MATIC needed — the relayer pays gas.
 *
 * Flow:
 *   1. Fetch redeemable positions from data-api
 *   2. Get relay address + nonce from relayer
 *   3. Build batch redeemPositions calldata
 *   4. Sign relay message (GSNv1 format)
 *   5. Submit to relayer (gasless)
 *   6. Poll for confirmation
 *
 * Usage: node src/claimer.js
 */
require('dotenv').config();
const crypto = require('crypto');
const { ethers } = require('ethers');
const axios = require('axios');
const config = require('./config');

// Wallet config
const SIGNER_KEY = config.PRIVATE_KEY;
const PROXY_WALLET = config.PROXY_WALLET;

// Builder API credentials (for relayer auth)
const BUILDER_API_KEY = config.BUILDER_API_KEY;
const BUILDER_SECRET = config.BUILDER_SECRET;
const BUILDER_PASSPHRASE = config.BUILDER_PASSPHRASE;

// API endpoints
const RELAYER_URL = 'https://relayer-v2.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';

// Contract addresses (Polygon)
const PROXY_FACTORY = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052';
const RELAY_HUB = '0xD216153c06E857cD7f72665E0aF1d7D82172F494';
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const COLLATERAL = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e

// ABIs (only the functions we need)
const CTF_ABI = [
  'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
];
const PROXY_ABI = [
  'function proxy((uint8,address,uint256,bytes)[] calls)',
];

const CHECK_INTERVAL = 60_000;  // check every 60s
const POLL_INTERVAL = 3_000;    // poll tx status every 3s
const POLL_TIMEOUT = 120_000;   // give up after 2 min

function log(msg) {
  console.log(`[${new Date().toISOString()}] [claimer] ${msg}`);
}

/* ── 1. Fetch redeemable positions ────────────────────────────── */

async function getRedeemablePositions() {
  try {
    const { data } = await axios.get(`${DATA_API}/positions`, {
      params: { user: PROXY_WALLET },
      timeout: 10_000,
    });
    return (data || []).filter(p => p.redeemable);
  } catch (err) {
    log('Error fetching positions: ' + err.message);
    return [];
  }
}

/* ── 2. Get relay address + nonce ─────────────────────────────── */

async function getRelayPayload(signerAddress) {
  const { data } = await axios.get(`${RELAYER_URL}/relay-payload`, {
    params: { address: signerAddress, type: 'PROXY' },
    timeout: 10_000,
  });
  return data; // { address: "0x…", nonce: "38" }
}

/* ── 3. Build batch redeemPositions calldata ───────────────────── */

function buildClaimData(conditionIds) {
  const ctfIface = new ethers.utils.Interface(CTF_ABI);
  const proxyIface = new ethers.utils.Interface(PROXY_ABI);

  const calls = conditionIds.map(conditionId => {
    const callData = ctfIface.encodeFunctionData('redeemPositions', [
      COLLATERAL,
      ethers.constants.HashZero,
      conditionId,
      [1, 2], // binary market index sets
    ]);
    return [
      1,            // callType 1 = DELEGATECALL
      CTF_ADDRESS,  // target = CTF contract
      0,            // value = 0
      callData,
    ];
  });

  return proxyIface.encodeFunctionData('proxy', [calls]);
}

/* ── 4. Sign relay message (GSNv1 format) ─────────────────────── */

async function signRelayMessage(wallet, params) {
  const { relay, from, to, data, fee, gasPrice, gasLimit, nonce, relayHub } = params;

  // GSNv1 hash:
  //   keccak256(abi.encodePacked(
  //     "rlx:", from, to, encodedFunction,
  //     txFee, gasPrice, gasLimit, nonce,
  //     relayHub, relay
  //   ))
  const hash = ethers.utils.solidityKeccak256(
    ['string', 'address', 'address', 'bytes', 'uint256', 'uint256', 'uint256', 'uint256', 'address', 'address'],
    ['rlx:',    from,      to,        data,    fee,       gasPrice,  gasLimit,  nonce,     relayHub,  relay],
  );

  // eth_sign: prefixes with "\x19Ethereum Signed Message:\n32"
  return wallet.signMessage(ethers.utils.arrayify(hash));
}

/* ── 5. Submit to relayer (with Builder HMAC auth) ────────────── */

function buildHmacSignature(secret, timestamp, method, requestPath, body) {
  let message = timestamp + method + requestPath;
  if (body !== undefined) message += body;
  const base64Secret = Buffer.from(secret, 'base64');
  const hmac = crypto.createHmac('sha256', base64Secret);
  const sig = hmac.update(message).digest('base64');
  return sig.replace(/\+/g, '-').replace(/\//g, '_');
}

function getBuilderAuthHeaders(method, path, body) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = buildHmacSignature(BUILDER_SECRET, timestamp, method, path, body);
  return {
    'POLY_BUILDER_API_KEY': BUILDER_API_KEY,
    'POLY_BUILDER_TIMESTAMP': String(timestamp),
    'POLY_BUILDER_PASSPHRASE': BUILDER_PASSPHRASE,
    'POLY_BUILDER_SIGNATURE': signature,
  };
}

async function submitRelay(payload) {
  const body = JSON.stringify(payload);
  const authHeaders = getBuilderAuthHeaders('POST', '/submit', body);
  const { data } = await axios.post(`${RELAYER_URL}/submit`, body, {
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    timeout: 30_000,
  });
  return data; // { transactionID, transactionHash, state }
}

/* ── 6. Poll for confirmation ─────────────────────────────────── */

async function pollTransaction(txId) {
  const deadline = Date.now() + POLL_TIMEOUT;

  while (Date.now() < deadline) {
    try {
      const { data } = await axios.get(`${RELAYER_URL}/transaction`, {
        params: { id: txId },
        timeout: 10_000,
      });

      const tx = Array.isArray(data) ? data[0] : data;

      if (tx.state === 'STATE_EXECUTED') return tx;
      if (tx.state === 'STATE_FAILED' || tx.state === 'STATE_REVERTED') {
        throw new Error(`Transaction ${tx.state}`);
      }

      log(`  Status: ${tx.state} — waiting…`);
    } catch (err) {
      if (err.message.startsWith('Transaction STATE_')) throw err;
      log(`  Poll error: ${err.message}`);
    }

    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  throw new Error('Transaction polling timed out after 2 min');
}

/* ── Orchestration ────────────────────────────────────────────── */

async function claimPositions(positions) {
  const wallet = new ethers.Wallet(SIGNER_KEY);
  const signerAddress = wallet.address;

  // Deduplicate condition IDs
  const conditionIds = [...new Set(positions.map(p => p.conditionId || p.condition_id))];

  log(`Claiming ${conditionIds.length} resolved market(s) via gasless relay…`);
  for (const cid of conditionIds) {
    const pos = positions.filter(p => (p.conditionId || p.condition_id) === cid);
    log(`  ${cid.slice(0, 10)}… — ${pos.map(p => p.outcome + ' (' + p.size + ')').join(', ')}`);
  }

  try {
    // 1. Get relay payload
    const relayPayload = await getRelayPayload(signerAddress);
    log(`  Relay: ${relayPayload.address} | Nonce: ${relayPayload.nonce}`);

    // 2. Build calldata
    const data = buildClaimData(conditionIds);

    // 3. Gas limit (~120k per condition observed, use 150k + overhead for safety)
    const gasLimit = 150_000 * conditionIds.length + 50_000;

    // 4. Sign
    const signature = await signRelayMessage(wallet, {
      relay: relayPayload.address,
      from: signerAddress,
      to: PROXY_FACTORY,
      data,
      fee: 0,
      gasPrice: 0,
      gasLimit,
      nonce: parseInt(relayPayload.nonce),
      relayHub: RELAY_HUB,
    });
    log(`  Signature: ${signature.slice(0, 20)}…`);

    // 5. Submit
    const result = await submitRelay({
      from: signerAddress,
      to: PROXY_FACTORY,
      proxyWallet: PROXY_WALLET,
      data,
      nonce: relayPayload.nonce,
      signature,
      signatureParams: {
        gasPrice: '0',
        gasLimit: gasLimit.toString(),
        relayerFee: '0',
        relayHub: RELAY_HUB,
        relay: relayPayload.address,
      },
      type: 'PROXY',
      metadata: '',
    });

    log(`  TX submitted: ${result.transactionID}`);
    log(`  TX hash: ${result.transactionHash}`);

    // 6. Poll for confirmation
    const confirmed = await pollTransaction(result.transactionID);
    log(`  CLAIMED! Hash: ${confirmed.transactionHash} | State: ${confirmed.state}`);
    if (confirmed.derivedMetadata) {
      log(`  Type: ${confirmed.derivedMetadata.txnType} | Ops: ${confirmed.derivedMetadata.operationCount}`);
    }
    return true;
  } catch (err) {
    log('Claim failed: ' + err.message);
    return false;
  }
}

async function checkAndClaim() {
  const positions = await getRedeemablePositions();

  if (positions.length === 0) return;

  log(`Found ${positions.length} redeemable position(s):`);
  for (const p of positions) {
    log(`  ${p.title || p.market_slug} — ${p.outcome} (${p.size} tokens)`);
  }

  await claimPositions(positions);
}

/* ── Entry point ──────────────────────────────────────────────── */

async function main() {
  if (!BUILDER_API_KEY || !BUILDER_SECRET || !BUILDER_PASSPHRASE) {
    console.error('Missing BUILDER_API_KEY, BUILDER_SECRET, or BUILDER_PASSPHRASE in .env');
    console.error('Create them at https://polymarket.com/settings?tab=builder');
    process.exit(1);
  }

  const wallet = new ethers.Wallet(SIGNER_KEY);
  log('Gasless auto-claimer started');
  log(`Signer:       ${wallet.address}`);
  log(`Proxy wallet: ${PROXY_WALLET}`);
  log(`Builder key:  ${BUILDER_API_KEY}`);
  log(`Checking every ${CHECK_INTERVAL / 1000}s`);

  // Run immediately, then on interval
  await checkAndClaim();
  setInterval(checkAndClaim, CHECK_INTERVAL);
}

process.on('SIGINT', () => {
  log('Shutting down');
  process.exit(0);
});

main().catch(err => {
  console.error('Claimer error:', err);
  process.exit(1);
});
