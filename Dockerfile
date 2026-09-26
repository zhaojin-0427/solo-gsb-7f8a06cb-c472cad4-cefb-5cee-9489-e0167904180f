FROM node:20-alpine

ENV NODE_ENV=production
WORKDIR /app

# 零运行时依赖：仅拷贝源码（public 为前端静态资源，examples 为内置示例）
COPY --chown=node:node package.json ./
COPY --chown=node:node server.js ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node examples ./examples

EXPOSE 3000

# 使用镜像内非 root 用户运行
USER node
CMD ["node", "server.js"]
