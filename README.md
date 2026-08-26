# X-Kit API

X (Twitter) 数据获取 API 服务，支持 Docker 部署。

## 功能

- 🔥 获取关注列表推文 (Timeline)
- 🔍 搜索推文
- 🌍 官方 Explore 热搜与完整地区切换
- 📰 Explore 新闻、体育、娱乐等动态分类
- 👤 获取指定用户信息
- 📝 获取指定用户推文

## 快速开始

### 1. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env，填入你的 Twitter auth_token
```

### 2. Docker 部署

```bash
docker-compose up -d
```

### 3. 本地开发

```bash
bun install
bun run dev
```

## API 文档

完整的参数、响应结构、官方分类列表和地区切换说明见 [API.md](./API.md)。

### 健康检查
```
GET /health
```

### 获取关注列表推文
```
GET /api/timeline?count=20
```
返回你关注用户的最新推文。

### 获取趋势话题 (Trending Topics)
```
GET /api/trends?region=worldwide&count=20
```
默认返回当前账号的官方 Explore Trending；传 `region` 或 `woeid` 可切换到指定地区。完整地区目录：`GET /api/trend-locations`。旧版时间线聚合仍可通过 `source=timeline` 使用。

### 获取探索/热门内容
```
GET /api/explore?category=for-you
```
支持官方动态分类，当前常见值为 `for-you`、`trending`、`news`、`sports`、`entertainment`。可用分类请调用 `GET /api/explore/categories`。

### 搜索推文
```
GET /api/search?q=keyword&count=20
```
按关键词搜索推文。

### 获取用户信息
```
GET /api/user/:username
```
获取指定用户的基本资料。

### 获取用户推文
```
GET /api/user/:username/tweets?count=20
```

### 获取推文详情和回复
```
GET /api/tweet?id=:tweetId
GET /api/tweet?url=:tweetUrl
```

### 获取 X Article / 长文内容
```
GET /api/article?id=:tweetOrArticleId
GET /api/article?url=:tweetOrArticleUrl
```
支持从发布文章的推文链接解析实际 Article ID，并返回标题、摘要、正文和关联推文。

### 获取推荐博主列表
```
GET /api/recommends
```
返回预配置的推荐博主列表（涵盖技术开发、AI、创业、设计等领域）。

### 获取推荐博主更新
```
GET /api/recommends/tweets?count=5&maxPerUser=3
```
获取推荐博主的最新推文汇总，自动聚合多个博主的内容。
获取指定用户的最新推文。

## 获取 Auth Token

1. 登录 https://x.com
2. 打开浏览器开发者工具 (F12)
3. Application -> Cookies -> https://x.com
4. 找到 `auth_token` 字段并复制其值

## Docker 命令

```bash
# 构建并启动
docker-compose up -d --build

# 查看日志
docker-compose logs -f

# 停止
docker-compose down
```
