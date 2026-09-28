# Frankfurter x402 service — minimal Node 22 image for Hugging Face Spaces (Docker SDK)
FROM node:22-alpine

WORKDIR /app

# Install deps first to leverage the layer cache.
# npm ci requires package-lock.json (committed). It keeps devDependencies by
# default, which we NEED because `npm start` runs via tsx (a devDependency).
COPY package.json package-lock.json ./
RUN npm ci

# Copy the rest of the service source.
COPY . .

# HF Spaces (and Replit) inject PORT; the app reads it via process.env.PORT.
# Keep a sane fallback for local `docker run`.
ENV PORT=7860
EXPOSE 7860

# Liveness probe so HF / UptimeRobot can confirm the service is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT}/healthz" >/dev/null 2>&1 || exit 1

# Equivalent to `tsx src/index.ts` — runs the x402 proxy.
CMD ["npm", "start"]
