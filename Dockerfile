# 使用官方 Bun 镜像
FROM oven/bun:1 AS base

WORKDIR /app

# 安装 curl 用于健康检查
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# 复制依赖文件。项目当前使用文本格式的 bun.lock，需要一并复制进镜像。
COPY package.json bun.lock bun.lockb* ./

# 安装依赖
RUN bun install --frozen-lockfile

# 复制源代码和配置文件
COPY src ./src
COPY recommends.json ./

# 暴露端口
EXPOSE 3000

# 启动服务
CMD ["bun", "run", "start"]
