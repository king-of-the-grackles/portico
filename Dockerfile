# syntax=docker/dockerfile:1
# Builds Portico as a single executable, then copies it into a small Debian image.
FROM oven/bun:1.4.2 AS build
WORKDIR /src
COPY package.json bun.lock ./
COPY server/package.json server/package.json
COPY plugin-claude-code/package.json plugin-claude-code/package.json
RUN bun install --frozen-lockfile
COPY server server
# portico join reuses the plugin's join code (plugin-claude-code/src/cli-run.ts), so the bundle needs it too.
COPY plugin-claude-code/src plugin-claude-code/src
RUN bun build server/src/cli.ts --compile --no-compile-autoload-bunfig --outfile /out/portico

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --user-group --home-dir /data --no-create-home portico \
 && mkdir -p /data /config \
 && chown portico:portico /data
COPY --from=build /out/portico /usr/local/bin/portico
COPY docker/entrypoint.sh /usr/local/bin/entrypoint
RUN chmod 755 /usr/local/bin/entrypoint
ENV PORT=8790 PORTICO_DB_PATH=/data/portico.db PORTICO_CONFIG=/config/portico.yaml
WORKDIR /data
EXPOSE 8790
VOLUME ["/data"]
ENTRYPOINT ["/usr/local/bin/entrypoint"]
CMD ["serve"]
