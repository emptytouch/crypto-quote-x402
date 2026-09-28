import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app, createRateLimiter, computeValue, fetchUpstream, parseCoins, pickPrices, pickCharts } from "../src/index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /healthz", () => {
  it("returns 200 with network + tier + cache info", async () => {
    const r = await request(app).get("/healthz");
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.network).toBe("eip155:2368");
    expect(r.body.asset).toBe("pieUSD");
    expect(r.body.tiers.price.price).toBe("$0.001");
    expect(r.body.tiers.convert.price).toBe("$0.01");
    expect(r.body.tiers.portfolio.price).toBe("$0.01");
    expect(r.body.tiers.history.price).toBe("$0.01");
    expect(r.body.cache.enabled).toBe(true);
  });
});

describe("unpaid gating", () => {
  it("GET /v1/price returns 402 with PAYMENT-REQUIRED header", async () => {
    const r = await request(app).get("/v1/price?coins=bitcoin,ethereum");
    expect(r.status).toBe(402);
    expect(r.headers["payment-required"]).toBeTruthy();
  });
  it("GET /v1/convert returns 402", async () => {
    const r = await request(app).get("/v1/convert?from=bitcoin&to=ethereum&amount=1");
    expect(r.status).toBe(402);
    expect(r.headers["payment-required"]).toBeTruthy();
  });
  it("GET /v1/history returns 402", async () => {
    const r = await request(app).get("/v1/history?coins=bitcoin&span=30");
    expect(r.status).toBe(402);
    expect(r.headers["payment-required"]).toBeTruthy();
  });
  it("POST /v1/portfolio returns 402", async () => {
    const r = await request(app).post("/v1/portfolio").send({ holdings: [{ coin: "bitcoin", amount: 1 }] });
    expect(r.status).toBe(402);
    expect(r.headers["payment-required"]).toBeTruthy();
  });
});

describe("tiered pricing", () => {
  const decodeAmount = (header: unknown): string => {
    const decoded = JSON.parse(Buffer.from(String(header), "base64").toString("utf8"));
    return String(decoded.accepts[0].amount);
  };

  it("prices premium endpoints above the standard price", async () => {
    const price = await request(app).get("/v1/price?coins=bitcoin");
    const convert = await request(app).get("/v1/convert?from=bitcoin&to=ethereum&amount=1");
    const history = await request(app).get("/v1/history?coins=bitcoin&span=30");
    const priceAmount = decodeAmount(price.headers["payment-required"]);
    const convertAmount = decodeAmount(convert.headers["payment-required"]);
    const historyAmount = decodeAmount(history.headers["payment-required"]);
    expect(BigInt(convertAmount)).toBe(BigInt(historyAmount));
    expect(BigInt(convertAmount)).toBeGreaterThan(BigInt(priceAmount));
  });

  it("charges the standard price for /v1/price", async () => {
    const price = await request(app).get("/v1/price?coins=bitcoin");
    const convert = await request(app).get("/v1/convert?from=bitcoin&to=ethereum&amount=1");
    const priceAmount = decodeAmount(price.headers["payment-required"]);
    const convertAmount = decodeAmount(convert.headers["payment-required"]);
    expect(BigInt(convertAmount)).toBeGreaterThan(BigInt(priceAmount));
  });

  it("POST /v1/portfolio is premium (above standard)", async () => {
    const portfolio = await request(app).post("/v1/portfolio").send({ holdings: [{ coin: "bitcoin", amount: 1 }] });
    const price = await request(app).get("/v1/price?coins=bitcoin");
    const portfolioAmount = decodeAmount(portfolio.headers["payment-required"]);
    const priceAmount = decodeAmount(price.headers["payment-required"]);
    expect(BigInt(portfolioAmount)).toBeGreaterThan(BigInt(priceAmount));
  });
});

describe("rate limiter", () => {
  const mkRes = () => {
    const res: any = { statusCode: 0, body: null };
    res.status = (c: number) => {
      res.statusCode = c;
      return res;
    };
    res.json = (b: unknown) => {
      res.body = b;
      return res;
    };
    return res;
  };
  const mkReq = (ip: string) => ({ ip, path: "/v1/price" }) as any;

  it("allows up to the limit, then returns 429", () => {
    const limiter = createRateLimiter(2);
    let passed = 0;
    const next = () => {
      passed += 1;
    };

    limiter(mkReq("1.2.3.4"), mkRes(), next);
    limiter(mkReq("1.2.3.4"), mkRes(), next);
    const third = mkRes();
    limiter(mkReq("1.2.3.4"), third, next);

    expect(passed).toBe(2);
    expect(third.statusCode).toBe(429);
  });

  it("counts each client separately", () => {
    const limiter = createRateLimiter(1);
    const next = () => {};
    limiter(mkReq("1.1.1.1"), mkRes(), next);
    const other = mkRes();
    limiter(mkReq("2.2.2.2"), other, next);
    expect(other.statusCode).toBe(0); // different client is not limited
  });

  it("is a no-op when disabled", () => {
    const limiter = createRateLimiter(0);
    let passed = 0;
    const next = () => {
      passed += 1;
    };
    for (let i = 0; i < 5; i++) limiter(mkReq("1.2.3.4"), mkRes(), next);
    expect(passed).toBe(5);
  });
});

describe("computeValue", () => {
  it("multiplies amount by price", () => {
    expect(computeValue(2, 50000)).toBe(100000);
  });
  it("throws on non-finite inputs", () => {
    expect(() => computeValue(NaN, 1)).toThrow(/finite/);
    expect(() => computeValue(1, Infinity)).toThrow(/finite/);
  });
});

describe("parseCoins / pickPrices", () => {
  it("normalises bare ids and qualifies them with coingecko:", () => {
    expect(parseCoins("Bitcoin, coingecko:ethereum")).toEqual(["coingecko:bitcoin", "coingecko:ethereum"]);
  });
  it("strips the coingecko: prefix in pickPrices", () => {
    const out = pickPrices({ "coingecko:bitcoin": { price: 60000, symbol: "BTC", timestamp: 1 } });
    expect(out.bitcoin).toEqual({ price: 60000, symbol: "BTC", timestamp: 1 });
  });
});

describe("pickCharts", () => {
  it("splits the prices:[{timestamp,price}] array into parallel arrays", () => {
    const out = pickCharts({
      "coingecko:bitcoin": { symbol: "BTC", confidence: 0.99, prices: [{ timestamp: 1, price: 100 }, { timestamp: 2, price: 200 }] },
    });
    expect(out.bitcoin).toEqual({ timestamps: [1, 2], prices: [100, 200] });
  });
  it("returns empty arrays when prices is missing", () => {
    expect(pickCharts({ "coingecko:ethereum": { symbol: "ETH" } }).ethereum).toEqual({ timestamps: [], prices: [] });
  });
});

describe("fetchUpstream", () => {
  it("forwards method + headers + body to the target URL", async () => {
    const seen: any = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: any, init: any) => {
        seen.url = String(input);
        seen.method = init.method;
        seen.headers = Object.fromEntries((init.headers as Headers).entries());
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const headers = new Headers({ "x-test": "1" });
    const res = await fetchUpstream(new URL("https://coins.llama.fi/prices/current/coingecko:bitcoin"), headers, "GET");
    expect(res.status).toBe(200);
    expect(seen.url).toBe("https://coins.llama.fi/prices/current/coingecko:bitcoin");
    expect(seen.method).toBe("GET");
    expect(seen.headers["x-test"]).toBe("1");
  });
});

describe("CORS", () => {
  it("answers OPTIONS preflight with 204 + CORS headers on paid routes", async () => {
    const r = await request(app).options("/v1/price");
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-origin"]).toBe("*");
    expect(r.headers["access-control-allow-headers"]).toContain("X-PAYMENT");
  });
  it("exposes CORS headers on the 402 challenge", async () => {
    const r = await request(app).get("/v1/price?coins=bitcoin");
    expect(r.headers["access-control-allow-origin"]).toBe("*");
    expect(r.headers["access-control-expose-headers"]).toContain("payment-required");
  });
});
