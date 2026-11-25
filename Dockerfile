FROM oven/bun:1.4-slim

WORKDIR /app

# Install dependencies first, so code-only changes reuse this cached layer.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src

# Data and logs live in a volume at /data, and backups in a separate volume at /backups, outside the data.
# IN_CONTAINER=1 makes the app use those two folders whatever DATA_DIR or BACKUP_DIR say, so a shared .env can't move them.
# The image's non-root "bun" user must own both.
ENV IN_CONTAINER=1
RUN mkdir /data /backups && chown bun:bun /data /backups
VOLUME /data /backups

USER bun
# The container always listens on 3000. The --port flag below beats any PORT in the environment, so a shared .env can't move it.
# To reach it from the host, map a port when you run it (docker run -p 8080:3000, or ports: in compose).
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
	CMD bun -e "fetch('http://localhost:3000/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

CMD ["bun", "src/index.ts", "--port=3000"]
