const { ethers } = require('ethers');
const { ExchangeOrderBuilder, Side: UtilsSide, getContracts } = require('@polymarket/order-utils');
const axios = require('axios');
const config = require('./config');
const { getClient, getWallet } = require('./client');

const EXCHANGE_ADDRESS = getContracts(config.CHAIN_ID).Exchange;

/**
 * Build, sign, and POST an order manually (bypassing SDK's broken amount calc).
 */
async function placeOrder(tokenId, amount, price) {
  const logs = [];
  const client = getClient();
  const wallet = getWallet();
  if (!client || !wallet) {
    logs.push('ERROR: Client not initialized');
    return { order: null, response: null, error: 'Client not initialized', logs };
  }

  // Clamp price to valid range (0.01–0.99)
  const clampedPrice = Math.min(0.99, Math.max(0.01, Math.round(price * 100) / 100));

  // Compute amounts matching Polymarket UI format:
  //   makerAmount = whole cents (2 USDC decimals, divisible by 10000 atomic)
  //   takerAmount = up to 4 decimal tokens (divisible by 100 atomic)
  const dollarAmount = parseFloat(amount);
  const makerAmount = String(Math.round(dollarAmount * 100) * 10000);
  const rawTaker = dollarAmount / clampedPrice;
  const takerAmount = String(Math.round(rawTaker * 10000) * 100);

  try {
    logs.push(`BUY $${dollarAmount} @ ${clampedPrice} | maker=${makerAmount} taker=${takerAmount}`);

    const orderBuilder = new ExchangeOrderBuilder(EXCHANGE_ADDRESS, config.CHAIN_ID, wallet);
    const order = await orderBuilder.buildSignedOrder({
      maker: config.PROXY_WALLET,
      taker: '0x0000000000000000000000000000000000000000',
      tokenId,
      makerAmount,
      takerAmount,
      side: UtilsSide.BUY,
      feeRateBps: '1000',
      nonce: '0',
      signer: wallet.address,
      expiration: '0',
      signatureType: 1
    });

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
        signature: order.signature
      },
      owner: client.creds?.key || '',
      orderType: 'FAK'
    };

    const { createL2Headers } = require('@polymarket/clob-client/dist/headers');
    const headers = await createL2Headers(wallet, client.creds, {
      method: 'POST',
      requestPath: '/order',
      body: JSON.stringify(payload)
    });

    const resp = await axios.post(`${config.CLOB_HOST}/order`, payload, { headers });
    const response = resp.data;
    logs.push('Response: ' + JSON.stringify(response));

    if (response?.error) {
      logs.push('Order error: ' + response.error);
      return { order, response, error: response.error, logs };
    }
    if (response?.success === false || response?.errorMsg) {
      const reason = response.errorMsg || 'unknown';
      if (reason) {
        logs.push('Order note: ' + reason);
      }
    }

    return { order, response, error: null, logs };
  } catch (error) {
    const apiError = error.response?.data?.error || error.response?.data?.errorMsg;
    logs.push('Order failed: ' + (apiError || error.message));
    if (error.response?.data) {
      logs.push('API response: ' + JSON.stringify(error.response.data));
    }
    return { order: null, response: null, error: apiError || error.message, logs };
  }
}

/**
 * Build, sign, and POST a GTC (resting) limit order.
 * Same as placeOrder() but with orderType 'GTC' instead of 'FAK'.
 * Returns the order ID from the response for later cancellation/polling.
 */
async function placeGTCOrder(tokenId, amount, price) {
  const logs = [];
  const client = getClient();
  const wallet = getWallet();
  if (!client || !wallet) {
    logs.push('ERROR: Client not initialized');
    return { orderID: null, error: 'Client not initialized', logs };
  }

  const clampedPrice = Math.min(0.99, Math.max(0.01, Math.round(price * 100) / 100));

  const dollarAmount = parseFloat(amount);
  const makerAmount = String(Math.round(dollarAmount * 100) * 10000);
  const rawTaker = dollarAmount / clampedPrice;
  const takerAmount = String(Math.round(rawTaker * 10000) * 100);

  try {
    logs.push(`GTC BUY $${dollarAmount} @ ${clampedPrice} | maker=${makerAmount} taker=${takerAmount}`);

    const orderBuilder = new ExchangeOrderBuilder(EXCHANGE_ADDRESS, config.CHAIN_ID, wallet);
    const order = await orderBuilder.buildSignedOrder({
      maker: config.PROXY_WALLET,
      taker: '0x0000000000000000000000000000000000000000',
      tokenId,
      makerAmount,
      takerAmount,
      side: UtilsSide.BUY,
      feeRateBps: '1000',
      nonce: '0',
      signer: wallet.address,
      expiration: '0',
      signatureType: 1
    });

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
        signature: order.signature
      },
      owner: client.creds?.key || '',
      orderType: 'GTC'
    };

    const { createL2Headers } = require('@polymarket/clob-client/dist/headers');
    const headers = await createL2Headers(wallet, client.creds, {
      method: 'POST',
      requestPath: '/order',
      body: JSON.stringify(payload)
    });

    const resp = await axios.post(`${config.CLOB_HOST}/order`, payload, { headers });
    const response = resp.data;
    logs.push('Response: ' + JSON.stringify(response));

    if (response?.error) {
      logs.push('GTC order error: ' + response.error);
      return { orderID: null, error: response.error, logs };
    }

    const orderID = response?.orderID || response?.id || null;
    logs.push('Order ID: ' + orderID);

    return { orderID, error: null, logs };
  } catch (error) {
    const apiError = error.response?.data?.error || error.response?.data?.errorMsg;
    logs.push('GTC order failed: ' + (apiError || error.message));
    if (error.response?.data) {
      logs.push('API response: ' + JSON.stringify(error.response.data));
    }
    return { orderID: null, error: apiError || error.message, logs };
  }
}

/**
 * Cancel a resting order by its order ID.
 */
async function cancelOrder(orderID) {
  const logs = [];
  const client = getClient();
  const wallet = getWallet();
  if (!client || !wallet) {
    logs.push('ERROR: Client not initialized');
    return { success: false, error: 'Client not initialized', logs };
  }

  try {
    logs.push(`Cancelling order ${orderID}`);

    const { createL2Headers } = require('@polymarket/clob-client/dist/headers');
    const body = JSON.stringify({ orderID });
    const headers = await createL2Headers(wallet, client.creds, {
      method: 'DELETE',
      requestPath: '/order',
      body
    });

    const resp = await axios.delete(`${config.CLOB_HOST}/order`, {
      data: { orderID },
      headers
    });
    logs.push('Cancel response: ' + JSON.stringify(resp.data));

    return { success: true, error: null, logs };
  } catch (error) {
    const apiError = error.response?.data?.error || error.response?.data?.errorMsg;
    logs.push('Cancel failed: ' + (apiError || error.message));
    return { success: false, error: apiError || error.message, logs };
  }
}

/**
 * Fetch the status of an order by its ID.
 */
async function getOrderStatus(orderID) {
  try {
    const resp = await axios.get(`${config.CLOB_HOST}/data/order/${orderID}`, { timeout: 10000 });
    return resp.data;
  } catch (error) {
    return null;
  }
}

/**
 * Build, sign, and POST a SELL order (to exit a position).
 */
async function placeSellOrder(tokenId, tokenAmount, price) {
  const logs = [];
  const client = getClient();
  const wallet = getWallet();
  if (!client || !wallet) {
    logs.push('ERROR: Client not initialized');
    return { order: null, response: null, error: 'Client not initialized', logs };
  }

  const clampedPrice = Math.min(0.99, Math.max(0.01, Math.round(price * 100) / 100));

  // SELL side: makerAmount = tokens to sell (max 2 decimals), takerAmount = USDC to receive (max 4 decimals)
  const roundedTokens = Math.floor(tokenAmount * 100) / 100; // floor to 2 decimals to avoid over-selling
  const makerAmount = String(Math.round(roundedTokens * 100) * 10000);
  const rawTaker = roundedTokens * clampedPrice;
  const takerAmount = String(Math.round(rawTaker * 10000) * 100);

  try {
    logs.push(`SELL ${tokenAmount.toFixed(4)} tokens @ ${clampedPrice} | maker=${makerAmount} taker=${takerAmount}`);

    const orderBuilder = new ExchangeOrderBuilder(EXCHANGE_ADDRESS, config.CHAIN_ID, wallet);
    const order = await orderBuilder.buildSignedOrder({
      maker: config.PROXY_WALLET,
      taker: '0x0000000000000000000000000000000000000000',
      tokenId,
      makerAmount,
      takerAmount,
      side: UtilsSide.SELL,
      feeRateBps: '1000',
      nonce: '0',
      signer: wallet.address,
      expiration: '0',
      signatureType: 1
    });

    const payload = {
      order: {
        salt: parseInt(order.salt),
        maker: order.maker,
        signer: order.signer,
        taker: order.taker,
        tokenId: order.tokenId,
        makerAmount: order.makerAmount,
        takerAmount: order.takerAmount,
        side: 'SELL',
        expiration: order.expiration,
        nonce: order.nonce,
        feeRateBps: order.feeRateBps,
        signatureType: order.signatureType,
        signature: order.signature
      },
      owner: client.creds?.key || '',
      orderType: 'FAK'
    };

    const { createL2Headers } = require('@polymarket/clob-client/dist/headers');
    const headers = await createL2Headers(wallet, client.creds, {
      method: 'POST',
      requestPath: '/order',
      body: JSON.stringify(payload)
    });

    const resp = await axios.post(`${config.CLOB_HOST}/order`, payload, { headers });
    const response = resp.data;
    logs.push('Response: ' + JSON.stringify(response));

    if (response?.error) {
      logs.push('Sell order error: ' + response.error);
      return { order, response, error: response.error, logs };
    }
    if (response?.success === false || response?.errorMsg) {
      const reason = response.errorMsg || 'unknown';
      logs.push('Sell order failed: ' + reason);
      return { order, response, error: reason, logs };
    }

    return { order, response, error: null, logs };
  } catch (error) {
    const apiError = error.response?.data?.error || error.response?.data?.errorMsg;
    logs.push('Sell order failed: ' + (apiError || error.message));
    if (error.response?.data) {
      logs.push('API response: ' + JSON.stringify(error.response.data));
    }
    return { order: null, response: null, error: apiError || error.message, logs };
  }
}

/**
 * Execute a stop-loss sell on a position.
 */
async function executeStopLoss(market, direction, tokenAmount, price) {
  const tokenId = direction === 'UP' ? market.tokens[0] : market.tokens[1];
  const logs = [];

  logs.push(`STOP LOSS SELL: ${market.title}`);
  logs.push(`  Direction: ${direction}`);
  logs.push(`  Tokens: ${tokenAmount.toFixed(4)}`);
  logs.push(`  Price: ${price}`);

  const result = await placeSellOrder(tokenId, tokenAmount, price);
  logs.push(...result.logs);

  return {
    success: !result.error,
    market: market.title,
    direction,
    tokenAmount,
    order: result.order,
    response: result.response,
    error: result.error,
    logs
  };
}

/**
 * Execute a snipe trade on a market.
 */
async function executeSnipe(market, direction, price) {
  const tokenId = direction === 'UP' ? market.tokens[0] : market.tokens[1];
  const logs = [];

  logs.push(`SNIPING: ${market.title}`);
  logs.push(`  Direction: ${direction}`);
  logs.push(`  Amount: $${config.BET_AMOUNT_USD}`);
  logs.push(`  Price: ${price}`);

  const result = await placeOrder(tokenId, config.BET_AMOUNT_USD, price);
  logs.push(...result.logs);

  if (result.error) {
    return {
      success: false,
      market: market.title,
      direction,
      amount: config.BET_AMOUNT_USD,
      order: result.order,
      response: result.response,
      error: result.error,
      logs
    };
  }

  return {
    success: true,
    market: market.title,
    direction,
    amount: config.BET_AMOUNT_USD,
    order: result.order,
    response: result.response,
    error: null,
    logs
  };
}

module.exports = {
  placeOrder,
  executeSnipe,
  executeStopLoss,
  placeSellOrder,
  placeGTCOrder,
  cancelOrder,
  getOrderStatus
};
