import { TwitterOpenApi } from "twitter-openapi-typescript";
import axios from "axios";
import { ClientTransaction, handleXMigration } from "x-client-transaction-id";

const ensureLatestConfig = () => {
  TwitterOpenApi.url =
    "https://raw.githubusercontent.com/fa0311/twitter-openapi/refs/heads/main/src/config/placeholder.json";
};

let transactionClient: ClientTransaction | null = null;
let transactionExpiresAt = 0;
let openApiConfigCache: { data: Record<string, any>; expiresAt: number } | null = null;

const refreshTransactionClient = async () => {
  const document = await handleXMigration();
  transactionClient = await ClientTransaction.create(document);
  transactionExpiresAt = Date.now() + 10 * 60 * 1000;
  return transactionClient;
};

export const getAuthCookies = async (TOKEN: string) => {
  const resp = await axios.get("https://x.com/manifest.json", {
    headers: {
      cookie: `auth_token=${TOKEN}`,
    },
  });

  const resCookie = (resp.headers["set-cookie"] as string[]) || [];
  const cookieObj = resCookie.reduce((acc: Record<string, string>, cookie: string) => {
    const [name, value] = cookie.split(";")[0].split("=");
    acc[name] = value;
    return acc;
  }, {});

  const merged = { ...cookieObj, auth_token: TOKEN };
  const cookieHeader = Object.entries(merged)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");

  return {
    cookieObj: merged,
    cookieHeader,
    csrfToken: merged.ct0,
  };
};

export const getApiHeaders = async () => {
  ensureLatestConfig();
  const api = new TwitterOpenApi();
  const headers = (await api.getHeaders()).api;
  return headers;
};

export const getOpenApiFlag = async (key: string) => {
  ensureLatestConfig();
  const now = Date.now();
  if (!openApiConfigCache || now > openApiConfigCache.expiresAt) {
    const resp = await axios.get(TwitterOpenApi.url);
    openApiConfigCache = { data: resp.data || {}, expiresAt: now + 10 * 60 * 1000 };
  }
  const flag = openApiConfigCache.data?.[key];
  if (!flag) {
    throw new Error(`Missing openapi flag: ${key}`);
  }
  return flag;
};

export const getTransactionId = async (method: string, path: string) => {
  const now = Date.now();
  if (!transactionClient || now > transactionExpiresAt) {
    await refreshTransactionClient();
  }
  try {
    return await transactionClient!.generateTransactionId(method, path);
  } catch (error) {
    transactionClient = null;
    transactionExpiresAt = 0;
    const nextClient = await refreshTransactionClient();
    return nextClient.generateTransactionId(method, path);
  }
};

export const _xClient = async (TOKEN: string) => {
  ensureLatestConfig();
  const { cookieObj } = await getAuthCookies(TOKEN);
  const api = new TwitterOpenApi();
  const client = await api.getClientFromCookies(cookieObj);
  return client;
};

export const xGuestClient = () => _xClient(process.env.GET_ID_X_TOKEN!);
export const XAuthClient = () => _xClient(process.env.AUTH_TOKEN!);
