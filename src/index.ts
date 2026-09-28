/**
 * crypto-quote-x402 — Web3 market-data API behind x402 on the Kite chain.
 *
 * Wraps the free, open DeFiLlama price API (https://coins.llama.fi) as a paid
 * service. Like frankfurter-x402, it adds production-grade layers on top of the
 * x402 payment gate:
 *
 *  1. Tiered pricing — a real-time `price` snapshot is cheap ($0.001); the
 *     server-computed `convert` and `portfolio` endpoints and the `history`
 *     time-series are premium ($0.01), because they either do server-side math
 *     or return much larger payloads.
 *  2. A read-through in-memory cache with TTL + Age/Cache-Control headers.
 *     Live prices move constantly, so `price` is cached briefly (60s); the
 *     `history` time-series is immutable, so it is cached long (30d). This cuts
 *     upstream load. Payment still happens per request — caching only reduces
 *     upstream traffic, never the charge.
 *  3. Per-client rate limiting + structured JSON logs, applied *after* the
 *     payment gate so only paid calls consume the limit.
 *
 * Discovery endpoints (/healthz) are free so a buyer can inspect the service.
 *
 * Routing note: every paid route is registered with a fully explicit
 * "METHOD /path" key in the payment middleware — there is no "/v1/*" catch-all.
 * x402 matches with `.find()` and returns the FIRST hit, so a catch-all would
 * silently swallow more specific routes and misprice them. Going fully explicit
 * removes the footgun entirely (a real bug we hit on frankfurter-x402).
 */
import express, { type Request, type Response, type NextFunction } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { FACILITATOR_URL, kiteChainByName, kiteMoneyParser } from "./kite.js";

const env = (key: string, fallback = ""): string => (process.env[key] ?? "").trim() || fallback;
const money = (v: string): string => (v.startsWith("$") ? v : `$${v}`);

/** Structured one-line JSON logs — easy to grep, ship, or alert on. */
const log = (level: "info" | "warn" | "error", msg: string, extra: Record<string, unknown> = {}): void => {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra }));
};

const payTo = env("PAY_TO");
if (!payTo) throw new Error("PAY_TO is required: the Kite wallet address that receives payments");
const chain = kiteChainByName(env("KITE_NETWORK", "testnet"));
const upstream = new URL(env("UPSTREAM_URL") || "invalid://");
if (!/^https?:$/.test(upstream.protocol)) throw new Error("UPSTREAM_URL is required, e.g. https://coins.llama.fi");

// Bail out of upstream calls that hang instead of tying up a Render connection.
const UPSTREAM_TIMEOUT_MS = Number(env("UPSTREAM_TIMEOUT_MS", "9000"));
// Guard against abusive requests that ask for an unbounded number of coins.
const MAX_COINS = Number(env("MAX_COINS", "50"));

// Tiered pricing. DeFiLlama is itself free, so the split reflects *value*: a
// single live snapshot is cheap; server-computed conversion/portfolio and the
// historical time-series (larger payload) are premium.
const stdPrice = money(env("PRICE_USD", "0.001")); // real-time price snapshot
const premiumPrice = money(env("PRICE_USD_PREMIUM", "0.01")); // convert / portfolio / history

const upstreamAuthHeader = env("UPSTREAM_AUTH_HEADER", "Authorization");
const upstreamAuthValue = env("UPSTREAM_AUTH_VALUE");

// Rate limiting. Paid calls are the ones that hit the upstream, so cap them per
// client. RATE_LIMIT_PER_MIN=0 disables (useful for load tests). Exported as a
// factory so the behaviour can be unit tested directly.
export function createRateLimiter(perMin: number) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  return function rateLimit(req: Request, res: Response, next: NextFunction): void {
    if (!Number.isFinite(perMin) || perMin <= 0) {
      next();
      return;
    }
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + 60_000 });
      next();
      return;
    }
    if (bucket.count >= perMin) {
      log("warn", "rate_limited", { key, path: req.path });
      res.status(429).json({ error: "rate limit exceeded", limit_per_min: perMin });
      return;
    }
    bucket.count += 1;
    next();
  };
}

const ratePerMin = Number(env("RATE_LIMIT_PER_MIN", "10"));
const rateLimit = createRateLimiter(ratePerMin);

// 1. Facilitator + Kite pricing.
const facilitator = new HTTPFacilitatorClient({ url: env("FACILITATOR_URL", FACILITATOR_URL) });
const resourceServer = new x402ResourceServer(facilitator).register(
  chain.network,
  new ExactEvmScheme().registerMoneyParser(kiteMoneyParser(chain)),
);

export const app = express();
app.disable("x-powered-by");

// Render terminates TLS in front of the app; advertise the public https origin
// in the 402 body so buyers see the URL they actually called.
app.set("trust proxy", 1);
// Parse JSON request bodies for the POST /v1/portfolio endpoint. GET requests
// carry no body, so this is a harmless no-op for them.
app.use(express.json({ limit: "1mb" }));

// CORS: let browser-based x402 clients (and the Kite Passport web agent) call
// the paid endpoints and send the X-PAYMENT header. Only the HTTP layer is
// opened — the 402 challenge and paid responses stay gated by x402.
app.use((_req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type,X-PAYMENT");
  res.set("Access-Control-Expose-Headers", "payment-required,x-payment-response");
  if (_req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

// ---------------------------------------------------------------------------
// Read-through cache (server-side only). Live prices move constantly, so `price`
// is cached briefly (60s, near real-time); the `history` time-series is
// immutable, so it is cached long (30d). Payment still happens per request —
// caching only reduces upstream traffic, never the charge. Because each paid
// request must be re-paid, paid 200 responses are marked `Cache-Control:
// no-store` so clients never replay a 200 and skip the next payment.
// ---------------------------------------------------------------------------
interface CacheEntry {
  at: number;
  ttl: number;
  status: number;
  body: Buffer;
}
const cache = new Map<string, CacheEntry>();
const CACHE_MAX = 200;

function cacheKey(method: string, url: string): string {
  return `${method} ${url}`;
}
/** Live prices are cached briefly; immutable history is cached long. */
function ttlForKind(kind: "price" | "history"): number {
  return kind === "price" ? 60_000 : 30 * 24 * 3_600_000;
}
function getCache(key: string): CacheEntry | null {
  const e = cache.get(key);
  if (!e) return null;
  if (Date.now() > e.at + e.ttl) {
    cache.delete(key);
    return null;
  }
  return e;
}
function setCache(key: string, entry: CacheEntry): void {
  if (cache.size >= CACHE_MAX && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, entry);
}

/** fetch with a hard timeout so a hung upstream can't occupy a connection. */
async function fetchWithTimeout(target: URL, init: RequestInit = {}): Promise<globalThis.Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(target, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

/** Forward a request to the upstream and return the response. Exported for tests. */
export async function fetchUpstream(target: URL, headers: Headers, method: string, body?: ReadableStream<Uint8Array>): Promise<globalThis.Response> {
  return fetchWithTimeout(target, {
    method,
    headers,
    body: body as unknown as BodyInit | undefined,
    duplex: "half",
  } as RequestInit);
}

/**
 * GET a JSON resource from the upstream with read-through caching. Throws on
 * network failure or a non-200 upstream status so callers can return 502.
 */
async function fetchJsonCached(target: URL, kind: "price" | "history"): Promise<any> {
  const key = cacheKey("GET", target.toString());
  const hit = getCache(key);
  if (hit && hit.status === 200) {
    return JSON.parse(hit.body.toString("utf8"));
  }
  let res: globalThis.Response;
  try {
    res = await fetchWithTimeout(target);
  } catch (err) {
    const aborted = err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
    throw new Error(aborted ? `upstream timeout after ${UPSTREAM_TIMEOUT_MS}ms` : `upstream unreachable: ${String(err)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (res.status !== 200) {
    throw new Error(`upstream returned ${res.status}`);
  }
  const json = JSON.parse(buf.toString("utf8"));
  setCache(key, { at: Date.now(), ttl: ttlForKind(kind), status: 200, body: buf });
  return json;
}

// ---------------------------------------------------------------------------
// DeFiLlama helpers. The upstream keys prices by "coingecko:<id>"; we accept
// either bare ids ("bitcoin") or fully-qualified ones and strip the prefix in
// the response so buyers get clean keys.
// ---------------------------------------------------------------------------
/** Normalise comma-separated coin ids into "coingecko:<id>" form. */
export function parseCoins(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((id) => {
      const lower = id.toLowerCase();
      return lower.startsWith("coingecko:") ? lower : `coingecko:${lower}`;
    });
}

/** Map {"coingecko:bitcoin": {price, symbol, timestamp}} -> {bitcoin: {...}}. */
export function pickPrices(coinsObj: Record<string, any> | undefined): Record<string, { price: number; symbol: string; timestamp: number }> {
  const out: Record<string, { price: number; symbol: string; timestamp: number }> = {};
  for (const [k, v] of Object.entries(coinsObj ?? {})) {
    const coin = k.replace(/^coingecko:/i, "");
    out[coin] = { price: Number(v?.price), symbol: v?.symbol, timestamp: Number(v?.timestamp) };
  }
  return out;
}

/**
 * Map {"coingecko:bitcoin": {symbol, confidence, prices:[{timestamp,price}]}}
 * -> {bitcoin: {timestamps:[], prices:[]}}. DeFiLlama's chart response nests a
 * single `prices` array of {timestamp, price} objects; we split it into parallel
 * arrays for a clean time-series shape.
 */
export function pickCharts(coinsObj: Record<string, any> | undefined): Record<string, { timestamps: number[]; prices: number[] }> {
  const out: Record<string, { timestamps: number[]; prices: number[] }> = {};
  for (const [k, v] of Object.entries(coinsObj ?? {})) {
    const coin = k.replace(/^coingecko:/i, "");
    const points = Array.isArray(v?.prices) ? v.prices : [];
    out[coin] = {
      timestamps: points.map((p: any) => Number(p?.timestamp)),
      prices: points.map((p: any) => Number(p?.price)),
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Computed value-add: this is the honest reason to charge for a free API.
//   - computeValue(amount, price): USD value of holding `amount` of a coin.
//   - convert / portfolio build on top of it with server-side math.
// ---------------------------------------------------------------------------
export function computeValue(amount: number, price: number): number {
  if (!Number.isFinite(amount) || !Number.isFinite(price)) throw new Error("amount and price must be finite numbers");
  return amount * price;
}

export async function handlePrice(req: Request, res: Response): Promise<void> {
  const coinsRaw = String(req.query.coins ?? "").trim();
  if (!coinsRaw) {
    res.status(400).json({ error: "coins query param required, e.g. ?coins=bitcoin,ethereum,solana" });
    return;
  }
  const ids = parseCoins(coinsRaw);
  if (ids.length > MAX_COINS) {
    res.status(400).json({ error: `too many coins: ${ids.length} (max ${MAX_COINS})` });
    return;
  }
  const target = new URL(`/prices/current/${ids.join(",")}`, upstream);
  let json: any;
  try {
    json = await fetchJsonCached(target, "price");
  } catch (err) {
    log("error", "price_upstream_failed", { detail: String(err) });
    res.status(502).json({ error: "upstream unreachable", detail: String(err) });
    return;
  }
  const coins = pickPrices(json?.coins);
  const missing = ids.map((i) => i.replace(/^coingecko:/, "")).filter((c) => !coins[c]);
  res.json({ coins, count: Object.keys(coins).length, missing, updatedAt: Date.now() });
}

export async function handleHistory(req: Request, res: Response): Promise<void> {
  const coinsRaw = String(req.query.coins ?? "").trim();
  if (!coinsRaw) {
    res.status(400).json({ error: "coins query param required, e.g. ?coins=bitcoin,ethereum&span=30" });
    return;
  }
  const span = Math.min(Math.max(Number(req.query.span ?? "30") || 30, 1), 365);
  const ids = parseCoins(coinsRaw);
  if (ids.length > MAX_COINS) {
    res.status(400).json({ error: `too many coins: ${ids.length} (max ${MAX_COINS})` });
    return;
  }
  const target = new URL(`/chart/${ids.join(",")}?span=${span}`, upstream);
  let json: any;
  try {
    json = await fetchJsonCached(target, "history");
  } catch (err) {
    log("error", "history_upstream_failed", { detail: String(err) });
    res.status(502).json({ error: "upstream unreachable", detail: String(err) });
    return;
  }
  res.json({ span, coins: pickCharts(json?.coins) });
}

export async function handleConvert(req: Request, res: Response): Promise<void> {
  const from = String(req.query.from ?? "").trim().toLowerCase();
  const to = String(req.query.to ?? "").trim().toLowerCase();
  const amountRaw = req.query.amount;
  const amount = typeof amountRaw === "string" ? Number(amountRaw) : NaN;

  if (!from || !to || amountRaw === undefined || !Number.isFinite(amount) || amount <= 0) {
    res.status(400).json({ error: "from, to (coin ids) and a positive numeric amount are required" });
    return;
  }
  const ids = [`coingecko:${from}`, `coingecko:${to}`];
  const target = new URL(`/prices/current/${ids.join(",")}`, upstream);
  let json: any;
  try {
    json = await fetchJsonCached(target, "price");
  } catch (err) {
    log("error", "convert_upstream_failed", { detail: String(err) });
    res.status(502).json({ error: "upstream unreachable", detail: String(err) });
    return;
  }
  const prices = pickPrices(json?.coins);
  const pFrom = prices[from]?.price;
  const pTo = prices[to]?.price;
  if (pFrom === undefined || pTo === undefined) {
    const missing = pFrom === undefined ? from : to;
    res.status(400).json({ error: `unknown or unpriced coin: ${missing}` });
    return;
  }
  const rate = pFrom / pTo;
  res.status(200).json({
    from,
    to,
    amount,
    rate: Number(rate.toFixed(8)),
    converted: Number((amount * rate).toFixed(8)),
    usdValue: Number(computeValue(amount, pFrom).toFixed(2)),
    prices: { [from]: pFrom, [to]: pTo },
  });
}

export async function handlePortfolio(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { holdings?: Array<{ coin?: unknown; amount?: unknown }> };
  const holdings = body.holdings;
  if (!Array.isArray(holdings) || holdings.length === 0) {
    res.status(400).json({ error: "POST a JSON body with holdings: [{ coin, amount }]" });
    return;
  }
  const clean = holdings
    .map((h) => ({ coin: String(h.coin ?? "").trim().toLowerCase(), amount: Number(h.amount) }))
    .filter((h) => h.coin && Number.isFinite(h.amount) && h.amount >= 0);
  if (clean.length === 0) {
    res.status(400).json({ error: "no valid holdings (need { coin, amount }) found" });
    return;
  }
  if (clean.length > MAX_COINS) {
    res.status(400).json({ error: `too many holdings: ${clean.length} (max ${MAX_COINS})` });
    return;
  }
  const ids = clean.map((h) => `coingecko:${h.coin}`);
  const target = new URL(`/prices/current/${ids.join(",")}`, upstream);
  let json: any;
  try {
    json = await fetchJsonCached(target, "price");
  } catch (err) {
    log("error", "portfolio_upstream_failed", { detail: String(err) });
    res.status(502).json({ error: "upstream unreachable", detail: String(err) });
    return;
  }
  const prices = pickPrices(json?.coins);
  let total = 0;
  const positions = clean.map((h) => {
    const price = prices[h.coin]?.price ?? 0;
    const value = computeValue(h.amount, price);
    total += value;
    return { coin: h.coin, amount: h.amount, price, value: Number(value.toFixed(2)) };
  });
  const missing = clean.map((h) => h.coin).filter((c) => !prices[c]);
  res.status(200).json({ totalUsd: Number(total.toFixed(2)), positions, missing });
}

// Captured once at boot so /healthz can report uptime for ops/debugging.
const startedAt = Date.now();

// Structured, machine-readable endpoint catalogue — lets a buyer/client see the
// exact method + path + price per tier. The `tiers` object is the human-facing
// description; this is the programmatic one.
const endpoints = {
  price: { method: "GET", path: "/v1/price", price: stdPrice, description: "real-time token prices (standard)" },
  convert: { method: "GET", path: "/v1/convert", price: premiumPrice, description: "server-computed cross conversion (premium)" },
  portfolio: { method: "POST", path: "/v1/portfolio", price: premiumPrice, description: "server-aggregated portfolio valuation (premium)" },
  history: { method: "GET", path: "/v1/history", price: premiumPrice, description: "historical price time-series (premium)" },
};

const tiers = {
  price: { endpoint: "GET /v1/price", price: stdPrice, description: "real-time token prices (standard)" },
  convert: { endpoint: "GET /v1/convert", price: premiumPrice, description: "server-computed cross conversion (premium)" },
  portfolio: { endpoint: "POST /v1/portfolio", price: premiumPrice, description: "server-aggregated portfolio valuation (premium)" },
  history: { endpoint: "GET /v1/history", price: premiumPrice, description: "historical price time-series (premium)" },
};

// 2. Free discovery.
app.get("/healthz", (_req, res) => {
  res.json({
    ok: true,
    service: "crypto-quote-x402",
    network: chain.network,
    asset: chain.assetSymbol,
    payTo,
    upstream: upstream.origin,
    tiers,
    endpoints,
    rateLimitPerMin: ratePerMin,
    cache: { enabled: true, maxEntries: CACHE_MAX },
    startedAt,
    uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
  });
});

// 3. Payment gate. Every route is explicit — no catch-all — so the FIRST-match
//    `.find()` in x402 can never misprice a more specific route.
app.use(
  paymentMiddleware(
    {
      "GET /v1/price": {
        accepts: { scheme: "exact", price: stdPrice, network: chain.network, payTo, maxTimeoutSeconds: 60 },
        description: "Real-time token prices from DeFiLlama",
        mimeType: "application/json",
      },
      "GET /v1/convert": {
        accepts: { scheme: "exact", price: premiumPrice, network: chain.network, payTo, maxTimeoutSeconds: 60 },
        description: "Server-computed cross conversion (premium)",
        mimeType: "application/json",
      },
      "POST /v1/portfolio": {
        accepts: { scheme: "exact", price: premiumPrice, network: chain.network, payTo, maxTimeoutSeconds: 60 },
        description: "Server-aggregated portfolio valuation (premium)",
        mimeType: "application/json",
      },
      "GET /v1/history": {
        accepts: { scheme: "exact", price: premiumPrice, network: chain.network, payTo, maxTimeoutSeconds: 60 },
        description: "Historical price time-series (premium)",
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

// Paid 200 responses must not be cached by clients, or they'd replay a 200 and
// skip the next payment. (Server-side caching of the upstream data still
// applies upstream of this.) Runs only when the payment gate calls next().
app.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// 4. Paid handlers. Rate limiting is applied here (after the gate), so only paid
//    calls consume the limit. No catch-all: each endpoint is its own route.
app.get("/v1/price", rateLimit, (req: Request, res: Response) => void handlePrice(req, res));
app.get("/v1/convert", rateLimit, (req: Request, res: Response) => void handleConvert(req, res));
app.get("/v1/history", rateLimit, (req: Request, res: Response) => void handleHistory(req, res));
app.post("/v1/portfolio", rateLimit, (req: Request, res: Response) => void handlePortfolio(req, res));

const port = Number(env("PORT", "8080"));
if (process.env.NODE_ENV !== "test") {
  app.listen(port, () => {
    log("info", "listening", {
      port,
      upstream: upstream.origin,
      network: chain.network,
      std: stdPrice,
      premium: premiumPrice,
      payTo,
      rateLimitPerMin: ratePerMin,
    });
  });
}
