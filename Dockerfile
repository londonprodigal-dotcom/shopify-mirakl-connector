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
RUN mkdir -p /app/state /mnt/templates
CMD ["node", "dist/index.js", "sync", "--incremental", "--templates-path", "/mnt/templates"]
