# All application state lives outside the image. See docs/docker.md.
ARG BUN_VERSION=1.4.2
FROM oven/bun:${BUN_VERSION}-debian AS bun
FROM mcr.microsoft.com/powershell:7.4-debian-12 AS powershell
FROM node:22-bookworm-slim AS base
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=powershell /opt/microsoft/powershell/7 /opt/microsoft/powershell/7
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git gh openssh-client curl unzip ripgrep python3 procps libicu72 libgssapi-krb5-2 \
 && ln -s /opt/microsoft/powershell/7/pwsh /usr/local/bin/pwsh \
 && rm -rf /var/lib/apt/lists/*

FROM base AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts --backend=copyfile
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# .next/cache holds only the build-time webpack cache (~750MB); the server does not read it.
RUN bun bin/prepare-runtime.js --source && bun run build \
 && node Tools/CUELO_Setup/files/native-runtime-patch.js --target /app \
 && rm -rf .next/cache

FROM base AS runtime
ARG UID=1000
ARG GID=1000
# The Node base already owns uid/gid 1000; rename it rather than creating a duplicate.
RUN groupmod --gid "${GID}" node && usermod --uid "${UID}" --gid "${GID}" --login omp --home /home/omp --move-home node \
 && mkdir -p /home/omp/.omp/agent /workspace && chown -R omp:node /home/omp /workspace
WORKDIR /app
COPY --from=build --chown=omp:node /app/node_modules ./node_modules
COPY --from=build --chown=omp:node /app/.next ./.next
COPY --from=build --chown=omp:node /app/public ./public
COPY --from=build --chown=omp:node /app/bin ./bin
COPY --from=build --chown=omp:node /app/Tools ./Tools
COPY --from=build --chown=omp:node /app/next.config.ts /app/package.json /app/install.mjs ./
RUN bun bin/prepare-runtime.js --check
ENV HOME=/home/omp NODE_ENV=production PORT=30141 CUELO_NO_OPEN=1 OMP_EXE=/app/node_modules/.bin/omp
VOLUME ["/home/omp/.omp", "/workspace"]
EXPOSE 30141
USER omp
WORKDIR /workspace
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
 CMD bun /app/install.mjs health
ENTRYPOINT ["bun", "/app/bin/docker-entrypoint.mjs"]
