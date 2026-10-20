# Deployment plan

Running costs matter here: £5 a month is 10% of a £50 account every month. So the plan starts free and only adds paid hosting when it's useful.

## Option A – free: run it on your own computer (recommended for Phase 1)

```bash
cd ai-trading-copilot
npm ci
npm run build
npm start            # http://127.0.0.1:8787
```

To use it from your iPhone on the same Wi-Fi, bind to your network and set a token:

```bash
HOST=0.0.0.0 APP_ACCESS_TOKEN=$(openssl rand -base64 32) npm start
```

Open `http://<your-computer-ip>:8787` in Safari → Share → **Add to Home Screen**. Enter the token once.

Cost: £0. The app only works while the computer is on.

## Option B – free: the standalone preview

`npm run build:preview` creates `dist/preview/`, a static site where the whole engine runs in the browser with simulated data. Host it on any free static host (GitHub Pages, Cloudflare Pages, Netlify). There is no server, no broker and no AI key, and data stays in that browser.

## Option C – always-on, about £3–5 a month

Use the Dockerfile on a small VPS (Hetzner CX22, ~€4/month) or a container host (Fly.io, Railway).

```bash
docker build -t ai-trading-copilot .
docker run -d --name copilot -p 127.0.0.1:8787:8787 \
  -v copilot-data:/data \
  --env-file .env \
  --restart unless-stopped \
  ai-trading-copilot
```

Put HTTPS in front of it (Caddy: `copilot.example.com { reverse_proxy 127.0.0.1:8787 }`). Required:

- `NODE_ENV=production` (the image sets it) and `APP_ACCESS_TOKEN` of 24+ random characters. The server refuses to start without it.
- Secrets live only in the server's `.env` or the host's secret store. Never in git or the web app.
- Back up the `/data` volume (`state.json`, `market.json`, `audit.jsonl`).

## AI explanation costs

Without `ANTHROPIC_API_KEY` explanations are free (rules template). With a key, each explanation is one short Claude call, capped by `AI_MAX_CALLS_PER_DAY` (default 10) and `AI_MAX_COST_PER_DAY_GBP` (default £0.05). That caps AI spend at about £1.50 a month. Setting `CLAUDE_MODEL=claude-haiku-5-5` makes each call roughly 40× cheaper. Actual spend is shown in Activity → Costs.

## CI

`.github/workflows/ai-trading-copilot.yml` runs typecheck, tests, build and `npm audit` on every push that touches the app.

## Release checklist

- [ ] `npm run check` passes
- [ ] `TRADING_MODE=demo`, `BROKER=simulated`
- [ ] `APP_ACCESS_TOKEN` set; HTTPS in front
- [ ] No `T212_LIVE_*` variables anywhere (the server refuses to start if present)
- [ ] `/api/health` shows `"liveTrading": false`
