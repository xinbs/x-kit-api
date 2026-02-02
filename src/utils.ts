import { TwitterOpenApi } from "twitter-openapi-typescript";
import axios from "axios";

export const _xClient = async (TOKEN: string) => {
  const resp = await axios.get("https://x.com/manifest.json", {
    headers: {
      cookie: `auth_token=${TOKEN}`,
    },
  });

  const resCookie = resp.headers["set-cookie"] as string[];
  const cookieObj = resCookie.reduce((acc: Record<string, string>, cookie: string) => {
    const [name, value] = cookie.split(";")[0].split("=");
    acc[name] = value;
    return acc;
  }, {});

  const api = new TwitterOpenApi();
  const client = await api.getClientFromCookies({ ...cookieObj, auth_token: TOKEN });
  return client;
};

export const xGuestClient = () => _xClient(process.env.GET_ID_X_TOKEN!);
export const XAuthClient = () => _xClient(process.env.AUTH_TOKEN!);
