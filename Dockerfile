FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && echo "=== BUILD FINGERPRINT ===" && head -1 dist/worker/handlers/stockReconcile.js && grep -c expectedSellingPrice dist/worker/handlers/stockReconcile.js && echo "=== END ==="

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY mapping.yaml ./
COPY templates/ ./templates/
COPY src/db/migrations/ ./dist/db/migrations/
RUN mkdir -p /app/state /app/output /app/reports
# Default: run the webhook server.
# Worker service overrides: node dist/index.js worker
CMD ["node", "dist/index.js", "server"]
