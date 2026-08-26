// Additive metadata only. Unknown privacy must never be treated as public.
export function protectedStatus(user: any): boolean | null {
  const values = [user?.privacy?.protected, user?.legacy?.protected, user?.protected];
  if (values.includes(true)) return true;
  return values.includes(false) ? false : null;
}

const postId = (value: unknown): string | null =>
  typeof value === "string" && /^\d{1,25}$/.test(value) ? value : null;

function safeLink(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function postProvenance(result: any) {
  const legacy = result?.legacy || {};
  const note = result?.note_tweet?.note_tweet_results?.result;
  const entities = [note?.entity_set?.urls, legacy?.entities?.urls].flatMap(rows => Array.isArray(rows) ? rows : []);
  const seen = new Set<string>();
  const urls: { url: string | null; expandedUrl: string; displayUrl: string | null }[] = [];
  for (const entity of entities.slice(0, 40)) {
    const expandedUrl = safeLink(entity?.expanded_url ?? entity?.expandedUrl ?? entity?.url);
    if (!expandedUrl || seen.has(expandedUrl)) continue;
    seen.add(expandedUrl);
    urls.push({ url: safeLink(entity?.url), expandedUrl, displayUrl: typeof (entity?.display_url ?? entity?.displayUrl) === "string" ? (entity.display_url ?? entity.displayUrl).slice(0, 300) : null });
    if (urls.length >= 20) break;
  }
  const inReplyToStatusId = postId(legacy.in_reply_to_status_id_str ?? legacy.inReplyToStatusIdStr);
  return {
    isReply: !!inReplyToStatusId,
    inReplyToStatusId,
    quotedStatusId: postId(legacy.quoted_status_id_str ?? legacy.quotedStatusIdStr ?? result?.quoted_status_result?.result?.rest_id),
    retweetedStatusId: postId(legacy.retweeted_status_id_str ?? legacy.retweeted_status_result?.result?.rest_id ?? legacy.retweetedStatusResult?.result?.restId),
    urls,
    possiblySensitive: legacy.possibly_sensitive === true || legacy.possiblySensitive === true,
    restrictedAudience: !!(result?.trusted_friends_info || legacy.trusted_friends_info || result?.super_follows_reply_user_result || result?.exclusive_tweet_info || result?.limited_actions || result?.limitedActionResults),
  };
}
