# Architecture

AI Trading Copilot is split into small modules with one job each. The rule that holds it together: **nothing that can make a mistake on its own is allowed to place an order.** The strategy only suggests, the AI only explains, the risk engine only checks, and orders go out only after your approval and a second risk check.

## Module map

```
                        ┌──────────────────────────────┐
  iPhone (PWA) ───────▶ │  HTTP API  (src/server/app)  │  bearer token, CSP, no secrets in responses
                        └──────────────┬───────────────┘
                                       │
                        ┌──────────────▼───────────────┐
                        │  CopilotEngine (core/engine)  │  orchestration only
                        └──┬──────┬──────┬──────┬───┬──┘
                           │      │      │      │   │
     ┌─────────────────────▼┐ ┌───▼────┐ │  ┌───▼───▼──────────────┐
     │ Market data          │ │Strategy│ │  │ Risk engine          │
     │ core/marketdata      │ │core/   │ │  │ core/risk            │
     │ (Simulated in Ph. 1) │ │strategy│ │  │ sizing + validateEntry│
     └──────────────────────┘ └────────┘ │  └──────────────────────┘
                                         │
                ┌────────────────────────▼──┐   ┌─────────────────────────────┐
                │ AI explanations (core/ai)  │   │ Execution (core/execution)  │
                │ Claude → template fallback │   │ idempotent ExecutionService │
                │ budget-capped, display-only│   │ → BrokerAdapter             │
                └────────────────────────────┘   └──────┬───────────────┬──────┘
                                                        │               │
                                          SimulatedBroker (Ph. 1)   Trading212DemoBroker
                                                                    (server-only, demo host only,
                                                                     disabled in Ph. 1)

  Portfolio ledger (core/portfolio) · Fee model (core/fees) · Hash-chained audit log (core/audit)
```

`src/core` has no Node or browser dependencies, so the same engine runs on the server and inside the standalone preview build.

## Trade lifecycle

1. **Tick** (every 3s): refresh market data, expire old approvals, check stop-loss/target exits on open positions, check circuit breakers, record equity.
2. **Scan** (every 30s): `evaluateTrend` scores each ETF against six transparent rules. A BUY signal needs all six.
3. **Size**: `sizePosition` works out a fractional quantity so that loss at the stop **plus estimated costs** ≤ £0.50, then caps by the fixed £12.50 max position and by available cash.
4. **Pre-check**: `validateEntry` runs every risk check. If any fails, no proposal is shown; the scanner shows why.
5. **Explain**: Claude (if configured and within budget) or the rules template writes a plain-English explanation. It receives the finished trade and cannot change it.
6. **Propose**: a `PENDING` proposal with an expiry (10 min by default) appears on your phone.
7. **Approve** (press-and-hold): the engine re-runs `validateEntry` with a **fresh quote** and checks the price hasn't moved more than 30bps. Then `ExecutionService` submits exactly one order keyed `entry-<proposalId>`.
8. **Fill**: holdings and cash change only on a confirmed fill. A broker that only *accepts* an order (Trading 212) leaves the proposal `SUBMITTED` until the fill is reconciled.
9. **Exit**: the stop-loss and target are part of the approved plan and run automatically (they only reduce exposure). You can also close manually.

## Safety design

| Requirement | Where it's enforced |
| --- | --- |
| Demo mode only | `loadConfig` refuses `TRADING_MODE≠demo`, any `T212_LIVE_*`/`LIVE_TRADING` variable; risk check `demo_mode`; the T212 client hard-codes the demo host and re-checks it on every request |
| No real prices faked | All quotes carry `source: "SIMULATED"`; UI labels it everywhere; no backfilled performance history |
| No orders fabricated | Simulated fills are flagged `simulated: true`; broker errors are recorded as `ERROR`, never as fills; ACCEPTED ≠ FILLED |
| Approval for every new entry | Only `approve()` creates entry orders; scan never does; approvals expire; press-and-hold UI |
| Independent risk validation | `validateEntry` is a pure function, run at proposal time and again at execution |
| Duplicate protection | One pending proposal per ETF; in-flight lock; idempotency key per proposal; risk check `duplicate`; broker-side pending-order check (T212) |
| Stale data / failed checks stop orders | `data_fresh` check; simulated broker refuses to fill on stale data; exits are skipped on stale data; UI banner |
| No leverage/CFDs/margin | Cash-only sizing; `no_leverage`, `cash`, `long_only` checks; ETF allow-list |
| £0.50 risk per trade | Default and **hard ceiling** in `risk/limits.ts`; `limits_sane` check catches tampering |
| No automatic risk increases | Limits are fixed £ amounts, never derived from equity or the goal. In-app changes are tighten-only; config values are clamped to hard ceilings |
| Emergency stop | Manual button; automatic at the £45 equity floor; cancels pending approvals; release requires typing `RESUME` |
| Credentials server-side | Read from env on the server only; never returned by the API, never bundled; `.env` is git-ignored; logger redacts `Authorization` |
| Audit trail | SHA-256 hash chain (tamper-evident) in state plus an append-only `audit.jsonl` on disk |
| Low operating cost | Claude calls capped per day (count and £); free template fallback; tiny server footprint |

## Choices and trade-offs

- **TypeScript everywhere.** One language for server, UI and the shared engine; strict compiler settings.
- **JSON file storage** with atomic writes. Enough for one user and a few hundred trades; swap `StateStore` for SQLite/Postgres when needed.
- **Polling, not websockets.** The phone polls every 2.5s while visible. Simple and cheap.
- **Fractional quantities.** With £12.50 positions, fractional shares are essential. Trading 212 supports them; quantity precision is per instrument.
- **Strategy is deliberately simple.** It is a transparent baseline, not a promise of returns. Most signals of this type lose small amounts; the risk caps exist for that reason.

## Phase 2 (not built)

1. A real market-data provider (e.g. a licensed LSE feed) behind `MarketDataProvider`, with staleness checks kept.
2. Trading 212 **demo** integration: verify tickers via `/equity/metadata/instruments`, reconcile fills via `/equity/history/orders`, place broker-side stop orders.
3. Push notifications to iPhone for new proposals (Web Push on the installed PWA).
4. Only after a long, reviewed paper-trading record: a separate, explicitly reviewed change to consider live trading. This build contains no live code path.
