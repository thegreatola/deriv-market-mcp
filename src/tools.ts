import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DerivError } from "./deriv.js";
import { Markets, TIMEFRAMES, type Timeframe } from "./markets.js";

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const symbolArg = z
  .string()
  .min(1)
  .describe(
    'A Deriv symbol code ("frxEURUSD", "R_75", "cryBTCUSD") or its name ("EUR/USD", "Volatility 75 Index"). ' +
      "Use list_markets to find codes.",
  );

const timeframeKeys = Object.keys(TIMEFRAMES) as [Timeframe, ...Timeframe[]];

const candleShape = {
  time: z.string(),
  epoch: z.number(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
};

const priceShape = {
  symbol: z.string(),
  name: z.string().nullable(),
  price: z.number(),
  epoch: z.number(),
  time: z.string(),
  pipSize: z.number(),
};

export function buildServer(markets: Markets, version: string): McpServer {
  const server = new McpServer(
    { name: "deriv-market-mcp", version },
    {
      instructions:
        "Live market data from Deriv's public feed: currencies, stock indices, commodities, crypto and " +
        "Deriv synthetic indices. Read only; it cannot trade. Times are UTC. Call list_markets first if " +
        "you are unsure of a symbol. The feed is rate limited per IP address, so prefer one get_candles " +
        "call over many get_price calls, and do not retry a rate-limit error straight away.",
    },
  );

  server.registerTool(
    "list_markets",
    {
      title: "List markets",
      description:
        "List the symbols Deriv's public feed offers, with whether each market is open now. " +
        "Filter by market group (for example forex, indices, commodities, cryptocurrency, synthetic_index) " +
        "or by a search word.",
      inputSchema: {
        market: z
          .string()
          .optional()
          .describe('Only this market group, e.g. "forex" or "synthetic_index".'),
        search: z.string().optional().describe('Only symbols whose name or code contains this, e.g. "gold".'),
        open_only: z.boolean().optional().describe("Only markets open right now."),
      },
      outputSchema: {
        count: z.number(),
        marketGroups: z.array(z.string()),
        symbols: z.array(
          z.object({
            symbol: z.string(),
            name: z.string(),
            market: z.string(),
            submarket: z.string(),
            isOpen: z.boolean(),
          }),
        ),
      },
      annotations: { title: "List markets", ...READ_ONLY },
    },
    async ({ market, search, open_only }) =>
      run(async () => {
        const all = await markets.listSymbols();
        const q = search?.toLowerCase();
        const symbols = all
          .filter((s) => !market || s.market === market)
          .filter((s) => !q || s.name.toLowerCase().includes(q) || s.symbol.toLowerCase().includes(q))
          .filter((s) => !open_only || (s.isOpen && !s.isSuspended))
          .map(({ symbol, name, market, submarket, isOpen, isSuspended }) => ({
            symbol,
            name,
            market,
            submarket,
            isOpen: isOpen && !isSuspended,
          }));
        const marketGroups = [...new Set(all.map((s) => s.market))];
        return { count: symbols.length, marketGroups, symbols };
      }),
  );

  server.registerTool(
    "get_price",
    {
      title: "Get latest price",
      description: "The latest quoted price for one symbol, with the time it was quoted (UTC).",
      inputSchema: { symbol: symbolArg },
      outputSchema: priceShape,
      annotations: { title: "Get latest price", ...READ_ONLY },
    },
    async ({ symbol }) => run(() => markets.getPrice(symbol)),
  );

  server.registerTool(
    "get_prices",
    {
      title: "Get several prices",
      description:
        "Latest prices for up to 10 symbols in one call. Requests are paced to respect the feed's rate " +
        "limit, so 10 symbols take about 5 seconds. A symbol that fails is reported in errors and does " +
        "not fail the others.",
      inputSchema: {
        symbols: z.array(symbolArg).min(1).max(10),
      },
      outputSchema: {
        prices: z.array(z.object(priceShape)),
        errors: z.array(z.object({ symbol: z.string(), error: z.string() })),
      },
      annotations: { title: "Get several prices", ...READ_ONLY },
    },
    async ({ symbols }) =>
      run(async () => {
        const settled = await Promise.allSettled(symbols.map((s) => markets.getPrice(s)));
        const prices = [];
        const errors = [];
        for (let i = 0; i < settled.length; i++) {
          const r = settled[i];
          if (r.status === "fulfilled") prices.push(r.value);
          else errors.push({ symbol: symbols[i], error: messageOf(r.reason) });
        }
        if (prices.length === 0 && errors.length > 0) {
          throw new DerivError("AllFailed", `No prices returned. First error: ${errors[0].error}`);
        }
        return { prices, errors };
      }),
  );

  server.registerTool(
    "get_candles",
    {
      title: "Get candles",
      description:
        "OHLC candles for one symbol, oldest first. Buckets are aligned to UTC (daily bars start at " +
        "00:00 UTC). The last candle may still be forming; lastCandleForming says so. Deriv keeps about " +
        "a year of daily bars and about 700 bars of intraday history.",
      inputSchema: {
        symbol: symbolArg,
        timeframe: z.enum(timeframeKeys).default("H1").describe("Candle size, M1 to D1."),
        count: z.number().int().min(1).max(500).default(50).describe("How many candles, up to 500."),
      },
      outputSchema: {
        symbol: z.string(),
        name: z.string().nullable(),
        timeframe: z.string(),
        lastCandleForming: z.boolean(),
        candles: z.array(z.object(candleShape)),
      },
      annotations: { title: "Get candles", ...READ_ONLY },
    },
    async ({ symbol, timeframe, count }) => run(() => markets.getCandles(symbol, timeframe, count)),
  );

  server.registerTool(
    "get_trading_hours",
    {
      title: "Get trading hours",
      description:
        "Today's opening and closing times (UTC), trading days and upcoming holidays or early closes for one symbol.",
      inputSchema: { symbol: symbolArg },
      outputSchema: {
        symbol: z.string(),
        name: z.string(),
        tradingDays: z.array(z.string()),
        opens: z.array(z.string()),
        closes: z.array(z.string()),
        events: z.array(z.object({ description: z.string(), dates: z.string() })),
      },
      annotations: { title: "Get trading hours", ...READ_ONLY },
    },
    async ({ symbol }) => run(() => markets.getTradingHours(symbol)),
  );

  return server;
}

/** Wrap a tool body: data goes out as structured content plus JSON text, errors as isError. */
async function run(fn: () => Promise<object>): Promise<CallToolResult> {
  try {
    const data = await fn();
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data as Record<string, unknown>,
    };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: messageOf(err) }] };
  }
}

function messageOf(err: unknown): string {
  if (err instanceof DerivError) {
    const hint = err.isRateLimit ? " (rate limited: wait about a minute before retrying)" : "";
    return `${err.code}: ${err.message}${hint}`;
  }
  return err instanceof Error ? err.message : String(err);
}
