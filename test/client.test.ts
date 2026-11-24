import assert from "node:assert/strict";
import { test } from "node:test";
import { DerivClient, DerivError } from "../src/deriv.js";
import { fakeDeriv } from "./fake.js";

test("paces requests at least minIntervalMs apart", async () => {
  const fake = fakeDeriv(() => ({ ok: 1 }));
  const client = new DerivClient({ socketFactory: fake.factory, minIntervalMs: 80 });
  await Promise.all([client.request({ a: 1 }), client.request({ a: 2 }), client.request({ a: 3 })]);
  const gaps = fake.sent.slice(1).map((s, i) => s.at - fake.sent[i].at);
  for (const gap of gaps) assert.ok(gap >= 75, `gap ${gap} ms is under the 80 ms pace`);
  client.close();
});

test("shares one socket across many requests", async () => {
  const fake = fakeDeriv(() => ({ ok: 1 }));
  const client = new DerivClient({ socketFactory: fake.factory, minIntervalMs: 0 });
  await Promise.all([1, 2, 3, 4].map((n) => client.request({ n })));
  assert.equal(fake.connections(), 1);
  client.close();
});

test("matches replies to requests by req_id", async () => {
  const fake = fakeDeriv((req) => ({ echo: req.n }));
  const client = new DerivClient({ socketFactory: fake.factory, minIntervalMs: 0 });
  const results = await Promise.all([1, 2, 3].map((n) => client.request({ n })));
  assert.deepEqual(
    results.map((r) => r.echo),
    [1, 2, 3],
  );
  client.close();
});

test("turns a Deriv error reply into a DerivError", async () => {
  const fake = fakeDeriv(() => ({ error: { code: "InvalidSymbol", message: "Invalid symbol." } }));
  const client = new DerivClient({ socketFactory: fake.factory, minIntervalMs: 0 });
  await assert.rejects(client.request({ ticks_history: "NOPE" }), (e: unknown) => {
    assert.ok(e instanceof DerivError);
    assert.equal(e.code, "InvalidSymbol");
    return true;
  });
  client.close();
});

test("never retries a rate-limit refusal: one call, one request sent", async () => {
  const fake = fakeDeriv(() => ({ error: { code: "RateLimit", message: "Rate limit reached." } }));
  const client = new DerivClient({ socketFactory: fake.factory, minIntervalMs: 0 });
  await assert.rejects(client.request({ x: 1 }), (e: unknown) => e instanceof DerivError && e.isRateLimit);
  assert.equal(fake.sent.length, 1);
  assert.equal(client.sentCount, 1);
  client.close();
});

test("times out a request that gets no reply, and keeps working after", async () => {
  let silent = true;
  const fake = fakeDeriv(() => (silent ? undefined : { ok: 1 }));
  const client = new DerivClient({ socketFactory: fake.factory, minIntervalMs: 0, timeoutMs: 50 });
  await assert.rejects(client.request({ x: 1 }), (e: unknown) => e instanceof DerivError && e.code === "Timeout");
  silent = false;
  const ok = await client.request({ x: 2 });
  assert.equal(ok.ok, 1);
  client.close();
});

test("a bad DERIV_MIN_INTERVAL_MS falls back to 500 ms instead of turning pacing off", () => {
  const before = process.env.DERIV_MIN_INTERVAL_MS;
  process.env.DERIV_MIN_INTERVAL_MS = "abc";
  try {
    const client = new DerivClient({ socketFactory: fakeDeriv(() => undefined).factory });
    assert.equal((client as any).minIntervalMs, 500);
  } finally {
    if (before === undefined) delete process.env.DERIV_MIN_INTERVAL_MS;
    else process.env.DERIV_MIN_INTERVAL_MS = before;
  }
});
