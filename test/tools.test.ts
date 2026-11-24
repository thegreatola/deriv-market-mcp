import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DerivClient } from "../src/deriv.js";
import { Markets } from "../src/markets.js";
import { buildServer } from "../src/tools.js";
import { fakeDeriv, SYMBOLS } from "./fake.js";

async function connect(responder: (req: Record<string, any>) => Record<string, any> | undefined) {
  const fake = fakeDeriv((req) => (req.active_symbols ? SYMBOLS : responder(req)));
  const deriv = new DerivClient({ socketFactory: fake.factory, minIntervalMs: 0 });
  const server = buildServer(new Markets(deriv), "test");
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const close = async () => {
    await client.close();
    deriv.close();
  };
  return { client, close };
}

test("lists five read-only tools with output schemas", async () => {
  const { client, close } = await connect(() => undefined);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    "get_candles",
    "get_price",
    "get_prices",
    "get_trading_hours",
    "list_markets",
  ]);
  for (const t of tools) {
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} is not marked read-only`);
    assert.ok(t.outputSchema, `${t.name} has no output schema`);
  }
  await close();
});

test("list_markets filters by group and open state", async () => {
  const { client, close } = await connect(() => undefined);
  const res: any = await client.callTool({ name: "list_markets", arguments: { open_only: true } });
  assert.equal(res.isError, undefined);
  const names = res.structuredContent.symbols.map((s: any) => s.symbol);
  assert.deepEqual(names.sort(), ["R_75", "frxEURUSD"]);
  const fx: any = await client.callTool({ name: "list_markets", arguments: { market: "forex" } });
  assert.equal(fx.structuredContent.count, 1);
  await close();
});

test("get_price returns structured content", async () => {
  const { client, close } = await connect(() => ({
    history: { prices: [44473.9152], times: [1_795_485_944] },
    pip_size: 4,
  }));
  const res: any = await client.callTool({ name: "get_price", arguments: { symbol: "Volatility 75 Index" } });
  assert.equal(res.structuredContent.symbol, "R_75");
  assert.equal(res.structuredContent.price, 44473.9152);
  await close();
});

test("a Deriv error comes back as isError with the reason, not a crash", async () => {
  const { client, close } = await connect(() => ({ error: { code: "InvalidSymbol", message: "Invalid symbol." } }));
  const res: any = await client.callTool({ name: "get_price", arguments: { symbol: "NOPE" } });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /InvalidSymbol/);
  await close();
});

test("get_prices reports one bad symbol without failing the rest", async () => {
  const { client, close } = await connect((req) =>
    req.ticks_history === "NOPE"
      ? { error: { code: "InvalidSymbol", message: "Invalid symbol." } }
      : { history: { prices: [1.09], times: [1_795_485_944] }, pip_size: 5 },
  );
  const res: any = await client.callTool({ name: "get_prices", arguments: { symbols: ["EUR/USD", "NOPE"] } });
  assert.equal(res.structuredContent.prices.length, 1);
  assert.equal(res.structuredContent.errors[0].symbol, "NOPE");
  await close();
});

test("rejects bad arguments before touching Deriv", async () => {
  const { client, close } = await connect(() => undefined);
  const res: any = await client.callTool({
    name: "get_candles",
    arguments: { symbol: "R_75", timeframe: "H3", count: 5000 },
  });
  assert.equal(res.isError, true);
  await close();
});
