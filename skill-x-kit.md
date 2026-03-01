# X-Kit API Skill for Claude Code

Query X (Twitter) data through a local API service.

## API Base URL

```
http://localhost:3000
```

## Available Endpoints

### 1. Get Timeline (关注列表推文)
```
GET /api/timeline?count=20
```
获取你关注用户的最新推文。

**Parameters:**
- `count` (可选): 返回推文数量，默认20，最大100

**Example:**
```bash
curl "http://localhost:3000/api/timeline?count=10"
```

### 2. Get Trends (趋势话题)
```
GET /api/trends
```
获取热门话题标签（基于搜索和时间线聚合）。

**Rate Limit:** 每5分钟最多10次

**Example:**
```bash
curl "http://localhost:3000/api/trends"
```

### 3. Get Explore (热门推荐)
```
GET /api/explore?category=for-you
```
获取推荐的热门推文内容。

**Parameters:**
- `category` (可选): 分类，默认 for-you

**Rate Limit:** 每分钟最多20次

**Example:**
```bash
curl "http://localhost:3000/api/explore?count=20"
```

### 4. Search Tweets (搜索推文)
```
GET /api/search?q={keyword}&count=20
```
按关键词搜索推文。

**Parameters:**
- `q` (必需): 搜索关键词
- `count` (可选): 返回数量，默认20，最大100
- `sort` (可选): 排序方式，`latest`(默认，最新) / `top`(热度) / `hot`(同 top) / `popular`(同 top)

**Rate Limit:** 每5分钟最多10次（搜索频率限制较严格，避免触发Twitter检测）

**Example:**
```bash
curl "http://localhost:3000/api/search?q=AI&count=10"
```
```bash
curl "http://localhost:3000/api/search?q=AI&count=10&sort=top"
```

### 5. Get User Info (用户信息)
```
GET /api/user/{username}
```
获取指定用户的基本资料。

**Rate Limit:** 每分钟最多20次

**Example:**
```bash
curl "http://localhost:3000/api/user/elonmusk"
```

### 6. Get User Tweets (用户推文)
```
GET /api/user/{username}/tweets?count=20
```
获取指定用户的最新推文。

**Parameters:**
- `count` (可选): 返回数量，默认20，最大100

**Rate Limit:** 每分钟最多20次

**Example:**
```bash
curl "http://localhost:3000/api/user/elonmusk/tweets?count=10"
```

### 7. Get Recommended Accounts (推荐博主列表)
```
GET /api/recommends
```
获取预配置的推荐博主列表，涵盖技术开发、AI、创业、设计等领域。

**Example:**
```bash
curl "http://localhost:3000/api/recommends"
```

**Response:**
```json
{
  "success": true,
  "count": 19,
  "description": "推荐关注的博主列表...",
  "data": [
    {
      "username": "ruanyf",
      "name": "阮一峰",
      "description": "知名技术博主",
      "tags": ["技术博主", "教育者"],
      "id": "1580781"
    }
  ]
}
```

### 8. Get Recommended Accounts' Tweets (推荐博主更新)
```
GET /api/recommends/tweets?count=5&maxPerUser=3
```
获取推荐博主的最新推文汇总。

**Parameters:**
- `count` (可选): 获取前N个博主的推文，默认5
- `maxPerUser` (可选): 每个博主最多获取几条推文，默认3

**Rate Limit:** 每分钟最多10次

**Example:**
```bash
curl "http://localhost:3000/api/recommends/tweets?count=10&maxPerUser=2"
```

**Features:**
- 自动聚合多个博主的最新推文
- 按时间倒序排序
- 包含博主标签信息，方便分类阅读

### 9. Get Tweet Details & Replies (帖子详情与评论)
```
GET /api/tweet?id={tweetId}
GET /api/tweet?url={tweetUrl}
```
根据推文 ID 或链接获取主帖详情及评论列表。

**Parameters:**
- `id` (可选): 推文 ID
- `url` (可选): 推文链接

**Rate Limit:** 每分钟最多20次

**Example:**
```bash
curl "http://localhost:3000/api/tweet?url=https://x.com/vikingmute/status/2027704841674367277"
```

## Response Format

所有端点返回 JSON 格式：

```json
{
  "success": true,
  "count": 10,
  "data": [...]
}
```

错误时返回：

```json
{
  "success": false,
  "error": "error message"
}
```

## Rate Limits (频率限制)

为避免被 Twitter 检测异常，API 已内置频率限制：

| 端点 | 限制 |
|-----|------|
| `/api/search` | 每5分钟10次 |
| `/api/trends` | 每5分钟10次 |
| `/api/timeline` | 每分钟30次 |
| `/api/explore` | 每分钟20次 |
| `/api/user/*` | 每分钟20次 |
| `/api/tweet` | 每分钟20次 |

超过限制会返回 429 错误：

```json
{
  "success": false,
  "error": "Rate limit exceeded",
  "retryAfter": 180
}
```

## Usage Examples

### 获取最新关注推文
```typescript
const response = await fetch('http://localhost:3000/api/timeline?count=5');
const data = await response.json();
if (data.success) {
  console.log(data.data);
}
```

### 搜索话题
```typescript
const response = await fetch('http://localhost:3000/api/search?q=人工智能&count=10&sort=top');
const data = await response.json();
```

### 获取趋势话题
```typescript
const response = await fetch('http://localhost:3000/api/trends');
const data = await response.json();
```

### 获取帖子详情与评论
```typescript
const response = await fetch('http://localhost:3000/api/tweet?url=https://x.com/vikingmute/status/2027704841674367277');
const data = await response.json();
```

## Notes

- 建议配置 AUTH_TOKEN，服务会自动拉取最新 cookie 以支持搜索
- 只有在没有 AUTH_TOKEN 时才需要手动配置 X_COOKIE
- 搜索功能可能受 Twitter 限制，某些关键词可能无法搜索
- 建议缓存结果，避免频繁调用
- 所有时间戳为 Twitter 格式（如 "Mon Feb 02 09:59:12 +0000 2026"）
