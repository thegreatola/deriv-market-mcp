# deriv-market-mcp

An MCP server that gives AI agents live market data from Deriv's public feed: prices, OHLC candles, market lists and trading hours for currencies, stock indices, commodities, crypto and Deriv's synthetic indices.

It is read only. It cannot place trades, and it needs no account or API key.

## Tools

| Tool | What it returns |
|---|---|
| `list_markets` | Every symbol the feed offers, with whether it is open now. Filter by group (`forex`, `indices`, `commodities`, `cryptocurrency`, `synthetic_index`), by a search word, or to open markets only. |
| `get_price` | The latest quote for one symbol and the time it was quoted (UTC). |
| `get_prices` | Latest quotes for up to 10 symbols in one call. A bad symbol is reported in `errors` and does not fail the rest. |
| `get_candles` | OHLC candles from M1 to D1, oldest first, up to 500. Says whether the last candle is still forming. |
| `get_trading_hours` | Today's open and close times, trading days, and upcoming holidays or early closes. |

Symbols can be given as Deriv codes (`frxEURUSD`, `R_75`, `cryBTCUSD`) or by name (`EUR/USD`, `eurusd`, `Volatility 75 Index`). Every tool has an input schema, an output schema and read-only annotations, so clients get typed, structured results.

## Use it

Requires Node 22 or later.

```bash
git clone https://github.com/thegreatola/deriv-market-mcp
cd deriv-market-mcp
npm install
npm run build
```

**Claude Code**

```bash
claude mcp add deriv-market -- node /absolute/path/to/deriv-market-mcp/dist/index.js
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "deriv-market": {
      "command": "node",
      "args": ["/absolute/path/to/deriv-market-mcp/dist/index.js"]
    }
  }
}
```

Then ask things like "Is EUR/USD open right now, and what did it do over the last 24 hours?" or "Compare the last five daily candles of gold and BTC/USD".

### Settings

| Environment variable | Default | Meaning |
|---|---|---|
| `DERIV_MIN_INTERVAL_MS` | `500` | Minimum gap between two requests to Deriv. |
| `DERIV_WS_URL` | Deriv's public options feed | WebSocket endpoint. |

## How it works

```
MCP client (Claude, any agent)
        |  stdio, JSON-RPC
  tools.ts     schemas, annotations, errors as isError
        |
  markets.ts   symbol names, caching, candle clean-up
        |
  deriv.ts     one paced WebSocket, replies matched by req_id
        |
  wss://api.derivws.com  (public, no key)
```

### Design decisions

**One paced socket, no retry ladder.** Deriv rate-limits its public feed by client IP address, not by connection. When an address is throttled, a brand-new connection is refused on its first request, and every resend counts against the same limit. A client that retries with backoff keeps the address throttled for as long as it runs. So this server sends requests one at a time with a minimum gap, never retries on its own, and tells the agent plainly that it was rate limited and should wait.

**An empty reply is treated as a possible rate limit.** Under load the feed often answers with an empty series rather than an error. The error message says so, so an agent doesn't decide a market has vanished.

**Prices come from a one-shot history read.** The feed's `ticks` call subscribes to a stream. A second read of the same symbol on that socket then fails with "already subscribed", and the socket carries a stream nobody reads. `get_price` asks for the last tick from `ticks_history` instead, which returns the same quote at the same time.

**The oldest candle is dropped when it is partial.** Deriv cuts the requested window mid-period, so the first bar can be a fragment (a "daily" bar that starts at 00:56). Buckets are aligned to UTC, so the server asks for one extra bar and drops the first one if its timestamp is off the period boundary.

**Caching protects the budget.** The symbol list is cached for 10 minutes, trading hours for an hour, and a price for one second. Resolving "EUR/USD" to `frxEURUSD` doesn't cost a request after the first call.

**Unlisted codes still work.** The feed serves history for some symbols its own list leaves out, so an unknown code is passed through to Deriv instead of being refused locally.

## Tests

```bash
npm test          # 19 offline tests against a fake socket, no network
npm run test:live # one test against the real feed
npm run smoke     # builds, starts the server over stdio and calls every tool
```

The offline tests check pacing, one shared socket, reply matching, that a rate-limit refusal is sent exactly once, timeouts, symbol names, that the subscribing `ticks` call is never sent, partial-candle dropping, and that tool errors come back as `isError` instead of crashing the server. CI runs them on Node 22 and 24.

## Limits

- Data is Deriv's own quote feed. It is not an exchange feed and can differ from other brokers.
- History depth is set by Deriv: about a year of daily bars and roughly 700 bars of H1 or H4.
- Weekly and monthly candles are not served; build them from daily bars.
- Not financial advice. Nothing here places or suggests trades.

## License

MIT
