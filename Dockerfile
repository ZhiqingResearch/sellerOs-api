# syntax=docker/dockerfile:1.10
# secret 挂载的 env= 选项需要 frontend ≥1.8（1.7 会报 unexpected key 'env'），1.10 为 feat 分支原用版本

# 固定 Alpine 小版本，避免 chromium-headless-shell 随 node:22-alpine 漂移后不可用。
ARG NODE_IMAGE=node:22-alpine3.24

FROM ${NODE_IMAGE} AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=bind,source=.npmrc,target=/app/.npmrc,readonly \
    --mount=type=secret,id=github_packages_token,env=PACKAGES_TOKEN,required=true \
    npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build


FROM ${NODE_IMAGE} AS production-deps

WORKDIR /app

ENV NODE_ENV=production \
    PRISMA_SKIP_POSTINSTALL_GENERATE=true

COPY package.json package-lock.json ./
COPY prisma ./prisma

# 安装、Prisma Client 生成和清理必须在同一层完成，避免生成文件及缓存叠加进镜像。
# 生产运行不需要依赖包的 source map / TypeScript 声明文件。
RUN --mount=type=cache,target=/root/.npm \
    --mount=type=bind,source=.npmrc,target=/app/.npmrc,readonly \
    --mount=type=secret,id=github_packages_token,env=PACKAGES_TOKEN,required=true \
    npm ci --omit=dev --omit=peer \
    && ./node_modules/.bin/prisma generate \
    && rm -rf /root/.cache \
    && find node_modules -type f \( \
      -name "*.map" -o \
      -name "*.d.ts" -o \
      -name "*.d.mts" -o \
      -name "*.d.cts" \
    \) -delete


FROM ${NODE_IMAGE} AS runtime-base

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY prisma ./prisma
COPY --from=production-deps /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

RUN addgroup -S appgroup \
    && adduser -S appuser -G appgroup \
    && mkdir -p /app/logs \
    && chown appuser:appgroup /app/logs
USER appuser

EXPOSE 8000

CMD ["sh", "-c", "npx prisma db push --accept-data-loss --skip-generate && node dist/main.js"]


# 可选极简目标：不带后端收据 PDF 附件能力，邮件自动降级为 HTML 正文。
# 构建：docker build --target runtime-no-pdf -t ai-sourcing-api:no-pdf .
FROM runtime-base AS runtime-no-pdf


# 默认生产目标：headless shell 足够完成 HTML -> PDF，无需完整 Chromium GUI。
FROM runtime-base AS runtime

USER root
RUN apk add --no-cache chromium-headless-shell ca-certificates font-wqy-zenhei
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-headless-shell
USER appuser
