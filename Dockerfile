# 业余天文台观测夜排程 —— 单镜像运行
FROM node:20-slim

WORKDIR /app

# 仅依赖 better-sqlite3（Node 20 有预编译二进制，无需构建工具链）
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY src ./src
COPY public ./public

# SQLite 数据库目录（compose 中挂载为命名卷）
RUN mkdir -p /app/data
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/app/data/scheduler.db

EXPOSE 8080
VOLUME ["/app/data"]

CMD ["node", "src/server.js"]
