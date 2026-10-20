# Going live

Three steps: run it on a server, prove it on the Trading 212 **practice** account, then switch to real money. Don't skip step 2: it is the only way to check that orders, fills and stop-losses work end to end with the real broker.

The most you can lose is what's in the trading account. A Trading 212 Invest or Stocks ISA account has no margin, and the app only buys ETFs with cash. Put only the money you're prepared to lose in that account.

## How it trades

- **Prices:** end-of-day closing prices for 9 liquid London-listed ETFs (Alpha Vantage). A fund isn't traded if its prices are more than one session old, outside a sensible range, or disagree with Trading 212's own price.
- **When:** new buys only on LSE trading days, 08:15–16:00 UK time. A scan runs every 10 minutes.
- **Buys:** limit orders at last close + 0.5%, valid for the day. The app never pays more than the limit. If the price runs away, the order expires unfilled.
- **Stop-loss:** as soon as a buy fills, a stop-loss order is placed **at Trading 212**, so it works even if the server is down. If it ever goes missing, the app places a new one and notifies you.
- **Take-profit:** when Trading 212's price reaches the target, the app cancels the stop and sells.
- **Your approval:** every trade waits for you unless you turn on **auto mode** (Risk tab, type AUTO). Auto mode uses exactly the same risk checks.
- **Limits:** £0.50 max loss per trade, £12.50 per position, 3 positions, 3 new trades a day, £1.50 daily loss limit, £50 total invested, emergency stop if the account falls to £45.
- **Never:** leverage, shorting, CFDs, non-GBP funds, market-order buys.

Stops are market orders when triggered. A big overnight gap can make a loss larger than planned.

## 1. Server

Use a small always-on server (about £3–5/month), or your own computer if you only want it trading while that's on.

```bash
git clone <this repo> && cd 01/ai-trading-copilot
cp .env.example .env      # then edit .env on the server
docker build -t copilot .
docker run -d --name copilot -p 127.0.0.1:8787:8787 -v copilot-data:/data --env-file .env --restart unless-stopped copilot
```

Put HTTPS in front (e.g. Caddy) and open the address on your iPhone → Share → Add to Home Screen.

## 2. Practice account (a few trading days)

1. In the Trading 212 app, switch to your **practice** account and generate an API key in its settings. Give it only these permissions: account, portfolio, orders:read, orders:execute, history:orders, metadata. Restrict it to your server's IP.
2. Get a free Alpha Vantage key.
3. Set up notifications: install **ntfy**, subscribe to a long random topic, and put `https://ntfy.sh/<topic>` in `NTFY_URL`.
4. In `.env` set:
   ```
   TRADING_MODE=paper
   APP_ACCESS_TOKEN=<openssl rand -base64 32>
   ALPHAVANTAGE_API_KEY=...
   T212_DEMO_API_KEY=...
   T212_DEMO_API_SECRET=...
   NTFY_URL=https://ntfy.sh/<your topic>
   ```
5. Restart. The log lists each ETF matched at Trading 212, with its ticker and whether it's priced in pounds or pence.
6. Check, over a few days:
   - [ ] The app shows the practice account's real cash and value.
   - [ ] An approved buy appears in Trading 212 as a limit order, then fills.
   - [ ] A **stop order** appears in Trading 212 straight after the fill.
   - [ ] Closing a position from the app cancels the stop and sells.
   - [ ] Notifications arrive on your phone.
   - [ ] The emergency stop cancels a pending buy.
   - [ ] Auto mode places a trade on its own when you turn it on.

## 3. Real money

1. In the Trading 212 app, on your **real** Invest or ISA account, generate a key with the same limited permissions and IP restriction.
2. Fund the account with the amount you're prepared to lose (e.g. £50).
3. In `.env`, remove the practice keys and set:
   ```
   TRADING_MODE=live
   T212_LIVE_API_KEY=...
   T212_LIVE_API_SECRET=...
   LIVE_TRADING_ACK=I accept that this trades real money
   ```
4. Restart. The app shows a red **LIVE · REAL MONEY** badge. Every trade still needs your approval until you turn on auto mode.

**To stop everything:** tap Emergency stop in the app. It cancels pending buys, but stop-losses stay in place. To shut down completely, stop the server and revoke the API key in Trading 212.

## What the server refuses to do

- Start live mode without live keys, the exact acknowledgement sentence and an access token.
- Start any non-live mode while real-money keys are present.
- Trade a fund it couldn't match at Trading 212, or that isn't priced in GBP or pence.
- Buy before it has synced the account, outside market hours, on stale or implausible prices, or beyond any limit.
- Resend an order after a timeout. It looks the order up at the broker instead, because Trading 212's order endpoints aren't idempotent.
