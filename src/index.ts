import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { get } from "lodash";
import dayjs from "dayjs";
import axios from "axios";
import { xGuestClient, XAuthClient, _xClient } from "./utils";

const app = new Hono();

app.use(cors());
app.use(logger());

// 简单的内存频率限制器
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const rateLimits = new Map<string, RateLimitEntry>();

// 频率限制中间件
// 搜索端点：每IP每5分钟最多10次
// 其他端点：每IP每分钟最多30次
const rateLimit = (options: { windowMs: number; maxRequests: number }) => {
  return async (c: any, next: any) => {
    const ip = c.req.header("x-forwarded-for") || c.req.header("x-real-ip") || "unknown";
    const key = `${ip}:${c.req.path}`;
    const now = Date.now();

    const entry = rateLimits.get(key);

    if (entry) {
      if (now > entry.resetTime) {
        // 重置窗口
        rateLimits.set(key, { count: 1, resetTime: now + options.windowMs });
      } else if (entry.count >= options.maxRequests) {
        // 超过限制
        return c.json({
          success: false,
          error: "Rate limit exceeded",
          retryAfter: Math.ceil((entry.resetTime - now) / 1000),
        }, 429);
      } else {
        // 增加计数
        entry.count++;
      }
    } else {
      // 新条目
      rateLimits.set(key, { count: 1, resetTime: now + options.windowMs });
    }

    await next();
  };
};

// 清理过期的 rate limit 条目（每10分钟运行一次）
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimits.entries()) {
    if (now > entry.resetTime) {
      rateLimits.delete(key);
    }
  }
}, 10 * 60 * 1000);

// 加载推荐博主配置
const loadRecommends = async () => {
  try {
    const file = Bun.file("./recommends.json");
    const text = await file.text();
    return JSON.parse(text);
  } catch (error) {
    console.error("Failed to load recommends.json:", error);
    return { accounts: [] };
  }
};

// 健康检查
app.get("/health", (c) => c.json({ status: "ok", time: new Date().toISOString() }));

// 获取推荐博主列表
app.get("/api/recommends", async (c) => {
  try {
    const data = await loadRecommends();
    return c.json({
      success: true,
      count: data.accounts?.length || 0,
      description: data.description,
      data: data.accounts || [],
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 获取推荐博主的最新推文 - 频率限制：每分钟最多10次
app.get("/api/recommends/tweets", rateLimit({ windowMs: 60 * 1000, maxRequests: 10 }), async (c) => {
  try {
    const count = parseInt(c.req.query("count") || "5");
    const maxPerUser = parseInt(c.req.query("maxPerUser") || "3");

    const data = await loadRecommends();
    const accounts = data.accounts || [];

    if (accounts.length === 0) {
      return c.json({ success: false, error: "No recommended accounts found" }, 404);
    }

    const client = await xGuestClient();
    const allTweets: any[] = [];

    // 获取每个推荐博主的最新推文
    for (const account of accounts.slice(0, count)) {
      try {
        const userResp = await client.getUserApi().getUserByScreenName({
          screenName: account.username,
        });

        const userId = userResp.data.user?.restId;
        if (!userId) continue;

        const tweetsResp = await client.getTweetApi().getUserTweets({
          userId,
          count: maxPerUser,
        });

        const tweets = tweetsResp.data.data.map((tweet) => ({
          id: get(tweet, "raw.result.legacy.idStr"),
          text: get(tweet, "raw.result.legacy.fullText"),
          createdAt: get(tweet, "raw.result.legacy.createdAt"),
          stats: {
            likes: get(tweet, "raw.result.legacy.favoriteCount"),
            retweets: get(tweet, "raw.result.legacy.retweetCount"),
            replies: get(tweet, "raw.result.legacy.replyCount"),
          },
          user: {
            id: account.id,
            username: account.username,
            name: account.name,
            description: account.description,
            tags: account.tags,
          },
          url: `https://x.com/${account.username}/status/${get(tweet, "raw.result.legacy.idStr")}`,
        }));

        allTweets.push(...tweets);
      } catch (e) {
        console.log(`Failed to get tweets for ${account.username}:`, e);
        // 继续处理下一个账号
      }
    }

    // 按时间倒序排序
    const sortedTweets = allTweets.sort((a, b) => {
      const idA = a.id || "";
      const idB = b.id || "";
      return idB.localeCompare(idA);
    });

    return c.json({
      success: true,
      source: "recommended_accounts",
      count: sortedTweets.length,
      data: sortedTweets,
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 获取关注列表的推文 (Timeline) - 频率限制：每分钟最多30次
app.get("/api/timeline", rateLimit({ windowMs: 60 * 1000, maxRequests: 30 }), async (c) => {
  try {
    const count = parseInt(c.req.query("count") || "20");
    const client = await XAuthClient();

    const resp = await client.getTweetApi().getHomeLatestTimeline({
      count: Math.min(count, 100),
    });

    // 过滤并格式化推文
    const tweets = resp.data.data
      .filter((tweet) => !tweet.referenced_tweets || tweet.referenced_tweets.length === 0)
      .map((tweet) => {
        const fullText = get(tweet, "raw.result.legacy.fullText", "");
        const isRetweet = fullText?.includes("RT @");
        const isQuote = get(tweet, "raw.result.legacy.isQuoteStatus");

        // 提取媒体
        const mediaItems = get(tweet, "raw.result.legacy.extendedEntities.media", []);
        const images = mediaItems
          .filter((media: any) => media.type === "photo")
          .map((media: any) => media.mediaUrlHttps);

        const videos = mediaItems
          .filter((media: any) => media.type === "video" || media.type === "animated_gif")
          .map((media: any) => {
            const variants = get(media, "videoInfo.variants", []);
            const bestQuality = variants
              .filter((v: any) => v.contentType === "video/mp4")
              .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0];
            return bestQuality?.url;
          })
          .filter(Boolean);

        return {
          id: get(tweet, "raw.result.legacy.idStr"),
          text: fullText,
          createdAt: get(tweet, "raw.result.legacy.createdAt"),
          user: {
            id: get(tweet, "user.restId"),
            screenName: get(tweet, "user.legacy.screenName"),
            name: get(tweet, "user.legacy.name"),
            avatar: get(tweet, "user.legacy.profileImageUrlHttps"),
            followersCount: get(tweet, "user.legacy.followersCount"),
            friendsCount: get(tweet, "user.legacy.friendsCount"),
          },
          stats: {
            likes: get(tweet, "raw.result.legacy.favoriteCount"),
            retweets: get(tweet, "raw.result.legacy.retweetCount"),
            replies: get(tweet, "raw.result.legacy.replyCount"),
          },
          media: {
            images,
            videos,
          },
          url: `https://x.com/${get(tweet, "user.legacy.screenName")}/status/${get(tweet, "raw.result.legacy.idStr")}`,
          isRetweet,
          isQuote,
        };
      })
      .filter((tweet) => !tweet.isRetweet && !tweet.isQuote);

    return c.json({
      success: true,
      count: tweets.length,
      data: tweets,
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 搜索推文 - 频率限制：每5分钟最多10次
app.get("/api/search", rateLimit({ windowMs: 5 * 60 * 1000, maxRequests: 10 }), async (c) => {
  try {
    const query = c.req.query("q");
    const count = parseInt(c.req.query("count") || "20");

    if (!query) {
      return c.json({ success: false, error: "Missing search query (q)" }, 400);
    }

    const client = await xGuestClient();

    const resp = await client.getTweetApi().getSearchTimeline({
      rawQuery: query,
      count: Math.min(count, 100),
    });

    const tweets = resp.data.data
      .filter((tweet) => !tweet.referenced_tweets || tweet.referenced_tweets.length === 0)
      .map((tweet) => {
        const fullText = get(tweet, "raw.result.legacy.fullText", "");
        const mediaItems = get(tweet, "raw.result.legacy.extendedEntities.media", []);

        return {
          id: get(tweet, "raw.result.legacy.idStr"),
          text: fullText,
          createdAt: get(tweet, "raw.result.legacy.createdAt"),
          user: {
            screenName: get(tweet, "user.legacy.screenName"),
            name: get(tweet, "user.legacy.name"),
            avatar: get(tweet, "user.legacy.profileImageUrlHttps"),
            followersCount: get(tweet, "user.legacy.followersCount"),
          },
          stats: {
            likes: get(tweet, "raw.result.legacy.favoriteCount"),
            retweets: get(tweet, "raw.result.legacy.retweetCount"),
          },
          media: {
            images: mediaItems
              .filter((media: any) => media.type === "photo")
              .map((media: any) => media.mediaUrlHttps),
          },
          url: `https://x.com/${get(tweet, "user.legacy.screenName")}/status/${get(tweet, "raw.result.legacy.idStr")}`,
        };
      });

    return c.json({
      success: true,
      query,
      count: tweets.length,
      data: tweets,
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 获取指定用户的推文 - 频率限制：每分钟最多20次
app.get("/api/user/:username/tweets", rateLimit({ windowMs: 60 * 1000, maxRequests: 20 }), async (c) => {
  try {
    const username = c.req.param("username");
    const count = parseInt(c.req.query("count") || "20");

    const client = await xGuestClient();

    const user = await client.getUserApi().getUserByScreenName({
      screenName: username,
    });

    const userId = user.data.user?.restId;
    if (!userId) {
      return c.json({ success: false, error: "User not found" }, 404);
    }

    const resp = await client.getTweetApi().getUserTweets({
      userId,
      count: Math.min(count, 100),
    });

    const tweets = resp.data.data.map((tweet) => ({
      id: get(tweet, "raw.result.legacy.idStr"),
      text: get(tweet, "raw.result.legacy.fullText"),
      createdAt: get(tweet, "raw.result.legacy.createdAt"),
      stats: {
        likes: get(tweet, "raw.result.legacy.favoriteCount"),
        retweets: get(tweet, "raw.result.legacy.retweetCount"),
        replies: get(tweet, "raw.result.legacy.replyCount"),
      },
      url: `https://x.com/${username}/status/${get(tweet, "raw.result.legacy.idStr")}`,
    }));

    return c.json({
      success: true,
      username,
      count: tweets.length,
      data: tweets,
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 获取 x.com/explore 趋势话题 - 频率限制：每5分钟最多10次
app.get("/api/trends", rateLimit({ windowMs: 5 * 60 * 1000, maxRequests: 10 }), async (c) => {
  try {
    const client = await xGuestClient();

    // 方案1: 尝试使用搜索热门话题
    const hotKeywords = ["news", "breaking", "trending", "viral", "today"];
    const allHashtags = new Map<string, { count: number; tweets: any[] }>();

    // 搜索多个热门关键词，聚合话题标签
    for (const keyword of hotKeywords.slice(0, 3)) {
      try {
        const searchResp = await client.getTweetApi().getSearchTimeline({
          rawQuery: keyword,
          count: 30,
        });

        searchResp.data.data.forEach((tweet) => {
          const text = get(tweet, "raw.result.legacy.fullText", "");
          const hashtags = get(tweet, "raw.result.legacy.entities.hashtags", []);

          hashtags.forEach((tag: any) => {
            const tagText = tag.text;
            if (tagText && tagText.length > 1) {
              const existing = allHashtags.get(tagText);
              if (existing) {
                existing.count++;
              } else {
                allHashtags.set(tagText, {
                  count: 1,
                  tweets: [{
                    id: get(tweet, "raw.result.legacy.idStr"),
                    text: text.slice(0, 100),
                    user: get(tweet, "user.legacy.screenName"),
                  }],
                });
              }
            }
          });
        });
      } catch (e) {
        // 忽略单个搜索失败
      }
    }

    // 方案2: 从时间线补充话题标签
    try {
      const timelineResp = await client.getTweetApi().getHomeLatestTimeline({
        count: 100,
      });

      timelineResp.data.data.forEach((tweet) => {
        const text = get(tweet, "raw.result.legacy.fullText", "");
        const hashtags = get(tweet, "raw.result.legacy.entities.hashtags", []);

        hashtags.forEach((tag: any) => {
          const tagText = tag.text;
          if (tagText && tagText.length > 1) {
            const existing = allHashtags.get(tagText);
            if (existing) {
              existing.count++;
            } else {
              allHashtags.set(tagText, {
                count: 1,
                tweets: [{
                  id: get(tweet, "raw.result.legacy.idStr"),
                  text: text.slice(0, 100),
                  user: get(tweet, "user.legacy.screenName"),
                }],
              });
            }
          }
        });
      });
    } catch (e) {
      // 忽略时间线获取失败
    }

    // 按出现次数排序
    const sortedTrends = Array.from(allHashtags.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 20)
      .map(([tag, data]) => ({
        name: tag,
        displayName: `#${tag}`,
        count: data.count,
        url: `https://x.com/search?q=%23${encodeURIComponent(tag)}`,
        directLink: `https://x.com/hashtag/${encodeURIComponent(tag)}`,
        sampleTweet: data.tweets[0] || null,
      }));

    if (sortedTrends.length > 0) {
      return c.json({
        success: true,
        source: "aggregated_search_timeline",
        note: "基于搜索和时间线聚合的热门话题标签",
        count: sortedTrends.length,
        data: sortedTrends,
      });
    }

    return c.json({
      success: false,
      error: "未能获取到趋势话题，可能需要检查 token 权限",
    }, 500);
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 获取探索/热门内容 (Explore) - 频率限制：每分钟最多20次
app.get("/api/explore", rateLimit({ windowMs: 60 * 1000, maxRequests: 20 }), async (c) => {
  try {
    const category = c.req.query("category") || "for-you";
    const client = await xGuestClient();

    // 获取探索页时间线
    const resp = await client.getTweetApi().getHomeLatestTimeline({
      count: 50,
    });

    const tweets = resp.data.data
      .filter((tweet) => !tweet.referenced_tweets || tweet.referenced_tweets.length === 0)
      .slice(0, 20)
      .map((tweet) => {
        const fullText = get(tweet, "raw.result.legacy.fullText", "");
        const mediaItems = get(tweet, "raw.result.legacy.extendedEntities.media", []);

        // 提取话题标签
        const hashtags = get(tweet, "raw.result.legacy.entities.hashtags", [])
          .map((h: any) => h.text)
          .filter(Boolean);

        return {
          id: get(tweet, "raw.result.legacy.idStr"),
          text: fullText,
          createdAt: get(tweet, "raw.result.legacy.createdAt"),
          hashtags,
          user: {
            screenName: get(tweet, "user.legacy.screenName"),
            name: get(tweet, "user.legacy.name"),
            avatar: get(tweet, "user.legacy.profileImageUrlHttps"),
            followersCount: get(tweet, "user.legacy.followersCount"),
            verified: get(tweet, "user.legacy.verified"),
          },
          stats: {
            likes: get(tweet, "raw.result.legacy.favoriteCount"),
            retweets: get(tweet, "raw.result.legacy.retweetCount"),
            replies: get(tweet, "raw.result.legacy.replyCount"),
            quotes: get(tweet, "raw.result.legacy.quoteCount"),
          },
          media: {
            images: mediaItems
              .filter((media: any) => media.type === "photo")
              .map((media: any) => media.mediaUrlHttps),
            videos: mediaItems
              .filter((media: any) => media.type === "video" || media.type === "animated_gif")
              .map((media: any) => {
                const variants = get(media, "videoInfo.variants", []);
                const bestQuality = variants
                  .filter((v: any) => v.contentType === "video/mp4")
                  .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0];
                return bestQuality?.url;
              })
              .filter(Boolean),
          },
          url: `https://x.com/${get(tweet, "user.legacy.screenName")}/status/${get(tweet, "raw.result.legacy.idStr")}`,
        };
      });

    return c.json({
      success: true,
      category,
      count: tweets.length,
      data: tweets,
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 获取用户信息 - 频率限制：每分钟最多20次
app.get("/api/user/:username", rateLimit({ windowMs: 60 * 1000, maxRequests: 20 }), async (c) => {
  try {
    const username = c.req.param("username");
    const client = await xGuestClient();

    const resp = await client.getUserApi().getUserByScreenName({
      screenName: username,
    });

    const user = resp.data.user;
    if (!user) {
      return c.json({ success: false, error: "User not found" }, 404);
    }

    const legacy = get(user, "legacy", {});

    return c.json({
      success: true,
      data: {
        id: user.restId,
        screenName: legacy.screenName,
        name: legacy.name,
        description: legacy.description,
        location: legacy.location,
        avatar: legacy.profileImageUrlHttps,
        banner: legacy.profileBannerUrl,
        verified: legacy.verified,
        blueVerified: legacy.isBlueVerified,
        stats: {
          followers: legacy.followersCount,
          following: legacy.friendsCount,
          tweets: legacy.statusesCount,
          listed: legacy.listedCount,
        },
        createdAt: legacy.createdAt,
        url: `https://x.com/${legacy.screenName}`,
      },
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

const port = parseInt(process.env.PORT || "3000");

export default {
  port,
  fetch: app.fetch,
  idleTimeout: 60,
};
