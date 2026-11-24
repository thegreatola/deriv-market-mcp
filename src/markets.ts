/**
 * Market-data operations built on DerivClient. These are what the MCP tools
 * call; they hold the Deriv-specific rules so the tool layer stays thin.
 */
import { DerivClient, DerivError, type DerivResponse } from "./deriv.js";

export const TIMEFRAMES = {
  M1: 60,
  M2: 120,
  M3: 180,
  M5: 300,
  M10: 600,
  M15: 900,
  M30: 1800,
  H1: 3600,
  H2: 7200,
  H4: 14400,
  H8: 28800,
  D1: 86400,
} as const;
export type Timeframe = keyof typeof TIMEFRAMES;

export interface MarketSymbol {
  symbol: string;
  name: string;
  market: string;
  submarket: string;
  isOpen: boolean;
  isSuspended: boolean;
  pipSize: number;
}

export interface Candle {
  time: string;
  epoch: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface CandleSeries {
  symbol: string;
  name: string | null;
  timeframe: Timeframe;
  candles: Candle[];
  /** True when the last candle is still forming (its period has not ended). */
  lastCandleForming: boolean;
}

export interface Price {
  symbol: string;
  name: string | null;
  price: number;
  epoch: number;
  time: string;
  pipSize: number;
}

export interface TradingHours {
  symbol: string;
  name: string;
  tradingDays: string[];
  opens: string[];
  closes: string[];
  events: { description: string; dates: string }[];
}

/** Small TTL cache so repeated tool calls don't spend the per-IP budget. */
class TtlCache {
  private readonly store = new Map<string, { at: number; value: unknown }>();
  get<T>(key: string, ttlMs: number): T | undefined {
    const hit = this.store.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value as T;
    return undefined;
  }
  set(key: string, value: unknown): void {
    this.store.set(key, { at: Date.now(), value });
  }
}

const SYMBOLS_TTL = 10 * 60_000;
const HOURS_TTL = 60 * 60_000;
const PRICE_TTL = 1_000;

export class Markets {
  private readonly cache = new TtlCache();

  constructor(private readonly client: DerivClient) {}

  /** Every symbol Deriv's public feed lists, with open/closed state. */
  async listSymbols(): Promise<MarketSymbol[]> {
    const cached = this.cache.get<MarketSymbol[]>("symbols", SYMBOLS_TTL);
    if (cached) return cached;
    const res = await this.client.request({ active_symbols: "brief" });
    const list: MarketSymbol[] = (res.active_symbols ?? []).map((s: any) => ({
      symbol: s.underlying_symbol,
      name: s.underlying_symbol_name,
      market: s.market,
      submarket: s.submarket,
      isOpen: s.exchange_is_open === 1,
      isSuspended: s.is_trading_suspended === 1,
      pipSize: s.pip_size,
    }));
    list.sort((a, b) => a.market.localeCompare(b.market) || a.name.localeCompare(b.name));
    this.cache.set("symbols", list);
    return list;
  }

  /**
   * Turn what an agent typed ("EUR/USD", "eurusd", "Volatility 75 Index",
   * "R_75") into a Deriv symbol code. Unknown input is passed through as-is,
   * because the feed serves history for some codes it does not list.
   */
  async resolveSymbol(input: string): Promise<{ symbol: string; name: string | null }> {
    const raw = input.trim();
    const symbols = await this.listSymbols();
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
    const want = norm(raw);

    const exact = symbols.find((s) => s.symbol === raw);
    if (exact) return { symbol: exact.symbol, name: exact.name };

    const match =
      symbols.find((s) => norm(s.symbol) === want) ??
      symbols.find((s) => norm(s.name) === want) ??
      symbols.find((s) => norm(s.symbol) === `frx${want}`);
    if (match) return { symbol: match.symbol, name: match.name };

    return { symbol: raw, name: null };
  }

  async getPrice(input: string): Promise<Price> {
    const { symbol, name } = await this.resolveSymbol(input);
    const key = `price:${symbol}`;
    const cached = this.cache.get<Price>(key, PRICE_TTL);
    if (cached) return cached;

    // One-shot history read, never the subscribing `ticks` call.
    const res = await this.client.request({
      ticks_history: symbol,
      style: "ticks",
      count: 1,
      end: "latest",
    });
    const prices: number[] = res.history?.prices ?? [];
    const times: number[] = res.history?.times ?? [];
    if (prices.length === 0) throw emptyResponse(symbol);

    const epoch = times[times.length - 1];
    const price: Price = {
      symbol,
      name,
      price: prices[prices.length - 1],
      epoch,
      time: isoTime(epoch),
      pipSize: Number(res.pip_size ?? 0),
    };
    this.cache.set(key, price);
    return price;
  }

  async getCandles(input: string, timeframe: Timeframe, count: number): Promise<CandleSeries> {
    const { symbol, name } = await this.resolveSymbol(input);
    const granularity = TIMEFRAMES[timeframe];

    // Ask for one extra: the oldest bar of a series is often a partial bucket
    // (the window starts mid-period), and it gets dropped below.
    let ask = count + 1;
    let candles = await this.fetchCandles(symbol, granularity, ask);
    if (candles.length === 0) throw emptyResponse(symbol);

    // Deriv's count is a span of time (count x granularity back from now), not a
    // number of bars, so weekends and session breaks return fewer bars than asked:
    // count 6 on daily gold across a weekend gives 4 or 5. Widen the window in
    // proportion to what came back, at most twice, and stop when history runs out.
    for (let i = 0; i < 2 && candles.length < count; i++) {
      const next = Math.min(MAX_CANDLES, Math.ceil((ask * (count + 1)) / Math.max(candles.length, 1)) + 2);
      if (next <= ask) break;
      const wider = await this.fetchCandles(symbol, granularity, next);
      if (wider.length <= candles.length) break;
      candles = wider;
      ask = next;
    }
    if (candles.length > count) candles = candles.slice(candles.length - count);

    const last = candles[candles.length - 1];
    const lastCandleForming = last ? last.epoch + granularity > Date.now() / 1000 : false;

    return { symbol, name, timeframe, candles, lastCandleForming };
  }

  private async fetchCandles(symbol: string, granularity: number, count: number): Promise<Candle[]> {
    const res = await this.client.request({ ticks_history: symbol, style: "candles", granularity, count, end: "latest" });
    return dropPartialFirst((res.candles ?? []).map(toCandle), granularity);
  }

  async getTradingHours(input: string): Promise<TradingHours> {
    const { symbol } = await this.resolveSymbol(input);
    let res = this.cache.get<DerivResponse>("hours", HOURS_TTL);
    if (!res) {
      res = await this.client.request({ trading_times: "today" });
      this.cache.set("hours", res);
    }
    for (const market of res.trading_times?.markets ?? []) {
      for (const sub of market.submarkets ?? []) {
        for (const s of sub.symbols ?? []) {
          if (s.underlying_symbol === symbol) {
            return {
              symbol,
              name: s.name,
              tradingDays: s.trading_days ?? [],
              opens: s.times?.open ?? [],
              closes: s.times?.close ?? [],
              events: (s.events ?? []).map((e: any) => ({
                description: e.descrip,
                dates: e.dates,
              })),
            };
          }
        }
      }
    }
    throw new DerivError("UnknownSymbol", `No trading hours listed for "${input}".`);
  }
}

/**
 * Deriv slices the requested window mid-bucket, so the first candle can be
 * stamped off the period boundary (a "daily" bar starting at 00:56).
 * Buckets are aligned to UTC, so a real bar's epoch divides evenly.
 */
/** The most bars Deriv returns in one ticks_history request. */
const MAX_CANDLES = 5000;

export function dropPartialFirst(candles: Candle[], granularity: number): Candle[] {
  if (candles.length > 0 && candles[0].epoch % granularity !== 0) return candles.slice(1);
  return candles;
}

function toCandle(c: any): Candle {
  const epoch = Number(c.epoch);
  return {
    time: isoTime(epoch),
    epoch,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
  };
}

function isoTime(epoch: number): string {
  return new Date(epoch * 1000).toISOString();
}

function emptyResponse(symbol: string): DerivError {
  // Under load Deriv answers with an empty series rather than an error, so an
  // empty reply is more often the limiter than a dead symbol.
  return new DerivError(
    "EmptyResponse",
    `Deriv returned no data for ${symbol}. The market may be closed, the code may be wrong, ` +
      `or this IP is being rate limited. Wait a minute before trying again.`,
  );
}
