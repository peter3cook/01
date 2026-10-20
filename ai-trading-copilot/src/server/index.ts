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

  const { app, engine, saveMarket } = await buildApp(config);
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

  const shutdown = async () => {
    clearInterval(timer);
    clearInterval(marketTimer);
    saveMarket();
    await app.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await app.listen({ port: config.port, host: config.host });
  console.log(
    `AI Trading Copilot (DEMO MODE · simulated data · live trading disabled) on http://${config.host}:${config.port}` +
      `\n  AI explanations: ${config.anthropicApiKey ? config.claudeModel : "rules template (no ANTHROPIC_API_KEY)"}` +
      `\n  Auth: ${config.accessToken ? "bearer token required" : "OFF (local development only)"}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
