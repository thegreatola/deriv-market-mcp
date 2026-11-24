/**
 * A small client for Deriv's public market-data WebSocket.
 *
 * Design choices, each from something that broke in production elsewhere:
 *
 * - One shared socket. Requests are matched to replies by req_id, so many
 *   tool calls can share it.
 * - Requests are paced (one every `minIntervalMs`). Deriv's limit is keyed to
 *   the client IP, so bursts from one machine get the whole address refused,
 *   and a fresh connection does not reset it.
 * - No automatic retries. Every resend counts against the same per-IP limit
 *   that just refused the request, so a retry ladder keeps the address
 *   throttled. A refusal is returned to the caller as a clear error instead.
 * - Never uses the bare `ticks` call: it subscribes, and a second read of the
 *   same symbol on that socket fails with "already subscribed".
 */

export const DEFAULT_URL = "wss://api.derivws.com/trading/v1/options/ws/public";

export type DerivRequest = Record<string, unknown>;
export type DerivResponse = Record<string, any>;

export class DerivError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DerivError";
  }

  /** True when the refusal looks like Deriv's rate limiter. */
  get isRateLimit(): boolean {
    return this.code === "RateLimit" || this.code === "EmptyResponse";
  }
}

/** The subset of the WebSocket API this client uses, so tests can pass a fake. */
export interface SocketLike {
  readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export type SocketFactory = (url: string) => SocketLike;

export interface DerivClientOptions {
  url?: string;
  /** Minimum gap between two requests sent on the socket. */
  minIntervalMs?: number;
  /** How long to wait for a reply before failing the request. */
  timeoutMs?: number;
  /** Close the socket after this long with nothing in flight. */
  idleCloseMs?: number;
  socketFactory?: SocketFactory;
}

interface Pending {
  resolve: (r: DerivResponse) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const OPEN = 1;

export class DerivClient {
  private readonly url: string;
  private readonly minIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly idleCloseMs: number;
  private readonly socketFactory: SocketFactory;

  private socket: SocketLike | null = null;
  private opening: Promise<SocketLike> | null = null;
  private nextReqId = 1;
  private readonly pending = new Map<number, Pending>();
  private lastSentAt = 0;
  private queue: Promise<void> = Promise.resolve();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;

  /** Requests actually sent to Deriv (cache hits are not counted). */
  public sentCount = 0;

  constructor(opts: DerivClientOptions = {}) {
    this.url = opts.url ?? process.env.DERIV_WS_URL ?? DEFAULT_URL;
    // A bad value (e.g. "abc" -> NaN) would silently turn pacing off, so fall back to 500.
    const envInterval = Number(process.env.DERIV_MIN_INTERVAL_MS);
    this.minIntervalMs =
      opts.minIntervalMs ?? (Number.isFinite(envInterval) && envInterval >= 0 ? envInterval : 500);
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.idleCloseMs = opts.idleCloseMs ?? 60_000;
    this.socketFactory =
      opts.socketFactory ?? ((url) => new WebSocket(url) as unknown as SocketLike);
  }

  /**
   * Send one request and wait for its reply. Calls are serialised through a
   * queue so the pacing holds however many tool calls arrive at once.
   */
  request(req: DerivRequest): Promise<DerivResponse> {
    const run = this.queue.then(() => this.sendPaced(req));
    // Keep the queue alive even when one request fails.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  close(): void {
    this.clearIdle();
    const s = this.socket;
    this.socket = null;
    this.opening = null;
    s?.close();
    this.failAll(new DerivError("Closed", "Connection closed."));
  }

  private async sendPaced(req: DerivRequest): Promise<DerivResponse> {
    const wait = this.lastSentAt + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);

    const socket = await this.connect();
    const reqId = this.nextReqId++;
    this.clearIdle();

    const reply = new Promise<DerivResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        this.armIdle();
        reject(new DerivError("Timeout", `No reply from Deriv within ${this.timeoutMs} ms.`));
      }, this.timeoutMs);
      this.pending.set(reqId, { resolve, reject, timer });
    });

    this.lastSentAt = Date.now();
    this.sentCount++;
    socket.send(JSON.stringify({ ...req, req_id: reqId }));
    return reply;
  }

  private connect(): Promise<SocketLike> {
    if (this.socket && this.socket.readyState === OPEN) return Promise.resolve(this.socket);
    if (this.opening) return this.opening;

    this.opening = new Promise<SocketLike>((resolve, reject) => {
      const s = this.socketFactory(this.url);
      s.onopen = () => {
        this.socket = s;
        this.opening = null;
        resolve(s);
      };
      s.onerror = () => {
        if (this.opening) {
          this.opening = null;
          reject(new DerivError("ConnectFailed", `Could not connect to ${this.url}.`));
        }
      };
      s.onclose = () => {
        if (this.socket === s) this.socket = null;
        this.failAll(new DerivError("Disconnected", "Deriv closed the connection."));
      };
      s.onmessage = (ev) => this.onMessage(ev.data);
    });
    return this.opening;
  }

  private onMessage(raw: unknown): void {
    let msg: DerivResponse;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }
    const id = Number(msg.req_id);
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (this.pending.size === 0) this.armIdle();

    if (msg.error) {
      p.reject(new DerivError(String(msg.error.code ?? "Error"), String(msg.error.message ?? "Deriv error.")));
    } else {
      p.resolve(msg);
    }
  }

  private failAll(err: Error): void {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) {
        const s = this.socket;
        this.socket = null;
        s?.close();
      }
    }, this.idleCloseMs);
    // Never keep the process alive just to close an idle socket.
    this.idleTimer.unref?.();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
