# ---------- 依赖构建阶段 ----------
FROM node:20-bookworm AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# 完整镜像自带 python3/make/g++，better-sqlite3 无预编译包时可回退源码编译
RUN npm ci --omit=dev

# ---------- 运行阶段 ----------
FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/app/data/observatory.db
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown -R node:node /app
USER node
EXPOSE 8080
VOLUME ["/app/data"]
CMD ["node", "server.js"]
