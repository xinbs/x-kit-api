# X-Kit API

X (Twitter) 数据获取 API 服务，支持 Docker 部署。

## 功能

- 🔥 获取关注列表推文 (Timeline)
- 🔍 搜索推文
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
GET /api/trends
```
从搜索和时间线中聚合热门话题标签，按出现频率排序。

**说明：**
- 搜索热门关键词（news, breaking, trending等）收集话题
- 从你关注用户的时间线中提取话题标签
- 聚合后返回出现频率最高的标签

**响应示例：**
```json
{
  "success": true,
  "source": "aggregated_search_timeline",
  "count": 10,
  "data": [
    {
      "name": "话题",
      "displayName": "#话题",
      "count": 5,
      "url": "https://x.com/search?q=%23话题",
      "directLink": "https://x.com/hashtag/话题",
      "sampleTweet": {...}
    }
  ]
}
```

**注意：** 这与 x.com/explore 的官方趋势话题可能不同，是基于你关注内容的个性化趋势。

### 获取探索/热门内容
```
GET /api/explore?category=for-you
```
获取推荐的热门推文内容。

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
