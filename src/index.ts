#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "node:module";
import { DerivClient } from "./deriv.js";
import { Markets } from "./markets.js";
import { buildServer } from "./tools.js";

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };

const client = new DerivClient();
const server = buildServer(new Markets(client), version);

const shutdown = async () => {
  client.close();
  await server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await server.connect(new StdioServerTransport());
// stdout carries the protocol, so logs go to stderr.
console.error(`deriv-market-mcp ${version} ready on stdio`);
