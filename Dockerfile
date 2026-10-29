FROM node:24-bookworm-slim

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DB_PATH=/app/data/cartera.db \
    PYTHON=python3

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pandas python3-openpyxl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node public ./public
COPY --chown=node:node server ./server
COPY --chown=node:node etl ./etl

RUN mkdir -p /app/data /app/respaldos /app/tmp \
    && chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status===200?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
