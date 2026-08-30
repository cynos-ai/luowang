ARG NODE_IMAGE=docker.m.daocloud.io/library/node:24.14.1-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c
ARG NPM_REGISTRY=https://registry.npmmirror.com
ARG PLAYWRIGHT_DOWNLOAD_HOST=https://registry.npmmirror.com/-/binary/playwright
ARG DEBIAN_MIRROR=http://mirrors.aliyun.com/debian
ARG DEBIAN_SECURITY_MIRROR=http://mirrors.aliyun.com/debian-security

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
RUN npm ci --registry=${NPM_REGISTRY}

FROM dependencies AS browsers

ARG PLAYWRIGHT_DOWNLOAD_HOST

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST}" \
  npx --no-install playwright install --with-deps chromium \
  && chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}"

FROM browsers AS quality

COPY --chown=node:node . .
RUN chown node:node /app

USER node

RUN npm run verify:browser

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
  && apt-get install --no-install-recommends -y ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /data \
  && chown node:node /data

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=browsers /ms-playwright /ms-playwright

RUN npx --no-install playwright install-deps chromium

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["node", "dist/server/main.js"]
