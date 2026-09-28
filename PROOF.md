# Paid-call proof (x402 on Kite testnet `eip155:2368`, pieUSD)

Every paid endpoint below settled on-chain via the Kite facilitator
(`facilitator.pieverse.io/v2`). Hashes are reproducible: run
`npm run selfpay` (see README) against the deployed service with any Kite
testnet key holding pieUSD.

## Verified transactions

| Endpoint | Tier | Price | Tx hash | Buyer |
|---|---|---|---|---|
| `GET /v1/price` | standard | $0.001 | 0x755cfeeb36bd8b29d6a1c8935e7e9076539fc0b31baa6d52720fc611be2faad4 | 0x92DF53ED56E3baCc6b9F2b1E10ACdA5355Fbf9C9 |
| `GET /v1/convert` | premium | $0.01 | 0xa5f6f67dfd6b6ad3be2f4443137aa4e7499e7e616a2e215a590de8c2daded84a | 0x92DF53ED56E3baCc6b9F2b1E10ACdA5355Fbf9C9 |
| `POST /v1/portfolio` | premium | $0.01 | 0x775689314d8db3d609f0e241a1ed7d5debc42e7918cb6f62bad49eb2388c3047 | 0x92DF53ED56E3baCc6b9F2b1E10ACdA5355Fbf9C9 |
| `GET /v1/history` | premium | $0.01 | 0x35ac542c5787147201ceaaacb479efbee56285a8fd6e916a35793d82928dba89 | 0x92DF53ED56E3baCc6b9F2b1E10ACdA5355Fbf9C9 |

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
