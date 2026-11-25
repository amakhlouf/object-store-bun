FROM oven/bun:1.4

WORKDIR /app

# Install dependencies first, so code-only changes reuse this cached layer.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

# Data and logs live in a volume at /data. The image's non-root "bun" user must own it.
ENV PORT=3000 \
	DATA_DIR=/data
RUN mkdir /data && chown bun:bun /data
VOLUME /data

USER bun
# Documents the port the server listens on. It follows PORT, which defaults to 3000 above and can be overridden at run time.
EXPOSE $PORT

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
	CMD bun -e "fetch('http://localhost:' + Bun.env.PORT + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["bun", "src/index.ts"]
