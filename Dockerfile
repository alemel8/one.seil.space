# Multi-stage build pro produkční Node.js aplikaci
# Final image jen runtime, bez build deps a dev závislostí

FROM node:20-alpine AS deps
WORKDIR /app

# Install build deps potřebné pro better-sqlite3 native binding
RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev


FROM node:20-alpine AS runtime
WORKDIR /app

# Bezpečnost: aplikace neběží jako root
RUN addgroup -g 1001 -S app && adduser -S app -u 1001 -G app

# Pouze production node_modules
COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app . .

# Nepotřebné v image
RUN rm -rf .git .github test/ data/ .env* docs/

# Nasaď non-root user
USER app

EXPOSE 3000

# Healthcheck pro Coolify/Docker
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
