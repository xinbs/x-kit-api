import { describe, expect, test } from "bun:test";
import { mapRawTweet, mapRawUser, mapAdaptiveTweet } from "./x-api";

const fixture = () => ({
  rest_id: "2092572767715819657",
  core: { user_results: { result: { rest_id: "42", core: { screen_name: "researcher", name: "Researcher" }, privacy: { protected: false }, legacy: {} } } },
  legacy: { full_text: "New research https://t.co/test", created_at: "Wed Aug 26 11:20:00 +0000 2026", favorite_count: 4, entities: { urls: [{ url: "https://t.co/test", expanded_url: "https://example.org/paper", display_url: "example.org/paper" }] } },
});

describe("public post provenance contract", () => {
  test("adaptive search fallback has identical privacy and context semantics", () => {
    const tweet = { id_str: "2092572767715819657", text: "Fallback original", in_reply_to_status_id_str: "2092572000000000000", entities: { urls: [{ expanded_url: "https://example.org/source" }] } };
    expect(mapAdaptiveTweet(tweet, { screen_name: "writer", protected: false })).toMatchObject({ text: "Fallback original", user: { protected: false }, isReply: true, urls: [{ expandedUrl: "https://example.org/source" }] });
    expect(mapAdaptiveTweet(tweet, { screen_name: "writer" })?.user.protected).toBeNull();
  });
  test("preserves current post fields and adds explicit privacy, external links and reply context", () => {
    const result = mapRawTweet(fixture());
    expect(result).toMatchObject({ id: "2092572767715819657", text: "New research https://t.co/test", stats: { likes: 4 }, user: { screenName: "researcher", protected: false }, isReply: false, inReplyToStatusId: null, urls: [{ url: "https://t.co/test", expandedUrl: "https://example.org/paper" }] });
    expect(result?.url).toBe("https://x.com/researcher/status/2092572767715819657");
  });
  test.each([true, false])("maps modern privacy %p", protectedValue => {
    const raw = fixture(); raw.core.user_results.result.privacy.protected = protectedValue;
    expect(mapRawTweet(raw)?.user.protected).toBe(protectedValue);
    expect(mapRawUser(raw.core.user_results.result)?.protected).toBe(protectedValue);
  });
  test("unknown and malformed privacy never become public; true wins conflicting fields", () => {
    const raw: any = fixture(); delete raw.core.user_results.result.privacy;
    expect(mapRawTweet(raw)?.user.protected).toBeNull();
    raw.core.user_results.result.legacy.protected = "false";
    expect(mapRawTweet(raw)?.user.protected).toBeNull();
    raw.core.user_results.result.legacy.protected = false;
    expect(mapRawTweet(raw)?.user.protected).toBe(false);
    raw.core.user_results.result.privacy = { protected: true };
    expect(mapRawTweet(raw)?.user.protected).toBe(true);
  });
  test("preserves referenced post IDs without leaking the referenced private body", () => {
    const raw: any = fixture();
    Object.assign(raw.legacy, { in_reply_to_status_id_str: "2092572000000000000", quoted_status_id_str: "2092571000000000000", retweeted_status_result: { result: { rest_id: "2092570000000000000", legacy: { full_text: "private quoted content" } } } });
    const result = mapRawTweet(raw);
    expect(result).toMatchObject({ isReply: true, inReplyToStatusId: "2092572000000000000", quotedStatusId: "2092571000000000000", retweetedStatusId: "2092570000000000000" });
    expect(JSON.stringify(result)).not.toContain("private quoted content");
  });
  test("only emits bounded http links; never credentials, javascript, duplicates or malformed entities", () => {
    const raw: any = fixture();
    raw.legacy.entities.urls.push({ expanded_url: "javascript:alert(1)" }, { expanded_url: "https://user:password@example.org/" }, { expanded_url: "https://example.org/paper" }, null);
    expect(mapRawTweet(raw)?.urls).toHaveLength(1);
    raw.legacy.entities.urls = [{ expanded_url: "https://example.org/" + "x".repeat(3000) }];
    expect(mapRawTweet(raw)?.urls).toEqual([]);
  });
  test("note tweet entities and full text take precedence", () => {
    const raw: any = fixture();
    raw.note_tweet = { note_tweet_results: { result: { text: "The complete long post", entity_set: { urls: [{ expanded_url: "https://example.org/long" }] } } } };
    expect(mapRawTweet(raw)?.text).toBe("The complete long post");
    expect(mapRawTweet(raw)?.urls?.some((url: any) => url.expandedUrl === "https://example.org/long")).toBe(true);
  });
  test("restricted audience and sensitive content metadata survive normalization", () => {
    const raw: any = fixture(); raw.trusted_friends_info = { owner_id: "42" }; raw.legacy.possibly_sensitive = true;
    expect(mapRawTweet(raw)).toMatchObject({ restrictedAudience: true, possiblySensitive: true });
  });
});
