FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package*.json ./
COPY mapping.yaml ./
COPY templates/ ./templates/
RUN echo "=== Template files in image ===" && ls -la /app/templates/ && echo "=== End template list ==="
RUN mkdir -p /app/state /app/output /app/reports
CMD ["node", "dist/index.js", "sync", "--incremental"]
