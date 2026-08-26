import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { get } from "lodash";
import axios from "axios";
import { getApiHeaders, getAuthCookies, getOpenApiFlag, getTransactionId } from "./utils";
import {
  fetchHomeTimeline,
  fetchExploreLocations,
  fetchExploreSettings,
  fetchOfficialExplore,
  fetchOfficialRegionTrends,
  fetchRawUser,
  fetchTrendLocations,
  fetchTweetDetail,
  fetchUserTweets,
  mapRawUser,
  mapRawTweets,
  resolveTrendLocation,
} from "./x-api";
import { errorCheck } from "twitter-openapi-typescript/dist/src/utils/api";

const app = new Hono();
let guestTokenCache: { token: string; expiresAt: number } | null = null;

const boundedInt = (value: string | undefined, fallback: number, max: number) => {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), max) : fallback;
};

app.use(cors());
app.use(logger());

// 简单的内存频率限制器
interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const rateLimits = new Map<string, RateLimitEntry>();

// 频率限制中间件
// 搜索端点：默认每IP每5分钟最多30次
// 其他端点：每IP每分钟最多30次
const searchRateWindowMs = parseInt(process.env.SEARCH_RATE_WINDOW_MS || "300000");
const searchRateMax = parseInt(process.env.SEARCH_RATE_MAX || "30");
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

    const allTweets: any[] = [];

    // 获取每个推荐博主的最新推文
    for (const account of accounts.slice(0, count)) {
      try {
        const rawUser = await fetchRawUser(account.username);
        const userId = rawUser?.rest_id || rawUser?.restId;
        if (!userId) continue;
        const tweets = (await fetchUserTweets(userId, maxPerUser)).map((tweet: any) => ({
          ...tweet,
          user: {
            ...tweet.user,
            id: userId,
            username: account.username,
            name: tweet.user?.name || account.name,
            description: account.description,
            tags: account.tags,
          },
          url: `https://x.com/${account.username}/status/${tweet.id}`,
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
    const tweets = (await fetchHomeTimeline(Math.min(count * 2, 100)))
      .filter((tweet: any) => !tweet.isRetweet && !tweet.isQuote)
      .slice(0, Math.min(count, 100));

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
app.get("/api/search", rateLimit({ windowMs: searchRateWindowMs, maxRequests: searchRateMax }), async (c) => {
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
      return mapRawTweets(instructions, Math.min(count, 100));
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
      const detail = typeof response.data === "string"
        ? response.data
        : JSON.stringify(response.data || "");
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

    const mapped = await fetchTweetDetail(tweetId);
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

app.get("/api/article", rateLimit({ windowMs: 60 * 1000, maxRequests: 20 }), async (c) => {
  try {
    const url = c.req.query("url");
    const idParam = c.req.query("id") || c.req.query("articleId") || c.req.query("tweetId");
    const articleMatch = url?.match(/article\/(\d+)/);
    const statusMatch = url?.match(/status\/(\d+)/);
    const tweetId = idParam || articleMatch?.[1] || statusMatch?.[1];

    if (!tweetId) {
      return c.json({ success: false, error: "Missing article id (id or url)" }, 400);
    }

    const authToken = process.env.AUTH_TOKEN?.trim();
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
    const buildHeaders = async (path: string, referer: string) => {
      const baseHeaders = await getApiHeaders();
      const headers: Record<string, string> = {
        ...baseHeaders,
        referer,
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

    const resolveFinalUrl = async (link: string) => {
      try {
        const resp = await axios.get(link, {
          maxRedirects: 5,
          timeout: 15000,
          validateStatus: (status) => status >= 200 && status < 400,
        });
        const responseUrl = get(resp, "request.res.responseUrl") || link;
        return responseUrl;
      } catch {
        return link;
      }
    };

    const extractArticleIdFromUrl = (link?: string | null) => {
      if (!link) return null;
      const match = link.match(/(?:^|\/)article\/(\d+)/);
      return match?.[1] || null;
    };

    const getTweetId = (tweet: any) => {
      const legacy = get(tweet, "raw.result.legacy", {});
      return (
        legacy.idStr ||
        legacy.id_str ||
        get(tweet, "raw.result.restId") ||
        get(tweet, "raw.result.rest_id") ||
        get(tweet, "raw.result.id_str") ||
        get(tweet, "raw.rest_id")
      );
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

    const buildTweetItem = (tweetResults: any) => {
      let result = tweetResults?.result;
      if (result?.tweet) {
        result = result.tweet;
      }
      if (!result) return null;
      const userResult = result?.core?.user_results?.result || result?.core?.userResults?.result || {};
      const userCore = userResult?.core || {};
      const userLegacy = userResult?.legacy || {};
      return {
        raw: { result },
        user: {
          legacy: {
            ...userLegacy,
            screenName: userCore.screen_name || userCore.screenName || userLegacy.screen_name || userLegacy.screenName,
            name: userCore.name || userLegacy.name,
            profileImageUrlHttps:
              userResult?.avatar?.image_url ||
              userResult?.avatar?.imageUrl ||
              userLegacy.profile_image_url_https ||
              userLegacy.profileImageUrlHttps,
            followersCount: userLegacy.followers_count ?? userLegacy.followersCount,
          },
          restId: userResult?.rest_id || userResult?.restId,
        },
      };
    };

    const fetchTweetDetailItems = async (id: string) => {
      const flag = await getOpenApiFlag("TweetDetail");
      const path = flag["@path"];
      const params = {
        variables: JSON.stringify({
          ...(flag.variables || {}),
          focalTweetId: id,
        }),
        features: JSON.stringify(flag.features || {}),
        fieldToggles: JSON.stringify({
          ...(flag.fieldToggles || {}),
          withArticleRichContentState: true,
          withArticlePlainText: true,
          withArticleSummaryText: true,
          withArticleVoiceOver: true,
        }),
      };
      const headers = await buildHeaders(path, `https://x.com/i/status/${id}`);
      const resp = await axios.get(`https://x.com${path}`, { params, headers });
      const conversation =
        resp.data?.data?.threaded_conversation_with_injections_v2 ||
        resp.data?.data?.threadedConversationWithInjectionsV2;
      const normalized = errorCheck(conversation, resp.data?.errors);
      return collectTweetResults(normalized.instructions || [])
        .map(buildTweetItem)
        .filter(Boolean);
    };

    const extractCandidateUrls = (tweet: any) => {
      const legacy = get(tweet, "raw.result.legacy", {});
      const urls = legacy.entities?.urls || [];
      const candidates = new Set<string>();
      urls.forEach((u: any) => {
        const expanded = u?.expandedUrl || u?.expanded_url;
        const urlValue = u?.url;
        const display = u?.displayUrl || u?.display_url;
        if (expanded) candidates.add(expanded);
        if (urlValue) candidates.add(urlValue);
        if (display) candidates.add(display);
      });
      const articleResult =
        get(tweet, "raw.result.article.articleResults.result") ||
        get(tweet, "raw.result.article.article_results.result");
      const articleRestId = articleResult?.restId || articleResult?.rest_id;
      if (articleRestId) {
        candidates.add(`https://x.com/i/article/${articleRestId}`);
      }
      const bindings = get(tweet, "raw.result.card.legacy.binding_values", []);
      if (Array.isArray(bindings)) {
        bindings.forEach((b: any) => {
          const v = b?.value?.string_value || b?.value?.s;
          if (typeof v === "string") candidates.add(v);
        });
      }
      const fullText = legacy.fullText || legacy.full_text || "";
      const textUrls = fullText.match(/https?:\/\/\S+/g) || [];
      textUrls.forEach((u: string) => candidates.add(u));
      return Array.from(candidates);
    };

    const collectImageUrls = (mediaItems: any[]) =>
      Array.from(new Set(
        (mediaItems || [])
          .map((media: any) =>
            media?.mediaUrlHttps ||
            media?.media_url_https ||
            media?.mediaInfo?.originalImgUrl ||
            media?.media_info?.original_img_url
          )
          .filter(Boolean)
      ));

    const collectVideoUrls = (mediaItems: any[]) =>
      Array.from(new Set(
        (mediaItems || [])
          .filter((media: any) => media?.type === "video" || media?.type === "animated_gif")
          .map((media: any) => {
            const variants = media?.videoInfo?.variants || media?.video_info?.variants || [];
            const bestQuality = variants
              .filter((v: any) => v?.contentType === "video/mp4" || v?.content_type === "video/mp4")
              .sort((a: any, b: any) => (b?.bitrate || 0) - (a?.bitrate || 0))[0];
            return bestQuality?.url;
          })
          .filter(Boolean)
      ));

    const mapArticle = (tweet: any) => {
      const legacy = get(tweet, "raw.result.legacy", {});
      const fullText = legacy.fullText || legacy.full_text || "";
      const id =
        legacy.idStr ||
        legacy.id_str ||
        get(tweet, "raw.result.restId") ||
        get(tweet, "raw.result.rest_id") ||
        get(tweet, "raw.result.id_str") ||
        get(tweet, "raw.rest_id");
      const userLegacy = get(tweet, "user.legacy", {});
      const screenName = userLegacy.screenName || userLegacy.screen_name;
      const mediaItems = legacy.extendedEntities?.media || legacy.extended_entities?.media || [];
      const articleResult =
        get(tweet, "raw.result.article.articleResults.result") ||
        get(tweet, "raw.result.article.article_results.result");
      const articleMediaItems = articleResult?.mediaEntities || articleResult?.media_entities || [];
      const coverMedia = articleResult?.coverMedia || articleResult?.cover_media;
      const mediaImages = Array.from(new Set([
        ...collectImageUrls(mediaItems.filter((media: any) => media?.type === "photo")),
        ...collectImageUrls(articleMediaItems),
        coverMedia?.mediaInfo?.originalImgUrl,
        coverMedia?.media_info?.original_img_url,
      ].filter(Boolean)));
      const mediaVideos = collectVideoUrls(mediaItems);

      const noteResult =
        get(tweet, "raw.result.note_tweet.note_tweet_results.result") ||
        get(tweet, "raw.result.note_tweet_results.result") ||
        get(tweet, "raw.result.note_tweet");
      const noteText = noteResult?.text || noteResult?.full_text || noteResult?.fullText || null;
      const noteTitle = noteResult?.title || noteResult?.display_title || noteResult?.displayTitle || null;
      const noteSummary = get(noteResult, "summary.text") || noteResult?.summary || null;
      const articleText = articleResult?.plainText || articleResult?.plain_text || null;
      const articleTitle = articleResult?.title || null;
      const articlePreview = articleResult?.previewText || articleResult?.preview_text || null;
      const articleId = articleResult?.restId || articleResult?.rest_id || null;

      return {
        id,
        articleId,
        article: articleText || noteText || articleTitle || noteTitle || articlePreview || noteSummary
          ? {
            text: articleText || noteText || fullText,
            title: articleTitle || noteTitle || undefined,
            summary: articlePreview || noteSummary || undefined,
          }
          : null,
        content: articleText || noteText || fullText,
        isArticle: Boolean(articleText || noteText),
        tweet: {
          id,
          text: fullText,
          createdAt: legacy.createdAt || legacy.created_at,
          inReplyToStatusId: legacy.inReplyToStatusIdStr || legacy.in_reply_to_status_id_str,
          conversationId: legacy.conversationIdStr || legacy.conversation_id_str,
          user: {
            id: get(tweet, "user.restId"),
            screenName,
            name: userLegacy.name,
            avatar: userLegacy.profileImageUrlHttps || userLegacy.profile_image_url_https,
            followersCount: userLegacy.followersCount || userLegacy.followers_count,
          },
          stats: {
            likes: legacy.favoriteCount ?? legacy.favorite_count,
            retweets: legacy.retweetCount ?? legacy.retweet_count,
            replies: legacy.replyCount ?? legacy.reply_count,
            quotes: legacy.quoteCount ?? legacy.quote_count,
          },
          media: {
            images: mediaImages,
            videos: mediaVideos,
          },
          url: screenName && id ? `https://x.com/${screenName}/status/${id}` : undefined,
        },
      };
    };

    const fetchArticleById = async (id: string) => {
      const items = await fetchTweetDetailItems(id);
      const mapped = items.map(mapArticle).filter((t: any) => t.id);
      const focal = mapped.find((t: any) => t.id === id) || null;
      return focal ? { focal, items } : { focal: null, items };
    };

    const items = await fetchTweetDetailItems(tweetId);
    const mapped = items.map(mapArticle).filter((t: any) => t.id);
    const focal = mapped.find((t: any) => t.id === tweetId) || null;

    if (!focal) {
      return c.json({ success: false, error: "Article not found" }, 404);
    }

    if (!focal.isArticle) {
      const rawFocal = items.find((t: any) => getTweetId(t) === tweetId) || null;
      if (rawFocal) {
        const candidates = extractCandidateUrls(rawFocal);
        let resolvedArticleId: string | null = null;
        for (const candidate of candidates) {
          const directId = extractArticleIdFromUrl(candidate);
          if (directId) {
            resolvedArticleId = directId;
            break;
          }
          if (candidate.includes("t.co/")) {
            const finalUrl = await resolveFinalUrl(candidate);
            const idFromFinal = extractArticleIdFromUrl(finalUrl);
            if (idFromFinal) {
              resolvedArticleId = idFromFinal;
              break;
            }
          }
        }
        if (resolvedArticleId && resolvedArticleId !== tweetId) {
          const resolved = await fetchArticleById(resolvedArticleId);
          if (resolved.focal) {
            return c.json({
              success: true,
              articleId: resolved.focal.articleId || resolvedArticleId,
              article: resolved.focal.article,
              content: resolved.focal.content,
              isArticle: resolved.focal.isArticle,
              tweet: resolved.focal.tweet,
            });
          }
        }
      }
    }

    return c.json({
      success: true,
      articleId: focal.articleId || tweetId,
      article: focal.article,
      content: focal.content,
      isArticle: focal.isArticle,
      tweet: focal.tweet,
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

    const rawUser = await fetchRawUser(username);
    const userId = rawUser?.rest_id || rawUser?.restId;
    if (!userId) {
      return c.json({ success: false, error: "User not found" }, 404);
    }
    const tweets = (await fetchUserTweets(userId, Math.min(count, 100))).map((tweet: any) => ({
      ...tweet,
      url: `https://x.com/${username}/status/${tweet.id}`,
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

// 获取官方趋势地区目录（WOEID）
app.get("/api/trend-locations", rateLimit({ windowMs: 60 * 1000, maxRequests: 30 }), async (c) => {
  try {
    const q = (c.req.query("q") || "").trim().toLowerCase();
    const country = (c.req.query("country") || "").trim().toLowerCase();
    const type = (c.req.query("type") || "").trim().toLowerCase();
    const limit = boundedInt(c.req.query("limit"), 200, 1000);
    const allLocations = await fetchTrendLocations();
    const matched = allLocations.filter((location: any) => {
      const searchable = [
        location.name,
        location.slug,
        location.country,
        location.countryCode,
        location.placeType,
        location.woeid,
      ].filter(Boolean).join(" ").toLowerCase();
      const countryMatches = !country ||
        String(location.countryCode || "").toLowerCase() === country ||
        String(location.country || "").toLowerCase() === country;
      const typeMatches = !type || String(location.placeType || "").toLowerCase() === type;
      return (!q || searchable.includes(q)) && countryMatches && typeMatches;
    });
    const data = matched.slice(0, limit);

    return c.json({
      success: true,
      source: "x_trends_available",
      usage: "将 region 或 woeid 传给 /api/trends",
      total: allLocations.length,
      matchedCount: matched.length,
      count: data.length,
      data,
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 获取官方 Explore 地点目录（place_id，仅用于识别账号偏好地点）
app.get("/api/explore/locations", rateLimit({ windowMs: 60 * 1000, maxRequests: 30 }), async (c) => {
  try {
    const q = (c.req.query("q") || "").trim().toLowerCase();
    const type = (c.req.query("type") || "").trim().toLowerCase();
    const limit = boundedInt(c.req.query("limit"), 200, 1000);
    const allLocations = await fetchExploreLocations();
    const matched = allLocations.filter((location: any) => {
      const searchable = [location.name, location.slug, location.placeId, location.locationType]
        .filter(Boolean).join(" ").toLowerCase();
      const typeMatches = !type || String(location.locationType || "").toLowerCase() === type;
      return (!q || searchable.includes(q)) && typeMatches;
    });
    const data = matched.slice(0, limit);

    return c.json({
      success: true,
      source: "x_explore_locations",
      usage: "只读地点目录；placeId 不是 WOEID，地区热搜请使用 /api/trend-locations",
      total: allLocations.length,
      matchedCount: matched.length,
      count: data.length,
      data,
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 获取当前账号的官方 Explore 设置（只读）
app.get("/api/explore/settings", rateLimit({ windowMs: 60 * 1000, maxRequests: 30 }), async (c) => {
  try {
    return c.json({
      success: true,
      readOnly: true,
      note: "这是当前 AUTH_TOKEN 对应账号的全局 Explore 设置，本服务不会自动修改它",
      data: await fetchExploreSettings(),
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 获取当前账号可用的官方 Explore 分类
app.get("/api/explore/categories", rateLimit({ windowMs: 60 * 1000, maxRequests: 30 }), async (c) => {
  try {
    const result = await fetchOfficialExplore("for-you");
    return c.json({
      success: true,
      source: "official_explore",
      count: result.categories.length,
      data: result.categories,
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 获取 x.com 官方趋势话题 - 频率限制：每5分钟最多10次
app.get("/api/trends", rateLimit({ windowMs: 5 * 60 * 1000, maxRequests: 10 }), async (c) => {
  try {
    const source = (c.req.query("source") || "official").trim().toLowerCase();
    const count = boundedInt(c.req.query("count"), 20, 50);
    const region = c.req.query("region")?.trim();
    const woeid = c.req.query("woeid")?.trim();

    if (!["official", "timeline", "aggregated", "aggregated_timeline"].includes(source)) {
      return c.json({
        success: false,
        error: `Unsupported trends source: ${source}`,
        supportedSources: ["official", "timeline"],
      }, 400);
    }

    if (source === "official") {
      const useAccountRegion = !woeid && (!region || ["account", "current", "personalized"]
        .includes(region.toLowerCase()));
      if (useAccountRegion) {
        const result = await fetchOfficialExplore("trending");
        const data = result.trends.slice(0, count);
        return c.json({
          success: true,
          source: "official_explore",
          region: "account",
          note: "使用当前账号的官方 Explore/Trending 地区与个性化设置",
          settingsUrl: "/api/explore/settings",
          count: data.length,
          data,
        });
      }

      let location;
      try {
        location = await resolveTrendLocation(region, woeid);
      } catch (error: any) {
        return c.json({
          success: false,
          error: error.message,
          locationsUrl: "/api/trend-locations",
        }, 400);
      }
      const result = await fetchOfficialRegionTrends(location.woeid);
      const data = result.trends.slice(0, count);
      return c.json({
        success: true,
        source: "official_region",
        region: location,
        asOf: result.asOf,
        createdAt: result.createdAt,
        count: data.length,
        data,
      });
    }

    const allHashtags = new Map<string, { count: number; tweets: any[] }>();
    const tweets = await fetchHomeTimeline(100);
    tweets.forEach((tweet: any) => {
      (tweet.hashtags || []).forEach((tagText: string) => {
        if (!tagText || tagText.length <= 1) return;
        const existing = allHashtags.get(tagText);
        if (existing) {
          existing.count++;
        } else {
          allHashtags.set(tagText, {
            count: 1,
            tweets: [{
              id: tweet.id,
              text: tweet.text.slice(0, 100),
              user: tweet.user?.screenName,
            }],
          });
        }
      });
    });

    // 按出现次数排序
    const sortedTrends = Array.from(allHashtags.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, count)
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
        source: "aggregated_timeline",
        note: "兼容模式：基于当前账号时间线聚合的热门话题标签",
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

// 获取官方探索/热门内容 (Explore) - 频率限制：每分钟最多20次
app.get("/api/explore", rateLimit({ windowMs: 60 * 1000, maxRequests: 20 }), async (c) => {
  try {
    const category = c.req.query("category") || "for-you";
    const source = (c.req.query("source") || "official").trim().toLowerCase();
    const count = boundedInt(c.req.query("count"), 20, 100);

    if (!["official", "timeline", "home"].includes(source)) {
      return c.json({
        success: false,
        error: `Unsupported Explore source: ${source}`,
        supportedSources: ["official", "timeline"],
      }, 400);
    }

    if (source === "timeline" || source === "home") {
      const tweets = (await fetchHomeTimeline(count)).slice(0, count);
      return c.json({
        success: true,
        source: "timeline",
        category: "home",
        count: tweets.length,
        data: tweets,
      });
    }

    let result;
    try {
      result = await fetchOfficialExplore(category);
    } catch (error: any) {
      if (String(error.message).startsWith("Unsupported Explore category:")) {
        return c.json({
          success: false,
          error: error.message,
          categoriesUrl: "/api/explore/categories",
        }, 400);
      }
      throw error;
    }
    const trends = result.trends.slice(0, count);
    const tweets = result.tweets.slice(0, count);

    return c.json({
      success: true,
      source: "official_explore",
      category: result.category,
      availableCategories: result.categories,
      count: trends.length + tweets.length,
      counts: { trends: trends.length, tweets: tweets.length },
      data: { trends, tweets },
    });
  } catch (error: any) {
    return c.json({ success: false, error: error.message }, 500);
  }
});

// 获取用户信息 - 频率限制：每分钟最多20次
app.get("/api/user/:username", rateLimit({ windowMs: 60 * 1000, maxRequests: 20 }), async (c) => {
  try {
    const username = c.req.param("username");
    const user = mapRawUser(await fetchRawUser(username));
    if (!user) {
      return c.json({ success: false, error: "User not found" }, 404);
    }

    return c.json({
      success: true,
      data: user,
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
