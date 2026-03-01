import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { get } from "lodash";
import dayjs from "dayjs";
import axios from "axios";
import { getApiHeaders, getAuthCookies, getOpenApiFlag, getTransactionId, xGuestClient, XAuthClient } from "./utils";
import { errorCheck } from "twitter-openapi-typescript/dist/src/utils/api";

const app = new Hono();
let guestTokenCache: { token: string; expiresAt: number } | null = null;

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

const getGuestToken = async () => {
  const now = Date.now();
  if (guestTokenCache && guestTokenCache.expiresAt > now) {
    return guestTokenCache.token;
  }
  const resp = await axios.post(
    "https://api.twitter.com/1.1/guest/activate.json",
    null,
    {
      headers: {
        authorization:
          "Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA",
      },
    }
  );
  const token = resp.data?.guest_token;
  if (token) {
    guestTokenCache = { token, expiresAt: now + 10 * 60 * 1000 };
  }
  return token;
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

    const client = process.env.AUTH_TOKEN ? await XAuthClient() : await xGuestClient();
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
    const sortRaw = (c.req.query("sort") || c.req.query("order") || "latest").toLowerCase();
    const sort =
      sortRaw === "top" || sortRaw === "hot" || sortRaw === "popular"
        ? "Top"
        : "Latest";

    if (!query) {
      return c.json({ success: false, error: "Missing search query (q)" }, 400);
    }

    const authToken = process.env.AUTH_TOKEN?.trim();
    const mapGraphqlTweet = (tweetResults: any) => {
      let result = tweetResults?.result;
      if (result?.tweet) {
        result = result.tweet;
      }
      const legacy = result?.legacy || {};
      const userResult = result?.core?.user_results?.result || result?.core?.userResults?.result;
      const userLegacy = userResult?.legacy || {};
      const mediaItems = legacy?.extended_entities?.media || legacy?.extendedEntities?.media || [];
      const id = legacy?.id_str || legacy?.idStr;
      const screenName = userLegacy?.screen_name || userLegacy?.screenName;

      return {
        id,
        text: legacy?.full_text || legacy?.fullText || "",
        createdAt: legacy?.created_at || legacy?.createdAt,
        user: {
          screenName,
          name: userLegacy?.name,
          avatar: userLegacy?.profile_image_url_https || userLegacy?.profileImageUrlHttps,
          followersCount: userLegacy?.followers_count || userLegacy?.followersCount,
        },
        stats: {
          likes: legacy?.favorite_count ?? legacy?.favoriteCount ?? 0,
          retweets: legacy?.retweet_count ?? legacy?.retweetCount ?? 0,
        },
        media: {
          images: (mediaItems || [])
            .filter((media: any) => media.type === "photo")
            .map((media: any) => media.media_url_https || media.mediaUrlHttps || media.media_url),
        },
        url: screenName && id ? `https://x.com/${screenName}/status/${id}` : undefined,
      };
    };

    const collectTweetResults = (node: any, acc: any[] = []) => {
      if (!node) return acc;
      if (Array.isArray(node)) {
        node.forEach((item) => collectTweetResults(item, acc));
        return acc;
      }
      if (typeof node === "object") {
        const tweetResults = node.tweet_results || node.tweetResults;
        if (tweetResults?.result) {
          acc.push(tweetResults);
        }
        Object.values(node).forEach((value) => collectTweetResults(value, acc));
      }
      return acc;
    };

    const mapAdaptiveTweet = (tweet: any, user: any) => {
      const mediaItems = tweet?.extended_entities?.media || [];
      return {
        id: tweet?.id_str,
        text: tweet?.full_text || tweet?.text || "",
        createdAt: tweet?.created_at,
        user: {
          screenName: user?.screen_name,
          name: user?.name,
          avatar: user?.profile_image_url_https,
          followersCount: user?.followers_count,
        },
        stats: {
          likes: tweet?.favorite_count,
          retweets: tweet?.retweet_count,
        },
        media: {
          images: mediaItems
            .filter((media: any) => media.type === "photo")
            .map((media: any) => media.media_url_https || media.media_url),
        },
        url: user?.screen_name ? `https://x.com/${user.screen_name}/status/${tweet?.id_str}` : undefined,
      };
    };

    const explicitCookie = process.env.X_COOKIE?.trim();
    const guestToken = process.env.GET_ID_X_TOKEN?.trim();
    let cookieHeader = "";
    let csrfToken = "";

    if (authToken) {
      const cookies = await getAuthCookies(authToken);
      cookieHeader = cookies.cookieHeader;
      csrfToken = cookies.csrfToken || "";
    } else if (explicitCookie) {
      cookieHeader = explicitCookie;
      const match = explicitCookie.match(/ct0=([^;]+)/);
      csrfToken = match?.[1] || "";
    } else if (guestToken) {
      const cookies = await getAuthCookies(guestToken);
      cookieHeader = cookies.cookieHeader;
      csrfToken = cookies.csrfToken || "";
    }

    if (!cookieHeader) {
      throw new Error("Missing auth cookie");
    }

    const hasAuthCookie = /auth_token=/.test(cookieHeader);
    const buildHeaders = async (path: string) => {
      const baseHeaders = await getApiHeaders();
      const headers: Record<string, string> = {
        ...baseHeaders,
        referer: `https://x.com/search?q=${encodeURIComponent(query)}`,
        cookie: cookieHeader,
      };
      if (csrfToken) {
        headers["x-csrf-token"] = csrfToken;
      }
      if (authToken || hasAuthCookie) {
        headers["x-twitter-auth-type"] = "OAuth2Session";
      } else {
        const guestTokenValue = await getGuestToken();
        if (guestTokenValue) {
          headers["x-guest-token"] = guestTokenValue;
        }
      }
      const transactionId = await getTransactionId("GET", path);
      headers["x-client-transaction-id"] = transactionId;
      return headers;
    };

    const searchGraphql = async (product: string) => {
      const flag = await getOpenApiFlag("SearchTimeline");
      const path = flag["@path"];
      const variables = {
        ...(flag.variables || {}),
        rawQuery: query,
        count: Math.min(count, 100),
        querySource: "typed_query",
        product,
      };
      const params = {
        variables: JSON.stringify(variables),
        features: JSON.stringify(flag.features || {}),
        fieldToggles: JSON.stringify(flag.fieldToggles || {}),
      };
      const headers = await buildHeaders(path);
      const resp = await axios.get(`https://x.com${path}`, { params, headers });
      const searchData = resp.data?.data?.searchByRawQuery || resp.data?.data?.search_by_raw_query;
      const normalized = errorCheck(searchData, resp.data?.errors);
      const timeline = normalized.searchTimeline || normalized.search_timeline;
      const instructions = timeline.timeline.instructions;
      const tweetResults = collectTweetResults(instructions);
      const seen = new Set<string>();
      const tweets = tweetResults
        .map(mapGraphqlTweet)
        .filter((tweet: any) => {
          if (!tweet?.id) return false;
          if (seen.has(tweet.id)) return false;
          seen.add(tweet.id);
          return true;
        })
        .slice(0, Math.min(count, 100));
      return tweets;
    };

    const searchAdaptive = async () => {
      const path = "/i/api/2/search/adaptive.json";
      const headers = await buildHeaders(path);
      const params = {
        include_profile_interstitial_type: 1,
        include_blocking: 1,
        include_blocked_by: 1,
        include_followed_by: 1,
        include_want_retweets: 1,
        include_mute_edge: 1,
        include_can_dm: 1,
        include_can_media_tag: 1,
        include_ext_has_nft_avatar: 1,
        include_ext_is_blue_verified: 1,
        include_ext_verified_type: 1,
        include_ext_profile_image_shape: 1,
        skip_status: 1,
        cards_platform: "Web-12",
        include_cards: 1,
        include_ext_alt_text: true,
        include_ext_limited_action_results: false,
        include_quote_count: true,
        include_reply_count: 1,
        tweet_mode: "extended",
        include_ext_views: true,
        include_entities: true,
        include_user_entities: true,
        include_ext_media_color: true,
        include_ext_media_availability: true,
        include_ext_sensitive_media_warning: true,
        include_ext_trusted_friends_metadata: true,
        send_error_codes: true,
        simple_quoted_tweet: true,
        q: query,
        result_type: sort === "Top" ? "popular" : "recent",
        query_source: "typed_query",
        count: Math.min(count, 100),
        request_context: "launch",
        pc: 1,
        spelling_corrections: 1,
        include_ext_edit_control: true,
        ext: "mediaStats,highlightedLabel,creatorSubscriptions,voiceInfo,superFollowMetadata,unmentionInfo,editControl",
      };

      const adaptiveResp = await axios.get("https://x.com/i/api/2/search/adaptive.json", {
        params,
        headers,
      });
      const adaptiveJson = adaptiveResp.data;
      if (adaptiveJson?.errors?.length) {
        throw new Error(JSON.stringify(adaptiveJson.errors));
      }
      const tweetsMap = adaptiveJson?.globalObjects?.tweets || {};
      const usersMap = adaptiveJson?.globalObjects?.users || {};
      const tweets = Object.values(tweetsMap)
        .map((tweet: any) => {
          const user = usersMap[tweet.user_id_str];
          return mapAdaptiveTweet(tweet, user);
        })
        .filter((tweet: any) => tweet?.id)
        .slice(0, Math.min(count, 100));

      return tweets;
    };

    let tweets = [];
    try {
      let items;
      items = await searchGraphql(sort);
      tweets = items;
      if (tweets.length === 0) {
        tweets = await searchAdaptive();
      }
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 404 || status === 403) {
        tweets = await searchAdaptive();
      } else {
        throw error;
      }
    }

    return c.json({
      success: true,
      query,
      count: tweets.length,
      data: tweets,
    });
  } catch (error: any) {
    const response = error?.response;
    if (response?.status) {
      let detail = "";
      try {
        detail = JSON.stringify(await response.json());
      } catch {
        try {
          detail = await response.text();
        } catch {
          detail = "";
        }
      }
      return c.json({
        success: false,
        error: `Search request failed (${response.status})`,
        detail,
      }, response.status);
    }
    return c.json({ success: false, error: error.message }, 500);
  }
});

app.get("/api/tweet", rateLimit({ windowMs: 60 * 1000, maxRequests: 20 }), async (c) => {
  try {
    const url = c.req.query("url");
    const idParam = c.req.query("id") || c.req.query("tweetId");
    const match = url?.match(/status\/(\d+)/);
    const tweetId = idParam || match?.[1];

    if (!tweetId) {
      return c.json({ success: false, error: "Missing tweet id (id or url)" }, 400);
    }

    const client = process.env.AUTH_TOKEN ? await XAuthClient() : await xGuestClient();
    const resp = await client.getTweetApi().getTweetDetail({ focalTweetId: tweetId });

    const items = (resp.data.data || []).filter((tweet: any) => !tweet.promotedMetadata);

    const mapTweet = (tweet: any) => {
      const legacy = get(tweet, "raw.result.legacy", {});
      const fullText = legacy.fullText || "";
      const mediaItems = legacy.extendedEntities?.media || [];
      const id =
        legacy.idStr ||
        get(tweet, "raw.result.rest_id") ||
        get(tweet, "raw.result.id_str") ||
        get(tweet, "raw.rest_id");
      const userLegacy = get(tweet, "user.legacy", {});
      const screenName = userLegacy.screenName;
      const mediaImages = mediaItems
        .filter((media: any) => media.type === "photo")
        .map((media: any) => media.mediaUrlHttps);
      const mediaVideos = mediaItems
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
        id,
        text: fullText,
        createdAt: legacy.createdAt,
        inReplyToStatusId: legacy.inReplyToStatusIdStr,
        conversationId: legacy.conversationIdStr,
        user: {
          id: get(tweet, "user.restId"),
          screenName,
          name: userLegacy.name,
          avatar: userLegacy.profileImageUrlHttps,
          followersCount: userLegacy.followersCount,
        },
        stats: {
          likes: legacy.favoriteCount,
          retweets: legacy.retweetCount,
          replies: legacy.replyCount,
          quotes: legacy.quoteCount,
        },
        media: {
          images: mediaImages,
          videos: mediaVideos,
        },
        url: screenName && id ? `https://x.com/${screenName}/status/${id}` : undefined,
      };
    };

    const mapped = items.map(mapTweet).filter((t: any) => t.id);
    const focal = mapped.find((t: any) => t.id === tweetId) || null;
    const replies = mapped.filter((t: any) => t.id !== tweetId);

    return c.json({
      success: true,
      tweetId,
      tweet: focal,
      count: replies.length,
      data: replies,
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
