import axios from "axios";
import { postProvenance, protectedStatus } from "./post-provenance";
import { getApiHeaders, getAuthCookies, getOpenApiFlag, getTransactionId } from "./utils";

type GraphqlOptions = {
  token?: string;
  referer?: string;
  transactionId?: boolean;
};

type XRestOptions = {
  token?: string;
  referer?: string;
  params?: Record<string, any>;
};

let trendLocationsCache: { data: any[]; expiresAt: number } | null = null;
let exploreLocationsCache: { data: any[]; expiresAt: number } | null = null;

const compact = <T>(values: Array<T | undefined | null>): T[] => values.filter(Boolean) as T[];

const unwrapTweetResult = (value: any): any => {
  let result = value?.result || value;
  if (result?.tweet) result = result.tweet;
  return result;
};

const unwrapUserResult = (value: any): any => {
  let result = value?.result || value;
  if (result?.user) result = result.user;
  return result;
};

const buildXHeaders = async (token: string, referer: string) => {
  const cookies = await getAuthCookies(token);
  const headers: Record<string, string> = {
    ...(await getApiHeaders()),
    cookie: cookies.cookieHeader,
    referer,
    "x-twitter-auth-type": "OAuth2Session",
  };
  if (cookies.csrfToken) headers["x-csrf-token"] = cookies.csrfToken;
  return headers;
};

export const requestXRest = async (path: string, options: XRestOptions = {}) => {
  const token = (options.token || process.env.AUTH_TOKEN || process.env.GET_ID_X_TOKEN || "").trim();
  if (!token) throw new Error("Missing X auth token");
  const headers = await buildXHeaders(token, options.referer || "https://x.com/explore");
  const response = await axios.get(`https://x.com${path}`, {
    headers,
    params: options.params,
    timeout: 20_000,
  });
  return response.data;
};

export const requestXGraphql = async (
  operation: string,
  variables: Record<string, any>,
  options: GraphqlOptions = {},
) => {
  const token = (options.token || process.env.AUTH_TOKEN || process.env.GET_ID_X_TOKEN || "").trim();
  if (!token) throw new Error("Missing X auth token");

  const flag = await getOpenApiFlag(operation);
  const path = flag["@path"];
  const method = String(flag["@method"] || "GET").toUpperCase();
  if (!path) throw new Error(`Missing GraphQL path: ${operation}`);

  const headers = await buildXHeaders(token, options.referer || "https://x.com/home");
  if (options.transactionId) {
    headers["x-client-transaction-id"] = await getTransactionId(method, path);
  }

  const mergedVariables = { ...(flag.variables || {}), ...variables };
  const url = `https://x.com${path}`;
  const response = method === "POST"
    ? await axios.post(url, {
        variables: mergedVariables,
        features: flag.features || {},
        queryId: flag.queryId,
      }, { headers, timeout: 20_000 })
    : await axios.get(url, {
        headers,
        timeout: 20_000,
        params: {
          variables: JSON.stringify(mergedVariables),
          features: JSON.stringify(flag.features || {}),
          ...(flag.fieldToggles
            ? { fieldToggles: JSON.stringify(flag.fieldToggles) }
            : {}),
        },
      });

  if (response.data?.errors?.length && !response.data?.data) {
    throw new Error(`${operation}: ${JSON.stringify(response.data.errors)}`);
  }
  return response.data;
};

export const collectTweetResults = (node: any): any[] => {
  const results: any[] = [];
  const visit = (value: any) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const tweetResults = value.tweet_results || value.tweetResults;
    if (tweetResults?.result && !value.promotedMetadata) {
      results.push(tweetResults.result);
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(node);
  return results;
};

export const mapRawTweet = (rawResult: any) => {
  const result = unwrapTweetResult(rawResult);
  const legacy = result?.legacy || {};
  if (!result || (!result.rest_id && !legacy.id_str)) return null;

  const userResult = unwrapUserResult(
    result?.core?.user_results || result?.core?.userResults,
  );
  const userLegacy = userResult?.legacy || {};
  const userCore = userResult?.core || {};
  const noteText = result?.note_tweet?.note_tweet_results?.result?.text;
  const mediaItems = legacy?.extended_entities?.media || legacy?.extendedEntities?.media || [];
  const id = result.rest_id || legacy.id_str || legacy.idStr;
  const screenName =
    userCore.screen_name || userCore.screenName || userLegacy.screen_name || userLegacy.screenName;

  const images = mediaItems
    .filter((media: any) => media?.type === "photo")
    .map((media: any) => media.media_url_https || media.mediaUrlHttps || media.media_url)
    .filter(Boolean);
  const videos = mediaItems
    .filter((media: any) => media?.type === "video" || media?.type === "animated_gif")
    .map((media: any) => {
      const variants = media?.video_info?.variants || media?.videoInfo?.variants || [];
      return variants
        .filter((variant: any) => (variant.content_type || variant.contentType) === "video/mp4")
        .sort((a: any, b: any) => (b.bitrate || 0) - (a.bitrate || 0))[0]?.url;
    })
    .filter(Boolean);

  return {
    id,
    text: noteText || legacy.full_text || legacy.fullText || "",
    createdAt: legacy.created_at || legacy.createdAt,
    user: {
      id: userResult?.rest_id || userResult?.restId,
      screenName,
      name: userCore.name || userLegacy.name,
      avatar:
        userResult?.avatar?.image_url ||
        userResult?.avatar?.imageUrl ||
        userLegacy.profile_image_url_https ||
        userLegacy.profileImageUrlHttps,
      followersCount: userLegacy.followers_count ?? userLegacy.followersCount,
      friendsCount: userLegacy.friends_count ?? userLegacy.friendsCount,
      verified: userResult?.verification?.verified ?? userLegacy.verified,
      blueVerified: userResult?.is_blue_verified ?? userResult?.isBlueVerified,
      protected: protectedStatus(userResult),
    },
    stats: {
      likes: legacy.favorite_count ?? legacy.favoriteCount ?? 0,
      retweets: legacy.retweet_count ?? legacy.retweetCount ?? 0,
      replies: legacy.reply_count ?? legacy.replyCount ?? 0,
      quotes: legacy.quote_count ?? legacy.quoteCount ?? 0,
      bookmarks: legacy.bookmark_count ?? legacy.bookmarkCount ?? 0,
      views: result?.views?.count,
    },
    media: { images, videos },
    hashtags: compact(
      (legacy?.entities?.hashtags || []).map((tag: any) => tag?.text),
    ),
    url: id ? `https://x.com/${screenName || "i"}/status/${id}` : undefined,
    isRetweet: Boolean(legacy.retweeted_status_result || legacy.retweetedStatusResult),
    isQuote: Boolean(legacy.is_quote_status ?? legacy.isQuoteStatus),
    ...postProvenance(result),
  };
};

export const mapRawTweets = (node: any, limit = 100) => {
  const seen = new Set<string>();
  return collectTweetResults(node)
    .map(mapRawTweet)
    .filter((tweet: any) => {
      if (!tweet?.id || seen.has(tweet.id)) return false;
      seen.add(tweet.id);
      return true;
    })
    .slice(0, limit);
};

export const mapRawUser = (rawResult: any) => {
  const result = unwrapUserResult(rawResult);
  const legacy = result?.legacy || {};
  const core = result?.core || {};
  if (!result || (!result.rest_id && !result.restId)) return null;
  const screenName = core.screen_name || core.screenName || legacy.screen_name || legacy.screenName;
  return {
    id: result.rest_id || result.restId,
    screenName,
    name: core.name || legacy.name,
    description: result?.profile_bio?.description || legacy.description,
    location: result?.location?.location || legacy.location,
    avatar:
      result?.avatar?.image_url ||
      result?.avatar?.imageUrl ||
      legacy.profile_image_url_https ||
      legacy.profileImageUrlHttps,
    banner: legacy.profile_banner_url || legacy.profileBannerUrl,
    verified: result?.verification?.verified ?? legacy.verified,
    blueVerified: result.is_blue_verified ?? result.isBlueVerified,
    protected: protectedStatus(result),
    stats: {
      followers: legacy.followers_count ?? legacy.followersCount ?? 0,
      following: legacy.friends_count ?? legacy.friendsCount ?? 0,
      tweets: legacy.statuses_count ?? legacy.statusesCount ?? 0,
      listed: legacy.listed_count ?? legacy.listedCount ?? 0,
    },
    createdAt: core.created_at || core.createdAt || legacy.created_at || legacy.createdAt,
    url: screenName ? `https://x.com/${screenName}` : undefined,
  };
};

// Search's adaptive fallback must retain the same privacy/provenance contract.
export const mapAdaptiveTweet = (tweet: any, user: any) => mapRawTweet({
  rest_id: tweet?.id_str,
  legacy: { ...tweet, full_text: tweet?.full_text || tweet?.text || "" },
  core: { user_results: { result: { rest_id: user?.id_str, legacy: user } } },
});

export const fetchRawUser = async (username: string, token?: string) => {
  const data = await requestXGraphql(
    "UserByScreenName",
    { screen_name: username },
    { token, referer: `https://x.com/${username}` },
  );
  return data?.data?.user?.result;
};

export const fetchUserTweets = async (userId: string, count: number, token?: string) => {
  const data = await requestXGraphql(
    "UserTweets",
    { userId, count: Math.min(Math.max(count, 1), 100) },
    { token },
  );
  const instructions = data?.data?.user?.result?.timeline?.timeline?.instructions || [];
  return mapRawTweets(instructions, count);
};

export const fetchHomeTimeline = async (count: number, token?: string) => {
  const data = await requestXGraphql(
    "HomeLatestTimeline",
    { count: Math.min(Math.max(count, 1), 100), seenTweetIds: [] },
    { token, referer: "https://x.com/home" },
  );
  const instructions = data?.data?.home?.home_timeline_urt?.instructions || [];
  return mapRawTweets(instructions, count);
};

export const fetchTweetDetail = async (tweetId: string, token?: string) => {
  const data = await requestXGraphql(
    "TweetDetail",
    { focalTweetId: tweetId },
    { token, referer: `https://x.com/i/status/${tweetId}` },
  );
  const instructions = data?.data?.threaded_conversation_with_injections_v2?.instructions || [];
  return mapRawTweets(instructions, 100);
};

const normalizeLocation = (value: string) => value
  .trim()
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-|-$/g, "");

export const fetchTrendLocations = async () => {
  const now = Date.now();
  if (trendLocationsCache && trendLocationsCache.expiresAt > now) {
    return trendLocationsCache.data;
  }
  const rows = await requestXRest("/i/api/1.1/trends/available.json");
  const locations = (Array.isArray(rows) ? rows : []).map((item: any) => ({
    name: item.name,
    slug: normalizeLocation(item.name || ""),
    woeid: item.woeid,
    country: item.country || undefined,
    countryCode: item.countryCode || undefined,
    placeType: item.placeType?.name || undefined,
    parentId: item.parentid,
  }));
  trendLocationsCache = { data: locations, expiresAt: now + 6 * 60 * 60 * 1000 };
  return locations;
};

export const fetchExploreLocations = async () => {
  const now = Date.now();
  if (exploreLocationsCache && exploreLocationsCache.expiresAt > now) {
    return exploreLocationsCache.data;
  }
  const rows = await requestXRest("/i/api/2/guide/explore_locations_with_auto_complete.json");
  const locations = (Array.isArray(rows) ? rows : []).map((item: any) => ({
    name: item.name,
    slug: normalizeLocation(item.name || ""),
    placeId: item.place_id,
    locationType: item.location_type,
  }));
  exploreLocationsCache = { data: locations, expiresAt: now + 6 * 60 * 60 * 1000 };
  return locations;
};

export const fetchExploreSettings = () =>
  requestXRest("/i/api/2/guide/get_explore_settings.json");

export const resolveTrendLocation = async (region?: string, woeid?: string) => {
  const locations = await fetchTrendLocations();
  if (woeid) {
    const id = Number(woeid);
    if (!Number.isSafeInteger(id)) throw new Error("Invalid WOEID");
    const match = locations.find((item: any) => item.woeid === id);
    if (!match) throw new Error(`Unsupported trend location WOEID: ${woeid}`);
    return match;
  }

  const requested = (region || "worldwide").trim();
  const normalized = normalizeLocation(requested);
  const aliases: Record<string, string> = {
    global: "worldwide",
    world: "worldwide",
    usa: "us",
    "united-states-of-america": "us",
    uk: "gb",
    britain: "gb",
    england: "gb",
  };
  const target = aliases[normalized] || normalized;
  if (target === "worldwide") {
    return locations.find((item: any) => item.woeid === 1);
  }

  const countryMatches = locations.filter((item: any) =>
    String(item.countryCode || "").toLowerCase() === target,
  );
  if (countryMatches.length) {
    return countryMatches.find((item: any) => item.placeType === "Country") || countryMatches[0];
  }

  const nameMatches = locations.filter((item: any) =>
    item.slug === target || normalizeLocation(item.country || "") === target,
  );
  if (nameMatches.length) {
    return nameMatches.find((item: any) => item.placeType === "Country") || nameMatches[0];
  }
  throw new Error(`Unsupported trend region: ${requested}`);
};

export const fetchOfficialRegionTrends = async (woeid: number) => {
  const data = await requestXRest("/i/api/1.1/trends/place.json", {
    params: { id: woeid },
    referer: "https://x.com/explore/tabs/trending",
  });
  const result = Array.isArray(data) ? data[0] : null;
  return {
    asOf: result?.as_of,
    createdAt: result?.created_at,
    locations: result?.locations || [],
    trends: (result?.trends || []).map((trend: any) => ({
      name: trend.name,
      query: trend.query,
      url: trend.url,
      tweetVolume: trend.tweet_volume,
      promotedContent: trend.promoted_content,
    })),
  };
};

export const collectExploreTrends = (node: any) => {
  const trends: any[] = [];
  const seen = new Set<string>();
  const visit = (value: any) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (value.itemType === "TimelineTrend" && value.name) {
      const rawUrl = value.trend_url?.url || value.trend_metadata?.url?.url || "";
      const trendId = rawUrl.match(/trending\/(\d+)/)?.[1];
      let query = value.name;
      try {
        const queryUrl = new URL(rawUrl.replace("twitter://search/", "https://x.com/search"));
        query = queryUrl.searchParams.get("query") || value.name;
      } catch {}
      const key = trendId || `${value.name}:${value.trend_metadata?.domain_context || ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        trends.push({
          id: trendId,
          name: value.name,
          query,
          domainContext: value.trend_metadata?.domain_context,
          socialContext: value.social_context,
          isAiTrend: Boolean(value.is_ai_trend),
          url: `https://x.com/search?q=${encodeURIComponent(query)}`,
        });
      }
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(node);
  return trends;
};

export const fetchOfficialExplore = async (category: string) => {
  const page = await requestXGraphql("ExplorePage", {}, {
    referer: "https://x.com/explore",
  });
  const body = page?.data?.explore_page?.body;
  const categories = (body?.timelines || []).map((item: any) => ({
    id: item.id,
    label: item.labelText,
    refreshIntervalSec: item.refreshIntervalSec,
    timelineId: item.timeline?.id,
  }));
  const normalizedCategory = category.replace(/-/g, "_").toLowerCase();
  const selected = categories.find((item: any) => item.id === normalizedCategory);
  if (!selected) {
    throw new Error(`Unsupported Explore category: ${category}`);
  }

  let instructions;
  if (normalizedCategory === "for_you") {
    instructions = body?.initialTimeline?.timeline?.timeline?.instructions || [];
  } else {
    const timeline = await requestXGraphql(
      "GenericTimelineById",
      { timelineId: selected.timelineId, count: 40 },
      { referer: `https://x.com/explore/tabs/${normalizedCategory}` },
    );
    instructions = timeline?.data?.timeline?.timeline?.instructions || [];
  }
  return {
    category: selected,
    categories,
    trends: collectExploreTrends(instructions),
    tweets: mapRawTweets(instructions, 100),
  };
};
