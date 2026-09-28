# 部署到公开 HTTPS（免费 · 不绑卡）

本服务是标准 Node 22 / Express 应用。下面用 **Render 免费 Web Service** 把它跑成公开 HTTPS 服务，**全程免费、不需要信用卡**，再用 **UptimeRobot** 免卡保活。

> ⚠️ **不要用 Hugging Face Spaces。** HF 已于 2025 年把 **Docker / Gradio Space 改为付费（PRO）**，免费只剩 Static（跑不了服务端）。本指南已从 HF 切换到 Render。

---

## 0. 为什么 Render 是当前首选

| 平台 | 免卡 | 免费额度 | 跑 Node 服务 | 公开 HTTPS | 休眠 |
|---|---|---|---|---|---|
| **Render** ⭐ | ✅ 不需要卡 | 750 实例小时/月 | ✅ 原生支持 Node | ✅ `*.onrender.com` | 15 分钟无流量休眠 |
| Koyeb | ✅ 不需要卡 | 1 个免费 Web 服务 | ✅ 支持 Docker | ✅ `*.koyeb.app` | 会休眠 |
| SnapDeploy | ✅ 不需要卡 | 10 次部署/天，4 容器 | ✅ 支持 Docker | ✅ 公开 URL | 45 分钟休眠 |
| ~~HF Spaces (Docker)~~ | ❌ 已改付费 | — | — | — | — |
| Fly / Cloud Run / VPS | ❌ 需国际卡 | — | — | — | — |

> 若 Render 注册时意外要卡，直接改用 **Koyeb**（同样免卡、支持 Dockerfile）。

---

## 1. 准备一个含服务内容的 GitHub 仓库

Render 直接连 GitHub。两种方式任选：

**方式 A（推荐，独立仓库）**——把本服务平铺到一个只含服务的仓库（`Dockerfile` 在根目录）：
```bash
# 已就绪：D:\Web3\kiteai\crypto-quote-x402
cd /d/Web3/kiteai/crypto-quote-x402
git init && git add -A && git commit -m "crypto-quote x402 service"
git remote add origin https://github.com/<你>/crypto-quote-x402.git
git push -u origin main
```

**方式 B（不另开仓库）**——直接用主 fork 仓库 `kite-x402-services`，稍后把 Render 的 **Root Directory** 设为 `services/crypto-quote-x402` 即可。

> `.env` / `node_modules` 已被 `.dockerignore` / `.gitignore` 排除，不会进仓库；真实密钥只放在 Render 的环境变量面板里。

---

## 2. 在 Render 建 Web Service

1. 注册 https://render.com （用 GitHub 或邮箱登录，免费层不绑卡）
2. Dashboard → **New** → **Web Service**
3. 连接你的 GitHub 仓库（首次需授权 Render 访问 GitHub）
   - 方式 B 的话，把 **Root Directory** 填 `services/crypto-quote-x402`
4. 关键配置：
   | 项 | 值 |
   |---|---|
   | Language / Runtime | **Node**（若用 Dockerfile 则 Render 自动识别为 Docker） |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Instance Type | **Free** |
   | Health Check Path | `/healthz` |
5. **Create Web Service**

> `npm install`（不带 `--omit=dev`）会保留 `tsx`，这是必须的——`npm start` 靠它跑 TS。**不要设 `NODE_ENV=production`**。

---

## 3. 设置环境变量

Render → 你的服务 → **Environment** → 添加：

| 变量名 | 值 | 说明 |
|---|---|---|
| `PAY_TO` | `0x9e610cd701472bf7c815a6404b6ff88d81838c91` | 你的 Kite 钱包（收款地址） |
| `KITE_NETWORK` | `testnet` | 走 `eip155:2368` + 免费 pieUSD，与 service.yaml 一致 |
| `UPSTREAM_URL` | `https://coins.llama.fi` | 被代理的上游（DeFiLlama，免费 keyless） |
| `PRICE_USD` | `0.001` | 标准档：`/v1/price`（字符串） |
| `PRICE_USD_PREMIUM` | `0.01` | 溢价档：`/v1/convert` / `/v1/portfolio` / `/v1/history`（字符串） |
| `RATE_LIMIT_PER_MIN` | `10` | 每客户端付费请求限流；`0` 关闭 |

> **不要手动设 `PORT`**——Render 自动注入（默认 10000），应用已读 `process.env.PORT`。保存后 Render 会自动重新部署。

**改动 env 不会自动重新部署**（见主仓库 `render-x402-deploy` 笔记）：改完变量后需到 Render 手动触发一次 **Manual Deploy**（Clear build cache 可选）。本服务代码改动走 push → 因为是用 Render API 建的实例，**push 也不会自动触发部署**，同样需要手动 Deploy。

---

## 4. 验证服务

```bash
BASE=https://<你的服务名>.onrender.com

# 健康检查：应返回 JSON，含 network / asset / tiers
curl $BASE/healthz

# 未付费应返回 402（证明 x402 中间件生效）
curl -i "$BASE/v1/price?coins=bitcoin,ethereum" | head -5
# 期望看到 HTTP/2 402 + PAYMENT-REQUIRED 头
```

> 首次请求若遇冷启动（30–60s），多等一会或先 `curl $BASE/healthz` 唤醒。

---

## 5. 保活（免费层 15 分钟休眠）

Render 免费实例 15 分钟无流量会休眠，冷启动 30–60s 会撞上 x402 的 60s 支付窗口。用 **UptimeRobot**（免费、不绑卡、邮箱注册）每 5 分钟 ping：

1. 注册 https://uptimerobot.com
2. **Add New Monitor** → Type: **HTTP(s)**
3. URL：`https://<你的服务名>.onrender.com/healthz`
4. Monitoring Interval：**Every 5 minutes**
5. 保存

---

## 6. 回到主仓库：升 testnet + 填 base_url

拿到域名后，把 `service.yaml` 从 `draft` 升到 `testnet` 并填 `base_url`（无路径的 https）：
```yaml
status: testnet
base_url: https://<你的服务名>.onrender.com
```
然后在仓库根目录重跑校验：
```bash
cd /d/Web3/kiteai/kite-x402-services
npm run validate        # 应：N service manifest(s) valid
```

---

## 7. 下一步（测试网付费证明）

用 Kite Passport 的 sandbox agent 自付一次，拿到交易哈希，作为"真实付费调用"证据贴 PR。四端点都要各跑一次（`QUOTE_ENDPOINT=price|convert|portfolio|history`），然后 `npm run proof` 自动回填 `PROOF.md` 表格。

---

## 费用与限制说明

- **完全免费、不绑卡**，只要不超 Render 免费额度（750 实例小时/月）。
- 免费服务 **15 分钟无流量会休眠**，靠 UptimeRobot 保活缓解；真用户在保活间隙命中仍可能冷启动。
- 适合：testnet 验证、demo、作品集、AI 工具后端。
- **不适合**：长期 `live`（真实资金、要稳定接客）——那时再换正经 VPS / 云。
