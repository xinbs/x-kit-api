# X-Kit API 接口文档

默认地址：`http://localhost:3000`

所有业务接口返回 JSON。成功响应通常包含 `success: true` 和 `data`；失败响应包含 `success: false`、`error`，参数错误返回 HTTP 400，上游或服务错误返回 HTTP 500，超过频率限制返回 HTTP 429。

## 端点总览

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/api/timeline` | 当前账号时间线最新推文 |
| GET | `/api/search` | 搜索 X 推文 |
| GET | `/api/trends` | 官方 Explore 热搜或指定地区热搜 |
| GET | `/api/trend-locations` | 可用于地区热搜的完整 WOEID 目录 |
| GET | `/api/explore` | 官方 Explore 分类内容 |
| GET | `/api/explore/categories` | 当前账号可用的 Explore 分类 |
| GET | `/api/explore/locations` | Explore 账号偏好地点目录 |
| GET | `/api/explore/settings` | 当前账号 Explore 设置（只读） |
| GET | `/api/user/:username` | 用户资料 |
| GET | `/api/user/:username/tweets` | 用户推文 |
| GET | `/api/tweet` | 推文详情与回复 |
| GET | `/api/article` | X Article/长文内容 |
| GET | `/api/recommends` | 本地配置的推荐账号 |
| GET | `/api/recommends/tweets` | 推荐账号最新推文聚合 |

## 官方热搜与地区切换

### `GET /api/trends`

默认读取当前账号在 X Explore 的官方 Trending 内容。

参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `count` | `20` | 返回条数，范围 1–50 |
| `source` | `official` | `official` 或 `timeline`；后者是旧版时间线标签聚合兼容模式 |
| `region` | `account` | 地区名称、slug、两位国家代码，或 `worldwide`；仅用于官方源 |
| `woeid` | 无 | 官方 WOEID，优先级高于 `region` |

常用调用：

```bash
# 当前账号的官方 Trending（受账号地区和个性化设置影响）
curl "http://localhost:3000/api/trends"

# Worldwide、国家、城市
curl "http://localhost:3000/api/trends?region=worldwide&count=20"
curl "http://localhost:3000/api/trends?region=us&count=20"
curl "http://localhost:3000/api/trends?region=japan&count=20"
curl "http://localhost:3000/api/trends?region=tokyo&count=20"

# 精确指定 WOEID
curl "http://localhost:3000/api/trends?woeid=23424856&count=20"

# 旧版兼容：从首页时间线聚合 hashtag
curl "http://localhost:3000/api/trends?source=timeline&count=20"
```

`region` 支持动态目录中的地区名称、slug 和国家代码，不应只依赖上面的示例。内置别名包括 `world`/`global`、`usa`、`uk`。传入无法识别的地区会返回 400，并给出 `locationsUrl`。

指定地区的响应示例：

```json
{
  "success": true,
  "source": "official_region",
  "region": {
    "name": "Japan",
    "slug": "japan",
    "woeid": 23424856,
    "countryCode": "JP",
    "placeType": "Country"
  },
  "asOf": "2026-08-26T10:00:00Z",
  "count": 20,
  "data": [
    {
      "name": "话题名称",
      "query": "话题搜索词",
      "url": "twitter://search?...",
      "tweetVolume": 12345,
      "promotedContent": null
    }
  ]
}
```

### `GET /api/trend-locations`

读取 X 官方 `trends/available` 目录。这里的 `woeid` 可以直接传给 `/api/trends`，是地区热搜的权威可选列表。目录由 X 动态返回并缓存 6 小时。

参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `q` | 无 | 模糊搜索名称、slug、国家、国家代码、类型或 WOEID |
| `country` | 无 | 按国家名称或两位国家代码精确筛选 |
| `type` | 无 | 按地点类型筛选，如 `Country`、`Town`、`Supername` |
| `limit` | `200` | 返回上限，范围 1–1000 |

```bash
curl "http://localhost:3000/api/trend-locations?q=tokyo"
curl "http://localhost:3000/api/trend-locations?country=JP&type=Town&limit=100"
curl "http://localhost:3000/api/trend-locations?type=Country&limit=1000"
```

响应中的 `total` 是完整目录条数，`matchedCount` 是筛选后的总数，`count` 是本次实际返回数。如果某个国家或地区不在目录中，X 当前不提供该地区的 WOEID 热搜；请使用 `region=account` 或选择目录中的可用地区。

## 官方 Explore

### `GET /api/explore`

读取 X 官方 Explore 页面和分类时间线。

参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `category` | `for-you` | 分类 ID；可用值应从 `/api/explore/categories` 动态获取 |
| `count` | `20` | 对 `trends` 和 `tweets` 分别限制，范围 1–100 |
| `source` | `official` | `official` 或 `timeline`；`timeline` 返回首页时间线兼容数据 |

当前常见分类为：

- `for-you`：Explore 综合推荐
- `trending`：官方热搜
- `news`：新闻
- `sports`：体育
- `entertainment`：娱乐

分类由 X 按账号动态下发，以上列表可能变化。接口同时返回 `availableCategories`，内容按 `data.trends` 和 `data.tweets` 分组；某些分类只有趋势卡片而没有普通推文，这是正常响应。

```bash
curl "http://localhost:3000/api/explore?category=for-you&count=20"
curl "http://localhost:3000/api/explore?category=news&count=20"
curl "http://localhost:3000/api/explore?category=sports&count=20"
curl "http://localhost:3000/api/explore?category=entertainment&count=20"
```

### `GET /api/explore/categories`

返回当前账号实际可用的分类：

```json
{
  "success": true,
  "source": "official_explore",
  "count": 5,
  "data": [
    {
      "id": "trending",
      "label": "Trending",
      "refreshIntervalSec": 1200,
      "timelineId": "..."
    }
  ]
}
```

### `GET /api/explore/settings`

只读返回 `AUTH_TOKEN` 对应账号当前的 Explore 设置，例如是否启用个性化趋势、当前位置和 unified trends。本服务不提供修改接口，因为 X 的设置是账号级全局状态，修改会影响网页和其他客户端。

### `GET /api/explore/locations`

返回 X 的 Explore 自动补全地点目录，参数为 `q`、`type`、`limit`。响应中的 `placeId` 用于识别账号偏好地点，不是 WOEID，不能传给 `/api/trends`。

```bash
curl "http://localhost:3000/api/explore/locations?q=japan&limit=20"
curl "http://localhost:3000/api/explore/locations?type=Country&limit=1000"
```

地区热搜请用 `/api/trend-locations`；查看当前账号是否使用当前位置请用 `/api/explore/settings`。

## 时间线与搜索

### `GET /api/timeline`

参数：`count`，默认 20，最大 100。返回当前账号首页最新推文，过滤转推和引用推文。

```bash
curl "http://localhost:3000/api/timeline?count=20"
```

### `GET /api/search`

参数：

| 参数 | 是否必需 | 说明 |
| --- | --- | --- |
| `q` | 是 | X 搜索语法或关键词 |
| `count` | 否 | 默认 20，最大 100 |
| `sort` | 否 | `latest`（默认）或 `top`；`hot`、`popular` 等同 `top` |
| `order` | 否 | `sort` 的兼容别名 |

```bash
curl --get "http://localhost:3000/api/search" \
  --data-urlencode "q=OpenAI lang:zh" \
  --data "count=20" \
  --data "sort=latest"
```

## 用户、推文与文章

### `GET /api/user/:username`

```bash
curl "http://localhost:3000/api/user/OpenAI"
```

返回用户 ID、用户名、简介、头像、认证状态和关注统计。

### `GET /api/user/:username/tweets`

参数：`count`，默认 20，最大 100。

```bash
curl "http://localhost:3000/api/user/OpenAI/tweets?count=20"
```

### `GET /api/tweet`

传 `id`/`tweetId` 或 `url`，返回主帖和回复：

```bash
curl "http://localhost:3000/api/tweet?id=2092205524481667467"
curl --get "http://localhost:3000/api/tweet" \
  --data-urlencode "url=https://x.com/user/status/2092205524481667467"
```

### `GET /api/article`

传 `id`/`articleId`/`tweetId` 或 `url`。支持直接 Article ID，也支持从发布文章的推文和短链接解析实际 Article ID。

```bash
curl "http://localhost:3000/api/article?id=2092464354935407048"
```

返回标题、摘要、正文、文章媒体和关联推文；普通推文没有长文时 `isArticle` 为 `false`。

## 推荐账号

### `GET /api/recommends`

读取本地 `recommends.json` 中配置的账号列表。

### `GET /api/recommends/tweets`

参数：

- `count`：读取前多少个推荐账号，默认 5。
- `maxPerUser`：每个账号最多获取多少条，默认 3。

```bash
curl "http://localhost:3000/api/recommends/tweets?count=5&maxPerUser=3"
```

## 频率限制

| 端点 | 默认限制 |
| --- | --- |
| `/api/search` | 每 IP 每 5 分钟 30 次，可通过环境变量调整 |
| `/api/trends` | 每 IP 每 5 分钟 10 次 |
| `/api/timeline`、地区/分类目录 | 每 IP 每分钟 30 次 |
| `/api/explore`、`/api/user/*`、`/api/tweet`、`/api/article` | 每 IP 每分钟 20 次 |
| `/api/recommends/tweets` | 每 IP 每分钟 10 次 |

429 响应包含距窗口重置的 `retryAfter` 秒数。搜索限制环境变量：`SEARCH_RATE_WINDOW_MS`、`SEARCH_RATE_MAX`。

## 认证与注意事项

- 配置 `.env` 中的 `AUTH_TOKEN`；服务会使用该账号的会话访问 X Web API。
- `/api/trends` 不带地区时以及 `/api/explore` 的结果会受到该账号的地区、语言、关注关系和个性化设置影响。
- X 的内部 Web API、分类和地点目录可能调整；客户端应读取本服务返回的动态目录，不要硬编码全部可选项。
- `AUTH_TOKEN`、Cookie 和 CSRF 信息不会出现在正常业务响应中，不应写入日志或提交到版本库。

### Public-post provenance (additive, 2026-08-26)

Timeline, GraphQL search, adaptive search fallback, profile posts and tweet detail retain all existing fields. Each post additionally includes:

- `user.protected`: explicit boolean, or `null` when upstream privacy is unknown. A `true` value wins conflicting upstream fields. `/api/user/:username` also returns `protected`.
- `isReply`, `inReplyToStatusId`, `quotedStatusId`, `retweetedStatusId`: reference IDs without copying referenced private bodies.
- `urls`: up to 20 distinct `{url, expandedUrl, displayUrl}` objects. Only HTTP(S), no embedded credentials; this metadata does not authorize a downstream URL fetch.
- `possiblySensitive`, `restrictedAudience`: known upstream safety/audience flags. Downstream public news ingestion must exclude protected/unknown users and restricted posts.

`/api/timeline` currently uses `HomeLatestTimeline` (Following); it is not a For You recommendation endpoint. Authentication cookies remain internal to this service and are not part of this contract.

Run the offline regression suite with `bun test`; tests use synthetic fixtures, do not read production cookies, and do not call X.
