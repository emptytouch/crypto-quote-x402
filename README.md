# Crypto Market Data (x402 on Kite)

Wraps the free, open [DeFiLlama](https://coins.llama.fi) price API as an x402
service on the Kite chain, and adds **server-computed value** on top: a
cross-conversion endpoint and a portfolio-valuation endpoint. Built from the
official `typescript-express` x402 template, then extended well past the stock
wrapper.

| | |
|---|---|
| `GET /v1/price` | real-time token prices → `https://coins.llama.fi/prices/prettified` |
| `GET /v1/convert` | **computed** cross conversion, e.g. `/v1/convert?from=bitcoin&to=ethereum&amount=1` |
| `POST /v1/portfolio` | **computed** portfolio valuation, body `{ holdings: [{coin, amount}] }` |
| `GET /v1/history` | historical price time-series, e.g. `/v1/history?coins=bitcoin&span=30` |
| Price | `price` **$0.001**; `convert` / `portfolio` / `history` **$0.01** (pieUSD, Kite testnet `eip155:2368`) |
| Upstream auth | none (DeFiLlama is free & keyless) |
| Deployed | `status: testnet` — https://crypto-quote-x402.onrender.com |
| Paid proof | see `PROOF.md` |

## Why this is more than a `.env`-only wrapper

DeFiLlama is already keyless and free, so the value we add is the *computation*
and the *packaging* — not proxying a paywalled API. This service extends the
stock template with four production layers:

1. **Tiered pricing** — a single live price snapshot is cheap; the server-computed
   `convert` and `portfolio` endpoints and the `history` time-series (far larger
   payload) are premium. The split reflects *value*, not upstream cost.
2. **Computed value-add (`/v1/convert`, `/v1/portfolio`)** — the honest reason
   to charge for a free API: the buyer pays for arithmetic (price lookup + math),
   not just a proxied endpoint. `portfolio` aggregates many coins into one USD
   total; `convert` turns a quantity of one coin into the equivalent of another.
3. **Read-through cache** with TTL + `Age`/`Cache-Control`: live `price` is cached
   briefly (60s, near real-time), `history` is immutable and cached long (30d).
   Cuts upstream load. Payment still happens per request — caching only saves the
   upstream call.
4. **Per-client rate limiting + structured JSON logs**, applied *after* the
   payment gate, so only paid calls consume the limit.

### Routing note (a real x402 footgun, avoided here)

x402's `paymentMiddleware` matches routes with `.find()` and returns the **first**
hit. A catch-all like `"GET /v1/*"` placed before specific routes silently
swallows them and misprices them (we hit this on frankfurter-x402, where
`/v1/convert` was being charged the standard price). This service registers
**every** paid route as a fully explicit `"METHOD /path"` key — no catch-all — so
mis-pricing is structurally impossible.

## Architecture

```
            buyer
              │  GET /v1/price | /v1/convert | POST /v1/portfolio | GET /v1/history
              ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  crypto-quote-x402 (Express, this repo)                       │
   │                                                                │
   │   /healthz ──────────────► 200 (free discovery)                │
   │                                                                │
   │   paymentMiddleware ─────► 402 + PAYMENT-REQUIRED (exact,       │
   │   (x402 gate)                 pieUSD, eip155:2368)             │
   │        │ verified                                              │
   │        ▼                                                       │
   │   rateLimit (per-IP) ──► 429 when over RATE_LIMIT_PER_MIN       │
   │        │                                                       │
   │        ├── /v1/convert ─► computeValue()  (local math)          │
   │        ├── /v1/portfolio ─► computeValue() per position (math)  │
   │        ├── /v1/price ───► fetchJsonCached() ──┐                 │
   │        └── /v1/history ──► fetchJsonCached() ─┤                 │
   │                                               │ miss            │
   │                          ┌────────────────────┴────────┐        │
   │                          │  in-memory cache (TTL)      │         │
   │                          └────────────┬────────────────┘         │
   │                                       │ hit / miss                │
   │                                       ▼                          │
   │                          DeFiLlama API (coins.llama.fi)          │
   └──────────────────────────────────────────────────────────────┘
              │ settle (EIP-3009 transferWithAuthorization)
              ▼
        Kite facilitator (facilitator.pieverse.io/v2)
              │
              ▼
        Kite chain · pieUSD (eip155:2368)
```

## Tiered pricing

| Endpoint | Tier | Price | Notes |
|---|---|---|---|
| `GET /v1/price` | standard | $0.001 | real-time snapshot of N coins |
| `GET /v1/convert` | premium | $0.01 | server-computed cross conversion |
| `POST /v1/portfolio` | premium | $0.01 | server-aggregated portfolio USD value |
| `GET /v1/history` | premium | $0.01 | historical time-series (large payload) |

Prices are env-driven: `PRICE_USD` (standard), `PRICE_USD_PREMIUM` (convert /
portfolio / history).

## Run locally

```bash
npm install
cp .env.example .env     # set PAY_TO to your Kite wallet
npm start                # tsx src/index.ts, listens on $PORT (default 8080)
```

Any host that runs Node 22 works (Render, Fly, Cloud Run, a VPS). The service
must be reachable over public https: Kite Passport fetches the URL server-side,
so `localhost` and tunnels that require a browser check will not work.

## Try it

```bash
curl -i "$BASE_URL/healthz"
# 200 { ok:true, network:"eip155:2368", asset:"pieUSD", tiers:{...}, rateLimitPerMin:10, cache:{...} }

curl -i "$BASE_URL/v1/price?coins=bitcoin,ethereum,solana"
# 402 with a PAYMENT-REQUIRED header until a payment is attached
# paid -> 200 { coins:{ bitcoin:{price,symbol,timestamp}, ... }, count, missing }

curl -i "$BASE_URL/v1/convert?from=bitcoin&to=ethereum&amount=1"
# paid -> 200 { from, to, amount, rate, converted, usdValue, prices }

curl -i -X POST "$BASE_URL/v1/portfolio" -H 'content-type: application/json' \
  -d '{"holdings":[{"coin":"bitcoin","amount":1},{"coin":"ethereum","amount":10}]}'
# paid -> 200 { totalUsd, positions:[{coin,amount,price,value}], missing }

curl -i "$BASE_URL/v1/history?coins=bitcoin&span=30"
# paid -> 200 { span, coins:{ bitcoin:{timestamps,prices}, ... } }
```

### Self-pay buyer script (verify payment yourself)

`kpass session execute` currently refuses this host client-side — Kite's
executable-service catalog does not yet include `crypto-quote-x402.onrender.com`
— so use the buyer script, which signs the EIP-3009 payment directly:

```bash
# any Kite testnet key holding pieUSD
BUYER_PRIVATE_KEY=0x... npm run selfpay

# or a Kite Passport sandbox session
KITE_SESSION_FILE=/path/to/sessions.json npm run selfpay

# pick an endpoint
QUOTE_ENDPOINT=convert Q_FROM=bitcoin Q_TO=ethereum Q_AMOUNT=1 npm run selfpay
QUOTE_ENDPOINT=portfolio HOLDINGS='[{"coin":"bitcoin","amount":1}]' npm run selfpay
QUOTE_ENDPOINT=history COINS=bitcoin,ethereum SPAN=30 npm run selfpay
```

Settlement tx hashes are appended to `proof/paid-calls.jsonl`.

## Cache

`price` is cached for 60s (near real-time); `history` is immutable and cached for
30d (capped at 200 entries, LRU-ish eviction). Cache hits replay the stored
response with an `Age` header and a `public, max-age=…` `Cache-Control`. Only
successful GETs are cached.

## Rate limiting & logs

`RATE_LIMIT_PER_MIN` (default 10, `0` disables) caps paid requests per client IP.
Logs are one-line JSON: `listening`, `proxy_ok`/`cache_hit`, `upstream_unreachable`,
`rate_limited`, `*_upstream_failed`.

## Tests

```bash
npm test
```

Covers: `/healthz` shape, the 402 gate on all four endpoints, tiered-amount
assertions (premium > standard, premium endpoints equal), rate-limiter unit
tests, `computeValue` math, `parseCoins`/`pickPrices` normalisation, and
`fetchUpstream` forwarding. The facilitator is mocked locally (no network).

## Status

`testnet`. The service answers the x402 challenge on `eip155:2368` in pieUSD.
A paid call has settled on-chain — see `PROOF.md`. Unpaid → `402`, paid → `200`
with the DeFiLlama payload (or the computed result for `convert`/`portfolio`).

## Related contribution

Proposed to the KiteAI community catalog as a `services/crypto-quote-x402`
entry in [`gokite-ai/kite-x402-services`](https://github.com/gokite-ai/kite-x402-services).
