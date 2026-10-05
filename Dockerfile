ARG NODE_IMAGE=docker.m.daocloud.io/library/node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG PLAYWRIGHT_DOWNLOAD_HOST=https://registry.npmmirror.com/-/binary/playwright
ARG DEBIAN_MIRROR=http://mirrors.aliyun.com/debian
ARG DEBIAN_SECURITY_MIRROR=http://mirrors.aliyun.com/debian-security
ARG COMPOSE_VERSION=2.39.2

FROM ${NODE_IMAGE} AS dependencies

ARG NPM_REGISTRY
ARG DEBIAN_MIRROR
ARG DEBIAN_SECURITY_MIRROR

WORKDIR /app

RUN sed -i \
  -e "s#http://deb.debian.org/debian-security#${DEBIAN_SECURITY_MIRROR}#g" \
  -e "s#http://deb.debian.org/debian#${DEBIAN_MIRROR}#g" \
  /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates git python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY scripts/patch-playwright-request-headers.mjs ./scripts/patch-playwright-request-headers.mjs
COPY scripts/patch-playwright-screenshot-guard.mjs ./scripts/patch-playwright-screenshot-guard.mjs
RUN npm ci --registry=${NPM_REGISTRY} \
  && node scripts/patch-playwright-request-headers.mjs

FROM dependencies AS docker-client

ARG DEBIAN_MIRROR
ARG DEBIAN_SECURITY_MIRROR
ARG TARGETARCH
ARG COMPOSE_VERSION

USER root

RUN apt-get update \
  && apt-get install --no-install-recommends -y docker.io \
  && rm -rf /var/lib/apt/lists/* \
  && case "${TARGETARCH}" in \
      amd64) compose_arch=x86_64; compose_sha=a55a8cd4ef103aac282812554e531aac8df7e914a287ee81e14d695556a22902 ;; \
      arm64) compose_arch=aarch64; compose_sha=54488fffb60782f3c8787a48b95ed15f49f5a3a85f4105304bd46db5edd9db61 ;; \
      *) echo "Unsupported Compose architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && mkdir -p /usr/local/lib/docker/cli-plugins \
  && node -e "fetch(process.argv[1]).then(r => { if (!r.ok) throw new Error('download failed: ' + r.status); return r.arrayBuffer(); }).then(b => require('node:fs').writeFileSync(process.argv[2], Buffer.from(b)))" \
    "https://github.com/docker/compose/releases/download/v${COMPOSE_VERSION}/docker-compose-linux-${compose_arch}" \
    /usr/local/lib/docker/cli-plugins/docker-compose \
  && echo "${compose_sha}  /usr/local/lib/docker/cli-plugins/docker-compose" | sha256sum -c - \
  && chmod 0755 /usr/local/lib/docker/cli-plugins/docker-compose \
  && docker compose version

FROM dependencies AS browsers

ARG PLAYWRIGHT_DOWNLOAD_HOST

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST}" \
  npx --no-install playwright install --with-deps chromium \
  && chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}"

FROM browsers AS quality

COPY --from=docker-client /usr/bin/docker /usr/bin/docker
COPY --from=docker-client /usr/local/lib/docker/cli-plugins/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose
COPY --chown=node:node . .
RUN chown node:node /app

USER node

RUN docker compose version \
  && npm run verify:browser

CMD ["npm", "run", "test:e2e"]

FROM quality AS build

USER root

RUN npm run build
RUN npm prune --omit=dev

FROM ${NODE_IMAGE} AS runtime

ARG DEBIAN_MIRROR
ARG DEBIAN_SECURITY_MIRROR

ENV NODE_ENV=production \
  LUOWANG_HOST=0.0.0.0 \
  LUOWANG_PORT=3000 \
  LUOWANG_DATA_DIR=/data \
  PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

RUN sed -i \
  -e "s#http://deb.debian.org/debian-security#${DEBIAN_SECURITY_MIRROR}#g" \
  -e "s#http://deb.debian.org/debian#${DEBIAN_MIRROR}#g" \
  /etc/apt/sources.list.d/debian.sources \
  && apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates git docker.io \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data \
  && chown node:node /data

COPY --from=docker-client /usr/local/lib/docker/cli-plugins/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=browsers /ms-playwright /ms-playwright

RUN printf 'Acquire::Retries "5";\nAcquire::http::Timeout "30";\n' > /etc/apt/apt.conf.d/80-luowang-retries \
  && npx --no-install playwright install-deps chromium

COPY --from=build --chown=node:node /app/dist ./dist

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "dist/server/projects/main.js"]
