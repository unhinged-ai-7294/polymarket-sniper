# Polymarket Sniper Bot 🎯

Automated trading bot for Polymarket crypto up/down markets (BTC/ETH 5-min and 15-min).

## Strategy

The bot trades Polymarket BTC 5-minute up/down markets using a 3-layer system. Each layer is additive — they all run together and whichever triggers first places the bet.

### Layer 1: Early Entry (T-240 to T-30)

If the market odds surge to 94%+ for one side and **stay there** for 3 consecutive readings (~6 seconds), buy in immediately. The logic: when odds are already that decisive early on, the market has made up its mind. If you wait for the normal checkpoints at T-30, there'll be no liquidity left — everyone will have already bought in.

### Layer 2: Checkpoint Snipe (T-30 / T-20 / T-10)

The core strategy. At each checkpoint, check if the leading side's odds meet the minimum threshold:

- **T-30**: Buy if leader odds are **90%+**
- **T-20**: Buy if leader odds are **87%+**
- **T-10**: Buy if leader odds are **85%+**

If odds aren't high enough at one checkpoint, the bot waits for the next one with a lower threshold.

### Layer 3: Last Resort (T-3 to T-1)

If all checkpoints passed without placing a bet, the bot makes a final play in the last 3 seconds. It looks at two signals (either one is enough to buy):

- **BTC price**: If BTC is $15+ away from the price-to-beat, buy the side the price favors
- **Odds momentum**: If one side's odds surged 15c+ in the last few ticks, buy the surging side

No hard odds threshold — it trusts the price action and momentum to tell it which side to pick.

### Stop Loss

After any trade (from any layer), if the odds drop 30c from the entry price, the bot sells immediately to limit damage.

### Order Execution

All trades use Fill-and-Kill (FAK) orders with escalating slippage steps (3c → 6c → 10c → 14c) and automatic retries.

## Setup

1. Clone the repo
2. Copy `.env.example` to `.env`
3. Add your Polymarket private key (export from https://reveal.magic.link/polymarket)
4. Install dependencies: `npm install`
5. Run: `npm start`

## Configuration (.env)

```env
PRIVATE_KEY=0x...your_private_key
BET_AMOUNT_USD=3
SNIPE_SECONDS=30
MIN_ODDS=0.85
STOP_LOSS_CENTS=0.30
```

## How it works

1. Fetches the current BTC 5-minute up/down market from Polymarket
2. Connects to Chainlink BTC/USD price feed and Polymarket odds via WebSocket
3. Records odds ticks every 2 seconds for momentum detection
4. **Early entry** (T-240 to T-30): buys in if odds are 94%+ and sustained
5. **Checkpoints** (T-30 / T-20 / T-10): buys the leader if odds meet thresholds
6. **Last resort** (T-3 to T-1): if market is undecided, follows price or odds momentum
7. Monitors for stop loss after any trade
8. When market ends, starts a new cycle automatically
9. Records all market data (snapshots, trades, outcomes) for analysis

## ⚠️ Disclaimer

- Trading involves risk. Only use funds you can afford to lose.
- Past performance does not guarantee future results.
- This bot is for educational purposes.

## License

MIT
