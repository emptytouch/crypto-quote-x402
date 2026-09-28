/**
 * Self-pay buyer client for crypto-quote-x402.
 *
 * x402 payments are signed with an EIP-3009 authorization, so this script
 * reproduces the buyer side without a wallet UI: it calls a paid endpoint from
 * the deployed service, pays the request, and records the settlement tx hash to
 * proof/paid-calls.jsonl — reproducible evidence that the endpoint really
 * settles on-chain.
 *
 * It is deliberately agnostic about *who* pays: any Kite testnet key holding
 * pieUSD works, so a reviewer can run this themselves instead of trusting a
 * screenshot.
 *
 * Key resolution order:
 *   1. BUYER_PRIVATE_KEY  — raw hex key (0x...); simplest for automation/CI
 *   2. KITE_SESSION_FILE  — explicit path to a Kite Passport sandbox sessions.json
 *   3. auto-detect        — ./.kite-passport/..., ~/.kite-passport/..., legacy path
 *
 * Which endpoint to call (QUOTE_ENDPOINT, default "price"):
 *   price     -> GET  /v1/price?coins=bitcoin,ethereum,solana      (COINS)
 *   convert   -> GET  /v1/convert?from=bitcoin&to=ethereum&amount=1 (Q_FROM/Q_TO/Q_AMOUNT)
 *   history   -> GET  /v1/history?coins=bitcoin&span=30            (COINS, SPAN)
 *   portfolio -> POST /v1/portfolio  body {holdings:[{coin,amount}]}  (HOLDINGS json)
 *
 * Prereqs:
 *   - the service is deployed and BASE_URL points at it
 *   - the paying key holds testnet pieUSD on eip155:2368
 *   - `npm install` has run (provides @x402/*, viem, undici)
 *   - if your network needs a proxy to reach foreign hosts (onrender.com /
 *     facilitator.pieverse.io), export HTTPS_PROXY=http://<host>:<port> first;
 *     the script routes all fetches through it automatically.
 *
 * Run:
 *   BUYER_PRIVATE_KEY=0x... node examples/paid-call.mjs
 *   KITE_SESSION_FILE=/path/to/sessions.json node examples/paid-call.mjs
 *   QUOTE_ENDPOINT=convert Q_FROM=bitcoin Q_TO=ethereum Q_AMOUNT=1 node examples/paid-call.mjs
 */
import { x402Client } from "@x402/core/client";
import { x402HTTPClient } from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Proxy support: Node's global fetch (undici) ignores HTTPS_PROXY by default, so
// on a machine that needs a proxy to reach foreign hosts (onrender.com,
// facilitator.pieverse.io) every call fails with ECONNRESET. If a proxy env var
// is present, route ALL fetches through it via undici's global dispatcher.
const proxyUrl =
  process.env.HTTPS_PROXY || process.env.https_proxy ||
  process.env.HTTP_PROXY || process.env.http_proxy;
if (proxyUrl) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log("proxy         :", proxyUrl);
}

const NET = "eip155:2368";
const ASSET = "0x38129cf4CE5E183eFF248F42A7D345Bb1B47621A"; // pieUSD
const BASE = (process.env.BASE_URL || "https://crypto-quote-x402.onrender.com").replace(/\/$/, "");

const norm = (k) => (k.startsWith("0x") ? k : `0x${k}`);

function resolvePrivateKey() {
  const raw = (process.env.BUYER_PRIVATE_KEY || "").trim();
  if (raw) return norm(raw);

  const candidates = [];
  if (process.env.KITE_SESSION_FILE) candidates.push(process.env.KITE_SESSION_FILE);
  candidates.push(
    path.join(process.cwd(), ".kite-passport", "sandbox", "sessions.json"),
    path.join(os.homedir(), ".kite-passport", "sandbox", "sessions.json"),
    "D:/Web3/kiteai/kpass/.kite-passport/sandbox/sessions.json", // legacy dev-machine location
  );

  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    try {
      const sess = JSON.parse(fs.readFileSync(file, "utf8"));
      const pk = sess?.sessions?.[sess.current_session_id]?.private_key;
      if (pk) {
        console.log("session file :", file);
        return norm(pk);
      }
    } catch {
      /* try the next candidate */
    }
  }

  throw new Error(
    "No buyer key found.\n" +
      "  Set BUYER_PRIVATE_KEY=0x<hex>  (a Kite testnet key holding pieUSD), or\n" +
      "  Set KITE_SESSION_FILE=/path/to/sessions.json  (Kite Passport sandbox session).\n" +
      "  Searched: " +
      candidates.join(", "),
  );
}

const account = privateKeyToAccount(resolvePrivateKey());
console.log("payer address :", account.address);

const coreClient = x402Client.fromConfig({
  schemes: [{ network: NET, client: new ExactEvmScheme(toClientEvmSigner(account)) }],
  spendControls: { allowedAssets: [{ network: NET, asset: ASSET }] },
});
const client = new x402HTTPClient(coreClient);

// Build the target URL + optional POST body for the chosen endpoint.
const endpoint = (process.env.QUOTE_ENDPOINT || "price").toLowerCase();
let path2;
let label;
let method = "GET";
let postBody = undefined;
switch (endpoint) {
  case "convert": {
    const from = (process.env.Q_FROM || "bitcoin").toLowerCase();
    const to = (process.env.Q_TO || "ethereum").toLowerCase();
    const amount = process.env.Q_AMOUNT || "1";
    path2 = `/v1/convert?from=${from}&to=${to}&amount=${amount}`;
    label = `convert ${amount} ${from}->${to}`;
    break;
  }
  case "history": {
    const coins = process.env.COINS || "bitcoin,ethereum";
    const span = process.env.SPAN || "30";
    path2 = `/v1/history?coins=${coins}&span=${span}`;
    label = `history ${coins} ${span}d`;
    break;
  }
  case "portfolio": {
    const holdingsRaw = process.env.HOLDINGS || '[{"coin":"bitcoin","amount":1},{"coin":"ethereum","amount":10}]';
    let holdings;
    try {
      holdings = JSON.parse(holdingsRaw);
    } catch {
      throw new Error("HOLDINGS must be a JSON array of {coin, amount}");
    }
    path2 = "/v1/portfolio";
    method = "POST";
    postBody = JSON.stringify({ holdings });
    label = `portfolio (${holdings.length} positions)`;
    break;
  }
  case "price":
  default: {
    const coins = process.env.COINS || "bitcoin,ethereum,solana";
    path2 = `/v1/price?coins=${coins}`;
    label = `price ${coins}`;
    break;
  }
}

const url = `${BASE}${path2}`;
console.log(`endpoint       : ${label} (${method})`);
console.log(`url            : ${url}`);

const proofDir = path.join(process.cwd(), "proof");
fs.mkdirSync(proofDir, { recursive: true });
const outFile = path.join(proofDir, "paid-calls.jsonl");

const r1 = await fetch(url, { method });
console.log("unpaid status:", r1.status);
const pr = client.getPaymentRequiredResponse((n) => r1.headers.get(n));
const payload = await client.createPaymentPayload(pr);
const a = payload?.payload?.authorization;
console.log("authorization:", a ? `${a.from} -> ${a.to} value=${a.value}` : "(n/a)");

const paid = await fetch(url, {
  method,
  headers: { ...client.encodePaymentSignatureHeader(payload), ...(postBody ? { "content-type": "application/json" } : {}) },
  body: postBody,
});
console.log("PAID status  :", paid.status);
let settle = null;
try {
  settle = client.getPaymentSettleResponse((n) => paid.headers.get(n));
} catch (e) {
  console.log("settle parse err:", e.message);
}
const txt = await paid.text();
console.log("body         :", txt.slice(0, 300));

const record = {
  url,
  method,
  endpoint,
  label,
  unpaid_status: r1.status,
  accepts: pr.accepts,
  authorization: a || null,
  paid_status: paid.status,
  settlement: settle,
  body: txt,
};
fs.appendFileSync(outFile, JSON.stringify(record) + "\n");

console.log("\n================ SUMMARY");
console.log(`| ${label} | ${paid.status} | ${settle?.transaction ?? "(none)"} |`);
console.log(`\nWrote 1 record to ${outFile}`);
