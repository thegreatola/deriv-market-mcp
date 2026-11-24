import assert from "node:assert/strict";
import { test } from "node:test";
import { DerivClient } from "../src/deriv.js";
import { dropPartialFirst, Markets } from "../src/markets.js";
import { fakeDeriv, SYMBOLS } from "./fake.js";

const H1 = 3600;

function setup(extra: (req: Record<string, any>) => Record<string, any> | undefined) {
  const fake = fakeDeriv((req) => (req.active_symbols ? SYMBOLS : extra(req)));
  const client = new DerivClient({ socketFactory: fake.factory, minIntervalMs: 0 });
  return { fake, client, markets: new Markets(client) };
}

test("resolves names and loose codes to Deriv symbols", async () => {
  const { markets, client } = setup(() => undefined);
  assert.equal((await markets.resolveSymbol("EUR/USD")).symbol, "frxEURUSD");
  assert.equal((await markets.resolveSymbol("eurusd")).symbol, "frxEURUSD");
  assert.equal((await markets.resolveSymbol("volatility 75 index")).symbol, "R_75");
  assert.equal((await markets.resolveSymbol("r_75")).symbol, "R_75");
  // Unlisted codes pass through: the feed serves some symbols it does not list.
  assert.deepEqual(await markets.resolveSymbol("DSI10"), { symbol: "DSI10", name: null });
  client.close();
});

test("caches the symbol list instead of re-fetching it", async () => {
  const { markets, fake, client } = setup(() => undefined);
  await markets.listSymbols();
  await markets.listSymbols();
  await markets.resolveSymbol("EUR/USD");
  assert.equal(fake.sent.filter((s) => s.req.active_symbols).length, 1);
  client.close();
});

test("reads the price with one-shot history, never the subscribing ticks call", async () => {
  const { markets, fake, client } = setup(() => ({
    history: { prices: [1.0912], times: [1_795_485_944] },
    pip_size: 5,
  }));
  const p = await markets.getPrice("EUR/USD");
  assert.equal(p.symbol, "frxEURUSD");
  assert.equal(p.price, 1.0912);
  assert.equal(p.time, new Date(1_795_485_944_000).toISOString());
  for (const { req } of fake.sent) assert.equal("ticks" in req, false, "sent a bare ticks request");
  const priceReq = fake.sent.find((s) => s.req.ticks_history)!.req;
  assert.equal(priceReq.style, "ticks");
  assert.equal(priceReq.count, 1);
  client.close();
});

test("reports an empty reply as a possible rate limit", async () => {
  const { markets, client } = setup(() => ({ history: { prices: [], times: [] } }));
  await assert.rejects(markets.getPrice("R_75"), /rate limited/);
  client.close();
});

test("dropPartialFirst removes a first bar stamped off the period boundary", () => {
  const bar = (epoch: number) => ({ time: "", epoch, open: 1, high: 1, low: 1, close: 1 });
  const partial = [bar(3600 * 10 + 56 * 60), bar(3600 * 11), bar(3600 * 12)];
  assert.equal(dropPartialFirst(partial, H1).length, 2);
  const aligned = [bar(3600 * 10), bar(3600 * 11)];
  assert.equal(dropPartialFirst(aligned, H1).length, 2);
});

test("getCandles asks for one extra, drops the partial bar and trims to count", async () => {
  const now = Math.floor(Date.now() / 1000);
  const current = now - (now % H1);
  const epochs = [current - 3 * H1 + 120, current - 2 * H1, current - H1, current];
  const { markets, fake, client } = setup(() => ({
    candles: epochs.map((epoch) => ({ epoch, open: 1, high: 2, low: 0.5, close: 1.5 })),
  }));

  const series = await markets.getCandles("R_75", "H1", 3);
  const req = fake.sent.find((s) => s.req.ticks_history)!.req;
  assert.equal(req.count, 4);
  assert.equal(req.granularity, H1);
  assert.equal(series.candles.length, 3);
  assert.equal(series.candles[0].epoch, current - 2 * H1);
  assert.equal(series.lastCandleForming, true);
  client.close();
});
