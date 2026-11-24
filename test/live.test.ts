/**
 * Hits Deriv's real public feed. Skipped unless LIVE=1 (npm run test:live),
 * so CI and offline runs never spend the per-IP budget.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { DerivClient } from "../src/deriv.js";
import { Markets } from "../src/markets.js";

const live = process.env.LIVE === "1";

test("live: lists markets, reads prices, candles and hours", { skip: !live }, async () => {
  const client = new DerivClient();
  const markets = new Markets(client);
  try {
    const symbols = await markets.listSymbols();
    assert.ok(symbols.length > 20, `only ${symbols.length} symbols listed`);

    // Synthetic indices trade around the clock, so this works on weekends.
    const price = await markets.getPrice("Volatility 75 Index");
    assert.equal(price.symbol, "R_75");
    assert.ok(price.price > 0);

    const series = await markets.getCandles("R_75", "H1", 24);
    assert.equal(series.candles.length, 24);
    for (const c of series.candles) {
      assert.equal(c.epoch % 3600, 0, `candle at ${c.time} is off the hour`);
      assert.ok(c.low <= c.open && c.open <= c.high && c.low <= c.close && c.close <= c.high);
    }
    for (let i = 1; i < series.candles.length; i++) {
      assert.ok(series.candles[i].epoch > series.candles[i - 1].epoch, "candles are not oldest first");
    }

    const daily = await markets.getCandles("frxEURUSD", "D1", 30);
    for (const c of daily.candles) assert.equal(c.epoch % 86400, 0, `daily bar at ${c.time} is not 00:00 UTC`);
    assert.equal(daily.candles.length, 30, "weekends don't shorten the series");

    const hours = await markets.getTradingHours("EUR/USD");
    assert.ok(hours.tradingDays.includes("Mon"));

    // Five reads and one cached symbol list. Daily bars across weekends may need up
    // to two wider requests to fill the count; nothing else is sent.
    assert.ok(client.sentCount >= 5 && client.sentCount <= 7, `sent ${client.sentCount}`);
  } finally {
    client.close();
  }
});
