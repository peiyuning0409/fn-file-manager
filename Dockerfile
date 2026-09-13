FROM node:20-alpine

LABEL maintainer="FN File Manager"
LABEL description="飞牛NAS专属文件资源管理器 - 深空蓝毛玻璃质感"

WORKDIR /app

# 复制依赖清单并安装
COPY package.json ./
RUN npm install --omit=dev --registry=https://registry.npmmirror.com --no-audit --no-fund

# 复制应用代码
COPY server.js ./
COPY public/ ./public/

# 创建数据根目录（实际存储通过 volume 挂载覆盖）
RUN mkdir -p /data

ENV NODE_ENV=production
ENV PORT=8888

EXPOSE 8888

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8888/ || exit 1

CMD ["node", "server.js"]
