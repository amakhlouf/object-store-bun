FROM oven/bun:1.4

WORKDIR /app

# Install dependencies first, so code-only changes reuse this cached layer.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

# Data and logs live in a volume at /data. The image's non-root "bun" user must own it.
# LOG_DIR must sit inside the volume: ./logs would resolve to /app/logs, which bun cannot create.
ENV PORT=3000 \
	DATA_DIR=/data \
	LOG_DIR=/data/logs
RUN mkdir /data && chown bun:bun /data
VOLUME /data

USER bun
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
	CMD bun -e "fetch('http://localhost:' + Bun.env.PORT + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["bun", "src/index.ts"]
