# Paid-call proof (x402 on Kite testnet `eip155:2368`, pieUSD)

Every paid endpoint below settled on-chain via the Kite facilitator
(`facilitator.pieverse.io/v2`). Hashes are reproducible: run
`npm run selfpay` (see README) against the deployed service with any Kite
testnet key holding pieUSD.

## Verified transactions

| Endpoint | Tier | Price | Tx hash | Buyer |
|---|---|---|---|---|
| `GET /v1/price` | standard | $0.001 | _(run `npm run selfpay`)_ | |
| `GET /v1/convert` | premium | $0.01 | _(run `npm run selfpay`)_ | |
| `POST /v1/portfolio` | premium | $0.01 | _(run `npm run selfpay`)_ | |
| `GET /v1/history` | premium | $0.01 | _(run `npm run selfpay`)_ | |

## How to (re)generate proof after a deploy

```bash
# standard: price snapshot
QUOTE_ENDPOINT=price COINS=bitcoin,ethereum,solana npm run selfpay

# premium: computed cross conversion
QUOTE_ENDPOINT=convert Q_FROM=bitcoin Q_TO=ethereum Q_AMOUNT=1 npm run selfpay

# premium: computed portfolio valuation
QUOTE_ENDPOINT=portfolio HOLDINGS='[{"coin":"bitcoin","amount":1},{"coin":"ethereum","amount":10}]' npm run selfpay

# premium: historical time-series
QUOTE_ENDPOINT=history COINS=bitcoin,ethereum SPAN=30 npm run selfpay
```

Each run appends the settlement tx to `proof/paid-calls.jsonl`. After all four
endpoints are paid, regenerate the table above with:

```bash
npm run proof
```

Paste the four hashes into the bounty dashboard and the `gokite-ai/kite-x402-services` PR.
