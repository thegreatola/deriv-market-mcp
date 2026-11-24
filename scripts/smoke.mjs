// Starts the built server over stdio, the way Claude Desktop or Claude Code
// would, and calls each tool once against the live feed.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
const client = new Client({ name: "smoke", version: "1" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const calls = [
  ["list_markets", { market: "forex", open_only: true }],
  ["get_price", { symbol: "EUR/USD" }],
  ["get_prices", { symbols: ["Volatility 75 Index", "cryBTCUSD", "NOPE"] }],
  ["get_candles", { symbol: "R_75", timeframe: "H4", count: 3 }],
  ["get_trading_hours", { symbol: "EUR/USD" }],
  ["get_price", { symbol: "NOPE" }],
];
for (const [name, args] of calls) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content[0].text;
  console.log(`\n${name} ${JSON.stringify(args)}${res.isError ? "  [isError]" : ""}\n  ${text.slice(0, 300)}`);
}
await client.close();
