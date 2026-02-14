# Polymarket Sniper Bot 🎯

Automated trading bot for Polymarket crypto up/down markets (BTC/ETH 5-min and 15-min).

## Strategy

The bot monitors BTC and ETH up/down markets and places bets in the final seconds when the outcome direction becomes highly predictable (>80% confidence based on market odds).

## Setup

1. Clone the repo
2. Copy `.env.example` to `.env`
3. Add your Polymarket private key (export from https://reveal.magic.link/polymarket)
4. Install dependencies: `npm install`
5. Run: `npm start`

## Configuration (.env)

```env
PRIVATE_KEY=0x...your_private_key
BET_AMOUNT_USD=2
MIN_CONFIDENCE=0.80
SNIPE_SECONDS=30
```

## How it works

1. Scans Polymarket for active BTC/ETH 5-min and 15-min up/down markets
2. Monitors markets approaching resolution (<5 minutes remaining)
3. In the final 30 seconds, checks if market odds show >80% confidence
4. If confidence threshold met, places a market buy order
5. Repeats every 10 seconds

## ⚠️ Disclaimer

- Trading involves risk. Only use funds you can afford to lose.
- Past performance does not guarantee future results.
- This bot is for educational purposes.

## License

MIT
