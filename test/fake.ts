import type { SocketFactory, SocketLike } from "../src/deriv.js";

export type Responder = (req: Record<string, any>) => Record<string, any> | undefined;

/** A fake Deriv socket. `responder` returns the reply body, or undefined to stay silent. */
export function fakeDeriv(responder: Responder) {
  const sent: { at: number; req: Record<string, any> }[] = [];
  let connections = 0;

  const factory: SocketFactory = () => {
    connections++;
    const s: SocketLike = {
      readyState: 0,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send(data: string) {
        const req = JSON.parse(data);
        sent.push({ at: Date.now(), req });
        const body = responder(req);
        if (body) {
          setTimeout(() => s.onmessage?.({ data: JSON.stringify({ ...body, req_id: req.req_id }) }), 1);
        }
      },
      close() {
        s.readyState = 3;
        s.onclose?.({});
      },
    };
    setTimeout(() => {
      s.readyState = 1;
      s.onopen?.({});
    }, 1);
    return s;
  };

  return { factory, sent, connections: () => connections };
}

export const SYMBOLS = {
  active_symbols: [
    {
      underlying_symbol: "frxEURUSD",
      underlying_symbol_name: "EUR/USD",
      market: "forex",
      submarket: "major_pairs",
      exchange_is_open: 1,
      is_trading_suspended: 0,
      pip_size: 0.00001,
    },
    {
      underlying_symbol: "R_75",
      underlying_symbol_name: "Volatility 75 Index",
      market: "synthetic_index",
      submarket: "random_index",
      exchange_is_open: 1,
      is_trading_suspended: 0,
      pip_size: 0.0001,
    },
    {
      underlying_symbol: "OTC_DJI",
      underlying_symbol_name: "Wall Street 30",
      market: "indices",
      submarket: "americas_OTC",
      exchange_is_open: 0,
      is_trading_suspended: 0,
      pip_size: 0.01,
    },
  ],
};
