import { buildApp } from "./app";
import { ConfigError, loadConfig } from "./config";

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`Refusing to start: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }

  const banner =
    config.tradingMode === "live"
      ? "LIVE – REAL MONEY (Trading 212)"
      : config.tradingMode === "paper"
        ? "PAPER – Trading 212 practice account, real prices"
        : "SIMULATED – made-up prices, paper broker";
  console.log(`Pete’s Trading starting in ${banner}`);

  const { app, engine, saveMarket, refreshPrices } = await buildApp(config);
  await refreshPrices();
  await engine.tick();

  let ticking = false;
  const timer = setInterval(async () => {
    if (ticking) return;
    ticking = true;
    try {
      await engine.tick();
    } catch (e) {
      app.log.error(e, "tick failed");
    } finally {
      ticking = false;
    }
  }, config.tickIntervalMs);
  const marketTimer = setInterval(saveMarket, 30_000);
  const priceTimer = config.tradingMode === "simulated" ? undefined : setInterval(() => void refreshPrices().catch(() => {}), 3600_000);

  const shutdown = async () => {
    clearInterval(timer);
    clearInterval(marketTimer);
    if (priceTimer) clearInterval(priceTimer);
    saveMarket();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: config.port, host: config.host });
  console.log(
    `Listening on http://${config.host}:${config.port}` +
      `\n  AI explanations: ${config.anthropicApiKey ? config.claudeModel : "rules template (no ANTHROPIC_API_KEY)"}` +
      `\n  Auth: ${config.accessToken ? "access token required" : "OFF (simulated local development only)"}` +
      `\n  Phone notifications: ${config.notify.ntfyUrl ? "ntfy" : config.notify.telegramToken ? "Telegram" : "OFF"}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
